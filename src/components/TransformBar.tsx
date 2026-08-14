import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../lib/tauriShim";
import {
  DEFAULT_SCREENSHOT_PRESETS,
  TEXT_ELIGIBLE_PRESETS,
  MAX_VISIBLE_PRESETS,
  MAX_PRESET_LABEL_LENGTH,
} from "../lib/presets";
import ClampedText from "./ClampedText";
import ConfirmPopover from "./ConfirmPopover";
import { clampMenuPosition } from "../lib/menuPosition";

interface CustomPreset {
  label: string;
  instruction: string;
}

// Mirrors src-tauri/src/settings.rs::Settings. Only the fields TransformBar
// actually touches are typed here, but get/save_settings round-trip the
// *whole* object, so we still need to carry every field through untouched
// (see loadedSettings below) rather than constructing a partial one.
interface Settings {
  custom_presets: CustomPreset[];
  // Screenshots' own fully separate custom-preset pool (2026-08-06 split) --
  // see the matching field's doc comment on settings.rs::Settings. Only
  // read/written when `context === "screenshot"` (see Props), same as
  // visible_presets_screenshots below.
  custom_presets_screenshots?: CustomPreset[];
  // Which preset labels (builtin instruction text or custom preset label)
  // are actually shown as buttons here -- capped at MAX_VISIBLE_PRESETS (see
  // lib/presets.ts). Missing on settings saved before this existed, which
  // defaults to "every builtin visible, no customs" -- i.e. exactly what
  // everyone already saw before this was configurable.
  visible_presets?: string[];
  // Same idea, but for the Screenshots Transform panel -- kept as a
  // separate list (see settings.rs's own comment on this field) since which
  // presets make sense differs between copied text and OCR'd screenshot
  // text. Only read/written when `context === "screenshot"` (see Props).
  visible_presets_screenshots?: string[];
  [key: string]: unknown;
}

interface Props {
  content: string;
  onDone: () => void; // called after the user pastes the result, to close + hide panel
  onCancel: () => void;
  // Jumps the user to Settings -> Presets so they can change which chips
  // show up here, instead of trying to manage the picking logic inline.
  onManagePresets?: () => void;
  // Which of the two independent "which presets are visible" lists to read/
  // write -- "text" for clip history (the original, default behavior) and
  // "screenshot" for ScreenshotsPanel's Transform action. The underlying
  // preset pool (builtins + custom_presets) is shared either way; only
  // visibility differs, per the 2026-07-31 decision to let presets be
  // chosen separately for screenshots vs. text.
  context?: "text" | "screenshot";
  // Hides the "Input" section below (default: shown). The History/
  // Screenshots/Folders panels all render their own preview of the item's
  // content in the space above this component now (see each panel's
  // transform overlay), which made this section a second, literal copy of
  // the exact same text a few pixels down -- pointless duplication once
  // there's already an unmissable preview above. Left on by default for any
  // caller (e.g. Dashboard's "Edit with AI") that doesn't show its own
  // preview above the panel.
  showInputPreview?: boolean;
}

// Renders as the contents of the dedicated bottom transform panel in
// App.tsx (see the wrapping motion.div there for the panel's own height/
// background/border styling). Laid out as three stacked stages -- source
// text, instruction, result -- so the user can see what they're
// transforming and what they got back before committing to a paste.
export default function TransformBar({
  content,
  onDone,
  onCancel,
  onManagePresets,
  context = "text",
  showInputPreview = true,
}: Props) {
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pasted, setPasted] = useState(false);
  const [loadedSettings, setLoadedSettings] = useState<Settings | null>(null);
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetLabel, setPresetLabel] = useState("");
  // Which custom preset's delete is currently being confirmed, if any --
  // see ConfirmPopover. Deleting used to happen straight off the trash
  // icon's click with no way back; this makes it a two-step action instead.
  const [deleteConfirmLabel, setDeleteConfirmLabel] = useState<string | null>(null);
  const [deleteConfirmPos, setDeleteConfirmPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) =>
        setLoadedSettings({
          ...s,
          custom_presets: s.custom_presets ?? [],
          custom_presets_screenshots: s.custom_presets_screenshots ?? [],
        })
      )
      .catch(console.error);
  }, []);

  // Which field of Settings holds the visibility list for this instance's
  // context -- see the two doc comments above (Settings.visible_presets and
  // .visible_presets_screenshots).
  const visibleField = context === "screenshot" ? "visible_presets_screenshots" : "visible_presets";
  // Empty (2026-08-13, was the eligible-builtins list) -- visibleField only
  // ever tracks *custom* preset selection now (built-ins are always shown,
  // see eligibleBuiltins below), so there's nothing to default it to
  // besides "no customs shown yet."
  const visibleFallback: string[] = [];
  // Which builtins apply to this context -- filtering against this (not the
  // full BUILTIN_PRESETS) means a chip like "Clean up OCR errors" can never
  // render for plain text (2026-08-03 fix). Always all of them now
  // (2026-08-13) -- built-ins are no longer optional/toggleable, so this is
  // rendered directly with no visibility filtering.
  const eligibleBuiltins = context === "screenshot" ? DEFAULT_SCREENSHOT_PRESETS : TEXT_ELIGIBLE_PRESETS;
  // Which custom-preset pool belongs to this instance's context -- fully
  // separate arrays as of 2026-08-06 (see custom_presets_screenshots's doc
  // comment above), mirroring visibleField's own context switch.
  const customField = context === "screenshot" ? "custom_presets_screenshots" : "custom_presets";

  const customPresets = loadedSettings?.[customField] ?? [];
  const visiblePresetLabels = new Set(loadedSettings?.[visibleField] ?? visibleFallback);
  const visibleBuiltins = eligibleBuiltins;
  const visibleCustomPresets = customPresets.filter((p) => visiblePresetLabels.has(p.label));

  function startSavingPreset() {
    if (!instruction.trim()) return;
    setPresetLabel(instruction.trim().slice(0, MAX_PRESET_LABEL_LENGTH));
    setNamingPreset(true);
  }

  async function confirmSavePreset() {
    const label = presetLabel.trim();
    if (!label || !loadedSettings) return;
    // Auto-show the new preset if there's room under the cap -- saving one
    // and then not seeing it appear anywhere would be a confusing dead end.
    // If we're already at the cap, it's just saved hidden; the user can swap
    // it in from Settings -> Presets whenever they want. Only this
    // instance's own context list gets the new label added -- a preset
    // saved while transforming a screenshot shows up in Screenshots'
    // Transform panel, not text's, until manually enabled for both from
    // Settings.
    const currentVisible = loadedSettings[visibleField] ?? visibleFallback;
    const nextVisible =
      visibleCustomPresets.length < MAX_VISIBLE_PRESETS ? [...currentVisible, label] : currentVisible;
    const updated = {
      ...loadedSettings,
      [customField]: [...customPresets, { label, instruction: instruction.trim() }],
      [visibleField]: nextVisible,
    };
    setLoadedSettings(updated);
    await invoke("save_settings", { settings: updated });
    setNamingPreset(false);
    setPresetLabel("");
  }

  async function deletePreset(label: string) {
    if (!loadedSettings) return;
    // Scoped to this instance's own context -- custom presets are fully
    // separate pools per context now (2026-08-06), so deleting one here
    // only ever needs to touch this context's pool and visibility list, not
    // the other context's.
    const updated = {
      ...loadedSettings,
      [customField]: customPresets.filter((p) => p.label !== label),
      [visibleField]: (loadedSettings[visibleField] ?? visibleFallback).filter((l) => l !== label),
    };
    setLoadedSettings(updated);
    await invoke("save_settings", { settings: updated });
  }

  // `presetLabel` is only passed when this run came from clicking an actual
  // preset button (builtin or custom), not the freeform "type an
  // instruction" box -- see transform_clip's own doc comment in main.rs for
  // why that distinction matters (it's what "top presets" on Dashboard
  // counts).
  async function run(finalInstruction: string, presetLabel?: string) {
    if (!finalInstruction.trim() || loading) return;
    setLoading(true);
    setError(null);
    setPasted(false);
    try {
      const transformed = await invoke<string>("transform_clip", {
        content,
        instruction: finalInstruction,
        presetLabel: presetLabel ?? null,
      });
      setResult(transformed);
    } catch (e) {
      setError(typeof e === "string" ? e : "Transform failed. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  async function pasteResult() {
    if (!result) return;
    await invoke("paste_text", { text: result });
    setPasted(true);
    setTimeout(onDone, 280);
  }

  return (
    <div onClick={(e) => e.stopPropagation()} className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-borderLight/60 dark:border-borderDark/60 shrink-0">
        <i className="ti ti-sparkles text-[13px] text-accent dark:text-accentDark" />
        <span className="text-[12px] font-medium">Transform</span>
        <button
          onClick={onCancel}
          title="Close"
          className="ml-auto text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors shrink-0"
        >
          <i className="ti ti-x text-[14px]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-3">
        {showInputPreview && (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
              Input
            </p>
            <div className="bg-black/[0.03] dark:bg-white/[0.05] rounded-lg px-2.5 py-2">
              <ClampedText
                text={content}
                lines={3}
                className="text-[12px] leading-snug whitespace-pre-wrap break-words"
              />
            </div>
          </div>
        )}

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
                {visibleCustomPresets.length}/{MAX_VISIBLE_PRESETS} custom
              </span>
              <i className="ti ti-settings text-[10px]" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {visibleBuiltins.map((p) => (
              <button
                key={p}
                disabled={loading}
                onClick={() => {
                  setInstruction(p);
                  run(p, p);
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
                  disabled={loading}
                  onClick={() => {
                    setInstruction(p.instruction);
                    run(p.instruction, p.label);
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
          {/* Grown from a single-line input into a multi-line textarea
              (2026-08-03) -- now that the transform panel takes over the
              full view (see App.tsx/ScreenshotsPanel/FoldersPanel's overlay
              comments), there's a lot of vertical room that used to sit
              empty below a one-line box. Fixed at a taller rows count
              regardless of how much text is actually in it, rather than
              auto-growing, so the layout doesn't jump around as you type --
              it's sized for "there's space, use it," not for the current
              instruction's length. Enter still runs (matches the old
              input's behavior so short instructions aren't slowed down);
              Shift+Enter inserts a newline for anyone writing a longer,
              multi-step instruction. */}
          <textarea
            autoFocus
            rows={5}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              // Stop these from bubbling up to the panel's own keydown
              // handler, which would otherwise also treat Enter as "paste
              // selected item" and Escape as "hide the whole panel".
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                run(instruction);
              }
              if (e.key === "Escape") onCancel();
            }}
            placeholder="Or type your own instruction…"
            className="w-full bg-accent/10 dark:bg-accentDark/15 border border-accent/20 dark:border-accentDark/20 text-ink dark:text-cream rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
            disabled={loading}
          />
          <div className="flex gap-1.5 mt-1.5">
            <button
              onClick={() => run(instruction)}
              disabled={loading}
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
          {namingPreset && (
            <div className="flex gap-1.5 mt-1.5">
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
                className="flex-1 bg-accent/10 dark:bg-accentDark/15 border border-accent/20 dark:border-accentDark/20 text-ink dark:text-cream rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
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
          {loading && <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mt-1">Transforming…</p>}
          {error && <p className="text-[11px] text-red-600 dark:text-red-300 mt-1">{error}</p>}
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Output
          </p>
          {result !== null && !loading ? (
            <>
              <p className="text-[12.5px] leading-snug whitespace-pre-wrap break-words bg-accentFill dark:bg-accentFillDark border border-accent/20 dark:border-accentDark/20 rounded-lg px-2.5 py-2 mb-1.5 max-h-24 overflow-y-auto">
                {result}
              </p>
              <button
                onClick={pasteResult}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal text-[12px] font-medium py-1.5"
              >
                <i className={pasted ? "ti ti-check text-[13px]" : "ti ti-copy text-[13px]"} />
                {pasted ? "Pasted" : "Copy & paste"}
              </button>
            </>
          ) : (
            <p className="text-[12px] leading-snug text-inkMuted dark:text-inkMutedDark bg-black/[0.03] dark:bg-white/[0.05] border border-dashed border-borderLight dark:border-borderDark rounded-lg px-2.5 py-2 min-h-[2.25rem] flex items-center">
              {loading ? "Transforming…" : "Result will appear here"}
            </p>
          )}
        </div>
      </div>

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
