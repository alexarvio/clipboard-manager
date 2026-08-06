import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../lib/tauriShim";
import {
  BUILTIN_PRESETS,
  TEXT_ELIGIBLE_PRESETS,
  MAX_VISIBLE_PRESETS,
  MAX_PRESET_LABEL_LENGTH,
} from "../lib/presets";
import { formatTimestamp } from "../lib/dateFormat";
import { clampMenuPosition } from "../lib/menuPosition";
import FolderPicker from "./FolderPicker";
import ConfirmPopover from "./ConfirmPopover";

interface CustomPreset {
  label: string;
  instruction: string;
}

// Mirrors src-tauri/src/settings.rs::Settings -- same partial-typing
// approach as TransformBar.tsx (only the fields this screen touches are
// typed, the rest round-trips untouched through get/save_settings).
interface Settings {
  custom_presets: CustomPreset[];
  visible_presets?: string[];
  [key: string]: unknown;
}

interface TransformLogEntry {
  id: number;
  input: string;
  instruction: string;
  output: string;
  created_at: string;
}

interface Props {
  tier: "free" | "pro";
  onManagePresets: () => void;
  onOpenFolder: (folderId: number) => void;
  onCreateNewFolder: () => void;
  // Set by App.tsx when the user clicks "Transform" on an existing History
  // row, screenshot, or folder item (see App.tsx's goToTransform) -- this
  // tab is now where *every* transform happens, not just freeform pasted
  // text, so those entry points need a way to hand their content over. The
  // `seed` is a fresh value (App.tsx uses Date.now()) on every hand-off, not
  // just the content itself, so clicking Transform again on the exact same
  // item re-applies it (content alone wouldn't change, so a plain useEffect
  // dependency on content wouldn't re-fire). `sourceImage` is only present
  // when this came from a screenshot (see ScreenshotsPanel's
  // onTransformItem) -- rendered as a preview above Input so a screenshot's
  // OCR'd text doesn't look like an anonymous pasted-text run with no link
  // back to which screenshot it came from (2026-08-03 fix -- the first cut
  // of this hand-off dropped that entirely).
  pendingInput?: {
    content: string;
    seed: number;
    sourceImage?: { thumb_data_uri: string; width: number; height: number; screenshot_id: number };
  } | null;
  onConsumedPendingInput?: () => void;
}

// "main" identifies the top Output box as a copy/save target, as opposed to
// a specific Recent-list entry (identified by its own numeric id) -- lets
// Copy/Save feedback ("Copied"/"Saved") show up on exactly the button that
// was clicked instead of every copy/save-shaped button in the tab at once.
type ActionTarget = number | "main";

// The standalone AI Transform tab (added 2026-07-22, taking over Screenshots'
// old top-level tab slot -- Screenshots moved into a History sub-toggle).
// Originally just for freeform pasted text (paste in an email/webpage/
// whatever and run a transform without first saving it into History) --
// as of 2026-08-03 this is also where History/Screenshots/Folders send you
// when you click their own "Transform" action (see App.tsx's goToTransform
// and pendingInput above), replacing the old in-place TransformBar sheet
// those views used to open over themselves. That sheet only ever had ~58%
// (History/Folders) or the full height (Screenshots, after an earlier fix)
// of a fairly cramped popup to work with; jumping here instead means every
// transform -- whether it started from an existing item or a fresh paste --
// gets this tab's full-size Input/Instruction/Output layout, and still logs
// to the same persisted "recent transforms" history either way.
export default function TransformTab({
  tier,
  onManagePresets,
  onOpenFolder,
  onCreateNewFolder,
  pendingInput,
  onConsumedPendingInput,
}: Props) {
  const [input, setInput] = useState("");
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loadedSettings, setLoadedSettings] = useState<Settings | null>(null);
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetLabel, setPresetLabel] = useState("");
  // Which custom preset's delete is currently being confirmed, if any --
  // see ConfirmPopover. Deleting used to happen straight off the trash
  // icon's click with no way back; this makes it a two-step action instead.
  const [deleteConfirmLabel, setDeleteConfirmLabel] = useState<string | null>(null);
  const [deleteConfirmPos, setDeleteConfirmPos] = useState<{ top: number; left: number } | null>(null);
  const [log, setLog] = useState<TransformLogEntry[]>([]);
  // Image-to-text upload state -- separate from `error` (the transform-run
  // error) since this is a distinct step (reading/OCR'ing an image via a
  // native file dialog) that happens before there's even an instruction to
  // run. Drag-and-drop was considered instead/alongside (2026-08-01) and
  // dropped: this panel closes itself on click-away, and starting a drag
  // from Explorer focuses Explorer first, closing the panel before the
  // drop could land. A native dialog (see ocr_uploaded_image in main.rs)
  // has a clear open/close moment the Rust side can bracket to suppress
  // that same close-on-blur; a drag gesture starting in another window
  // doesn't give us one.
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  // Set when the current Input came from a screenshot (see pendingInput's
  // sourceImage) -- shown as a small preview above Input so it's clear
  // which screenshot the OCR'd text underneath actually came from. Cleared
  // whenever a new pendingInput arrives without one (a plain text item, or
  // a fresh freeform paste) and by its own dismiss button, so it can't keep
  // pointing at a screenshot the Input box no longer reflects.
  // screenshot_id is only present for a real captured screenshot (see
  // pendingInput.sourceImage) -- its full-res image lives in the DB, fetched
  // on demand via get_screenshot_full. An uploaded image (see uploadImage
  // below) was never persisted anywhere, so there's no id to fetch by;
  // ocr_uploaded_image sends the full-res data URI back inline instead, and
  // that's stashed in full_data_uri so the preview modal can use it directly
  // with no round-trip. Exactly one of the two is ever set.
  const [screenshotSource, setScreenshotSource] = useState<{
    thumb_data_uri: string;
    width: number;
    height: number;
    screenshot_id?: number;
    full_data_uri?: string;
  } | null>(null);
  // Full-size view of screenshotSource, opened by clicking its thumbnail --
  // same on-demand full-res fetch pattern as ScreenshotsPanel's own preview
  // modal (list_screenshots only ships a small thumbnail; the full image is
  // fetched only once someone actually asks to see it) -- except for an
  // uploaded image, where the full-res data is already in hand.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  // Tracks the *most recently requested* screenshot id -- same guard
  // ScreenshotsPanel's own previewRequestId uses, so a slower in-flight
  // fetch can't land after a newer request (or a dismiss) and overwrite the
  // preview with a stale/wrong image.
  const previewRequestId = useRef<number | null>(null);

  // Copy/Save are both "act on some piece of text, from one of several
  // buttons scattered across the tab" -- tracked generically by target
  // (see ActionTarget above) rather than one boolean per button, since that
  // would've meant a growing pile of near-identical state for every Recent
  // row.
  const [copiedTarget, setCopiedTarget] = useState<ActionTarget | null>(null);
  const [savedTarget, setSavedTarget] = useState<ActionTarget | null>(null);
  const [folderPickerPos, setFolderPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [pendingSave, setPendingSave] = useState<{ content: string; target: ActionTarget } | null>(null);

  // Applies content handed over from History/Screenshots/Folders (see the
  // Props doc comment on pendingInput above). Keyed on `seed` rather than
  // `content` so re-clicking Transform on the same item still re-applies it
  // even though the content string itself hasn't changed. Clears any
  // previous run's instruction/result too -- this is meant to feel like
  // starting a fresh transform on the clicked item, not appending to
  // whatever was left over from the last one.
  useEffect(() => {
    if (!pendingInput) return;
    setInput(pendingInput.content);
    setInstruction("");
    setResult(null);
    setError(null);
    setScreenshotSource(pendingInput.sourceImage ?? null);
    onConsumedPendingInput?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInput?.seed]);

  useEffect(() => {
    if (tier !== "pro") return;
    invoke<Settings>("get_settings")
      .then((s) => setLoadedSettings({ ...s, custom_presets: s.custom_presets ?? [] }))
      .catch(console.error);
    refreshLog();
  }, [tier]);

  function refreshLog() {
    invoke<TransformLogEntry[]>("get_transform_log").then(setLog).catch(console.error);
  }

  const customPresets = loadedSettings?.custom_presets ?? [];
  const visiblePresetLabels = new Set(loadedSettings?.visible_presets ?? TEXT_ELIGIBLE_PRESETS);
  // Filtered against TEXT_ELIGIBLE_PRESETS (not the full BUILTIN_PRESETS) so
  // an OCR-oriented preset like "Clean up OCR errors" can never render as a
  // chip here -- this tab always operates on plain text (pasted, typed, or
  // History's own clips), never OCR'd screenshot content, so it was never
  // eligible to begin with (2026-08-03 fix).
  const visibleBuiltins = TEXT_ELIGIBLE_PRESETS.filter((p) => visiblePresetLabels.has(p));
  const visibleCustomPresets = customPresets.filter((p) => visiblePresetLabels.has(p.label));
  const visibleCount = visibleBuiltins.length + visibleCustomPresets.length;

  function startSavingPreset() {
    if (!instruction.trim()) return;
    setPresetLabel(instruction.trim().slice(0, MAX_PRESET_LABEL_LENGTH));
    setNamingPreset(true);
  }

  async function confirmSavePreset() {
    const label = presetLabel.trim();
    if (!label || !loadedSettings) return;
    const nextVisible =
      visibleCount < MAX_VISIBLE_PRESETS
        ? [...(loadedSettings.visible_presets ?? BUILTIN_PRESETS), label]
        : loadedSettings.visible_presets ?? BUILTIN_PRESETS;
    const updated = {
      ...loadedSettings,
      custom_presets: [...customPresets, { label, instruction: instruction.trim() }],
      visible_presets: nextVisible,
    };
    setLoadedSettings(updated);
    await invoke("save_settings", { settings: updated });
    setNamingPreset(false);
    setPresetLabel("");
  }

  async function deletePreset(label: string) {
    if (!loadedSettings) return;
    const updated = {
      ...loadedSettings,
      custom_presets: customPresets.filter((p) => p.label !== label),
      visible_presets: (loadedSettings.visible_presets ?? BUILTIN_PRESETS).filter((l) => l !== label),
    };
    setLoadedSettings(updated);
    await invoke("save_settings", { settings: updated });
  }

  async function run(finalInstruction: string) {
    if (!input.trim() || !finalInstruction.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const transformed = await invoke<string>("transform_clip", {
        content: input,
        instruction: finalInstruction,
      });
      setResult(transformed);
      // Logged here (not in transform_clip itself) since only this tab
      // wants a browsable history of runs -- TransformBar's per-item
      // in-place fixes don't.
      await invoke("log_transform", { input, instruction: finalInstruction, output: transformed });
      refreshLog();
    } catch (e) {
      setError(typeof e === "string" ? e : "Transform failed. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  async function openScreenshotPreview() {
    if (!screenshotSource) return;
    // Uploaded image: the full-res data URI came back with ocr_uploaded_image
    // itself (never persisted, so there's no id to fetch it back by) --
    // nothing to await, just show it.
    if (screenshotSource.full_data_uri) {
      previewRequestId.current = null;
      setPreviewOpen(true);
      setPreviewError(false);
      setPreviewSrc(screenshotSource.full_data_uri);
      return;
    }
    const id = screenshotSource.screenshot_id;
    if (id == null) return;
    previewRequestId.current = id;
    setPreviewOpen(true);
    setPreviewSrc(null);
    setPreviewError(false);
    try {
      const fullDataUri = await invoke<string>("get_screenshot_full", { id });
      if (previewRequestId.current !== id) return;
      setPreviewSrc(fullDataUri);
    } catch {
      if (previewRequestId.current !== id) return;
      setPreviewError(true);
    }
  }

  function closeScreenshotPreview() {
    setPreviewOpen(false);
    setPreviewSrc(null);
    setPreviewError(false);
  }

  // Opens a native "choose an image" dialog (see ocr_uploaded_image in
  // main.rs -- it owns the whole file-pick + read + OCR step, since keeping
  // the file read on the Rust side means the raw file never has to cross
  // into JS at all), then drops the recognized text into the Input box --
  // editable from there, same as if it had been typed/pasted, so OCR
  // mistakes (more likely on a photo than a clean screenshot) can be fixed
  // before running a transform. The image is never written to disk/DB, but
  // (2026-08-05) it *is* now held in memory here as screenshotSource, so it
  // can be shown in the same "From a screenshot" preview card and expand
  // the same way a real screenshot's does -- previously this card only
  // showed up for the screenshot-panel entry point, so an uploaded image's
  // OCR'd text looked like anonymous pasted text with nothing to click on.
  async function uploadImage() {
    setImageError(null);
    setImageLoading(true);
    try {
      const picked = await invoke<{
        text: string;
        thumb_data_uri: string;
        full_data_uri: string;
        width: number;
        height: number;
      } | null>("ocr_uploaded_image");
      if (picked === null) return; // user cancelled the dialog
      if (!picked.text.trim()) {
        setImageError("Couldn't find any text in that image.");
        return;
      }
      setInput(picked.text);
      setResult(null);
      setScreenshotSource({
        thumb_data_uri: picked.thumb_data_uri,
        full_data_uri: picked.full_data_uri,
        width: picked.width,
        height: picked.height,
      });
    } catch (e) {
      setImageError(typeof e === "string" ? e : "Couldn't read text from that image.");
    } finally {
      setImageLoading(false);
    }
  }

  // Generic now (2026-07-27) -- used by the main Output box's Copy button
  // *and* each Recent-list row's own Copy button, not just the current
  // result, so past runs don't need to be reloaded into the main view just
  // to grab their text.
  async function copyText(text: string, target: ActionTarget) {
    // copy_to_clipboard, not paste_text -- this tab has no "hand control
    // back to whatever app was focused" moment the way the docked panel's
    // row actions do (see the same reasoning on Dashboard.tsx's copy
    // button), the user is actively looking at this window.
    await invoke("copy_to_clipboard", { text });
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget((cur) => (cur === target ? null : cur)), 1600);
  }

  function openFolderPickerAt(el: HTMLElement, content: string, target: ActionTarget) {
    const r = el.getBoundingClientRect();
    setFolderPickerPos(clampMenuPosition(r.bottom + 4, r.right - 192, 192));
    setPendingSave({ content, target });
  }

  async function confirmSaveToFolder(folderId: number) {
    if (!pendingSave) return;
    await invoke("add_to_folder", { folderId, content: pendingSave.content, title: null });
    setFolderPickerPos(null);
    setSavedTarget(pendingSave.target);
    setTimeout(() => setSavedTarget((cur) => (cur === pendingSave.target ? null : cur)), 1600);
    setPendingSave(null);
  }

  function loadLogEntry(entry: TransformLogEntry) {
    setInput(entry.input);
    setInstruction(entry.instruction);
    setResult(entry.output);
    setError(null);
    // Past runs aren't logged with any image reference, so any screenshot
    // preview currently showing would be stale/wrong for this entry.
    setScreenshotSource(null);
  }

  async function deleteLogEntry(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    setLog((cur) => cur.filter((l) => l.id !== id));
    await invoke("delete_transform_log_entry", { id });
  }

  if (tier !== "pro") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2.5">
        <i className="ti ti-sparkles text-[26px] text-accent dark:text-accentDark" />
        <p className="text-[13px] font-medium">AI Transform is a Pro feature</p>
        <p className="text-[12px] text-inkMuted dark:text-inkMutedDark max-w-[220px]">
          Paste in anything -- an email, a paragraph you found online, whatever -- and run it
          through a prompt without saving it first. Upgrade to Pro to turn it on.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 pt-2.5 pb-3 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
              Input
            </p>
            {/* Pick a picture with text in it (a photo, a scan, whatever) and
                its recognized text lands here instead -- same idea as
                Screenshots' OCR, just fed from an arbitrary file instead of
                a captured screenshot. A native dialog rather than
                drag-and-drop -- see uploadImage's doc comment for why. */}
            <button
              onClick={uploadImage}
              disabled={imageLoading}
              title="Upload a picture to extract its text"
              className="flex items-center gap-1 text-[10px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors disabled:opacity-50"
            >
              <i className="ti ti-photo-up text-[11px]" />
              <span>{imageLoading ? "Reading image…" : "Upload image"}</span>
            </button>
          </div>
          {/* Shown when this Input came from a screenshot's OCR'd text
              (2026-08-03) -- without this, jumping here from Screenshots'
              Transform action looked identical to freeform pasted text, no
              visual link back to the actual screenshot at all. Dismissible
              since it's just context, not something tied to a live value --
              if the text is edited from here on out it's just text. */}
          {screenshotSource && (
            <div className="flex items-center gap-2 mb-1.5 bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2 py-1.5">
              <button
                onClick={openScreenshotPreview}
                title="Click to expand"
                className="group relative shrink-0"
              >
                <img
                  src={screenshotSource.thumb_data_uri}
                  alt=""
                  className="w-12 h-8 rounded-md object-cover bg-black/[0.05] dark:bg-white/[0.08]"
                  draggable={false}
                />
                <div className="absolute inset-0 rounded-md flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                  <i className="ti ti-zoom-in text-white text-[12px] opacity-0 group-hover:opacity-90 transition-opacity" />
                </div>
              </button>
              <p className="flex-1 min-w-0 text-[11px] text-inkMuted dark:text-inkMutedDark">
                {screenshotSource.screenshot_id != null ? "From a screenshot" : "From an uploaded image"} (
                {screenshotSource.width}×{screenshotSource.height})
              </p>
              <button
                onClick={() => setScreenshotSource(null)}
                title="Dismiss"
                className="shrink-0 text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
              >
                <i className="ti ti-x text-[12px]" />
              </button>
            </div>
          )}
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Paste or type text to transform…"
              rows={7}
              className="w-full resize-none bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-2 text-[13px] outline-none"
            />
          </div>
          {imageError && (
            <p className="text-[11px] text-red-600 dark:text-red-300 mt-1">{imageError}</p>
          )}
        </div>

        {/* Instruction now lives in its own bordered box (2026-07-27), same
            treatment as Input/Output, instead of just floating loose chips
            + an input field with no container -- reads as a third,
            equally-weighted step instead of a looser afterthought between
            the two boxes. Not shy about height here either: presets can wrap
            to several rows and that's fine, the Recent list below is always
            reachable by scrolling. */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
              Instruction
            </p>
            <button
              onClick={onManagePresets}
              title="Choose which presets show up here"
              className="flex items-center gap-1 text-[10px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
            >
              <span>
                {visibleCount}/{MAX_VISIBLE_PRESETS} presets
              </span>
              <i className="ti ti-settings text-[10px]" />
            </button>
          </div>

          <div className="bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-2.5 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {visibleBuiltins.map((p) => (
                <button
                  key={p}
                  disabled={loading || !input.trim()}
                  onClick={() => {
                    setInstruction(p);
                    run(p);
                  }}
                  className={`text-[11px] px-2 py-1 rounded-md transition-colors disabled:opacity-40 ${
                    instruction === p
                      ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream"
                      : "bg-accent/10 dark:bg-accentDark/15 text-ink dark:text-cream hover:bg-accent/20 dark:hover:bg-accentDark/25"
                  }`}
                >
                  {p}
                </button>
              ))}
              {visibleCustomPresets.map((p) => (
                <div key={p.label} className="group relative">
                  <button
                    disabled={loading || !input.trim()}
                    onClick={() => {
                      setInstruction(p.instruction);
                      run(p.instruction);
                    }}
                    title={p.instruction}
                    className={`text-[11px] pl-2 pr-5 py-1 rounded-md transition-colors disabled:opacity-40 ${
                      instruction === p.instruction
                        ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream"
                        : "bg-accent/10 dark:bg-accentDark/15 text-ink dark:text-cream hover:bg-accent/20 dark:hover:bg-accentDark/25"
                    }`}
                  >
                    <i className="ti ti-bookmark text-[9px] mr-1 opacity-60" />
                    <span className="inline-block align-middle max-w-[140px] truncate">{p.label}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setDeleteConfirmPos(clampMenuPosition(r.bottom + 4, r.right - 224, 224, 100));
                      setDeleteConfirmLabel(p.label);
                    }}
                    title="Delete preset"
                    className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:!text-red-500 dark:hover:!text-red-400 transition-opacity"
                  >
                    <i className="ti ti-trash text-[10px]" />
                  </button>
                </div>
              ))}
            </div>

            {/* Separated from the chip row above with its own divider and
                label (2026-08-03) -- previously the free-text field sat
                right under the chips with no visual break, and clicking a
                chip echoed its label into this same box, which read as one
                crowded, slightly redundant block instead of two distinct
                ways to give an instruction ("pick a preset" vs. "write your
                own"). Run/Save moved to their own row below (same change
                just made in TransformBar) instead of squeezed onto the
                input's line. */}
            <div className="pt-2 border-t border-borderLight dark:border-borderDark">
              <p className="text-[10px] text-inkMuted dark:text-inkMutedDark mb-1.5">Or write your own</p>
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") run(instruction);
                }}
                placeholder="Type an instruction…"
                className="w-full bg-cream dark:bg-charcoal border border-accent/20 dark:border-accentDark/20 text-ink dark:text-cream rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                disabled={loading}
              />
              <div className="flex gap-1.5 mt-1.5">
                <button
                  onClick={() => run(instruction)}
                  disabled={loading || !input.trim() || !instruction.trim()}
                  className="flex-1 text-[11px] py-1.5 rounded-lg bg-accent/15 dark:bg-accentDark/20 disabled:opacity-40"
                >
                  Run
                </button>
                <button
                  onClick={startSavingPreset}
                  disabled={loading || !instruction.trim()}
                  title="Save as a reusable preset"
                  className="px-2.5 rounded-lg bg-accent/10 dark:bg-accentDark/15 disabled:opacity-30 hover:bg-accent/20 dark:hover:bg-accentDark/25 transition-colors"
                >
                  <i className="ti ti-device-floppy text-[13px]" />
                </button>
              </div>
            </div>

            {namingPreset && (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={presetLabel}
                  onChange={(e) => setPresetLabel(e.target.value.slice(0, MAX_PRESET_LABEL_LENGTH))}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") confirmSavePreset();
                    if (e.key === "Escape") setNamingPreset(false);
                  }}
                  maxLength={MAX_PRESET_LABEL_LENGTH}
                  placeholder="Name this preset…"
                  className="flex-1 bg-cream dark:bg-charcoal border border-accent/20 dark:border-accentDark/20 text-ink dark:text-cream rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                />
                <button
                  onClick={confirmSavePreset}
                  disabled={!presetLabel.trim()}
                  className="text-[11px] px-2.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal disabled:opacity-40"
                >
                  <i className="ti ti-check text-[12px]" />
                </button>
                <button
                  onClick={() => setNamingPreset(false)}
                  className="text-[11px] px-2.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08]"
                >
                  <i className="ti ti-x text-[12px]" />
                </button>
              </div>
            )}

            {loading && <p className="text-[11px] text-inkMuted dark:text-inkMutedDark">Transforming…</p>}
            {error && <p className="text-[11px] text-red-600 dark:text-red-300">{error}</p>}
          </div>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Output
          </p>
          {result !== null && !loading ? (
            <>
              <p className="text-[12.5px] leading-snug whitespace-pre-wrap break-words bg-accentFill dark:bg-accentFillDark border border-accent/20 dark:border-accentDark/20 rounded-lg px-2.5 py-2 mb-1.5 max-h-72 overflow-y-auto">
                {result}
              </p>
              {/* Icons live below the result box, not in its header --
                  Copy / Save to folder / Retry, in that order. */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => copyText(result, "main")}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal text-[12px] font-medium py-1.5"
                >
                  <i className={copiedTarget === "main" ? "ti ti-check text-[13px]" : "ti ti-copy text-[13px]"} />
                  {copiedTarget === "main" ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={(e) => openFolderPickerAt(e.currentTarget, result, "main")}
                  title="Save to folder"
                  className="flex items-center justify-center gap-1.5 rounded-lg bg-accent/10 dark:bg-accentDark/15 text-[12px] px-3 py-1.5 hover:bg-accent/20 dark:hover:bg-accentDark/25 transition-colors"
                >
                  <i className={savedTarget === "main" ? "ti ti-check text-[13px]" : "ti ti-folder-plus text-[13px]"} />
                  {savedTarget === "main" ? "Saved" : "Save"}
                </button>
                <button
                  onClick={() => run(instruction)}
                  disabled={loading || !instruction.trim()}
                  title="Run again"
                  className="flex items-center justify-center rounded-lg bg-black/[0.05] dark:bg-white/[0.08] px-3 py-1.5 disabled:opacity-40 hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors"
                >
                  <i className="ti ti-refresh text-[13px]" />
                </button>
              </div>
            </>
          ) : (
            <p className="text-[12px] leading-snug text-inkMuted dark:text-inkMutedDark bg-black/[0.03] dark:bg-white/[0.05] border border-dashed border-borderLight dark:border-borderDark rounded-lg px-2.5 py-2 min-h-[2.25rem] flex items-center">
              {loading ? "Transforming…" : "Result will appear here"}
            </p>
          )}
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Recent
          </p>
          {log.length === 0 ? (
            <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
              Nothing yet — run a transform above and it'll show up here.
            </p>
          ) : (
            <div className="rounded-2xl bg-creamSurface/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden">
              {log.map((entry, idx) => (
                <div key={entry.id}>
                  {/* A wrapping div (not a button) here, with the action
                      buttons as siblings rather than nested inside --
                      buttons can't legally contain buttons, and browsers
                      "fix" that by breaking the DOM apart in ways that make
                      clicks land unpredictably. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => loadLogEntry(entry)}
                    className="group w-full text-left px-3 py-2 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors flex items-start gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium text-accent dark:text-accentDark truncate">
                        {entry.instruction}
                      </p>
                      <p className="text-[12px] leading-snug truncate">{entry.output}</p>
                      <p className="text-[10px] text-inkMuted dark:text-inkMutedDark mt-0.5">
                        {formatTimestamp(entry.created_at)}
                      </p>
                    </div>
                    {/* Copy / Save to folder / remove -- same actions as the
                        main Output box, added 2026-07-27 so a past run can
                        be filed into a folder (or copied) directly from
                        here, without first reloading it into the main view
                        above just to get at those buttons. */}
                    <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyText(entry.output, entry.id);
                        }}
                        title="Copy"
                        className="p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
                      >
                        <i className={copiedTarget === entry.id ? "ti ti-check text-[12px]" : "ti ti-copy text-[12px]"} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openFolderPickerAt(e.currentTarget, entry.output, entry.id);
                        }}
                        title="Save to folder"
                        className="p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
                      >
                        <i className={savedTarget === entry.id ? "ti ti-check text-[12px]" : "ti ti-folder-plus text-[12px]"} />
                      </button>
                      <button
                        onClick={(e) => deleteLogEntry(e, entry.id)}
                        title="Remove from recent"
                        className="p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark hover:!text-red-500 dark:hover:!text-red-400 transition-colors"
                      >
                        <i className="ti ti-trash text-[12px]" />
                      </button>
                    </div>
                  </div>
                  {idx !== log.length - 1 && (
                    <div className="mx-3 border-b border-black/[0.05] dark:border-white/[0.07]" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {folderPickerPos &&
        createPortal(
          <FolderPicker
            position={folderPickerPos}
            onClose={() => {
              setFolderPickerPos(null);
              setPendingSave(null);
            }}
            onAdd={confirmSaveToFolder}
            onOpenFolder={(folderId) => {
              setFolderPickerPos(null);
              setPendingSave(null);
              onOpenFolder(folderId);
            }}
            onCreateNewFolder={() => {
              setFolderPickerPos(null);
              setPendingSave(null);
              onCreateNewFolder();
            }}
          />,
          document.body
        )}

      {/* Full-size view of the screenshot preview above Input, opened by
          clicking its thumbnail -- same fullscreen-over-black layout as
          ScreenshotsPanel's own preview modal, just without a Paste button
          (this tab isn't about re-pasting the screenshot, only seeing it). */}
      {previewOpen &&
        screenshotSource &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] bg-black/75 flex flex-col items-center justify-center p-6 gap-3"
            onClick={closeScreenshotPreview}
          >
            <div className="text-white/90 text-[12px]" onClick={(e) => e.stopPropagation()}>
              {screenshotSource.width}×{screenshotSource.height}
            </div>
            <div
              className="max-w-full max-h-[70vh] flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {previewError ? (
                <p className="text-white/80 text-[13px]">Couldn't load this screenshot.</p>
              ) : previewSrc ? (
                <img
                  src={previewSrc}
                  alt=""
                  className="max-w-full max-h-[70vh] rounded-lg shadow-2xl object-contain"
                  draggable={false}
                />
              ) : (
                <p className="text-white/70 text-[13px]">Loading…</p>
              )}
            </div>
            <button
              onClick={closeScreenshotPreview}
              className="rounded-lg bg-white text-charcoal text-[12.5px] font-medium px-4 py-2"
            >
              Close
            </button>
          </div>,
          document.body
        )}

      {deleteConfirmLabel &&
        deleteConfirmPos &&
        createPortal(
          <ConfirmPopover
            position={deleteConfirmPos}
            message={`Delete the "${deleteConfirmLabel}" preset? This can't be undone.`}
            onCancel={() => setDeleteConfirmLabel(null)}
            onConfirm={() => {
              deletePreset(deleteConfirmLabel);
              setDeleteConfirmLabel(null);
            }}
          />,
          document.body
        )}
    </div>
  );
}
