// Shared between TransformBar (renders the chips) and SettingsPanel (lets
// the user pick which ones show up). Built-in presets are just plain
// instruction strings sent straight to transform_clip -- unlike custom
// presets they have no separate {label, instruction} shape, so a builtin's
// own text doubles as both its display label and its instruction.
export const BUILTIN_PRESETS: string[] = [
  "Fix grammar",
  "Make formal",
  "Make casual",
  "Summarize",
  "To bullet points",
  "Simplify",
  // Added 2026-07-31 alongside the Text/Screenshots preset-visibility split
  // (see settings.rs's visible_presets_screenshots) -- these fit OCR'd
  // screenshot content (chat logs, invoices, error dialogs, code) much
  // better than the copy-editing-flavored ones above.
  "Extract key info",
  "Extract action items",
  "Clean up OCR errors",
];

// Which builtins actually make sense for plain copied/typed text -- "Clean
// up OCR errors" assumes there was an OCR step, which text clips never go
// through, so offering it there was a standing contradiction (2026-08-03
// fix, per the "there can't be OCR errors if it's text" catch). Everything
// here also happens to be BUILTIN_PRESETS minus the three OCR-oriented
// additions above.
export const TEXT_ELIGIBLE_PRESETS: string[] = [
  "Fix grammar",
  "Make formal",
  "Make casual",
  "Summarize",
  "To bullet points",
  "Simplify",
];

// Which builtins make sense for OCR'd screenshot content -- "Fix grammar" /
// "Make formal" / "Make casual" assume there's prose to copy-edit, which a
// screenshot of a chat log, invoice, error dialog, or code snippet usually
// isn't. This was originally just Screenshots' *default* visible subset
// (anyone could still turn the copy-editing ones on for screenshots from
// Settings) -- as of 2026-08-03 it's also the hard eligibility list, same
// context-appropriateness fix as TEXT_ELIGIBLE_PRESETS above, so the two
// lists are now sole complements of each other over BUILTIN_PRESETS. Kept
// in sync with settings.rs's default_visible_presets_screenshots(), which
// is the actual source of truth once a settings.json exists -- this
// constant only matters as this file's own fallback (see TransformBar/
// TransformTab/SettingsPanel's `?? DEFAULT_SCREENSHOT_PRESETS`).
export const DEFAULT_SCREENSHOT_PRESETS: string[] = [
  "Summarize",
  "Extract key info",
  "Extract action items",
  "Clean up OCR errors",
  "To bullet points",
  "Simplify",
];

// Hard cap on a custom preset's chip label -- unbounded input here (2026-08-03
// bug) let someone type/paste an arbitrarily long label, which rendered as
// an unbroken wall of text that blew out the chip's width and pushed the
// delete icon off past the edge of the panel. Matches the length TransformBar/
// TransformTab/SettingsPanel already truncated a new preset's *auto-filled*
// label to (from its instruction text) -- this just also enforces it on the
// label field itself, which was previously freely editable past that length.
// Tightened 40 -> 20 (2026-08-13) -- the label is meant to be a short name
// for the preset (think "Spanish", "Formal email"), not a second place to
// paste the instruction/prompt itself; 40 characters was still long enough
// to overflow the fixed-width preset chips in Transform's grid even with
// `truncate` catching the overflow visually. The actual instruction text has
// no length cap -- that's the field meant to hold real prompt-length content.
export const MAX_PRESET_LABEL_LENGTH = 20;

// Hard cap on how many of *your own saved (custom) presets* can be shown as
// chips in the Transform panel at once (2026-08-13, was a combined cap that
// also counted the built-ins toward it -- see TEXT_ELIGIBLE_PRESETS/
// DEFAULT_SCREENSHOT_PRESETS above). Built-ins are no longer optional: every
// eligible one for the current context is always shown, with nothing to
// toggle. This only governs which subset of your own saved presets (an
// unbounded, user-grown list) shows up as buttons -- see Settings ->
// Presets, and the "x / MAX_VISIBLE_PRESETS custom" counter in
// TransformBar/TransformTab.
export const MAX_VISIBLE_PRESETS = 6;
