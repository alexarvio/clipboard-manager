I have a Tauri 2 + React/TypeScript/Tailwind desktop app called "Clip" (a clipboard manager) in this folder. There's a persistent rendering bug I need you to actually debug and fix — I've been going back and forth with another Claude instance that could only reason about the code statically (no ability to run the app), and its fixes haven't worked.

## The bug

The main window ("Clip" panel) is supposed to be a left-docked sidebar (full screen height, ~1/5 screen width) that slides in/out with a global hotkey (default likely `ctrl+shift+v` — check `src-tauri/src/settings.rs` or wherever the default hotkey is set). When triggered, the window appears, but it renders as **just an empty frame/outline — completely transparent inside, no background, no text, no content at all.** Toggling the hotkey does make the frame appear/disappear, so visibility-toggling itself works; it's specifically the *content* that never renders.

## What's already been tried (and didn't fix it)

1. Replaced an unreliable `appWindow.onFocusChanged` listener with explicit Rust-emitted custom Tauri events (`"panel-open"` emitted from `toggle_panel()`'s show branch, `"panel-close-request"` emitted from the `WindowEvent::Focused(false)` handler) — theory was that the focus-changed event fires unreliably on Windows for transparent/always-on-top/skip-taskbar windows, leaving a `framer-motion` slide animation's `open` state stuck at `false` (so the panel content stays translated at `x: "-100%"`, fully off-screen/invisible, while only the native Tauri window shadow rendered as a faint outline).
2. Added a 400ms guard (`AppState.last_shown: Mutex<Instant>`) so a spurious `Focused(false)` blip right after `window.show()` + `set_focus()` can't immediately re-trigger the close animation.
3. Set `"shadow": false` in `tauri.conf.json` (suspected the `transparent: true` + `shadow: true` combo was the real culprit — a known flaky combination on Windows/WebView2).

None of these fixed it. The panel still renders as an empty transparent frame.

## What you should do

Don't just keep guessing from reading the code — actually run the app (`npm run tauri dev` from this directory), reproduce the bug, and use real debugging: check the WebView2 devtools console for errors (right-click the panel if you can, or check if `RUST_LOG`/webview console logs reveal anything), check whether the React tree is even mounting/rendering anything inside the panel, check actual computed styles/transform values on the root element when the panel is "open", and verify whether Tauri events are actually being received on the frontend (e.g. by temporarily logging on every `panel-open` event). Consider also that the bug could be unrelated to the animation/event work at all — e.g. a transparent-window + WebView2 compositing issue, a Tailwind/PostCSS build issue where the `bg-panel` / `backdrop-blur-2xl` classes aren't actually being generated in the built CSS, or something in how `transparent: true` interacts with `decorations: false` on this Windows version.

Key files:
- `src-tauri/tauri.conf.json` — window config (transparent, alwaysOnTop, skipTaskbar, decorations: false, shadow: false, visible: false at startup)
- `src-tauri/src/main.rs` — `dock_to_left_edge()`, `toggle_panel()`, the `WindowEvent` handler, `AppState`
- `src/App.tsx` — root component, the `motion.div` with the slide animation (`open` state, `variants: { open: { x: 0 }, closed: { x: "-100%" } }`), the `appWindow.listen("panel-open" / "panel-close-request", ...)` listeners
- `tailwind.config.js` — defines the custom `panel` color (`bg-panel`) used as the panel's background
- `src/styles.css` — global styles, `html/body/#root { background: transparent }`

Find the actual root cause (don't assume it's the same theory as before) and fix it. Verify the fix actually works by running the app yourself, not just by reading the code.
