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
export const MAX_PRESET_LABEL_LENGTH = 40;

// Hard cap on how many preset chips can be visible in the Transform panel at
// once -- there isn't room to show every builtin plus every custom preset
// someone creates, so visibility is opt-in past this limit (see
// Settings -> Presets, and the "x / MAX_VISIBLE_PRESETS" counter in
// TransformBar). Matches the count of builtins today so upgrading users see
// all 6 defaults still visible with nothing to change.
export const MAX_VISIBLE_PRESETS = 6;
