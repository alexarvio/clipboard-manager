import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Settings {
  hotkey: string;
  max_history: number;
  launch_at_startup: boolean;
  theme: "dark" | "light";
  server_url: string;
  app_secret: string;
  tier: "free" | "pro";
}

export default function SettingsPanel({
  onClose,
  onThemeChange,
  onTierChange,
}: {
  onClose: () => void;
  onThemeChange?: (theme: "dark" | "light") => void;
  onTierChange?: (tier: "free" | "pro") => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings").then(setSettings).catch(console.error);
  }, []);

  async function update(partial: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...partial };
    setSettings(next);
    if (partial.theme) onThemeChange?.(partial.theme);
    if (partial.tier) onTierChange?.(partial.tier);
    await invoke("save_settings", { settings: next });
  }

  if (!settings)
    return (
      <div className="p-4 text-inkMuted dark:text-inkMutedDark text-sm">Loading…</div>
    );

  return (
    <div
      onKeyDown={(e) => e.stopPropagation()}
      className="flex-1 overflow-y-auto px-4 py-4 text-sm space-y-5 text-ink dark:text-cream"
    >
      <div>
        <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">
          Global hotkey
        </label>
        <input
          value={settings.hotkey}
          onChange={(e) => update({ hotkey: e.target.value })}
          className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 outline-none"
          placeholder="Ctrl+Shift+V"
        />
        <p className="text-inkMuted dark:text-inkMutedDark text-xs mt-1 opacity-70">
          Restart the app after changing this for now (live re-registration is a v1.1 TODO).
        </p>
      </div>

      <div>
        <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">
          History limit
        </label>
        <p className="text-[13px]">
          {settings.tier === "pro" ? "Unlimited" : "50 items or 7 days, whichever comes first"}
        </p>
        <p className="text-inkMuted dark:text-inkMutedDark text-xs mt-1 opacity-70">
          {settings.tier === "pro"
            ? "Pro has no history cap."
            : "Fixed by plan, not editable — upgrade to Pro for unlimited history."}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span>Launch at startup</span>
        <input
          type="checkbox"
          checked={settings.launch_at_startup}
          onChange={(e) => update({ launch_at_startup: e.target.checked })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span>Theme</span>
        <select
          value={settings.theme}
          onChange={(e) => update({ theme: e.target.value as "dark" | "light" })}
          className="bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2 py-1"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>

      <div className="border-t border-borderLight dark:border-borderDark pt-4">
        <div className="flex items-center justify-between mb-1">
          <span>Plan (dev only)</span>
          <select
            value={settings.tier}
            onChange={(e) => update({ tier: e.target.value as "free" | "pro" })}
            className="bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2 py-1"
          >
            <option value="free">Free</option>
            <option value="pro">Pro</option>
          </select>
        </div>
        <p className="text-inkMuted dark:text-inkMutedDark text-xs opacity-70">
          No real billing exists yet — this just flips the flag that gates AI transform, for testing.
        </p>
      </div>

      <div className="border-t border-borderLight dark:border-borderDark pt-4">
        <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-3">
          AI transform (beta) — these point the app at your own backend. See
          server/README.md for how to run one.
        </p>
        <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">
          Server URL
        </label>
        <input
          value={settings.server_url}
          onChange={(e) => update({ server_url: e.target.value })}
          className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 outline-none"
          placeholder="http://localhost:8787"
        />
      </div>

      <div>
        <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">
          Server shared secret (only needed once deployed)
        </label>
        <input
          type="password"
          value={settings.app_secret}
          onChange={(e) => update({ app_secret: e.target.value })}
          className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 outline-none"
          placeholder="leave blank for local dev"
        />
      </div>

      <button
        onClick={onClose}
        className="w-full mt-4 bg-accent/15 dark:bg-accentDark/20 hover:bg-accent/25 dark:hover:bg-accentDark/30 transition-colors rounded-lg py-2"
      >
        Done
      </button>
    </div>
  );
}
