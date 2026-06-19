import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const PRESETS = [
  "Fix grammar",
  "Make formal",
  "Make casual",
  "Summarize",
  "To bullet points",
  "Translate to Spanish",
];

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
  [key: string]: unknown;
}

interface Props {
  content: string;
  onDone: () => void; // called after the user pastes the result, to close + hide panel
  onCancel: () => void;
}

// Renders as the contents of the dedicated bottom transform panel in
// App.tsx (see the wrapping motion.div there for the panel's own height/
// background/border styling). Laid out as three stacked stages -- source
// text, instruction, result -- so the user can see what they're
// transforming and what they got back before committing to a paste.
export default function TransformBar({ content, onDone, onCancel }: Props) {
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pasted, setPasted] = useState(false);
  const [loadedSettings, setLoadedSettings] = useState<Settings | null>(null);
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetLabel, setPresetLabel] = useState("");

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => setLoadedSettings({ ...s, custom_presets: s.custom_presets ?? [] }))
      .catch(console.error);
  }, []);

  const customPresets = loadedSettings?.custom_presets ?? [];

  async function persistPresets(next: CustomPreset[]) {
    if (!loadedSettings) return;
    const updated = { ...loadedSettings, custom_presets: next };
    setLoadedSettings(updated);
    await invoke("save_settings", { settings: updated });
  }

  function startSavingPreset() {
    if (!instruction.trim()) return;
    setPresetLabel(instruction.trim().slice(0, 40));
    setNamingPreset(true);
  }

  async function confirmSavePreset() {
    const label = presetLabel.trim();
    if (!label) return;
    await persistPresets([...customPresets, { label, instruction: instruction.trim() }]);
    setNamingPreset(false);
    setPresetLabel("");
  }

  async function deletePreset(label: string) {
    await persistPresets(customPresets.filter((p) => p.label !== label));
  }

  async function run(finalInstruction: string) {
    if (!finalInstruction.trim() || loading) return;
    setLoading(true);
    setError(null);
    setPasted(false);
    try {
      const transformed = await invoke<string>("transform_clip", {
        content,
        instruction: finalInstruction,
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
        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Input
          </p>
          <p className="text-[12px] leading-snug whitespace-pre-wrap break-words line-clamp-3 bg-black/[0.03] dark:bg-white/[0.05] rounded-lg px-2.5 py-2">
            {content}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Instruction
          </p>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                disabled={loading}
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
            {customPresets.map((p) => (
              <div key={p.label} className="group relative">
                <button
                  disabled={loading}
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
                  {p.label}
                </button>
                <button
                  onClick={() => deletePreset(p.label)}
                  title="Delete preset"
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
                >
                  <i className="ti ti-x text-[10px]" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                // Stop these from bubbling up to the panel's own keydown
                // handler, which would otherwise also treat Enter as "paste
                // selected item" and Escape as "hide the whole panel".
                e.stopPropagation();
                if (e.key === "Enter") run(instruction);
                if (e.key === "Escape") onCancel();
              }}
              placeholder="Or type your own instruction…"
              className="flex-1 bg-accent/10 dark:bg-accentDark/15 border border-accent/20 dark:border-accentDark/20 text-ink dark:text-cream rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
              disabled={loading}
            />
            <button
              onClick={() => run(instruction)}
              disabled={loading}
              className="text-[11px] px-2.5 rounded-lg bg-accent/15 dark:bg-accentDark/20 disabled:opacity-40"
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
                onChange={(e) => setPresetLabel(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") confirmSavePreset();
                  if (e.key === "Escape") setNamingPreset(false);
                }}
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
    </div>
  );
}
