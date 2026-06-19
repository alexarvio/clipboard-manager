use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// A user-saved custom transform instruction, reusable as a one-click
/// button alongside the built-in presets. Pro-only in the UI (TransformBar
/// is never rendered for Free tier at all, so no separate gate is needed
/// here) -- see docs/free-vs-pro.md.
#[derive(Serialize, Deserialize, Clone)]
pub struct CustomPreset {
    pub label: String,
    pub instruction: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub hotkey: String,
    /// Legacy field, no longer read by the trim logic. History caps are now
    /// fixed by tier (50 items / 7 days on Free, unlimited on Pro -- see
    /// db::trim_history_for_tier and docs/free-vs-pro.md) rather than
    /// user-editable. Kept in the struct so existing settings.json files on
    /// disk still deserialize without error.
    pub max_history: i64,
    pub launch_at_startup: bool,
    pub theme: String,
    /// Where the AI transform feature sends requests. Defaults to a local
    /// dev server; point this at your deployed server URL once you have one.
    /// The app never talks to Anthropic directly -- see server/README.md.
    #[serde(default = "default_server_url")]
    pub server_url: String,
    /// Optional shared secret sent as the x-app-secret header. Only needed
    /// once the server has APP_SHARED_SECRET set (i.e. once it's deployed
    /// somewhere public, not for local dev).
    #[serde(default)]
    pub app_secret: String,
    /// "free" or "pro". No real billing/account system exists yet -- this is
    /// the seam that future Stripe/license work will set. Until then it's a
    /// plain local flag (toggleable from Settings for dev testing) that
    /// gates AI transform server-side.
    #[serde(default = "default_tier")]
    pub tier: String,
    /// User-saved custom AI transform instructions, reusable as one-click
    /// preset buttons in TransformBar. `#[serde(default)]` so existing
    /// settings.json files on disk (written before this field existed)
    /// still deserialize fine, just with an empty list.
    #[serde(default)]
    pub custom_presets: Vec<CustomPreset>,
}

fn default_tier() -> String {
    "free".into()
}

fn default_server_url() -> String {
    "http://localhost:8787".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Ctrl+Shift+V".into(),
            max_history: 200,
            launch_at_startup: false,
            theme: "dark".into(),
            server_url: default_server_url(),
            app_secret: String::new(),
            tier: default_tier(),
            custom_presets: Vec::new(),
        }
    }
}

fn settings_path() -> PathBuf {
    let mut dir = dirs::config_dir().expect("no config dir");
    dir.push("clip");
    fs::create_dir_all(&dir).ok();
    dir.push("settings.json");
    dir
}

pub fn load() -> Settings {
    let path = settings_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(settings) = serde_json::from_str(&raw) {
            return settings;
        }
    }
    Settings::default()
}

pub fn save(settings: &Settings) {
    let path = settings_path();
    if let Ok(raw) = serde_json::to_string_pretty(settings) {
        fs::write(path, raw).ok();
    }
}
