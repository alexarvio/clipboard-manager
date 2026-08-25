import { useEffect, useState } from "react";
import { invoke } from "../lib/tauriShim";

// Mirrors src-tauri/src/settings.rs::Settings closely enough for what this
// screen reads and writes back.
interface OnboardingSettings {
  hotkey: string;
  theme: "dark" | "light";
  launch_at_startup: boolean;
  onboarding_complete: boolean;
  [key: string]: unknown;
}

const TOTAL_STEPS = 4;
// The last step is always the practical setup step (hotkey/theme/launch at
// startup) -- kept as a constant rather than a hardcoded "2"/"3" scattered
// through this file so adding or removing a feature-highlight step (like
// the search/organize step below, added 2026-08-25) only ever means
// touching TOTAL_STEPS and the step===N block itself, not every place that
// used to assume "setup is step 2".
const SETUP_STEP = TOTAL_STEPS - 1;

// Shown exactly once per device, right after AuthGate's onAuthenticated
// fires (see App.tsx/Dashboard.tsx, gated on settings.onboarding_complete).
// Mixes a few quick feature-highlight steps -- one per headline feature
// from the marketing site (auto-save, organize + search, AI transform) --
// with one practical setup step (hotkey, theme, launch at startup) -- the
// setup step is the one part of this that's actually useful to revisit, so
// "Skip tour" jumps straight to it rather than skipping past it too.
export default function Onboarding({ onDone }: { onDone: (theme: "dark" | "light") => void }) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<OnboardingSettings | null>(null);
  const [hotkey, setHotkey] = useState("Ctrl+Shift+V");
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<OnboardingSettings>("get_settings")
      .then((s) => {
        setSettings(s);
        setHotkey(s.hotkey);
        setTheme(s.theme);
        setLaunchAtStartup(s.launch_at_startup);
      })
      .catch(console.error);
  }, []);

  // The setup step lets you preview the theme choice live, same as the rest
  // of the app -- toggling the root .dark class here just mirrors what
  // App.tsx/Dashboard.tsx already do off of the theme setting.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  async function finish() {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const next: OnboardingSettings = {
        ...settings,
        hotkey: hotkey.trim() || settings.hotkey,
        theme,
        launch_at_startup: launchAtStartup,
        onboarding_complete: true,
      };
      await invoke("save_settings", { settings: next });
      onDone(theme);
    } catch (err) {
      console.error(err);
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col px-6 py-8 text-ink dark:text-cream">
      <div className="flex items-center justify-center relative mb-8">
        {step > 0 && (
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="absolute left-0 text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
            aria-label="Back"
          >
            <i className="ti ti-chevron-left text-[16px]" />
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-accent dark:bg-accentDark" : "w-1.5 bg-black/[0.12] dark:bg-white/[0.15]"
              }`}
            />
          ))}
        </div>
        {step < SETUP_STEP && (
          <button
            onClick={() => setStep(SETUP_STEP)}
            className="absolute right-0 text-[12px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
          >
            Skip
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center">
        {step === 0 && (
          <>
            <i className="ti ti-history text-[32px] text-accent dark:text-accentDark mb-4" />
            <h1 className="text-[17px] font-semibold mb-2">Everything you copy, remembered</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark max-w-[260px]">
              Clip saves what you copy automatically -- sorted by date and category -- so nothing gets lost the
              moment you copy something else.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <i className="ti ti-search text-[32px] text-accent dark:text-accentDark mb-4" />
            <h1 className="text-[17px] font-semibold mb-2">Organize it, then find it instantly</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark max-w-[260px]">
              Pin your most-used snippets and sort recurring text into folders. Search finds anything by keyword or
              by meaning, even the text inside a screenshot.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <i className="ti ti-wand text-[32px] text-accent dark:text-accentDark mb-4" />
            <h1 className="text-[17px] font-semibold mb-2">Rewrite, summarize, or translate</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark max-w-[260px]">
              Select any saved clip and transform it with AI right from the panel -- fix grammar, change tone, or
              translate on the spot.
            </p>
          </>
        )}

        {step === SETUP_STEP && (
          <div className="w-full max-w-[280px] text-left">
            <h1 className="text-[17px] font-semibold mb-1 text-center">Make it yours</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark mb-6 text-center">
              A couple of quick settings -- you can always change these later.
            </p>

            <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">Global hotkey</label>
            <input
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              placeholder="Ctrl+Shift+V"
              className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 text-[13px] outline-none mb-4"
            />

            <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">Theme</label>
            <div className="flex bg-black/[0.05] dark:bg-white/[0.07] rounded-full p-1 mb-4 text-[12.5px] font-medium">
              <button
                type="button"
                onClick={() => setTheme("light")}
                className={`flex-1 py-1.5 rounded-full transition-colors ${
                  theme === "light"
                    ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark"
                    : "text-inkMuted dark:text-inkMutedDark"
                }`}
              >
                Light
              </button>
              <button
                type="button"
                onClick={() => setTheme("dark")}
                className={`flex-1 py-1.5 rounded-full transition-colors ${
                  theme === "dark"
                    ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark"
                    : "text-inkMuted dark:text-inkMutedDark"
                }`}
              >
                Dark
              </button>
            </div>

            <label className="flex items-center justify-between mb-6">
              <span className="text-[13px]">Launch at startup</span>
              <input
                type="checkbox"
                checked={launchAtStartup}
                onChange={(e) => setLaunchAtStartup(e.target.checked)}
                className="w-4 h-4 accent-accent dark:accent-accentDark"
              />
            </label>

            <button
              onClick={finish}
              disabled={saving || !settings}
              className="w-full bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium disabled:opacity-50"
            >
              {saving ? "Getting started…" : "Get started"}
            </button>
          </div>
        )}
      </div>

      {step < SETUP_STEP && (
        <div className="flex justify-end mt-6">
          <button
            onClick={() => setStep((s) => s + 1)}
            className="flex items-center gap-1 text-[12.5px] font-medium bg-ink dark:bg-cream text-cream dark:text-charcoal px-4 py-2 rounded-lg"
          >
            Next
            <i className="ti ti-arrow-right text-[13px]" />
          </button>
        </div>
      )}
    </div>
  );
}
