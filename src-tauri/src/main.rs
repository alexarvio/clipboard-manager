// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod classify;
mod clipboard_listener;
mod db;
mod ocr;
mod settings;

use base64::Engine;
use rusqlite::Connection;
use settings::Settings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

pub struct AppState {
    pub conn: Mutex<Connection>,
    // Which account's history conn currently points at (see
    // db::account_key/db::open_for_account) -- kept alongside conn rather
    // than recomputed from settings.user_email on every access because the
    // background clipboard watcher thread (clipboard_listener.rs) needs it
    // too, for screenshot files, and reading a Mutex<String> here is cheaper
    // than re-normalizing/re-hashing an email on every single clipboard
    // change. Always kept in sync with conn: the two are swapped together
    // by run_auth_request/auth_logout/delete_account, never independently.
    pub account_key: Mutex<String>,
    pub settings: Mutex<Settings>,
    // Timestamp of the last time the panel was shown. Windows can fire a
    // spurious Focused(false) right as a hidden/transparent/always-on-top
    // window is first shown and focused (a brief false->true blip during
    // activation). Without a guard, that blip was immediately read as
    // "user clicked away" and the close animation fired before the open
    // animation ever finished, leaving only the empty bordered shell
    // visible. We ignore close-on-blur for a short window after showing.
    pub last_shown: Mutex<Instant>,
    // Records the text + time of the last clipboard write the app itself
    // performed (paste from history, paste from a folder, paste of an AI
    // transform result). The background watcher checks this before adding
    // anything to history, so re-pasting something we already know about
    // (especially a folder item, which is meant to live outside the rolling
    // history) doesn't get re-captured as a "new" clip.
    pub last_self_set: Mutex<Option<(String, Instant)>>,
    // Same self-capture guard as last_self_set above, but for screenshots
    // (see paste_screenshot): pasting a saved screenshot writes it back onto
    // the system clipboard as an image, which would otherwise immediately
    // look like a brand-new screenshot to the watcher thread and get
    // re-inserted as a duplicate. Keyed by a simple hash of the RGBA bytes
    // rather than the bytes themselves -- images are big, hashes are cheap
    // to compare on every 400ms watcher tick.
    pub last_self_set_screenshot: Mutex<Option<(u64, Instant)>>,
    // Root cause of the "Thread does not have a clipboard open" (os error
    // 1418) failures on screenshot paste: this app's own background watcher
    // (below) polls the clipboard every 400ms, including a get_image() call
    // when an image is present -- which, for a multi-megabyte screenshot, can
    // hold the OS-wide clipboard lock long enough to collide with
    // set_clipboard_image_and_guard's own retry loop. Both sides live in this
    // one process, so instead of just retrying harder against ourselves, the
    // writer sets this flag before touching the clipboard and the watcher
    // skips its poll (rather than colliding) while it's set. See
    // set_clipboard_image_and_guard / set_clipboard_and_paste and the watcher
    // loop in setup() below.
    pub clipboard_busy: AtomicBool,
    // Set for the duration of the native "choose an image" dialog opened by
    // ocr_uploaded_image (TransformTab's image upload). Opening that dialog
    // moves OS focus off this window exactly the way clicking any other app
    // does, which would otherwise fire WindowEvent::Focused(false) and
    // trigger the same close-on-blur path as clicking away -- see that
    // handler in setup() below, and the 2026-08-01 decision to drop
    // drag-and-drop entirely (starting a drag from Explorer blurs this
    // window before the drop can land, with no equivalent moment to
    // suppress it -- the file-dialog path at least has a clear start/end to
    // guard).
    pub dialog_open: AtomicBool,
    // One-shot "what's new" notice, set at most once per launch in setup()
    // when the installed version differs from settings.last_seen_version
    // (see that comparison for the full reasoning). take_update_notice
    // consumes this the first time either window asks, so it's naturally
    // idempotent -- no persisted "seen" flag needed, and no risk of showing
    // it twice across the quick panel and Dashboard both loading it.
    pub just_updated: Mutex<Option<String>>,
}

const SELF_SET_WINDOW: Duration = Duration::from_secs(3);

/// RAII guard for AppState::clipboard_busy -- sets the flag true on
/// construction, guarantees it's set back to false when dropped (including
/// on early `?`/return-Err exits), so the watcher thread never gets stuck
/// permanently skipping its poll if a clipboard write fails partway through.
struct ClipboardBusyGuard<'a>(&'a AtomicBool);
impl<'a> ClipboardBusyGuard<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(flag)
    }
}
impl<'a> Drop for ClipboardBusyGuard<'a> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `category` filters by auto-detected content category, and `date_from`/
/// `date_to` (inclusive RFC3339 bounds on created_at) filter by when the
/// item was copied. All free -- enforced nowhere, since these are just read
/// filters with no cost or abuse concern like transform_clip has.
#[tauri::command]
fn get_history(
    query: String,
    category: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    state: tauri::State<AppState>,
) -> Vec<db::ClipItem> {
    let tier = state.settings.lock().unwrap().tier.clone();
    // Free is capped at db::FREE_SEARCH_LIMIT results per search/filter call;
    // Pro passes -1 (SQLite's "no limit"). This is separate from the
    // FREE_HISTORY_LIMIT storage cap -- Free never actually needs this
    // (storage itself is already capped well under 100), but Pro's
    // unlimited-storage history needs an explicit "no limit" here, or it'd
    // silently fall back to whatever hardcoded default the SQL used to have.
    let limit = if tier == "pro" { -1 } else { db::FREE_SEARCH_LIMIT };
    let conn = state.conn.lock().unwrap();
    db::search(&conn, &query, category.as_deref(), date_from.as_deref(), date_to.as_deref(), limit)
}

/// Sets the system clipboard and simulates Ctrl+V after a short delay (long
/// enough for the panel to hide and focus to return to whatever app was
/// active before). Shared by both "paste this history item" and "paste this
/// AI-transformed text".
fn set_clipboard_and_paste(content: String, state: &AppState) {
    *state.last_self_set.lock().unwrap() = Some((content.clone(), Instant::now()));
    {
        let _busy = ClipboardBusyGuard::new(&state.clipboard_busy);
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            clipboard.set_text(content).ok();
        }
    }
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(180));
        use enigo::{Enigo, Keyboard, Settings as EnigoSettings};
        if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
            use enigo::Direction::Click;
            use enigo::Key;
            let _ = enigo.key(Key::Control, enigo::Direction::Press);
            let _ = enigo.key(Key::Unicode('v'), Click);
            let _ = enigo.key(Key::Control, enigo::Direction::Release);
        }
    });
}

#[tauri::command]
fn paste_item(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    if let Some(content) = db::get_content(&conn, id) {
        drop(conn);
        set_clipboard_and_paste(content, &state);
    }
}

/// Pastes arbitrary text directly -- used after an AI transform, where the
/// result isn't a stored history row (yet).
#[tauri::command]
fn paste_text(text: String, state: tauri::State<AppState>) {
    set_clipboard_and_paste(text, &state);
}

/// Sets the clipboard *without* simulating Ctrl+V afterward -- every other
/// "paste" command in this file (paste_item, paste_text, paste_screenshot,
/// paste_folder_item) intentionally does both, because they're all invoked
/// from the docked quick-panel right before it hides, handing control back
/// to whatever app the user was in. The Dashboard window (2026-07-21, its
/// own "Copy" button on Recent Activity rows) has no such target to hand
/// off to -- it's a regular full-size window the user is actively looking
/// at, not a transient overlay -- so simulating a paste there would just
/// fire Ctrl+V into the Dashboard's own webview for no reason. Reuses the
/// same ClipboardBusyGuard as set_clipboard_and_paste so it still plays
/// nicely with the background watcher thread.
#[tauri::command]
fn copy_to_clipboard(text: String, state: tauri::State<AppState>) {
    *state.last_self_set.lock().unwrap() = Some((text.clone(), Instant::now()));
    let _busy = ClipboardBusyGuard::new(&state.clipboard_busy);
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        clipboard.set_text(text).ok();
    }
}

/// `parent_id` is None for the top-level folder list, or Some(id) to list a
/// folder's direct subfolders (2026-07-19) -- see db::list_folders.
#[tauri::command]
fn list_folders(parent_id: Option<i64>, state: tauri::State<AppState>) -> Vec<db::Folder> {
    let conn = state.conn.lock().unwrap();
    db::list_folders(&conn, parent_id)
}

/// Looks up one folder by id, regardless of nesting -- used when jumping
/// straight to a folder from elsewhere (History's "saved in" indicator),
/// where only the id is known, not its parent chain.
#[tauri::command]
fn get_folder(id: i64, state: tauri::State<AppState>) -> Option<db::Folder> {
    let conn = state.conn.lock().unwrap();
    db::get_folder(&conn, id)
}

/// `parent_id` makes this a subfolder (2026-07-19) instead of a top-level
/// folder. The Free-tier cap (FREE_FOLDER_LIMIT) counts every folder
/// globally, subfolders included, so nesting can't be used to route around
/// the limit.
#[tauri::command]
fn create_folder(
    name: String,
    parent_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<db::Folder, String> {
    let conn = state.conn.lock().unwrap();
    let is_pro = state.settings.lock().unwrap().tier == "pro";
    if !is_pro && db::count_folders(&conn) >= db::FREE_FOLDER_LIMIT {
        return Err("folder limit reached".into());
    }
    let id = db::create_folder(&conn, &name, parent_id);
    // db::create_folder swallows insert errors and falls back to
    // last_insert_rowid(), so `id` isn't guaranteed to name a real row --
    // this used to `.expect()` on that, which panics inside the command
    // while holding the connection mutex, poisoning it for every other
    // command and the watcher thread. Surface it as a normal command error
    // instead; FoldersPanel already has a catch around create_folder.
    db::get_folder(&conn, id).ok_or_else(|| "couldn't create that folder".to_string())
}

/// Folder pinning is Pro-only -- Free already caps at 3 folders total, so
/// pinning wouldn't do anything there. Returns Err if not on Pro, Ok(false)
/// if the Pro-level FOLDER_PIN_LIMIT (3) was already reached, Ok(true) on
/// success (pin or unpin).
#[tauri::command]
fn toggle_folder_pin(id: i64, state: tauri::State<AppState>) -> Result<bool, String> {
    let is_pro = state.settings.lock().unwrap().tier == "pro";
    if !is_pro {
        return Err("folder pinning is a Pro feature".into());
    }
    let conn = state.conn.lock().unwrap();
    Ok(db::toggle_folder_pin(&conn, id))
}

#[tauri::command]
fn delete_folder(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_folder(&conn, id);
}

#[tauri::command]
fn list_folder_items(folder_id: i64, state: tauri::State<AppState>) -> Vec<db::FolderItem> {
    let conn = state.conn.lock().unwrap();
    db::list_folder_items(&conn, folder_id)
}

#[tauri::command]
fn list_folder_memberships(state: tauri::State<AppState>) -> Vec<db::FolderMembership> {
    let conn = state.conn.lock().unwrap();
    db::list_folder_memberships(&conn)
}

/// Screenshot equivalent of list_folder_memberships -- keyed by screenshot_id
/// instead of a content string, since screenshot-kind folder items have no
/// text content to match against. Powers ScreenshotsPanel's own "already
/// saved in" indicator.
#[tauri::command]
fn list_screenshot_folder_memberships(
    state: tauri::State<AppState>,
) -> Vec<db::ScreenshotFolderMembership> {
    let conn = state.conn.lock().unwrap();
    db::list_screenshot_folder_memberships(&conn)
}

/// Saves a clip into a folder. `title` is optional -- folder items don't
/// require one, they just fall back to showing the content alone.
#[tauri::command]
fn add_to_folder(
    folder_id: i64,
    content: String,
    title: Option<String>,
    state: tauri::State<AppState>,
) -> db::FolderItem {
    let conn = state.conn.lock().unwrap();
    let id = db::add_to_folder(&conn, folder_id, &content, title.as_deref());
    db::FolderItem {
        id,
        folder_id,
        title,
        content,
        created_at: chrono::Local::now().to_rfc3339(),
        kind: "text".into(),
        screenshot_id: None,
        thumb_data_uri: None,
    }
}

/// Saves a *reference* to an existing screenshot into a folder -- not a copy
/// of the image (unlike add_to_folder, which does copy the text). Free/Pro
/// split changed 2026-08-01 (see docs/free-vs-pro.md): capturing, viewing,
/// pasting, pinning, and filing screenshots are all local and free now,
/// same as text history -- only the AI-backed pieces (Transform, Smart
/// search) stay Pro-only, so this no longer gates on tier.
#[tauri::command]
fn add_screenshot_to_folder(
    folder_id: i64,
    screenshot_id: i64,
    title: Option<String>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    db::add_screenshot_to_folder(&conn, folder_id, screenshot_id, title.as_deref());
    Ok(())
}

#[tauri::command]
fn update_folder_item(
    id: i64,
    title: Option<String>,
    content: String,
    state: tauri::State<AppState>,
) {
    let conn = state.conn.lock().unwrap();
    db::update_folder_item(&conn, id, title.as_deref(), &content);
}

/// Title-only edit for screenshot-kind folder items -- see
/// db::update_folder_item_title for why these can't go through
/// update_folder_item (there's no content field to send back).
#[tauri::command]
fn update_folder_item_title(id: i64, title: Option<String>, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::update_folder_item_title(&conn, id, title.as_deref());
}

#[tauri::command]
fn delete_folder_item(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_folder_item(&conn, id);
}

/// Persists a drag-to-reorder within a folder (2026-07-19) -- `ordered_ids`
/// is every item in the folder, top to bottom, in its new order.
#[tauri::command]
fn reorder_folder_items(folder_id: i64, ordered_ids: Vec<i64>, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::reorder_folder_items(&conn, folder_id, &ordered_ids);
}

/// Pastes a folder item without it boomeranging back into rolling history --
/// see the `last_self_set` field on AppState and the watcher thread below.
/// Branches on kind: a text item just goes through the normal clipboard-text
/// path; a screenshot item looks up the referenced screenshot's full-res
/// file and pastes it as an image instead (same guarded path as
/// paste_screenshot -- see set_clipboard_image_and_guard below).
#[tauri::command]
fn paste_folder_item(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let info = {
        let conn = state.conn.lock().unwrap();
        db::get_folder_item_for_paste(&conn, id)
    };
    let Some((kind, content, screenshot_id)) = info else {
        return Ok(());
    };

    if kind == "screenshot" {
        let Some(screenshot_id) = screenshot_id else {
            return Ok(());
        };
        let path = {
            let conn = state.conn.lock().unwrap();
            db::get_screenshot_path(&conn, screenshot_id)
        };
        let Some(path) = path else {
            return Ok(());
        };
        set_clipboard_image_and_guard(&path, &state)
    } else {
        set_clipboard_and_paste(content, &state);
        Ok(())
    }
}

/// Cheap non-cryptographic hash used only to dedupe consecutive identical
/// screenshots (see the watcher loop below and last_self_set_screenshot on
/// AppState) -- not a security boundary, just fast enough to run against a
/// potentially multi-megabyte image buffer on every 400ms watcher tick.
fn hash_bytes(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Reads a full-resolution screenshot PNG from disk and writes it onto the
/// system clipboard as an image, guarded by last_self_set_screenshot so the
/// watcher thread doesn't immediately re-capture it as a "new" screenshot.
/// Shared by paste_screenshot and paste_folder_item (screenshot-kind items)
/// so both go through the exact same guarded path instead of two near-copies
/// drifting apart over time.
///
/// Bug fixed 2026-07-19: this used to only set the clipboard and stop there,
/// unlike set_clipboard_and_paste (the text equivalent), which also
/// simulates Ctrl+V after a short delay so the image actually lands wherever
/// the user was focused before opening Clip. Without that, "pasting" a
/// screenshot just silently copied it -- nothing appeared anywhere unless
/// the user then pressed Ctrl+V themselves. Same 180ms delay as the text
/// path, long enough for the panel to hide and focus to return.
fn set_clipboard_image_and_guard(path: &str, state: &AppState) -> Result<(), String> {
    // TEMPORARY debug logging -- remove once diagnosed, see paste_screenshot.
    eprintln!("[debug] set_clipboard_image_and_guard: opening {path}");
    let img = image::open(path).map_err(|e| {
        eprintln!("[debug] image::open FAILED: {e}");
        format!("couldn't read screenshot: {e}")
    })?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let bytes = rgba.into_raw();
    eprintln!("[debug] image opened OK, {width}x{height}, {} bytes", bytes.len());

    *state.last_self_set_screenshot.lock().unwrap() = Some((hash_bytes(&bytes), Instant::now()));

    // Root-caused 2026-07-20: the earlier theory here (a short retry loop is
    // enough to ride out "a few ms of contention") turned out not to hold in
    // practice -- the background watcher's own get_image() call on a
    // multi-megabyte screenshot can hold the OS-wide clipboard lock for
    // longer than the whole retry window, so every attempt failed with
    // "Thread does not have a clipboard open" (os error 1418). Real fix:
    // ClipboardBusyGuard tells the watcher to skip its poll entirely while
    // we're writing, so there's no self-collision to retry against in the
    // first place. The retry loop stays as defense-in-depth against *other*
    // processes (e.g. a screenshot tool) transiently holding the clipboard.
    let _busy = ClipboardBusyGuard::new(&state.clipboard_busy);
    let mut last_err = None;
    let mut succeeded = false;
    for attempt in 1..=5 {
        match arboard::Clipboard::new() {
            Ok(mut clipboard) => {
                let image_data = arboard::ImageData {
                    width: width as usize,
                    height: height as usize,
                    bytes: std::borrow::Cow::Owned(bytes.clone()),
                };
                match clipboard.set_image(image_data) {
                    Ok(()) => {
                        eprintln!("[debug] clipboard.set_image() succeeded on attempt {attempt}");
                        succeeded = true;
                        break;
                    }
                    Err(e) => {
                        eprintln!("[debug] clipboard.set_image() FAILED on attempt {attempt}: {e}");
                        last_err = Some(e.to_string());
                    }
                }
            }
            Err(e) => {
                eprintln!("[debug] arboard::Clipboard::new() FAILED on attempt {attempt}: {e}");
                last_err = Some(e.to_string());
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if !succeeded {
        return Err(format!(
            "couldn't set clipboard after 5 attempts: {}",
            last_err.unwrap_or_default()
        ));
    }

    thread::spawn(|| {
        thread::sleep(Duration::from_millis(180));
        eprintln!("[debug] simulating Ctrl+V now");
        use enigo::{Enigo, Keyboard, Settings as EnigoSettings};
        if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
            use enigo::Direction::Click;
            use enigo::Key;
            let _ = enigo.key(Key::Control, enigo::Direction::Press);
            let _ = enigo.key(Key::Unicode('v'), Click);
            let _ = enigo.key(Key::Control, enigo::Direction::Release);
            eprintln!("[debug] Ctrl+V simulation done");
        } else {
            eprintln!("[debug] Enigo::new() FAILED -- could not simulate keypress");
        }
    });

    Ok(())
}

/// Screenshots are Pro-only (see docs/free-vs-pro.md) -- gated the same way
/// as transform_clip/filter_by_ai, by checking tier in the command itself
/// rather than only hiding it in the UI, since the point is real gating not
/// just a hidden button. list/paste/pin all check this; delete doesn't, so
/// a screenshot saved while on Pro isn't stuck undeletable if tier reverts
/// to Free later.
/// `query`, when present and non-blank, does a plain substring match against
/// each screenshot's OCR'd text (see db::search_screenshots) -- free/instant,
/// no API call, same as the Free-tier-eligible half of the cheap/expensive
/// split discussed for folder rules. `None`/blank falls back to the original
/// unfiltered list. Smart (semantic) search over screenshots is a separate
/// command -- see semantic_search_screenshots below -- since it needs to be
/// async (embeds may need to run first) and stays Pro-gated on its own.
#[tauri::command]
fn list_screenshots(query: Option<String>, state: tauri::State<AppState>) -> Result<Vec<db::ScreenshotItem>, String> {
    let conn = state.conn.lock().unwrap();
    match query {
        Some(q) if !q.trim().is_empty() => Ok(db::search_screenshots(&conn, q.trim())),
        _ => Ok(db::list_screenshots(&conn)),
    }
}

/// Full-resolution preview image for the "expand" view in ScreenshotsPanel --
/// the thumbnail sent by list_screenshots is capped at THUMBNAIL_MAX_WIDTH
/// (320px), which is fine for a grid tile but too small to actually read a
/// screenshot's contents. No longer Pro-gated -- see add_screenshot_to_folder's
/// doc comment above for the 2026-08-01 Free/Pro split change.
#[tauri::command]
fn get_screenshot_full(id: i64, state: tauri::State<AppState>) -> Result<String, String> {
    let conn = state.conn.lock().unwrap();
    db::get_screenshot_full_data_uri(&conn, id).ok_or_else(|| "screenshot not found".into())
}

#[tauri::command]
fn paste_screenshot(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    // TEMPORARY debug logging -- remove once the "screenshot paste does
    // nothing, even manual Ctrl+V after" issue is diagnosed.
    eprintln!("[debug] paste_screenshot({id}) called");

    let path = {
        let conn = state.conn.lock().unwrap();
        db::get_screenshot_path(&conn, id)
    };
    eprintln!("[debug] get_screenshot_path({id}) = {:?}", path);
    let Some(path) = path else {
        eprintln!("[debug] no path found for id {id}, returning Ok(()) without touching clipboard");
        return Ok(());
    };

    set_clipboard_image_and_guard(&path, &state)
}

#[tauri::command]
fn delete_screenshot(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_screenshot(&conn, id);
}

/// One-time-per-screenshot catch-up pass: OCR only ever ran automatically at
/// capture time (see the watcher thread above), so any screenshot saved
/// before this feature existed in a working build has ocr_text left NULL
/// forever unless something explicitly re-processes it. Called once every
/// time ScreenshotsPanel mounts (see App.tsx) -- cheap to call repeatedly
/// since db::screenshots_missing_ocr only ever returns rows that are still
/// genuinely unprocessed (see that function's doc comment for why NULL vs
/// Some("") matters here).
///
/// Deliberately a plain (non-async) command rather than spawning its own
/// background thread the way capture-time OCR does -- tauri already runs
/// sync commands on a blocking-friendly thread pool, so this doesn't need
/// the extra machinery, and the frontend awaits it (then refreshes) rather
/// than firing-and-forgetting, so the UI doesn't need to guess when it's
/// safe to reload the list.
#[tauri::command]
fn backfill_screenshot_ocr(state: tauri::State<AppState>) -> Result<usize, String> {
    let missing = {
        let conn = state.conn.lock().unwrap();
        db::screenshots_missing_ocr(&conn, 500)
    };

    let mut processed = 0;
    for (id, file_path) in missing {
        // Re-decode the saved full-res PNG back to raw RGBA8 -- unlike
        // capture-time OCR, there's no in-memory clipboard buffer to reuse
        // here, this screenshot was saved to disk before OCR existed.
        let Ok(dynamic) = image::open(&file_path) else {
            continue;
        };
        let rgba = dynamic.to_rgba8();
        let (width, height) = (rgba.width(), rgba.height());
        let text = ocr::extract_text(rgba.as_raw(), width, height).unwrap_or_default();

        let conn = state.conn.lock().unwrap();
        db::save_ocr_text(&conn, id, &text);
        processed += 1;
    }

    Ok(processed)
}

/// In-memory result of ocr_uploaded_image -- deliberately mirrors the shape
/// of a real ScreenshotItem's preview fields (thumb_data_uri + width/height)
/// so TransformTab can render an uploaded image in the exact same "From a
/// screenshot" preview card as a real captured screenshot. full_data_uri is
/// sent inline (unlike get_screenshot_full's on-demand fetch) because this
/// image was never persisted -- there's no id to fetch it back by later, so
/// the only copy that will ever exist has to go out with this response.
#[derive(serde::Serialize, Clone)]
struct OcrUploadResult {
    text: String,
    thumb_data_uri: String,
    full_data_uri: String,
    width: u32,
    height: u32,
}

/// Encodes an image to an in-memory PNG and returns it as a data URI --
/// same format read_as_data_uri produces for on-disk screenshots, just
/// without ever touching disk (used for uploaded images, which are
/// deliberately never saved anywhere -- see ocr_uploaded_image below).
fn encode_png_data_uri(img: &image::DynamicImage) -> Result<String, String> {
    let mut bytes: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't encode image: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Opens a native "choose an image" dialog, runs the picked file through
/// local OCR (see ocr.rs), and returns the recognized text plus the image
/// itself (a thumbnail + full-res data URI, both held only in memory for
/// this response) for TransformTab to drop into its Input box and preview
/// card -- see that component's "Upload image" button. Unlike screenshots,
/// this image is never written to the database or to disk anywhere: read
/// from wherever the user picked it, decoded in memory, OCR'd and encoded
/// back to PNG in memory, and the original path/bytes are dropped once this
/// call returns -- only the data URIs the frontend asked for survive, and
/// only in React state (never persisted), same as OCR text always has been.
///
/// Returns `Ok(None)` if the user cancels the dialog (so the frontend can
/// tell "cancelled" apart from "picked an image with no recognizable text",
/// which is `Ok(Some(result))` with `result.text == ""`).
///
/// Drag-and-drop was considered instead of/alongside this (2026-08-01) and
/// deliberately dropped: this panel closes itself on `WindowEvent::
/// Focused(false)` (click-away-to-dismiss), and starting a drag from
/// Explorer focuses Explorer first, closing this panel before the drop
/// could ever land. A native dialog has a clear open/close moment we can
/// bracket with AppState::dialog_open to suppress that same close-on-blur;
/// a drag gesture that starts in another window entirely doesn't.
///
/// Gated the same way as the rest of this tab (Free tier never reaches this
/// screen at all -- see TransformTab.tsx's own tier check) -- OCR itself is
/// free/local, but this only exists to feed the Pro-only transform_clip
/// step, so there's no reason to let it be reachable on Free by calling the
/// command directly.
#[tauri::command]
fn ocr_uploaded_image(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<Option<OcrUploadResult>, String> {
    let is_pro = state.settings.lock().unwrap().tier == "pro";
    if !is_pro {
        return Err("AI Transform is a Pro feature".into());
    }

    // See AppState::dialog_open's doc comment -- this bracket is the whole
    // reason ocr_uploaded_image can get away with a blocking dialog call
    // without the panel closing itself out from under it.
    state.dialog_open.store(true, Ordering::SeqCst);
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    state.dialog_open.store(false, Ordering::SeqCst);

    let Some(file_path) = picked else {
        return Ok(None); // user cancelled -- not an error, just nothing to do
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("couldn't resolve that file path: {e}"))?;

    // Same soft cap as TransformTab's old client-side check, just enforced
    // here now that the file never passes through JS at all -- a huge image
    // is more likely a mistake (a whole PDF exported as one giant PNG) than
    // a real photo/scan, and it'd make OCR needlessly slow either way.
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err("That image is too large (max 20MB).".into());
        }
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("couldn't read that file: {e}"))?;
    let dynamic = image::load_from_memory(&bytes).map_err(|e| format!("couldn't read that image: {e}"))?;
    let rgba = dynamic.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());

    let text = ocr::extract_text(rgba.as_raw(), width, height).unwrap_or_default();

    // Same downscale rule as insert_screenshot's thumbnail, so this preview
    // card renders at the same size as a real screenshot's regardless of
    // which path produced it.
    let thumb_dynamic = if width > db::THUMBNAIL_MAX_WIDTH {
        let ratio = db::THUMBNAIL_MAX_WIDTH as f64 / width as f64;
        let thumb_height = (height as f64 * ratio).round() as u32;
        dynamic.resize(db::THUMBNAIL_MAX_WIDTH, thumb_height.max(1), image::imageops::FilterType::Triangle)
    } else {
        dynamic.clone()
    };

    let thumb_data_uri = encode_png_data_uri(&thumb_dynamic)?;
    let full_data_uri = encode_png_data_uri(&dynamic)?;

    Ok(Some(OcrUploadResult { text, thumb_data_uri, full_data_uri, width, height }))
}

#[tauri::command]
fn toggle_screenshot_pin(id: i64, state: tauri::State<AppState>) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    Ok(db::toggle_screenshot_pin(&conn, id))
}

#[derive(serde::Serialize)]
struct TransformRequest<'a> {
    content: &'a str,
    instruction: &'a str,
}

#[derive(serde::Deserialize)]
struct TransformResponse {
    result: Option<String>,
    error: Option<String>,
}

/// Sends the clip content + a user instruction to our own backend server
/// (not directly to Anthropic -- the real API key only ever lives on the
/// server, see server/README.md), and returns the transformed text.
#[tauri::command]
async fn transform_clip(
    content: String,
    instruction: String,
    // Only set when this run was triggered by clicking an actual preset
    // button (builtin or custom) rather than typing a freeform instruction
    // -- see TransformBar.tsx/TransformTab.tsx's run() calls. Powers the
    // Dashboard's "top presets" stat (db::bump_preset_usage below); a
    // freeform run intentionally isn't counted there, so that list reflects
    // presets people actually reach for, not every one-off instruction ever
    // typed.
    preset_label: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (server_url, app_secret, auth_token, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
            settings.tier.clone(),
        )
    };

    // This client-side check is a UX shortcut (instant paywall message, no
    // round trip) -- it is NOT the real gate. The server re-checks the
    // account's actual tier from its own database on every request (see
    // requirePro in server/index.js), because this `tier` value comes from
    // Settings, which the frontend can write (SettingsPanel's dev-only Plan
    // toggle). A client that simply lied about being Pro here would still
    // be rejected server-side.
    if tier != "pro" {
        return Err("upgrade to Pro to use AI transform".into());
    }

    // Same rule as the embedding pipeline and filter_by_ai below: content
    // that looks like an API key/secret never gets sent to the AI backend,
    // full stop -- this doesn't have a clip_item id to check the stored
    // is_secret flag against (content can be freshly typed, not just an
    // existing history item), so it's re-classified here directly.
    if classify::looks_like_secret(&content) {
        return Err(
            "this looks like an API key or secret, so it won't be sent for AI transform".into(),
        );
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/transform", server_url.trim_end_matches('/')))
        .json(&TransformRequest {
            content: &content,
            instruction: &instruction,
        });

    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }
    // The real per-account gate on the server side reads this, not the tier
    // field above -- see requireAuth/requirePro in server/index.js.
    if !auth_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {auth_token}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body: TransformResponse = resp.json().await.unwrap_or(TransformResponse {
            result: None,
            error: None,
        });
        return Err(body
            .error
            .unwrap_or_else(|| format!("server returned {status}")));
    }

    let body: TransformResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    // Only counted on a real, successful, paid transform -- matches the tier
    // check above (Free never reaches here) and is what the Dashboard's
    // "AI transforms run" tile reads (db::get_dashboard_stats).
    {
        let conn = state.conn.lock().unwrap();
        db::bump_lifetime(&conn, "transforms_run");
        if let Some(label) = preset_label.as_deref().filter(|l| !l.is_empty()) {
            db::bump_preset_usage(&conn, label);
        }
    }

    body.result.ok_or_else(|| "empty response from server".into())
}

#[tauri::command]
fn get_dashboard_stats(state: tauri::State<AppState>) -> db::DashboardStats {
    let conn = state.conn.lock().unwrap();
    db::get_dashboard_stats(&conn, 84) // 12 weeks, matches the heatmap grid
}

// --- Standalone AI Transform tab -----------------------------------------
// Backs TransformTab.tsx's "recent transforms" list -- see the transform_log
// table comment in db.rs for why this is a separate, capped, browse-only
// log rather than folder/history storage.

#[tauri::command]
fn log_transform(
    input: String,
    instruction: String,
    output: String,
    // Only set when this run came from clicking a preset button, mirroring
    // transform_clip's own preset_label param -- see db::log_transform's
    // preset_label migration comment for why this exists.
    preset_label: Option<String>,
    state: tauri::State<AppState>,
) -> i64 {
    let conn = state.conn.lock().unwrap();
    db::log_transform(&conn, &input, &instruction, &output, preset_label.as_deref())
}

#[tauri::command]
fn get_transform_log(state: tauri::State<AppState>) -> Vec<db::TransformLogEntry> {
    let conn = state.conn.lock().unwrap();
    db::get_transform_log(&conn)
}

#[tauri::command]
fn delete_transform_log_entry(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_transform_log_entry(&conn, id);
}

#[tauri::command]
fn clear_transform_log(state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::clear_transform_log(&conn);
}

#[derive(serde::Serialize)]
struct FilterItem<'a> {
    id: i64,
    content: &'a str,
}

#[derive(serde::Serialize)]
struct FilterRequest<'a> {
    items: Vec<FilterItem<'a>>,
    prompt: &'a str,
}

#[derive(serde::Deserialize)]
struct FilterResponse {
    matches: Option<Vec<i64>>,
    error: Option<String>,
}

/// Runs a user-defined AI filter (see settings::CustomFilter) against every
/// item currently in history, returning the ids of the ones that match
/// `prompt`. Pro-only and gated server-side for the same reason as
/// transform_clip -- every call is a real AI request.
#[tauri::command]
async fn filter_by_ai(prompt: String, state: tauri::State<'_, AppState>) -> Result<Vec<i64>, String> {
    let (server_url, app_secret, auth_token, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
            settings.tier.clone(),
        )
    };

    // Same caveat as transform_clip: this is a UX shortcut, not the real
    // gate -- the server re-checks the account's actual tier itself.
    if tier != "pro" {
        return Err("upgrade to Pro to use AI filters".into());
    }

    let candidates = {
        let conn = state.conn.lock().unwrap();
        db::search(&conn, "", None, None, None, db::AI_FILTER_CANDIDATE_LIMIT)
    };

    // Flagged secrets never leave the device for an AI request -- same rule
    // as the embedding pipeline (see clipboard_listener.rs) and transform
    // (see transform_clip's is_secret check above).
    let items: Vec<FilterItem> = candidates
        .iter()
        .filter(|it| !it.is_secret)
        .map(|it| FilterItem {
            id: it.id,
            content: &it.content,
        })
        .collect();

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/filter-match", server_url.trim_end_matches('/')))
        .json(&FilterRequest {
            items,
            prompt: &prompt,
        });

    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }
    if !auth_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {auth_token}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body: FilterResponse = resp.json().await.unwrap_or(FilterResponse {
            matches: None,
            error: None,
        });
        return Err(body
            .error
            .unwrap_or_else(|| format!("server returned {status}")));
    }

    let body: FilterResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    Ok(body.matches.unwrap_or_default())
}

#[derive(serde::Serialize)]
struct EmbedRequest<'a> {
    texts: Vec<&'a str>,
    input_type: &'a str,
}

#[derive(serde::Deserialize)]
struct EmbedResponse {
    embeddings: Option<Vec<Vec<f32>>>,
    error: Option<String>,
}

/// Calls the server's /embed endpoint (see server/index.js, which forwards
/// to Voyage AI -- Anthropic has no embeddings API of its own) for a batch
/// of texts and returns one vector per input, same order. `input_type` must
/// be "query" for search text and "document" for clip content -- Voyage's
/// models embed those two roles slightly differently for better retrieval
/// quality, so getting this wrong doesn't error, it just quietly makes
/// matches worse.
async fn embed_texts(
    texts: &[String],
    input_type: &str,
    server_url: &str,
    app_secret: &str,
    auth_token: &str,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/embed", server_url.trim_end_matches('/')))
        .json(&EmbedRequest {
            texts: texts.iter().map(|s| s.as_str()).collect(),
            input_type,
        });

    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }
    // Real per-account Pro gate on the server reads this -- see
    // requireAuth/requirePro in server/index.js.
    if !auth_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {auth_token}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body: EmbedResponse = resp.json().await.unwrap_or(EmbedResponse {
            embeddings: None,
            error: None,
        });
        return Err(body
            .error
            .unwrap_or_else(|| format!("server returned {status}")));
    }

    let body: EmbedResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    body.embeddings.ok_or_else(|| "empty embedding response".into())
}

/// Single-text convenience wrapper around embed_texts, for the two call
/// sites (embed-on-save in the watcher thread, and the query side of
/// semantic_search below) that only ever have one string to embed at a time.
/// The backfill path calls embed_texts directly so it can batch many clips
/// into one request instead of one request per clip.
async fn embed_text(
    text: &str,
    input_type: &str,
    server_url: &str,
    app_secret: &str,
    auth_token: &str,
) -> Result<Vec<f32>, String> {
    let texts = vec![text.to_string()];
    let mut vectors = embed_texts(&texts, input_type, server_url, app_secret, auth_token).await?;
    vectors.pop().ok_or_else(|| "empty embedding response".into())
}

/// One scored match returned to the frontend -- score is surfaced in the UI
/// (as a "N% match" badge) rather than kept internal, per the 2026-07-20
/// rework: semantic search used to silently merge into the substring-search
/// results with only a small sparkle icon marking the difference, which made
/// a miscalibrated threshold (see below) indistinguishable from a real bug --
/// a query with zero exact substring matches against a history full of short,
/// low-content strings (e.g. order codes) came back with every visible
/// result looking "semantically related" when none actually were. Now Text
/// and Smart are separate, explicit modes (App.tsx's searchMode) instead of
/// an invisible merge, and showing the real score lets the user judge
/// relevance themselves instead of trusting an opaque cutoff.
#[derive(serde::Serialize)]
struct SemanticMatch {
    id: i64,
    score: f32,
}

/// Semantic search: embeds the user's search text and ranks every stored
/// clip embedding by cosine similarity, returning matching (id, score) pairs
/// best-first. This is now a standalone search mode (Smart), not merged with
/// the substring search in get_history -- see App.tsx's searchMode state.
/// Pro-only, same reasoning as transform_clip: every call is a real
/// embeddings API request.
#[tauri::command]
async fn semantic_search(query: String, state: tauri::State<'_, AppState>) -> Result<Vec<SemanticMatch>, String> {
    let (server_url, app_secret, auth_token, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
            settings.tier.clone(),
        )
    };

    // UX shortcut, not the real gate -- see transform_clip's comment.
    if tier != "pro" {
        return Err("upgrade to Pro to use semantic search".into());
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let query_vector = embed_text(&query, "query", &server_url, &app_secret, &auth_token).await?;

    let conn = state.conn.lock().unwrap();
    // Bumped 0.4 -> 0.5 on 2026-07-20: 0.4 was tuned by feel, not measured,
    // and turned out to let effectively everything through against sparse/
    // low-content history (short alphanumeric strings can sit at a
    // deceptively high baseline cosine similarity for voyage-3.5-lite,
    // regardless of actual relatedness). 0.5 is still a guess, not a
    // verified value -- now that the real score ships to the frontend and
    // renders per-result, it's fine (and expected) to retune this further
    // once there's real usage data on what scores actually feel relevant.
    let results = db::semantic_search(&conn, &query_vector, 30, 0.5);
    Ok(results
        .into_iter()
        .map(|(id, score)| SemanticMatch { id, score })
        .collect())
}

/// One scored screenshot match -- returns the full ScreenshotItem (not just
/// an id) since ScreenshotsPanel doesn't necessarily have every matching
/// screenshot already loaded (list_screenshots caps at 200); see
/// db::semantic_search_screenshots's doc comment.
#[derive(serde::Serialize)]
struct ScreenshotSemanticMatch {
    screenshot: db::ScreenshotItem,
    score: f32,
}

/// Smart search over screenshots' OCR'd text. Two things happen here that
/// don't happen in the plain-text semantic_search above:
///
/// 1. Before searching, any screenshots with OCR text but no embedding yet
///    get embedded, in batches, right here -- screenshot embeddings are
///    computed on-demand (the first time Smart search actually runs) rather
///    than automatically on every capture, since screenshot volume is
///    unlimited/free and most screenshots are probably never searched for.
///    See screenshot_embeddings' table comment in db.rs::init for the full
///    reasoning. This does mean the *first* Smart search after a batch of
///    new screenshots can take noticeably longer than subsequent ones (it's
///    paying down the embedding backlog) -- that's the intended trade-off.
/// 2. Results carry the full screenshot, not just its id (see
///    ScreenshotSemanticMatch above).
///
/// Pro-only, same reasoning as every other AI-backed command here.
#[tauri::command]
async fn semantic_search_screenshots(
    query: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ScreenshotSemanticMatch>, String> {
    let (server_url, app_secret, auth_token, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
            settings.tier.clone(),
        )
    };

    // UX shortcut, not the real gate -- see transform_clip's comment.
    if tier != "pro" {
        return Err("upgrade to Pro to use Smart search".into());
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let missing = {
        let conn = state.conn.lock().unwrap();
        db::screenshots_missing_embeddings(&conn, BACKFILL_LIMIT)
    };
    for chunk in missing.chunks(BACKFILL_BATCH) {
        let texts: Vec<String> = chunk.iter().map(|(_, text)| text.clone()).collect();
        if let Ok(vectors) = embed_texts(&texts, "document", &server_url, &app_secret, &auth_token).await {
            let conn = state.conn.lock().unwrap();
            for ((id, _), vector) in chunk.iter().zip(vectors.iter()) {
                db::save_screenshot_embedding(&conn, *id, vector);
            }
        }
    }

    let query_vector = embed_text(&query, "query", &server_url, &app_secret, &auth_token).await?;

    let conn = state.conn.lock().unwrap();
    // Same 0.5 threshold as text semantic_search -- see that command's doc
    // comment for why this is a "best guess, retune with real usage data"
    // number rather than a carefully measured one.
    let results = db::semantic_search_screenshots(&conn, &query_vector, 30, 0.5);
    Ok(results
        .into_iter()
        .map(|(screenshot, score)| ScreenshotSemanticMatch { screenshot, score })
        .collect())
}

/// Smart search over the standalone Transform tab's "Recent" log (see
/// TransformTab.tsx) -- added 2026-08-25 alongside actually wiring the
/// search bar up on that tab (previously the search-mode toggle only
/// rendered for tab === "history", so this bar did nothing at all while on
/// Transform). Same on-demand-embedding-then-cosine-scan shape as
/// semantic_search_screenshots, and returns bare (id, score) pairs like the
/// plain-text semantic_search -- TransformTab.tsx already has every row
/// loaded in its own `log` state (transform_log is capped at 50 rows total),
/// so there's nothing to resolve server-side.
#[tauri::command]
async fn semantic_search_transform_log(
    query: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SemanticMatch>, String> {
    let (server_url, app_secret, auth_token, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
            settings.tier.clone(),
        )
    };

    // UX shortcut, not the real gate -- see transform_clip's comment. The
    // Smart-mode toggle itself already blocks a non-Pro account from ever
    // reaching this call (see App.tsx), but this stays as defense in depth,
    // same as every other AI-backed command here.
    if tier != "pro" {
        return Err("upgrade to Pro to use Smart search".into());
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let missing = {
        let conn = state.conn.lock().unwrap();
        // -1 (unlimited): transform_log is capped at 50 rows total (see
        // TRANSFORM_LOG_LIMIT), so even a full backfill here is at most a
        // couple of embedding-batch requests, not the unbounded-history
        // concern that same limit represents for clip_items/screenshots.
        db::transform_log_missing_embeddings(&conn, BACKFILL_LIMIT)
    };
    for chunk in missing.chunks(BACKFILL_BATCH) {
        let texts: Vec<String> = chunk.iter().map(|(_, text)| text.clone()).collect();
        if let Ok(vectors) = embed_texts(&texts, "document", &server_url, &app_secret, &auth_token).await {
            let conn = state.conn.lock().unwrap();
            for ((id, _), vector) in chunk.iter().zip(vectors.iter()) {
                db::save_transform_log_embedding(&conn, *id, vector);
            }
        }
    }

    let query_vector = embed_text(&query, "query", &server_url, &app_secret, &auth_token).await?;

    let conn = state.conn.lock().unwrap();
    // Same 0.5 threshold as the other Smart-search commands -- see
    // semantic_search's doc comment for why this is a starting guess.
    let results = db::semantic_search_transform_log(&conn, &query_vector, 30, 0.5);
    Ok(results
        .into_iter()
        .map(|(id, score)| SemanticMatch { id, score })
        .collect())
}

/// Kicked off once, the moment an account's tier flips to Pro (see
/// save_settings) -- without this, semantic search would come up empty for
/// anyone who upgrades with existing history, since embed-on-save (the
/// watcher thread above) only covers clips captured after upgrading.
/// -1 means "no limit" (same SQLite behavior db::search's -1 relies on) --
/// changed 2026-08-05 from a 300-item cap to unlimited, so upgrading to Pro
/// with years of existing history makes all of it Smart-searchable, not just
/// the newest 300. This was a real gap: at 300, anything older sat
/// permanently un-embedded (nothing ever re-touches it) unless that exact
/// clip got copied again. Cost-wise this is a non-issue -- embedding is
/// ~$0.0000008/item at voyage-3.5-lite pricing, so even a few thousand items
/// on one account's one-time upgrade is a fraction of a cent -- batched
/// BACKFILL_BATCH at a time so it's still a handful of requests, not one per
/// clip, regardless of how large the backfill turns out to be.
const BACKFILL_LIMIT: i64 = -1;
const BACKFILL_BATCH: usize = 50;

fn spawn_embedding_backfill(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };

        let (server_url, app_secret, auth_token) = {
            let settings = state.settings.lock().unwrap();
            (
                settings.server_url.clone(),
                settings.app_secret.clone(),
                settings.auth_token.clone(),
            )
        };
        let missing = {
            let conn = state.conn.lock().unwrap();
            db::clip_items_missing_embeddings(&conn, BACKFILL_LIMIT)
        };

        for chunk in missing.chunks(BACKFILL_BATCH) {
            let texts: Vec<String> = chunk.iter().map(|(_, content)| content.clone()).collect();
            if let Ok(vectors) = embed_texts(&texts, "document", &server_url, &app_secret, &auth_token).await {
                if let Some(state) = app.try_state::<AppState>() {
                    let conn = state.conn.lock().unwrap();
                    for ((id, _), vector) in chunk.iter().zip(vectors.iter()) {
                        db::save_embedding(&conn, *id, vector);
                    }
                }
            }
        }
    });
}

/// Returns false if pinning was refused because MAX_PINNED (3, flat for
/// every tier) was already reached -- the frontend uses this to surface a
/// "limit reached" hint instead of silently doing nothing.
#[tauri::command]
fn toggle_pin(id: i64, state: tauri::State<AppState>) -> bool {
    let conn = state.conn.lock().unwrap();
    db::toggle_pin(&conn, id)
}

#[tauri::command]
fn delete_history_item(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_item(&conn, id);
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// One-shot "what's new" notice -- see AppState::just_updated's doc comment.
/// Returns Some(version) at most once per launch, to whichever window (quick
/// panel or Dashboard) calls this first; every other call this run gets
/// None, same as a launch where nothing changed.
#[tauri::command]
fn take_update_notice(state: tauri::State<AppState>) -> Option<String> {
    state.just_updated.lock().unwrap().take()
}

#[tauri::command]
fn save_settings(settings: Settings, app: tauri::AppHandle, state: tauri::State<AppState>) {
    let was_pro = state.settings.lock().unwrap().tier == "pro";
    settings::save(&settings);

    let autostart = app.autolaunch();
    if settings.launch_at_startup {
        autostart.enable().ok();
    } else {
        autostart.disable().ok();
    }

    let became_pro = !was_pro && settings.tier == "pro";
    *state.settings.lock().unwrap() = settings;

    // See spawn_embedding_backfill's own doc comment -- this is the one
    // moment existing history (saved before upgrading) gets made searchable
    // by meaning, not just going forward.
    if became_pro {
        spawn_embedding_backfill(app);
    }
}

#[derive(serde::Serialize)]
struct AuthCredentials<'a> {
    email: &'a str,
    password: &'a str,
    // Only ever set on signup -- login has no reason to send it, and the
    // server's /auth/login route doesn't look for it. skip_serializing_if
    // keeps it out of the JSON body entirely on login rather than sending an
    // explicit `"firstName":null`.
    #[serde(skip_serializing_if = "Option::is_none", rename = "firstName")]
    first_name: Option<&'a str>,
}

#[derive(serde::Deserialize)]
struct AuthUser {
    email: String,
    tier: String,
    // #[serde(default)] so this doesn't break deserializing a response from
    // an older server that predates this field, or an account created
    // before first_name was collected (server sends "" for those, but
    // defensive either way).
    #[serde(default)]
    first_name: String,
}

#[derive(serde::Deserialize)]
struct AuthResponse {
    token: Option<String>,
    user: Option<AuthUser>,
    error: Option<String>,
}

/// Shared by auth_signup and auth_login -- both hit the same shape of
/// endpoint (POST {server_url}/auth/{path} with { email, password }, back
/// { token, user: { email, tier } }) and both do the same thing on success:
/// stash the session + account info in settings so the app treats this
/// device as signed in, and hand the resulting Settings back to the
/// frontend so it can drop the sign-up/log-in screen immediately without a
/// second round-trip to get_settings.
async fn run_auth_request(
    path: &str,
    email: String,
    password: String,
    first_name: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let server_url = { state.settings.lock().unwrap().server_url.clone() };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/{}", server_url.trim_end_matches('/'), path))
        .json(&AuthCredentials {
            email: &email,
            password: &password,
            first_name: first_name.as_deref(),
        })
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: AuthResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "sign-in failed".into()));
    }

    let token = body.token.ok_or("server didn't return a session")?;
    let user = body.user.ok_or("server didn't return account info")?;

    let was_pro = state.settings.lock().unwrap().tier == "pro";

    let mut settings = state.settings.lock().unwrap().clone();
    settings.auth_token = token;
    settings.user_email = user.email;
    settings.tier = user.tier;
    settings.first_name = user.first_name;
    settings::save(&settings);
    *state.settings.lock().unwrap() = settings.clone();

    // Swap to this account's own isolated clip history (see
    // db::open_for_account) rather than whatever conn was already open --
    // that's what actually stops signing into a second email on the same
    // machine from showing the first account's folders/pins. A no-op file
    // open if this account was already the one signed into (e.g. the same
    // person logging back in), and the one-time legacy-history migration if
    // this is the very first account ever signed into on this machine.
    let new_key = db::account_key(&settings.user_email);
    let new_conn = db::open_for_account(&new_key);
    *state.conn.lock().unwrap() = new_conn;
    *state.account_key.lock().unwrap() = new_key;

    // Covers logging into an existing Pro account on a device that's never
    // embedded its history before (a fresh install, or one that was Free
    // last time it saved settings) -- same backfill as save_settings.
    if !was_pro && settings.tier == "pro" {
        spawn_embedding_backfill(app);
    }

    Ok(settings)
}

/// Creates a new account on the server (see server/index.js POST /auth/signup)
/// and signs this device into it. Required before first use -- see
/// AuthGate.tsx, which is the only thing rendered until settings.auth_token
/// is non-empty.
#[tauri::command]
async fn auth_signup(
    email: String,
    password: String,
    first_name: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    run_auth_request("auth/signup", email, password, Some(first_name), app, state).await
}

/// Signs into an existing account (see server/index.js POST /auth/login).
#[tauri::command]
async fn auth_login(
    email: String,
    password: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    run_auth_request("auth/login", email, password, None, app, state).await
}

/// Clears the local session. Tier is reset to "free" rather than left as
/// whatever the account had -- once logged out there's no account backing
/// that tier anymore, and AuthGate will block further use until someone
/// signs back in anyway.
#[tauri::command]
fn auth_logout(state: tauri::State<AppState>) -> Settings {
    let mut settings = state.settings.lock().unwrap();
    settings.auth_token = String::new();
    settings.user_email = String::new();
    settings.tier = "free".into();
    settings.first_name = String::new();
    settings::save(&settings);
    let result = settings.clone();
    drop(settings);

    // Swap conn back off whichever account was just signed out of -- see
    // the matching swap in run_auth_request. AuthGate blocks all real
    // command usage while signed out anyway, but there's no reason to
    // leave a just-logged-out account's history reachable through conn in
    // the meantime.
    *state.conn.lock().unwrap() = db::open_for_account("");
    *state.account_key.lock().unwrap() = String::new();

    result
}

/// Permanently deletes the signed-in account on the server (see
/// server/index.js DELETE /auth/account) and then clears the local session
/// exactly like auth_logout -- there's no account left to be signed into
/// once this succeeds. Deliberately does *not* touch the local clip history
/// database: that's on-device data that exists independently of any
/// account (it's how Free tier works with nobody signed in at all), so
/// deleting the account shouldn't silently wipe clips sitting on this
/// machine -- see settings.rs's own reasoning for why auth state and local
/// data are kept as separate concerns throughout this app.
#[tauri::command]
async fn delete_account(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    let (server_url, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (settings.server_url.clone(), settings.auth_token.clone())
    };
    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{}/auth/account", server_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    if !ok {
        #[derive(serde::Deserialize)]
        struct ErrorResponse {
            error: Option<String>,
        }
        let body: ErrorResponse = resp.json().await.unwrap_or(ErrorResponse { error: None });
        return Err(body.error.unwrap_or_else(|| "couldn't delete your account".into()));
    }

    let mut settings = state.settings.lock().unwrap();
    settings.auth_token = String::new();
    settings.user_email = String::new();
    settings.tier = "free".into();
    settings.first_name = String::new();
    settings::save(&settings);
    let result = settings.clone();
    drop(settings);

    // Same conn swap as auth_logout -- the account's own history file on
    // disk is untouched (see this function's own doc comment above), this
    // just stops pointing the live conn at an account that no longer
    // exists.
    *state.conn.lock().unwrap() = db::open_for_account("");
    *state.account_key.lock().unwrap() = String::new();

    Ok(result)
}

#[derive(serde::Serialize)]
struct ForgotPasswordBody<'a> {
    email: &'a str,
}

#[derive(serde::Deserialize)]
struct MessageResponse {
    message: Option<String>,
    error: Option<String>,
}

/// Requests a password-reset code be emailed to this address (see
/// server/index.js POST /auth/forgot-password). Always succeeds from the
/// caller's perspective if the server itself is reachable -- the server
/// deliberately returns the same generic message whether or not that email
/// has an account, so AuthGate's "forgot password" screen can't be used to
/// probe who's signed up.
#[tauri::command]
async fn request_password_reset(
    email: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let server_url = { state.settings.lock().unwrap().server_url.clone() };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "{}/auth/forgot-password",
            server_url.trim_end_matches('/')
        ))
        .json(&ForgotPasswordBody { email: &email })
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: MessageResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "couldn't request a reset code".into()));
    }

    Ok(body
        .message
        .unwrap_or_else(|| "If an account exists for that email, a reset code is on its way.".into()))
}

#[derive(serde::Serialize)]
struct ResetPasswordBody<'a> {
    token: &'a str,
    new_password: &'a str,
}

/// Submits the code from the reset email along with a new password (see
/// server/index.js POST /auth/reset-password). On success the server signs
/// this device straight into the account, same as auth_signup/auth_login --
/// see run_auth_request's doc comment for why this returns the whole
/// updated Settings rather than just the token.
#[tauri::command]
async fn reset_password(
    token: String,
    new_password: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let server_url = { state.settings.lock().unwrap().server_url.clone() };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "{}/auth/reset-password",
            server_url.trim_end_matches('/')
        ))
        .json(&ResetPasswordBody {
            token: &token,
            new_password: &new_password,
        })
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: AuthResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "couldn't reset password".into()));
    }

    let session_token = body.token.ok_or("server didn't return a session")?;
    let user = body.user.ok_or("server didn't return account info")?;

    let was_pro = state.settings.lock().unwrap().tier == "pro";

    let mut settings = state.settings.lock().unwrap().clone();
    settings.auth_token = session_token;
    settings.user_email = user.email;
    settings.tier = user.tier;
    settings::save(&settings);
    *state.settings.lock().unwrap() = settings.clone();

    if !was_pro && settings.tier == "pro" {
        spawn_embedding_backfill(app);
    }

    Ok(settings)
}

// --- Billing (Stripe) -------------------------------------------------
//
// See docs/billing-flow.md for the full picture. Both checkout and the
// billing portal are opened in the system browser rather than an in-app
// webview -- Checkout needs to collect a real card, and that should
// obviously happen on Stripe's own domain, not inside a window this app
// controls. There's no deep link back into the app once someone finishes
// (see the note on WEBSITE_URL in server/billing.js); instead the frontend
// polls refresh_account_status a few times after opening the browser.

#[derive(serde::Serialize)]
struct CheckoutBody<'a> {
    plan: &'a str,
}

#[derive(serde::Deserialize)]
struct UrlResponse {
    url: Option<String>,
    error: Option<String>,
}

/// Starts a Stripe Checkout session for the given plan ("monthly" or
/// "annual") and opens it in the system's default browser.
#[tauri::command]
async fn start_checkout(plan: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (server_url, app_secret, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
        )
    };

    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/billing/checkout", server_url.trim_end_matches('/')))
        .json(&CheckoutBody { plan: &plan })
        .header("Authorization", format!("Bearer {auth_token}"));
    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: UrlResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "couldn't start checkout".into()));
    }
    let url = body.url.ok_or("server didn't return a checkout URL")?;

    open::that(url).map_err(|e| format!("couldn't open browser: {e}"))
}

/// Opens the Stripe Billing Portal (plan changes, cancellation, payment
/// method updates -- all handled on Stripe's side, no custom UI needed
/// here) in the system's default browser.
#[tauri::command]
async fn open_billing_portal(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (server_url, app_secret, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
        )
    };

    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/billing/portal", server_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {auth_token}"));
    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: UrlResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body
            .error
            .unwrap_or_else(|| "couldn't open billing portal".into()));
    }
    let url = body.url.ok_or("server didn't return a portal URL")?;

    open::that(url).map_err(|e| format!("couldn't open browser: {e}"))
}

// --- Email verification -----------------------------------------------------
//
// Trial-abuse fix (2026-08-25, see docs/billing-flow.md): start_checkout now
// fails with a specific "verify your email before starting a trial" message
// (server/billing.js's email_unverified error, surfaced as a 403 by
// server/index.js) when the signed-in account hasn't verified its email yet.
// SettingsPanel.tsx matches on that exact string and shows a code-entry form
// calling verify_email below instead of just displaying the error, then
// retries start_checkout once verification succeeds.

#[derive(serde::Serialize)]
struct VerifyEmailBody<'a> {
    code: &'a str,
}

#[derive(serde::Deserialize)]
struct SimpleResponse {
    #[serde(default)]
    ok: bool,
    error: Option<String>,
}

/// Submits the 6-digit code from the verification email (see
/// server/index.js POST /auth/verify-email).
#[tauri::command]
async fn verify_email(code: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (server_url, app_secret, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
        )
    };

    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/auth/verify-email", server_url.trim_end_matches('/')))
        .json(&VerifyEmailBody { code: &code })
        .header("Authorization", format!("Bearer {auth_token}"));
    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: SimpleResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "that code is invalid or has expired".into()));
    }
    Ok(())
}

/// Sends a fresh verification code, invalidating whatever was issued before
/// (see server/index.js POST /auth/resend-verification).
#[tauri::command]
async fn resend_verification(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (server_url, app_secret, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.auth_token.clone(),
        )
    };

    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{}/auth/resend-verification", server_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {auth_token}"));
    if !app_secret.is_empty() {
        req = req.header("x-app-secret", app_secret);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    let body: SimpleResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "couldn't send that -- try again in a moment".into()));
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct UpdateProfileBody<'a> {
    #[serde(rename = "firstName")]
    first_name: &'a str,
}

/// Updates the signed-in account's first name on the server (see
/// server/index.js POST /auth/update-profile) and mirrors it into local
/// settings -- used by Settings' Account section so accounts created before
/// first_name was collected at signup (or anyone who just wants to change
/// it) can set/edit it after the fact, same idea as refresh_account_status
/// pulling tier from the server rather than trusting a purely local value.
#[tauri::command]
async fn update_first_name(
    first_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let (server_url, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (settings.server_url.clone(), settings.auth_token.clone())
    };
    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "{}/auth/update-profile",
            server_url.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {auth_token}"))
        .json(&UpdateProfileBody {
            first_name: &first_name,
        })
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    let ok = resp.status().is_success();
    #[derive(serde::Deserialize)]
    struct UpdateProfileResponse {
        user: Option<AuthUser>,
        error: Option<String>,
    }
    let body: UpdateProfileResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    if !ok {
        return Err(body.error.unwrap_or_else(|| "couldn't update your name".into()));
    }
    let user = body.user.ok_or("server didn't return account info")?;

    let mut settings = state.settings.lock().unwrap().clone();
    settings.first_name = user.first_name;
    settings::save(&settings);
    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

/// Re-checks the account's real tier from the server (GET /auth/me) and
/// updates local settings to match. This is the only thing that actually
/// detects a Checkout session finishing -- there's no webhook back to the
/// desktop app, so the frontend calls this repeatedly for a while after
/// opening the browser (see UpgradePanel.tsx) until tier flips, or the
/// person gives up and closes the prompt.
#[tauri::command]
async fn refresh_account_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let (server_url, auth_token) = {
        let settings = state.settings.lock().unwrap();
        (settings.server_url.clone(), settings.auth_token.clone())
    };

    if auth_token.is_empty() {
        return Err("please log in first".into());
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/auth/me", server_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
        .await
        .map_err(|e| format!("couldn't reach server: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("session check failed ({status})"));
    }

    #[derive(serde::Deserialize)]
    struct MeResponse {
        user: AuthUser,
    }
    let body: MeResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response from server: {e}"))?;

    let was_pro = state.settings.lock().unwrap().tier == "pro";

    let mut settings = state.settings.lock().unwrap().clone();
    settings.tier = body.user.tier;
    settings.first_name = body.user.first_name;
    settings::save(&settings);
    *state.settings.lock().unwrap() = settings.clone();

    if !was_pro && settings.tier == "pro" {
        spawn_embedding_backfill(app);
    }

    Ok(settings)
}

/// Resizes + repositions the main window into a left-docked sidebar: full
/// screen height, ~1/5 of the screen width, flush against the left edge --
/// like the left-hand nav rail in Claude's desktop app. Recomputed against
/// whichever monitor the window currently lives on, so it still looks right
/// on unusual resolutions or if the window gets dragged to another monitor.
///
/// This is the *actual* source of the panel's on-screen size -- it runs
/// unconditionally in setup() on every launch and overwrites whatever width/
/// height is sitting in tauri.conf.json's "main" window entry before the
/// window is ever shown, so changing those conf.json numbers alone has no
/// visible effect. 2026-08-09: widened 20% (1/5 -> 1/5*1.2 of screen width)
/// as a one-off experiment to see how the panel's own components look with
/// more horizontal room.
fn dock_to_left_edge(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size(); // physical pixels
        let position = monitor.position();
        let scale = monitor.scale_factor();
        let sidebar_width = (size.width as f64 / 5.0 * 1.2).round() as u32;

        // 2026-07-21: monitor.size() is the *full* display resolution,
        // including the strip of screen the Windows taskbar sits on --
        // docking to the full height meant the bottom of the panel (e.g.
        // the Transform panel's "Copy & paste" button) rendered underneath
        // the taskbar instead of stopping above it. Tauri's Monitor API has
        // no cross-platform way to query the real Windows "work area"
        // (screen minus taskbar); getting that precisely means reaching for
        // raw Win32 calls (MonitorFromWindow/GetMonitorInfoW), which isn't
        // something I can compile-verify without a live Windows build --
        // too easy to get an HWND type mismatch across windows-rs/
        // windows-sys versions and ship something that doesn't build at
        // all. So this is a pragmatic approximation instead: reserve a
        // fixed strip at the bottom, scaled to the monitor's DPI, sized
        // generously enough to clear the default Windows taskbar (~40-48px
        // at 100% scale). Known limitations: assumes the taskbar is docked
        // to the bottom (the default, but not universal) and doesn't
        // account for a "large icons" taskbar; if the taskbar is
        // auto-hidden this just leaves a small unused gap rather than
        // overlapping, which is the safer failure mode of the two.
        const TASKBAR_RESERVE_LOGICAL_PX: f64 = 56.0;
        let reserved = (TASKBAR_RESERVE_LOGICAL_PX * scale).round() as u32;
        let docked_height = size.height.saturating_sub(reserved);

        let _ = window.set_size(tauri::PhysicalSize::new(sidebar_width, docked_height));
        let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
    }
}

/// Opens the separate, full-size Dashboard window (Insights/activity stats +
/// account) -- distinct from the docked quick-access panel toggled by the
/// global hotkey. Defined statically in tauri.conf.json (label "dashboard",
/// hidden at startup), so this just shows + focuses it; it's created once
/// and reused rather than rebuilt on every open.
fn open_dashboard(app: &tauri::AppHandle) {
    match app.get_webview_window("dashboard") {
        Some(window) => {
            window.show().ok();
            window.set_focus().ok();
        }
        None => {}
    }
}

fn toggle_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            window.hide().ok();
        } else {
            // Deliberately NOT re-docking here -- only the very first show
            // (see dock_to_left_edge's call in setup() below) snaps the
            // window to the left edge. After that, hiding/showing just
            // toggles visibility and leaves position/size exactly where the
            // user last put it (they can drag/resize it like any normal
            // window, and it'll reopen right back there next time).
            if let Some(state) = app.try_state::<AppState>() {
                *state.last_shown.lock().unwrap() = Instant::now();
            }
            window.show().ok();
            window.set_focus().ok();
            // Tell the frontend explicitly to play its slide-in animation.
            // We deliberately don't rely on the webview's focus-changed event
            // for this -- on a transparent/always-on-top/skip-taskbar window
            // like this one, that event fires unreliably on Windows, which
            // left the panel's content permanently animated off-screen while
            // only the OS-level window shadow was visible.
            window.emit("panel-open", ()).ok();
        }
    }
}

/// Polls until neither the quick panel ("main") nor the Dashboard window is
/// visible, then relaunches into a just-downloaded update -- see the
/// updater's setup() block above. Restarting the moment a background
/// download finishes (the old behavior) could close the app out from under
/// someone mid-paste or mid-Transform with no warning at all; waiting for
/// both windows to be hidden means the relaunch only ever happens at a
/// moment that already looks like "not actively using it" from the user's
/// side. Capped at MAX_UPDATE_RESTART_WAIT so a window left open for a long
/// stretch (Dashboard parked on a second monitor, say) doesn't defer the
/// update indefinitely -- 30 minutes is long enough to not interrupt a
/// normal active session, short enough that the update still lands the same
/// day. A plain blocking loop on its own OS thread (see the thread::spawn
/// call site) rather than an async task -- this crate's tokio dependency
/// doesn't enable the "time" feature, so there's no async sleep available,
/// and a simple poll loop doesn't need one.
fn wait_for_idle_then_restart(app: tauri::AppHandle) {
    const MAX_WAIT: Duration = Duration::from_secs(30 * 60);
    const POLL_INTERVAL: Duration = Duration::from_secs(5);
    let start = Instant::now();
    loop {
        let main_hidden = app
            .get_webview_window("main")
            .map(|w| !w.is_visible().unwrap_or(false))
            .unwrap_or(true);
        let dashboard_hidden = app
            .get_webview_window("dashboard")
            .map(|w| !w.is_visible().unwrap_or(false))
            .unwrap_or(true);
        if (main_hidden && dashboard_hidden) || start.elapsed() >= MAX_WAIT {
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }
    println!("[updater] idle (or wait capped), relaunching now");
    app.request_restart();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Only used for its Rust-side API (app.dialog()...blocking_pick_file()
        // in ocr_uploaded_image below) -- the frontend never calls this
        // plugin's own JS-exposed commands directly, so no capabilities/ACL
        // entry is needed for it (that system only gates calls that cross
        // the JS->Rust IPC boundary; a plugin's Rust API called from inside
        // one of our own #[tauri::command] functions isn't an IPC call).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // --- auto-update check (see docs/auto-updates.md) --------------
            // Fire-and-forget on startup: check the endpoint configured in
            // tauri.conf.json (a GitHub Release's latest.json), and if it
            // points at a newer version, silently download, verify against
            // the public key in that same config, install, and relaunch
            // into the new build. Every step logs and returns instead of
            // panicking -- a flaky network on startup should never stop the
            // app from opening normally on the version already installed.
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater = match updater_handle.updater() {
                    Ok(u) => u,
                    Err(e) => {
                        eprintln!("[updater] not configured: {e}");
                        return;
                    }
                };
                match updater.check().await {
                    Ok(Some(update)) => {
                        println!(
                            "[updater] update {} -> {} available, downloading",
                            update.current_version, update.version
                        );
                        match update
                            .download_and_install(|_chunk_len, _total| {}, || {})
                            .await
                        {
                            Ok(()) => {
                                println!(
                                    "[updater] installed, waiting for an idle moment to relaunch"
                                );
                                // Restarting the instant the download finishes
                                // (the old behavior) could yank the app out
                                // from under someone mid-paste or mid-Transform
                                // with zero warning -- see
                                // wait_for_idle_then_restart's own doc comment
                                // for why this waits instead. A plain OS
                                // thread (not another async task) since this
                                // is a simple blocking poll loop, same pattern
                                // as the clipboard watcher thread below.
                                let restart_handle = updater_handle.clone();
                                thread::spawn(move || {
                                    wait_for_idle_then_restart(restart_handle);
                                });
                            }
                            Err(e) => eprintln!("[updater] download/install failed: {e}"),
                        }
                    }
                    Ok(None) => println!("[updater] already on latest version"),
                    Err(e) => eprintln!("[updater] check failed: {e}"),
                }
            });

            // Settings (including any signed-in account from a previous launch)
            // load *before* the db connection opens, not after, so the very
            // first connection this run already lands in the right
            // account's own history instead of the pre-account/legacy
            // location and needing an immediate swap -- see
            // db::open_for_account for what "right" means here, including
            // the one-time legacy-file migration for whichever account
            // turns out to be first.
            let mut settings = settings::load();

            // "What's new" one-shot notice (see AppState::just_updated and
            // take_update_notice): whenever the installed version differs
            // from the last one this machine actually launched, whichever
            // window asks first this run gets to show a banner. This fires
            // for *any* version change -- a fresh manual install (like
            // testing a build before cutting a real release) as much as a
            // relaunch from the silent auto-updater above -- since both are
            // "the app you're looking at just changed" from the user's
            // point of view. Skipped on a brand-new install (last_seen_version
            // starts empty): there's nothing to compare against yet, so
            // showing "Updated to vX" on someone's very first launch would
            // be nonsense.
            let current_version = app.package_info().version.to_string();
            let just_updated = if !settings.last_seen_version.is_empty()
                && settings.last_seen_version != current_version
            {
                Some(current_version.clone())
            } else {
                None
            };
            if settings.last_seen_version != current_version {
                settings.last_seen_version = current_version;
                settings::save(&settings);
            }

            let hotkey = settings.hotkey.clone();
            let account_key = db::account_key(&settings.user_email);
            let conn = db::open_for_account(&account_key);

            app.manage(AppState {
                conn: Mutex::new(conn),
                account_key: Mutex::new(account_key),
                settings: Mutex::new(settings),
                last_shown: Mutex::new(Instant::now()),
                last_self_set: Mutex::new(None),
                last_self_set_screenshot: Mutex::new(None),
                clipboard_busy: AtomicBool::new(false),
                dialog_open: AtomicBool::new(false),
                just_updated: Mutex::new(just_updated),
            });

            // --- background clipboard watcher -------------------------------
            // 2026-08-19: switched from a 400ms polling loop to Windows'
            // native clipboard-change notification (see
            // clipboard_listener.rs for the full reasoning) -- a user
            // reported having to Ctrl+C two or three times before a paste
            // actually picked up the new content, traced to the old loop's
            // constant OpenClipboard polling colliding with other apps'
            // own clipboard writes. This thread just runs the listener's
            // blocking Win32 message loop; all the actual capture logic
            // (dedup, DB insert, embedding, OCR -- unchanged from before)
            // now lives in clipboard_listener::check_clipboard, called only
            // when Windows reports a real change instead of on every tick.
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                clipboard_listener::run(app_handle);
            });

            // --- global hotkey to toggle the panel ---------------------------
            let app_handle_for_shortcut = app.handle().clone();
            app.global_shortcut().on_shortcut(hotkey.as_str(), move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_panel(&app_handle_for_shortcut);
                }
            })?;

            // --- second hotkey: open the Dashboard directly --------------------
            // Added while the tray was broken, kept afterwards: a keyboard path
            // into the Dashboard that doesn't depend on the tray at all is
            // worth having on its own.
            let app_handle_for_dashboard_shortcut = app.handle().clone();
            app.global_shortcut().on_shortcut(
                "Ctrl+Shift+D",
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        open_dashboard(&app_handle_for_dashboard_shortcut);
                    }
                },
            )?;

            // --- system tray ---------------------------------------------------
            // Left-clicking the tray icon itself opens the full Dashboard window
            // (account/activity stats -- see open_dashboard), matching how Wispr
            // Flow's tray icon opens their main app window. The quick-access
            // docked panel stays reachable via the global hotkey and the
            // "Quick panel" menu item, so summoning it for a fast paste doesn't
            // require the heavier Dashboard window to open first.
            let dashboard_item =
                MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "Quick Panel", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&dashboard_item, &show_item, &settings_item, &quit_item],
            )?;

            // The tray icon is built here, in code, and must NOT also be
            // declared in tauri.conf.json's app.trayIcon. That entry builds a
            // second, independent tray icon, which is what put two
            // FatClipboard entries in the notification area: the config's one
            // carried the logo but none of the handlers below, so clicking it
            // did nothing, while this one carried every handler but had no
            // image set, so it showed up as a blank square. The config entry
            // is gone; this one now takes the app icon.
            let mut tray = TrayIconBuilder::with_id("main");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray
                .menu(&menu)
                // Tauri shows the attached menu on left-click by default,
                // which was silently swallowing left-clicks before they ever
                // reached on_tray_icon_event below -- that's why left-
                // clicking the tray icon appeared to do nothing (no error,
                // no dashboard, no visible menu either in practice). Left
                // click should open the Dashboard (see the comment above);
                // right-click still opens the menu normally regardless of
                // this setting.
                .show_menu_on_left_click(false)
                .tooltip("FatClipboard")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "dashboard" => open_dashboard(app),
                        "show" => toggle_panel(app),
                        "settings" => toggle_panel(app), // v1: settings live inside the same panel
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_dashboard(tray.app_handle());
                    }
                })
                .build(app)?;

            // Hide instead of closing when the user clicks the (invisible) close control.
            // For click-away-to-dismiss, this Rust-side window-focus event is the
            // reliable signal (unlike the webview's own focus-changed event, see the
            // comment in toggle_panel) -- but we don't hide immediately anymore, since
            // that gives the frontend no chance to play its slide-out animation first.
            // Instead we just tell the frontend "please close", and it calls back to
            // actually hide the window once its animation finishes.
            if let Some(window) = app.get_webview_window("main") {
                dock_to_left_edge(&window);

                // First run: no account yet, so surface the panel immediately
                // instead of waiting for the hotkey or tray menu -- a fresh
                // install otherwise has no way to discover the sign-up screen
                // at all (see AuthGate.tsx, which is all that's rendered
                // until settings.auth_token is set).
                let needs_auth = app
                    .state::<AppState>()
                    .settings
                    .lock()
                    .unwrap()
                    .auth_token
                    .is_empty();
                if needs_auth {
                    *app.state::<AppState>().last_shown.lock().unwrap() = Instant::now();
                    window.show().ok();
                    window.set_focus().ok();
                }

                let window_clone = window.clone();
                let app_handle_for_blur = app.handle().clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        window_clone.hide().ok();
                    }
                    WindowEvent::Focused(false) => {
                        // Windows can fire a spurious false->true focus blip
                        // right as we show()/set_focus() this window. If we
                        // acted on every Focused(false), that blip triggered
                        // the close animation immediately after open, so the
                        // panel never visibly rendered its content. Ignore
                        // blur events that land suspiciously close to the
                        // last time we showed the window.
                        let just_opened = app_handle_for_blur
                            .try_state::<AppState>()
                            .map(|s| s.last_shown.lock().unwrap().elapsed() < Duration::from_millis(400))
                            .unwrap_or(false);
                        // Also ignore blur while the native "choose an
                        // image" dialog (ocr_uploaded_image) is open --
                        // opening it steals OS focus the same way clicking
                        // any other app would, and without this the panel
                        // would close itself out from under its own file
                        // dialog. See AppState::dialog_open's doc comment.
                        let dialog_open = app_handle_for_blur
                            .try_state::<AppState>()
                            .map(|s| s.dialog_open.load(Ordering::SeqCst))
                            .unwrap_or(false);
                        if !just_opened && !dialog_open {
                            window_clone.emit("panel-close-request", ()).ok();
                        }
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            paste_item,
            paste_text,
            copy_to_clipboard,
            toggle_pin,
            delete_history_item,
            get_settings,
            save_settings,
            take_update_notice,
            auth_signup,
            auth_login,
            auth_logout,
            delete_account,
            request_password_reset,
            reset_password,
            start_checkout,
            open_billing_portal,
            verify_email,
            resend_verification,
            refresh_account_status,
            update_first_name,
            transform_clip,
            filter_by_ai,
            semantic_search,
            semantic_search_screenshots,
            semantic_search_transform_log,
            list_folders,
            get_folder,
            create_folder,
            toggle_folder_pin,
            delete_folder,
            list_folder_items,
            reorder_folder_items,
            list_folder_memberships,
            list_screenshot_folder_memberships,
            add_to_folder,
            add_screenshot_to_folder,
            update_folder_item,
            update_folder_item_title,
            delete_folder_item,
            paste_folder_item,
            get_dashboard_stats,
            log_transform,
            get_transform_log,
            delete_transform_log_entry,
            clear_transform_log,
            list_screenshots,
            get_screenshot_full,
            paste_screenshot,
            delete_screenshot,
            toggle_screenshot_pin,
            backfill_screenshot_ocr,
            ocr_uploaded_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
