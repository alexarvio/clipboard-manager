//! Event-driven clipboard capture, replacing the old fixed-interval polling
//! loop (2026-08-19 rewrite -- see the removed watcher thread that used to
//! live in main.rs's setup(), right before the global-hotkey registration).
//!
//! The old approach polled the OS clipboard on a 400ms timer forever, via
//! arboard::Clipboard::new() + get_text()/get_image(), whether or not
//! anything had actually changed -- running the whole time the app was
//! open, not just while its window was visible. Windows only allows one
//! process to hold the clipboard open at a time (OpenClipboard/
//! CloseClipboard under the hood), so every one of those ~2.5-per-second
//! polls was a small window where this app's own read could collide with
//! *any other app's* Ctrl+C or screenshot write happening at the same
//! instant -- reported by a user as "I have to copy two or three times
//! before paste actually has the new content." This had nothing to do with
//! how much history was stored (db::insert_if_new is an indexed O(1)
//! lookup + a single INSERT, and db::trim_history_for_tier is a total
//! no-op on Pro/unlimited -- see both in db.rs) -- it was purely a function
//! of how often this app touched the clipboard on its own, unprompted, at a
//! fixed rate forever.
//!
//! This file replaces that with Windows' built-in clipboard-change
//! notification instead: a hidden message-only window registers as a
//! clipboard format listener (AddClipboardFormatListener) and only reads
//! the clipboard in response to a real WM_CLIPBOARDUPDATE message, which
//! Windows only sends *after* some other app has already finished writing
//! to it. No polling, no periodic OpenClipboard calls competing with
//! anyone else -- the collision window the old approach was causing is
//! gone by construction, not just made less likely by polling slower.
//!
//! IMPORTANT / NOT YET BUILD-VERIFIED: like ocr.rs, this talks directly to
//! Win32 through the `windows` crate in an environment with no Windows/Rust
//! toolchain to compile against. The overall approach -- message-only
//! window, AddClipboardFormatListener, GetMessageW loop -- is the standard,
//! Microsoft-documented recipe for this exact problem. If it doesn't
//! compile as-is, the fix is almost certainly a small naming/signature
//! mismatch against whatever windows-rs 0.58 actually exposes (see
//! Cargo.toml's newly added Win32_* features), not a problem with the
//! approach itself -- run `cargo build` and share the errors.

use once_cell::sync::OnceCell;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use windows::core::{w, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::AddClipboardFormatListener;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, CW_USEDEFAULT, HWND_MESSAGE, MSG, WM_CLIPBOARDUPDATE, WNDCLASSW,
    WS_OVERLAPPED,
};
// try_state()/state() are trait methods on Manager, not inherent methods on
// AppHandle -- main.rs already has this import (it uses the same calls),
// but each file needs its own `use`.
use tauri::Manager;

use crate::{db, AppState};

// Set once from run() below, read from the wndproc callback -- a raw Win32
// window procedure is a plain `extern "system" fn` with a fixed signature
// (no closures allowed), so there's no way to capture the AppHandle at
// registration time the way the old thread::spawn(move || ...) closure
// used to.
static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();

// Screenshot dedup guard, same purpose as the old polling loop's local
// `last_seen_screenshot_hash` variable -- kept as a static Mutex instead of
// a closure-captured local since check_clipboard() below is now called
// from a plain fn pointer with no captured state of its own. Text needs no
// equivalent: db::insert_if_new already skips inserting when the new
// content matches the most recent row, which is the same dedup guarantee
// the old loop's `last_seen: String` local was providing by hand -- no
// image-table equivalent of that check exists in db::insert_screenshot, so
// this stays necessary for screenshots.
static LAST_SCREENSHOT_HASH: Mutex<Option<u64>> = Mutex::new(None);

/// Starts the listener. Blocking -- runs its own Win32 message loop
/// forever, so this must be called from a dedicated background thread (see
/// setup() in main.rs), never the main/UI thread.
pub fn run(app_handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle);
    if let Err(e) = run_inner() {
        eprintln!(
            "[clipboard-listener] failed to start: {e:?} -- clipboard capture is disabled for this session"
        );
    }
}

fn run_inner() -> Result<()> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        // Bound to an explicitly-typed local, not inlined as `instance.into()`
        // at each call site below -- windows-rs 0.58's CreateWindowExW takes
        // its handle-shaped params as `impl Param<T>` generics, and inlining
        // an ambiguous `.into()` into that position left the compiler unable
        // to pick which of Param<HINSTANCE>'s several blanket impls (owned
        // vs `&HINSTANCE`) to target, producing a `From<HMODULE> for
        // &HINSTANCE` error that doesn't exist. A concretely-typed
        // `HINSTANCE` local removes the ambiguity.
        let hinstance: windows::Win32::Foundation::HINSTANCE = instance.into();
        let class_name = w!("FatClipboardListener");

        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        // A zero return means registration failed (e.g. the class name was
        // already registered by a previous run that didn't clean up) --
        // best-effort, same "don't hard-fail the whole app over this"
        // posture as the rest of this function returning early via `?`
        // below if CreateWindowExW/AddClipboardFormatListener themselves
        // fail.
        let _ = RegisterClassW(&wc);

        // Handle-shaped args passed bare (not Some(..)-wrapped) -- Param<T>
        // already covers the "this can be null" case itself (see its
        // Option<T> blanket impl), so wrapping a concrete HWND/HINSTANCE in
        // Some() here made the argument's type Option<T> where a bare T (or
        // literal None for "no handle") was what the trait bound expected,
        // which is what the P2: Param<HWND> failure above was actually
        // about once the HINSTANCE ambiguity next to it is gone.
        let hwnd = CreateWindowExW(
            Default::default(),
            class_name,
            windows::core::PCWSTR::null(),
            WS_OVERLAPPED,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            HWND_MESSAGE, // message-only window -- never actually drawn, just a message target
            None,
            hinstance,
            None,
        )?;

        AddClipboardFormatListener(hwnd)?;

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE {
        if let Some(app_handle) = APP_HANDLE.get() {
            check_clipboard(app_handle.clone());
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Reads whatever's currently on the clipboard and, if it's new (and not
/// something this app itself just wrote -- see AppState::last_self_set /
/// last_self_set_screenshot), saves it to history. Exact same logic the old
/// 400ms polling loop ran on every tick; the only thing that changed is
/// *when* this runs (once, right after a real clipboard-change
/// notification, instead of on a fixed timer regardless of whether
/// anything changed).
fn check_clipboard(app_handle: tauri::AppHandle) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };

    // Same skip the old loop used -- this app's own writes (paste from
    // history/folders/AI transform) also fire WM_CLIPBOARDUPDATE and
    // shouldn't re-trigger a capture while one's in flight.
    // last_self_set/last_self_set_screenshot below still catch self-writes
    // after the fact too; this is just the fast early-out.
    if state.clipboard_busy.load(Ordering::SeqCst) {
        return;
    }

    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return;
    };

    if let Ok(text) = clipboard.get_text() {
        if text.trim().is_empty() {
            return;
        }

        let is_self_set = {
            let guard = state.last_self_set.lock().unwrap();
            match &*guard {
                Some((value, at)) => value == &text && at.elapsed() < crate::SELF_SET_WINDOW,
                None => false,
            }
        };
        if is_self_set {
            return;
        }

        let conn = state.conn.lock().unwrap();
        let new_id = db::insert_if_new(&conn, &text);
        let tier = state.settings.lock().unwrap().tier.clone();
        db::trim_history_for_tier(&conn, &tier);
        drop(conn);

        // Semantic search (Pro-only) -- embed the new clip in the
        // background so it's searchable by meaning the moment it lands in
        // history. Skipped on Free, same cost reasoning as transform_clip.
        // Also skipped for anything that looks like an API key/secret (see
        // classify::looks_like_secret) -- embedding sends the raw content to
        // Voyage AI, which is exactly what flagging it as a secret is meant
        // to prevent. Checked again here (not just relying on the DB flag)
        // since this is the only place that decides whether to embed at
        // all.
        let is_secret = crate::classify::looks_like_secret(&text);
        if let (Some(id), true, false) = (new_id, tier == "pro", is_secret) {
            let (server_url, app_secret, auth_token) = {
                let settings = state.settings.lock().unwrap();
                (
                    settings.server_url.clone(),
                    settings.app_secret.clone(),
                    settings.auth_token.clone(),
                )
            };
            let text_for_embed = text.clone();
            let app_handle_for_embed = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(vector) = crate::embed_text(
                    &text_for_embed,
                    "document",
                    &server_url,
                    &app_secret,
                    &auth_token,
                )
                .await
                {
                    if let Some(state) = app_handle_for_embed.try_state::<AppState>() {
                        let conn = state.conn.lock().unwrap();
                        db::save_embedding(&conn, id, &vector);
                    }
                }
            });
        }
        return;
    }

    // get_text() failed -- most likely the clipboard holds a
    // screenshot/image instead of text (Win+Shift+S, PrintScreen, etc. all
    // copy raw image data, not text). Same flow the old loop's else branch
    // ran.
    if let Ok(image) = clipboard.get_image() {
        let hash = crate::hash_bytes(&image.bytes);
        {
            let mut last_hash = LAST_SCREENSHOT_HASH.lock().unwrap();
            if *last_hash == Some(hash) {
                return;
            }
            *last_hash = Some(hash);
        }

        let is_self_set = {
            let guard = state.last_self_set_screenshot.lock().unwrap();
            match &*guard {
                Some((value, at)) => *value == hash && at.elapsed() < crate::SELF_SET_WINDOW,
                None => false,
            }
        };
        if is_self_set {
            return;
        }

        let tier = state.settings.lock().unwrap().tier.clone();
        let account_key = state.account_key.lock().unwrap().clone();
        let conn = state.conn.lock().unwrap();
        let new_screenshot_id = db::insert_screenshot(
            &conn,
            &account_key,
            &image.bytes,
            image.width as u32,
            image.height as u32,
        );
        db::trim_screenshots_for_tier(&conn, &tier);
        drop(conn);

        // OCR runs automatically on every screenshot, on both tiers -- see
        // ocr.rs's doc comment. Spawned on a plain OS thread (not
        // tauri::async_runtime) since ocr::extract_text blocks
        // synchronously on the WinRT async call.
        if let Some(id) = new_screenshot_id {
            let rgba = image.bytes.to_vec();
            let width = image.width as u32;
            let height = image.height as u32;
            let app_handle_for_ocr = app_handle.clone();
            std::thread::spawn(move || {
                let text = crate::ocr::extract_text(&rgba, width, height).unwrap_or_default();
                if let Some(state) = app_handle_for_ocr.try_state::<AppState>() {
                    let conn = state.conn.lock().unwrap();
                    db::save_ocr_text(&conn, id, &text);
                }
            });
        }
    }
}
