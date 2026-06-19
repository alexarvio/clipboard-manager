// Prevents an extra console window from popping up on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod classify;
mod db;
mod settings;

use rusqlite::Connection;
use settings::Settings;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct AppState {
    pub conn: Mutex<Connection>,
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
}

const SELF_SET_WINDOW: Duration = Duration::from_secs(3);

/// `category` filters by auto-detected content category (Pro-only in the
/// UI -- enforced there, not here, since this is just a read filter with no
/// cost or abuse concern like transform_clip has).
#[tauri::command]
fn get_history(
    query: String,
    category: Option<String>,
    state: tauri::State<AppState>,
) -> Vec<db::ClipItem> {
    let conn = state.conn.lock().unwrap();
    db::search(&conn, &query, category.as_deref())
}

/// Sets the system clipboard and simulates Ctrl+V after a short delay (long
/// enough for the panel to hide and focus to return to whatever app was
/// active before). Shared by both "paste this history item" and "paste this
/// AI-transformed text".
fn set_clipboard_and_paste(content: String, state: &AppState) {
    *state.last_self_set.lock().unwrap() = Some((content.clone(), Instant::now()));
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        clipboard.set_text(content).ok();
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

#[tauri::command]
fn list_folders(state: tauri::State<AppState>) -> Vec<db::Folder> {
    let conn = state.conn.lock().unwrap();
    db::list_folders(&conn)
}

#[tauri::command]
fn create_folder(name: String, state: tauri::State<AppState>) -> Result<db::Folder, String> {
    let conn = state.conn.lock().unwrap();
    let is_pro = state.settings.lock().unwrap().tier == "pro";
    if !is_pro && db::count_folders(&conn) >= db::FREE_FOLDER_LIMIT {
        return Err("folder limit reached".into());
    }
    let id = db::create_folder(&conn, &name);
    Ok(db::Folder {
        id,
        name,
        created_at: chrono::Local::now().to_rfc3339(),
        item_count: 0,
        pinned: false,
    })
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
    }
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

#[tauri::command]
fn delete_folder_item(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    db::delete_folder_item(&conn, id);
}

/// Pastes a folder item without it boomeranging back into rolling history --
/// see the `last_self_set` field on AppState and the watcher thread below.
#[tauri::command]
fn paste_folder_item(id: i64, state: tauri::State<AppState>) {
    let conn = state.conn.lock().unwrap();
    if let Some(content) = db::get_folder_item_content(&conn, id) {
        drop(conn);
        set_clipboard_and_paste(content, &state);
    }
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
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (server_url, app_secret, tier) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.server_url.clone(),
            settings.app_secret.clone(),
            settings.tier.clone(),
        )
    };

    // AI transform is the hard Free/Pro line (see docs/free-vs-pro.md) --
    // every call costs real money, so it's gated server-side here rather
    // than just hidden in the UI.
    if tier != "pro" {
        return Err("upgrade to Pro to use AI transform".into());
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

    body.result.ok_or_else(|| "empty response from server".into())
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
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(settings: Settings, app: tauri::AppHandle, state: tauri::State<AppState>) {
    settings::save(&settings);

    let autostart = app.autolaunch();
    if settings.launch_at_startup {
        autostart.enable().ok();
    } else {
        autostart.disable().ok();
    }

    *state.settings.lock().unwrap() = settings;
}

/// Resizes + repositions the main window into a left-docked sidebar: full
/// screen height, ~1/5 of the screen width, flush against the left edge --
/// like the left-hand nav rail in Claude's desktop app. Recomputed against
/// whichever monitor the window currently lives on, so it still looks right
/// on unusual resolutions or if the window gets dragged to another monitor.
fn dock_to_left_edge(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size(); // physical pixels
        let position = monitor.position();
        let sidebar_width = (size.width as f64 / 5.0).round() as u32;

        let _ = window.set_size(tauri::PhysicalSize::new(sidebar_width, size.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
    }
}

fn toggle_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            window.hide().ok();
        } else {
            dock_to_left_edge(&window);
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let conn = Connection::open(db::db_path()).expect("failed to open db");
            db::init(&conn);

            let settings = settings::load();
            let hotkey = settings.hotkey.clone();

            app.manage(AppState {
                conn: Mutex::new(conn),
                settings: Mutex::new(settings),
                last_shown: Mutex::new(Instant::now()),
                last_self_set: Mutex::new(None),
            });

            // --- background clipboard watcher -------------------------------
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let mut last_seen = String::new();
                loop {
                    if let Ok(mut clipboard) = arboard::Clipboard::new() {
                        if let Ok(text) = clipboard.get_text() {
                            if !text.trim().is_empty() && text != last_seen {
                                last_seen = text.clone();
                                if let Some(state) = app_handle.try_state::<AppState>() {
                                    let is_self_set = {
                                        let guard = state.last_self_set.lock().unwrap();
                                        match &*guard {
                                            Some((value, at)) => {
                                                value == &text && at.elapsed() < SELF_SET_WINDOW
                                            }
                                            None => false,
                                        }
                                    };
                                    if !is_self_set {
                                        let conn = state.conn.lock().unwrap();
                                        db::insert_if_new(&conn, &text);
                                        // History cap is now tier-driven (50 items / 7 days on
                                        // Free, unlimited on Pro) rather than the old editable
                                        // max_history setting -- see docs/free-vs-pro.md.
                                        let tier = state.settings.lock().unwrap().tier.clone();
                                        db::trim_history_for_tier(&conn, &tier);
                                    }
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(400));
                }
            });

            // --- global hotkey to toggle the panel ---------------------------
            let app_handle_for_shortcut = app.handle().clone();
            app.global_shortcut().on_shortcut(hotkey.as_str(), move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_panel(&app_handle_for_shortcut);
                }
            })?;

            // --- system tray ---------------------------------------------------
            let show_item = MenuItem::with_id(app, "show", "Show Clip", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let app_handle_for_tray = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Clip")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => toggle_panel(app),
                    "settings" => toggle_panel(app), // v1: settings live inside the same panel
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let _ = app_handle_for_tray; // reserved for future tray icon updates

            // Hide instead of closing when the user clicks the (invisible) close control.
            // For click-away-to-dismiss, this Rust-side window-focus event is the
            // reliable signal (unlike the webview's own focus-changed event, see the
            // comment in toggle_panel) -- but we don't hide immediately anymore, since
            // that gives the frontend no chance to play its slide-out animation first.
            // Instead we just tell the frontend "please close", and it calls back to
            // actually hide the window once its animation finishes.
            if let Some(window) = app.get_webview_window("main") {
                dock_to_left_edge(&window);

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
                        if !just_opened {
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
            toggle_pin,
            get_settings,
            save_settings,
            transform_clip,
            list_folders,
            create_folder,
            toggle_folder_pin,
            delete_folder,
            list_folder_items,
            add_to_folder,
            update_folder_item,
            delete_folder_item,
            paste_folder_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
