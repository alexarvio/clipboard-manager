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

/// A user-defined AI history filter: a name (shown as the filter chip label)
/// plus a free-text description of what should match, e.g. name "Recipes",
/// prompt "anything that's a recipe for a dish". Pro-only -- selecting one
/// calls the AI server to classify every history item against `prompt` (see
/// main.rs::filter_by_ai), which costs real money the same way transform
/// does, so it's gated the same way.
#[derive(Serialize, Deserialize, Clone)]
pub struct CustomFilter {
    pub name: String,
    pub prompt: String,
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
    /// Where the AI transform feature sends requests. Defaults to the
    /// deployed Railway server (2026-08-06) -- was a local dev server
    /// (localhost:8787) before this was actually deployed anywhere.
    /// The app never talks to Anthropic directly -- see server/README.md.
    #[serde(default = "default_server_url")]
    pub server_url: String,
    /// Shared secret sent as the x-app-secret header. Must match whatever
    /// APP_SHARED_SECRET is set to on the server -- the server rejects any
    /// request without a matching header once that env var is set (see
    /// server/README.md), which it now is on the deployed Railway instance.
    /// Baked in here (2026-08-06) rather than left empty, since an empty
    /// default would mean every app install starts out unable to reach the
    /// now-gated server until someone manually pastes this into Settings.
    /// This is a build-identity secret, not a per-user credential -- it
    /// just proves "this request came from a real build of the app," so
    /// shipping it inside the app (rather than treating it like a real
    /// secret) is the intended use, same as the server_url default above.
    #[serde(default = "default_app_secret")]
    pub app_secret: String,
    /// "free" or "pro". No real billing/account system exists yet -- this is
    /// the seam that future Stripe/license work will set. Until then it's a
    /// plain local flag (toggleable from Settings for dev testing) that
    /// gates AI transform server-side.
    #[serde(default = "default_tier")]
    pub tier: String,
    /// User-saved custom AI transform instructions for text clips, reusable
    /// as one-click preset buttons in TransformBar/TransformTab.
    /// `#[serde(default)]` so existing settings.json files on disk (written
    /// before this field existed) still deserialize fine, just with an
    /// empty list.
    #[serde(default)]
    pub custom_presets: Vec<CustomPreset>,
    /// Same idea as custom_presets, but the fully separate pool for
    /// screenshots' own Transform panel (2026-08-06 split) -- a preset
    /// created while managing Screenshots presets in Settings only ever
    /// shows up there, and vice versa for custom_presets/Text. Before this
    /// split, both contexts drew from one shared custom_presets list and
    /// only *visibility* (see visible_presets_screenshots below) differed
    /// per context, which meant a preset written for screenshots (e.g. "OCR
    /// cleanup") cluttered the Text "Your presets" list too, just unchecked
    /// by default. `#[serde(default)]` so pre-split settings.json files
    /// deserialize fine with an empty screenshot pool -- their existing
    /// custom_presets entries all become Text presets, which is the correct
    /// migration since that's the only pool that existed for them to have
    /// been added to.
    #[serde(default)]
    pub custom_presets_screenshots: Vec<CustomPreset>,
    /// User-defined AI history filters (Pro-only -- see CustomFilter docs
    /// above). `#[serde(default)]` so existing settings.json files written
    /// before this field existed still deserialize fine, just empty.
    #[serde(default)]
    pub custom_filters: Vec<CustomFilter>,
    /// Which built-in category chips (see classify.rs) show in the filter
    /// dropdown, in display order. There are more rule-based categories than
    /// most people want cluttering the dropdown at once, so this lets users
    /// pick a subset. `#[serde(default)]` falls back to the original 5 so
    /// existing settings.json files don't suddenly show nothing.
    #[serde(default = "default_visible_categories")]
    pub visible_categories: Vec<String>,
    /// Which preset chips (builtin instruction text or a custom preset's
    /// label -- both share one namespace) are shown in TransformBar, capped
    /// at MAX_VISIBLE_PRESETS (see src/lib/presets.ts, which this default
    /// must mirror). `#[serde(default)]` falls back to "every builtin
    /// visible, no customs" so existing settings.json files see exactly
    /// what they always saw before this was configurable.
    #[serde(default = "default_visible_presets")]
    pub visible_presets: Vec<String>,
    /// Same idea as visible_presets, but for screenshots' own Transform
    /// panel (see ScreenshotsPanel.tsx) -- kept as a separate field rather
    /// than reusing visible_presets, since which presets are useful differs
    /// by context ("Fix grammar" makes little sense on a screenshot of a
    /// Discord chat, and a screenshot-specific preset like "Extract key
    /// info" wouldn't necessarily belong in the text list either). The
    /// custom preset pool is *also* fully separate per context now (see
    /// custom_presets_screenshots above) -- only the built-in presets are
    /// still a shared, fixed set between the two visibility lists.
    /// `#[serde(default)]` uses default_visible_presets_screenshots (a
    /// distinct, screenshot-appropriate subset) rather than reusing
    /// default_visible_presets, so this actually looks different out of the
    /// box instead of just being customizable-but-identical.
    #[serde(default = "default_visible_presets_screenshots")]
    pub visible_presets_screenshots: Vec<String>,
    /// The signed-in account's session token (a JWT from the server's
    /// POST /auth/signup or /auth/login -- see server/index.js), or empty if
    /// no one is signed in. An account is required before first use (see
    /// AuthGate.tsx), so on a fresh install this starts empty and the app
    /// blocks on the sign-up/log-in screen until it's set. `#[serde(default)]`
    /// so settings.json files written before accounts existed still
    /// deserialize -- they'll just be treated as logged out.
    #[serde(default)]
    pub auth_token: String,
    /// The signed-in account's email, kept alongside auth_token purely for
    /// display (e.g. "Signed in as ..." in Settings) -- not used for any
    /// auth decision itself, the server is the source of truth for that.
    #[serde(default)]
    pub user_email: String,
    /// The signed-in account's first name (collected at signup, 2026-08-06)
    /// -- purely for display, same reasoning as user_email above (e.g. the
    /// "Good morning, {name}" greeting on Dashboard's Home tab). Empty for
    /// accounts created before this field existed, or if the server is on
    /// an older build that doesn't send it -- callers should fall back to
    /// something name-less rather than assume this is always populated.
    #[serde(default)]
    pub first_name: String,
    /// Whether the post-signup onboarding tour (feature highlights + a few
    /// practical setup steps: hotkey, theme, launch at startup) has been
    /// completed on this device. Deliberately per-device rather than
    /// server-tracked -- launch_at_startup/hotkey are OS-level settings that
    /// only make sense to ask about once per install, so a brand-new install
    /// (even for an existing account logging in on a new machine) starts
    /// false and sees onboarding once. `#[serde(default)]` treats any
    /// settings.json written before this field existed as already onboarded
    /// (see the special-case in load(), which backfills `true` for those).
    #[serde(default)]
    pub onboarding_complete: bool,
}

fn default_tier() -> String {
    "free".into()
}

fn default_server_url() -> String {
    "https://clipboard-manager-production.up.railway.app".into()
}

/// Must match APP_SHARED_SECRET on the deployed server (see the doc comment
/// on the `app_secret` field above for why this is safe to bake into the
/// app rather than treat as a real per-user secret).
fn default_app_secret() -> String {
    "d2bb3ec709731ebe180575e214204002cad3defafa5e31a314b82cc6eab668ef".into()
}

fn default_visible_categories() -> Vec<String> {
    vec![
        "link".into(),
        "email".into(),
        "phone".into(),
        "address".into(),
        "bank_account".into(),
    ]
}

fn default_visible_presets() -> Vec<String> {
    vec![
        "Fix grammar".into(),
        "Make formal".into(),
        "Make casual".into(),
        "Summarize".into(),
        "To bullet points".into(),
        "Simplify".into(),
    ]
}

/// Screenshots' own default visible subset -- deliberately different from
/// default_visible_presets above (see visible_presets_screenshots' doc
/// comment): "Fix grammar"/"Make formal"/"Make casual" rarely apply to OCR'd
/// screenshot text (chat logs, invoices, error dialogs, code), so they're
/// swapped for the OCR-oriented builtins added to src/lib/presets.ts
/// alongside this field. Must be kept in sync with that file's
/// DEFAULT_SCREENSHOT_PRESETS constant (the frontend's own fallback copy of
/// this same list).
fn default_visible_presets_screenshots() -> Vec<String> {
    vec![
        "Summarize".into(),
        "Extract key info".into(),
        "Extract action items".into(),
        "Clean up OCR errors".into(),
        "To bullet points".into(),
        "Simplify".into(),
    ]
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Ctrl+Shift+V".into(),
            max_history: 200,
            launch_at_startup: false,
            theme: "dark".into(),
            server_url: default_server_url(),
            app_secret: default_app_secret(),
            tier: default_tier(),
            custom_presets: Vec::new(),
            custom_presets_screenshots: Vec::new(),
            custom_filters: Vec::new(),
            visible_categories: default_visible_categories(),
            visible_presets: default_visible_presets(),
            visible_presets_screenshots: default_visible_presets_screenshots(),
            auth_token: String::new(),
            user_email: String::new(),
            first_name: String::new(),
            onboarding_complete: false,
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
        if let Ok(mut settings) = serde_json::from_str::<Settings>(&raw) {
            // `onboarding_complete` didn't exist before this field was added,
            // so it deserializes to `false` for every settings.json written
            // by an older build -- including ones belonging to someone who
            // already has an account and has been using the app for a while.
            // Don't make that person sit through onboarding retroactively:
            // if they're already signed in, treat them as already onboarded.
            //
            // This has to be conditional on the key genuinely being *absent*
            // from the file, not just on the deserialized value being false:
            // signing up writes auth_token and onboarding_complete=false in
            // the same save, so an unconditional backfill also swallowed the
            // tour for every new account that quit and relaunched before
            // finishing it (and for an existing account signing in on a new
            // machine, which is explicitly supposed to see it again).
            let field_present = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| v.get("onboarding_complete").cloned())
                .is_some();
            if !field_present && !settings.auth_token.is_empty() {
                settings.onboarding_complete = true;
            }
            return settings;
        }
    }
    Settings::default()
}

/// Writes settings.json atomically: serialize to a sibling temp file first,
/// then rename it over the real one (std::fs::rename replaces the
/// destination on Windows as well as Unix). A plain `fs::write` truncates
/// the existing file before writing the new bytes, so a crash/power loss in
/// that window left a zero-length settings.json -- which `load()` can't
/// parse, so it silently falls back to `Settings::default()`: signed out,
/// tier reset to free, custom presets/filters gone. Every command that
/// touches settings (save_settings, auth_signup/login/logout) goes through
/// here, and save_settings in particular runs on every keystroke-driven
/// settings change, so this is a genuinely frequent write.
pub fn save(settings: &Settings) {
    let path = settings_path();
    if let Ok(raw) = serde_json::to_string_pretty(settings) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, &raw).is_ok() && fs::rename(&tmp, &path).is_ok() {
            return;
        }
        // Temp-file path failed (e.g. an antivirus holding the temp file
        // open) -- fall back to the old in-place write rather than dropping
        // the change entirely, and clean up the temp file if it was created.
        fs::remove_file(&tmp).ok();
        fs::write(&path, raw).ok();
    }
}
