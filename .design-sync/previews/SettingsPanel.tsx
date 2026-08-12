import { SettingsPanel } from "clipboard-manager";

// SettingsPanel fetches its own data internally via invoke("get_settings")
// (see src/lib/tauriShim.ts's mock `settings` object -- hotkey, tier,
// presets, categories, filters, account email, etc.), so these stories only
// need to supply the external callback props; the panel's content populates
// itself from that shim's realistic defaults once mounted.

// Canonical view: every section as it renders with no special routing --
// Plan (free tier, trial CTA), General, Appearance & Startup, Filters
// (Categories tab), AI Transform (Text clips context, the default), Developer,
// and Account. No-ops cover every optional callback since this is the full
// interactive panel and any of them could be exercised by clicking around.
export function Default() {
  return (
    <SettingsPanel
      onClose={() => {}}
      onThemeChange={() => {}}
      onTierChange={() => {}}
      onFirstNameChange={() => {}}
      onVisibleCategoriesChange={() => {}}
      onLoggedOut={() => {}}
      onApplyCustomFilter={() => {}}
      onClearCustomFilter={() => {}}
    />
  );
}

// Same underlying settings, but landed on the AI Transform section's
// Screenshots context (as if opened via a "manage presets" link from the
// Screenshots side of the app) -- this swaps which built-in preset list
// shows ("Summarize"/"Extract key info"/"Extract action items"/"Clean up OCR
// errors"/"To bullet points"/"Simplify" instead of Text's
// "Fix grammar"/"Make formal"/"Make casual"/"Summarize"/"To bullet
// points"/"Simplify"), a real content difference rather than just a scroll
// position.
export function PresetsScreenshotContext() {
  return (
    <SettingsPanel
      onClose={() => {}}
      onThemeChange={() => {}}
      onTierChange={() => {}}
      onFirstNameChange={() => {}}
      onVisibleCategoriesChange={() => {}}
      onLoggedOut={() => {}}
      onApplyCustomFilter={() => {}}
      onClearCustomFilter={() => {}}
      scrollToPresets
      initialPresetContext="screenshot"
      onScrolledToPresets={() => {}}
    />
  );
}

// NOTE: a Pro-tier story was tried here and reverted. __setMockTier mutates
// shared module state for the whole page, but grid mode mounts every export
// on this file as a separate cell of the SAME page/module instance, and
// React's passive effects (where SettingsPanel's get_settings() call lives)
// don't fire until the entire synchronous mount loop finishes -- so a
// synchronous __setMockTier("pro") call in one story's render leaks into
// every other cell's effect on the page, including this file's own Default
// story (which would silently start rendering Pro-tier data too). Safe only
// when every story in a file wants the SAME tier (see ScreenshotsPanel.tsx,
// which does this deliberately). See .design-sync/NOTES.md's "Known preview
// limitations" section.
