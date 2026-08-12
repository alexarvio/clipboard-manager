import { TransformBar } from "clipboard-manager";

// TransformBar fetches its own settings via invoke("get_settings") (src/lib/tauriShim.ts),
// which mocks builtin presets as already visible for both the "text" and "screenshot"
// contexts -- no extra setup needed for that to render correctly. `result`/`loading`/
// `error` are internal state only reachable by typing an instruction and submitting (or by
// clicking a preset chip), so every story below renders the honest initial, no-result-yet
// baseline -- see the batch's learnings file for what that skips.

// Default caller shape: shown with its own Input preview, as used by callers (e.g.
// Dashboard's "Edit with AI") that don't already render their own preview of the content
// above this panel.
export function TextClip() {
  return (
    <TransformBar
      content="Hey team, quick update on the Q3 rollout — we're on track for the Sept 15 launch, pending final QA sign-off from the mobile squad. Let me know if you need anything from my side before then."
      context="text"
      onDone={() => {}}
      onCancel={() => {}}
      onManagePresets={() => {}}
    />
  );
}

// context="screenshot" swaps in the OCR-oriented preset defaults (Summarize, Extract key
// info, Extract action items, Clean up OCR errors, To bullet points, Simplify) instead of
// the copy-editing-flavored text presets -- this is how ScreenshotsPanel's Transform
// action (via TransformTab) renders it, with a short, OCR'd-text-flavored clip.
export function ScreenshotContext() {
  return (
    <TransformBar
      content="Order #48213 — Ships by Fri, Jun 14"
      context="screenshot"
      onDone={() => {}}
      onCancel={() => {}}
      onManagePresets={() => {}}
    />
  );
}

// showInputPreview={false}: how History/Screenshots/Folders panels embed this component --
// they already render their own preview of the item's content above the panel, so this
// hides TransformBar's own (otherwise redundant) Input section.
export function EmbeddedNoInputPreview() {
  return (
    <TransformBar
      content="const handleSubmit = () => { event.preventDefault(); onSave(formValues); };"
      context="text"
      showInputPreview={false}
      onDone={() => {}}
      onCancel={() => {}}
      onManagePresets={() => {}}
    />
  );
}
