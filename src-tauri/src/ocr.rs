//! Local, on-device OCR for screenshots, using Windows' built-in
//! `Windows.Media.Ocr` WinRT API rather than a cloud vision API.
//!
//! This is a deliberate choice, not just convenience: the rest of the
//! Screenshots feature is built around "your screenshots never leave this
//! device" (see db.rs's "Screenshots" section comment), and Windows.Media.Ocr
//! ships as part of Windows 10/11 with no extra install and no per-call cost,
//! so it keeps that story true for text extraction too. It's also *why* OCR
//! can run automatically on every single screenshot (see main.rs's watcher
//! thread) instead of being rationed the way AI Transform/embedding calls
//! are -- there's no API bill to worry about.
//!
//! IMPORTANT / NOT YET BUILD-VERIFIED: this file talks directly to WinRT
//! through the `windows` crate, which is the one part of this whole feature
//! that couldn't be checked with a real `cargo build` while writing it (this
//! environment has no Windows/Rust toolchain). The overall approach --
//! decode into a SoftwareBitmap, hand it to OcrEngine, block on the async
//! result -- is the standard, widely-used recipe for this, but exact method
//! names/signatures do shift between windows-rs versions. If this doesn't
//! compile as-is, the fix is almost certainly a small naming/signature
//! mismatch against whatever windows-rs version actually resolves, not a
//! problem with the overall approach.

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Win32::System::WinRT::{IMemoryBufferByteAccess, RoInitialize, RO_INIT_MULTITHREADED};

/// Runs OCR over a raw RGBA8 buffer -- the same format the clipboard watcher
/// already decodes screenshots into (see main.rs's insert_screenshot call
/// site) -- and returns the recognized text, or None if OCR isn't available,
/// finds nothing, or fails for any reason.
///
/// Blocking: `OcrEngine::RecognizeAsync` is awaited synchronously via
/// `.get()` rather than plugged into an async runtime, since this is meant to
/// be called from a plain background `std::thread::spawn`, not from inside
/// the tauri async runtime (see main.rs) -- keeps the call site simple, at
/// the cost of tying up one OS thread per in-flight OCR run, which is fine
/// given screenshots arrive one at a time, not in a tight loop.
pub fn extract_text(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    // WinRT calls require the calling thread's COM apartment to be
    // initialized -- a real WinRT app's UI thread does this implicitly, but
    // a plain std::thread::spawn thread in Rust doesn't. Safe to call more
    // than once per thread; a failure here (e.g. the thread was already
    // initialized as a different apartment type by something else) is
    // ignored rather than aborting the OCR attempt, since RecognizeAsync
    // will simply fail on its own below if the apartment state is actually a
    // problem.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    // TEMPORARY debug logging -- remove once OCR is confirmed working
    // end-to-end (same pattern as the paste_screenshot debug logging in
    // main.rs). Errors were previously swallowed silently here (.ok()
    // discarded them), which made "OCR didn't find anything" and "OCR
    // actually failed" indistinguishable from the outside.
    match run_ocr(rgba, width, height) {
        Ok(Some(text)) => {
            eprintln!("[debug] OCR found {} chars of text", text.len());
            Some(text)
        }
        Ok(None) => {
            eprintln!("[debug] OCR ran successfully but found no text");
            None
        }
        Err(e) => {
            eprintln!("[debug] OCR failed: {e:?}");
            None
        }
    }
}

fn run_ocr(rgba: &[u8], width: u32, height: u32) -> windows::core::Result<Option<String>> {
    let bitmap = rgba_to_software_bitmap(rgba, width, height)?;

    // Prefer whatever OCR language(s) the user already has installed via
    // their Windows display/input language settings; fall back to English if
    // that comes back empty (e.g. no language packs with OCR data present).
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().or_else(|_| {
        let english = Language::CreateLanguage(&HSTRING::from("en"))?;
        OcrEngine::TryCreateFromLanguage(&english)
    })?;

    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let text = result.Text()?.to_string_lossy();

    if text.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}

/// Builds a WinRT SoftwareBitmap (BGRA8) from a raw RGBA8 buffer, copying
/// pixel data in with the R/B channels swapped -- SoftwareBitmap's 8bpp
/// format is BGRA, not RGBA, and screenshots have no meaningful transparency
/// so alpha is ignored rather than treated as premultiplied/straight.
fn rgba_to_software_bitmap(rgba: &[u8], width: u32, height: u32) -> windows::core::Result<SoftwareBitmap> {
    let mut bgra = vec![0u8; rgba.len()];
    for px in 0..(rgba.len() / 4) {
        let i = px * 4;
        bgra[i] = rgba[i + 2]; // B <- R
        bgra[i + 1] = rgba[i + 1]; // G <- G
        bgra[i + 2] = rgba[i]; // R <- B
        bgra[i + 3] = rgba[i + 3]; // A <- A
    }

    // windows-rs 0.58's SoftwareBitmap::Create is (format, width, height) --
    // no alpha-mode parameter (that overload doesn't exist in this crate
    // version; an earlier draft of this function assumed a 4-arg signature
    // and didn't compile -- see the user's `cargo run` output). Bgra8 with
    // no explicit alpha handling defaults to straight/opaque-enough for OCR
    // purposes, which is all a screenshot (no meaningful transparency) needs.
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, width as i32, height as i32)?;

    {
        let buffer = bitmap.LockBuffer(BitmapBufferAccessMode::Write)?;
        let reference = buffer.CreateReference()?;
        let byte_access: IMemoryBufferByteAccess = windows::core::Interface::cast(&reference)?;

        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut capacity: u32 = 0;
        unsafe {
            byte_access.GetBuffer(&mut data_ptr, &mut capacity)?;
            let len = (capacity as usize).min(bgra.len());
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), data_ptr, len);
        }
    }

    Ok(bitmap)
}
