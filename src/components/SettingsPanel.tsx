import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../lib/tauriShim";
import { ALL_CATEGORIES } from "../lib/categories";
import {
  BUILTIN_PRESETS,
  DEFAULT_SCREENSHOT_PRESETS,
  TEXT_ELIGIBLE_PRESETS,
  MAX_VISIBLE_PRESETS,
  MAX_PRESET_LABEL_LENGTH,
} from "../lib/presets";
import { clampMenuPosition } from "../lib/menuPosition";
import ConfirmPopover from "./ConfirmPopover";

interface CustomPreset {
  label: string;
  instruction: string;
}

interface CustomFilter {
  name: string;
  prompt: string;
}

interface Settings {
  hotkey: string;
  max_history: number;
  launch_at_startup: boolean;
  theme: "dark" | "light";
  server_url: string;
  app_secret: string;
  tier: "free" | "pro";
  visible_categories: string[];
  custom_presets: CustomPreset[];
  // Screenshots' own fully independent custom-preset pool (2026-08-06
  // split) -- see the matching field on settings.rs::Settings for why a
  // preset saved under Screenshots no longer shows up in Text's "Your
  // presets" list at all, not just unchecked there.
  custom_presets_screenshots: CustomPreset[];
  visible_presets: string[];
  // Screenshots' own independent "which presets show as chips" list -- see
  // the matching field on settings.rs::Settings for why this is separate
  // from visible_presets rather than shared.
  visible_presets_screenshots: string[];
  custom_filters: CustomFilter[];
  user_email: string;
  first_name: string;
}

// Small shared wrapper so every settings section reads as its own card --
// icon + title header, then whatever content the section needs -- instead
// of the previous flat list of fields separated only by hairline dividers.
// Purely presentational (2026-07-27 restructure); doesn't touch any of the
// state/update logic below.
function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark p-4">
      <div className="flex items-center gap-2 mb-1">
        <i className={`ti ${icon} text-accent dark:text-accentDark text-[15px]`} />
        <p className="text-[13px] font-medium">{title}</p>
      </div>
      {description && (
        <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-3 opacity-70">{description}</p>
      )}
      <div className={description ? "" : "mt-3"}>{children}</div>
    </div>
  );
}

export default function SettingsPanel({
  onClose,
  onThemeChange,
  onTierChange,
  onFirstNameChange,
  onVisibleCategoriesChange,
  scrollToPresets,
  onScrolledToPresets,
  initialPresetContext,
  onLoggedOut,
}: {
  onClose: () => void;
  onThemeChange?: (theme: "dark" | "light") => void;
  onTierChange?: (tier: "free" | "pro") => void;
  // Fired after update_first_name succeeds (see saveName below) -- lets
  // Dashboard's greeting update immediately instead of waiting for the next
  // full get_settings load.
  onFirstNameChange?: (firstName: string) => void;
  onVisibleCategoriesChange?: (categories: string[]) => void;
  // Set by TransformBar's "x/6 presets" link (via App.tsx) to jump straight
  // to the Presets section below once settings has loaded and rendered it.
  scrollToPresets?: boolean;
  onScrolledToPresets?: () => void;
  // Which of the Presets section's Text/Screenshots tabs to land on when
  // scrollToPresets fires -- set to match whichever Transform panel (clip
  // history vs. Screenshots) the user actually clicked "manage presets"
  // from, so Settings doesn't open showing the wrong list.
  initialPresetContext?: "text" | "screenshot";
  // Called after auth_logout succeeds -- the parent (App.tsx/Dashboard.tsx)
  // is the one holding authToken state, so it needs to know to swap back to
  // AuthGate rather than this component owning that decision itself.
  onLoggedOut?: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presetCapMsg, setPresetCapMsg] = useState(false);
  const [presetSearch, setPresetSearch] = useState("");
  // Which custom preset's delete is currently being confirmed, if any --
  // see ConfirmPopover. Deleting used to happen straight off the trash
  // icon's click with no way back; this makes it a two-step action instead.
  const [deleteConfirmLabel, setDeleteConfirmLabel] = useState<string | null>(null);
  const [deleteConfirmPos, setDeleteConfirmPos] = useState<{ top: number; left: number } | null>(null);
  // Which of the two independent visibility lists this section is currently
  // editing -- text (clip history + the standalone Transform tab) or
  // screenshots. Purely a UI selector; both lists always exist in settings
  // regardless of which one is being shown right now.
  const [presetContext, setPresetContext] = useState<"text" | "screenshot">("text");
  // "Add preset" inline form -- previously the only way to create a custom
  // preset was to run a transform first (TransformBar's "Save as preset"
  // button), which meant you couldn't add one without a clip/screenshot on
  // hand to test it against. This lets you type an instruction straight
  // into Settings instead.
  const [addingPreset, setAddingPreset] = useState(false);
  const [newPresetInstruction, setNewPresetInstruction] = useState("");
  const [newPresetLabel, setNewPresetLabel] = useState("");
  const [newPresetLabelTouched, setNewPresetLabelTouched] = useState(false);
  const presetsRef = useRef<HTMLDivElement>(null);

  const [filterTab, setFilterTab] = useState<"categories" | "ai">("categories");
  const [filterSearch, setFilterSearch] = useState("");
  // Which custom AI filter's full prompt is expanded, if any -- these rows
  // used to only show the prompt via a single-line truncate + a hover
  // tooltip (title=), which meant reading the whole thing meant hovering
  // and waiting for the OS tooltip rather than just clicking to see it.
  // Single string, not a Set -- one filter's prompt open at a time is
  // plenty for a "quickly check what this one says" action.
  const [expandedFilterName, setExpandedFilterName] = useState<string | null>(null);
  // Mirrors expandedFilterName, but for the "Your presets" list below
  // (2026-08-09 redesign) -- a custom preset's instruction is now hidden by
  // default and only shown on expand, same "click to see the rest" pattern
  // as an AI filter's prompt, rather than always visible via a title=
  // tooltip.
  const [expandedPresetLabel, setExpandedPresetLabel] = useState<string | null>(null);
  const [addingFilter, setAddingFilter] = useState(false);
  const [newFilterName, setNewFilterName] = useState("");
  const [newFilterPrompt, setNewFilterPrompt] = useState("");

  // Billing (see docs/billing-flow.md). checkoutPlan is set the moment
  // start_checkout succeeds and stays set (driving the "waiting for
  // checkout" UI + polling) until either the account actually flips to Pro
  // or the person dismisses it -- there's no webhook back into the app, so
  // this polling loop is the only thing that ever notices checkout finished.
  const [checkoutPlan, setCheckoutPlan] = useState<"monthly" | "annual" | null>(null);
  const [checkoutStarting, setCheckoutStarting] = useState<"monthly" | "annual" | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // First-name editing (2026-08-06) -- separate from the rest of `settings`
  // since this one field is server-authoritative (stored on the account in
  // Postgres, not just locally), so it needs its own save action hitting
  // update_first_name rather than folding into the generic update()/
  // save_settings path the other fields use. Local draft state (nameInput)
  // is only synced from settings.first_name once, when settings first
  // loads -- see the effect below -- so typing doesn't get clobbered by any
  // unrelated re-render of `settings`.
  const [nameInput, setNameInput] = useState("");
  const [nameSynced, setNameSynced] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    if (settings && !nameSynced) {
      setNameInput(settings.first_name || "");
      setNameSynced(true);
    }
  }, [settings, nameSynced]);

  // Delete account (2026-08-06) -- deliberately more friction than
  // ConfirmPopover's click-to-confirm (used for reversible-ish things like
  // deleting a custom preset): typing the exact account email is the same
  // "prove you mean it" pattern Stripe/GitHub use for irreversible account
  // actions, harder to fat-finger through than a single extra click.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function closeDeleteModal() {
    setShowDeleteModal(false);
    setDeleteConfirmInput("");
    setDeleteError(null);
  }

  async function confirmDeleteAccount() {
    if (!settings || deleteConfirmInput.trim().toLowerCase() !== settings.user_email.toLowerCase()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await invoke("delete_account");
      onLoggedOut?.();
    } catch (err) {
      setDeleteError(typeof err === "string" ? err : "Couldn't delete your account.");
      setDeleting(false);
    }
  }

  async function saveName() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === settings?.first_name) return;
    setNameSaving(true);
    setNameError(null);
    try {
      const next = await invoke<Settings>("update_first_name", { firstName: trimmed });
      setSettings((prev) => (prev ? { ...prev, first_name: next.first_name } : prev));
      setNameInput(next.first_name);
      onFirstNameChange?.(next.first_name);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1800);
    } catch (err) {
      setNameError(typeof err === "string" ? err : "Couldn't save your name.");
    } finally {
      setNameSaving(false);
    }
  }

  useEffect(() => {
    // Cleanup on unmount -- Settings can close (or the panel it's docked in
    // can hide) while a poll is still running; nothing should keep firing
    // invoke calls against an unmounted component.
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function checkAccountStatus() {
    const next = await invoke<Settings>("refresh_account_status");
    setSettings((prev) => (prev ? { ...prev, tier: next.tier } : prev));
    onTierChange?.(next.tier);
    if (next.tier === "pro") {
      stopPolling();
      setCheckoutPlan(null);
    }
    return next.tier;
  }

  async function startCheckout(plan: "monthly" | "annual") {
    setCheckoutError(null);
    setCheckoutStarting(plan);
    try {
      await invoke("start_checkout", { plan });
      setCheckoutPlan(plan);
      // Poll every 3s for up to 5 minutes -- generous for someone who steps
      // away from the browser tab, but bounded so a permanently-abandoned
      // checkout doesn't poll forever. The manual "I've finished checking
      // out" button covers anyone who takes longer.
      let attempts = 0;
      stopPolling();
      pollRef.current = setInterval(async () => {
        attempts += 1;
        if (attempts > 100) {
          stopPolling();
          return;
        }
        try {
          await checkAccountStatus();
        } catch {
          // Transient network hiccup mid-poll -- don't surface an error for
          // every failed tick, just try again next interval.
        }
      }, 3000);
    } catch (err) {
      setCheckoutError(typeof err === "string" ? err : "Couldn't start checkout. Is the server running?");
    } finally {
      setCheckoutStarting(null);
    }
  }

  async function refreshNow() {
    setCheckoutError(null);
    try {
      const tier = await checkAccountStatus();
      if (tier !== "pro") {
        setCheckoutError("Still on Free — if you just finished checking out, give it a few seconds and try again.");
      }
    } catch (err) {
      setCheckoutError(typeof err === "string" ? err : "Couldn't check status.");
    }
  }

  async function openBillingPortal() {
    setCheckoutError(null);
    setPortalLoading(true);
    try {
      await invoke("open_billing_portal");
    } catch (err) {
      setCheckoutError(typeof err === "string" ? err : "Couldn't open the billing portal.");
    } finally {
      setPortalLoading(false);
    }
  }

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => {
        const customPresets = s.custom_presets ?? [];
        const customPresetsScreenshots = s.custom_presets_screenshots ?? [];
        // Every label that actually still resolves to a real preset for
        // *that* context -- builtin-appropriate-to-this-context, or a
        // custom preset from *that context's own pool* (2026-08-06: custom
        // presets are no longer shared between Text and Screenshots -- see
        // custom_presets_screenshots's doc comment on settings.rs::Settings).
        // A label can end up in visible_presets(_screenshots) without
        // qualifying anymore if a custom preset was ever deleted by some
        // other path than TransformBar/TransformTab's own deletePreset
        // (which cleans both lists itself), or -- as of 2026-08-03 -- if a
        // builtin that used to be toggleable for this context no longer is
        // (e.g. "Clean up OCR errors" under Text: there's no OCR step for a
        // plain text clip, so it never made sense there to begin with).
        // Pruning both cases here keeps the "x/6" counter honest and stops
        // a context from silently carrying a preset that doesn't apply to
        // it.
        const validTextLabels = new Set([
          ...TEXT_ELIGIBLE_PRESETS,
          ...customPresets.map((p) => p.label),
        ]);
        const validScreenshotLabels = new Set([
          ...DEFAULT_SCREENSHOT_PRESETS,
          ...customPresetsScreenshots.map((p) => p.label),
        ]);
        const visiblePresets = (s.visible_presets ?? TEXT_ELIGIBLE_PRESETS).filter((l) => validTextLabels.has(l));
        const visiblePresetsScreenshots = (
          s.visible_presets_screenshots ?? DEFAULT_SCREENSHOT_PRESETS
        ).filter((l) => validScreenshotLabels.has(l));
        const cleaned = {
          ...s,
          custom_presets: customPresets,
          custom_presets_screenshots: customPresetsScreenshots,
          visible_presets: visiblePresets,
          visible_presets_screenshots: visiblePresetsScreenshots,
          custom_filters: s.custom_filters ?? [],
        };
        setSettings(cleaned);
        const prunedSomething =
          visiblePresets.length !== (s.visible_presets ?? TEXT_ELIGIBLE_PRESETS).length ||
          visiblePresetsScreenshots.length !== (s.visible_presets_screenshots ?? DEFAULT_SCREENSHOT_PRESETS).length;
        if (prunedSomething) invoke("save_settings", { settings: cleaned }).catch(console.error);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (scrollToPresets && settings && presetsRef.current) {
      if (initialPresetContext) setPresetContext(initialPresetContext);
      presetsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      onScrolledToPresets?.();
    }
  }, [scrollToPresets, settings, initialPresetContext]);

  async function update(partial: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...partial };
    setSettings(next);
    if (partial.theme) onThemeChange?.(partial.theme);
    if (partial.tier) onTierChange?.(partial.tier);
    if (partial.visible_categories) onVisibleCategoriesChange?.(partial.visible_categories);
    await invoke("save_settings", { settings: next });
  }

  async function logOut() {
    await invoke("auth_logout");
    onLoggedOut?.();
  }

  function togglePresetVisible(label: string, checked: boolean) {
    if (!settings) return;
    const field = presetContext === "screenshot" ? "visible_presets_screenshots" : "visible_presets";
    const current = settings[field];
    if (checked && current.length >= MAX_VISIBLE_PRESETS) {
      setPresetCapMsg(true);
      setTimeout(() => setPresetCapMsg(false), 2400);
      return;
    }
    const next = checked ? [...current, label] : current.filter((l) => l !== label);
    update({ [field]: next });
  }

  // Deletes a custom preset entirely -- mirrors TransformBar/TransformTab's
  // own deletePreset (the trash icon on a preset button there). Scoped to
  // whichever context (Text/Screenshots) is currently selected here --
  // since custom presets are fully separate pools per context (2026-08-06),
  // this only ever needs to touch that one pool and its matching visibility
  // list, not both.
  function deletePreset(label: string) {
    if (!settings) return;
    const customField = presetContext === "screenshot" ? "custom_presets_screenshots" : "custom_presets";
    const visibleField = presetContext === "screenshot" ? "visible_presets_screenshots" : "visible_presets";
    update({
      [customField]: settings[customField].filter((p) => p.label !== label),
      [visibleField]: settings[visibleField].filter((l) => l !== label),
    });
  }

  // Mirrors saveNewCustomFilter/deleteCustomFilter in App.tsx -- both places
  // write the same settings.custom_filters array, so a filter added or
  // removed here shows up in the main window's filter dropdown too, and
  // vice versa.
  function saveNewFilter() {
    if (!settings) return;
    const name = newFilterName.trim();
    const prompt = newFilterPrompt.trim();
    if (!name || !prompt) return;
    const next = [...settings.custom_filters.filter((f) => f.name !== name), { name, prompt }];
    update({ custom_filters: next });
    setNewFilterName("");
    setNewFilterPrompt("");
    setAddingFilter(false);
  }

  function deleteFilter(name: string) {
    if (!settings) return;
    update({ custom_filters: settings.custom_filters.filter((f) => f.name !== name) });
  }

  if (!settings)
    return (
      <div className="p-4 text-inkMuted dark:text-inkMutedDark text-sm">Loading…</div>
    );

  const activePresetField = presetContext === "screenshot" ? "visible_presets_screenshots" : "visible_presets";
  const activeVisiblePresets = settings[activePresetField];
  const presetCount = activeVisiblePresets.length;
  // Which builtins are even offered as a toggle for the current context --
  // "Clean up OCR errors" makes no sense to turn on for plain text clips
  // (there's no OCR step), and "Fix grammar"/"Make formal"/"Make casual"
  // don't fit OCR'd screenshot content much better (2026-08-03 fix, see
  // TEXT_ELIGIBLE_PRESETS/DEFAULT_SCREENSHOT_PRESETS's own doc comments).
  const eligibleBuiltins = presetContext === "screenshot" ? DEFAULT_SCREENSHOT_PRESETS : TEXT_ELIGIBLE_PRESETS;
  // Which custom-preset pool "Your presets" reads/writes for the currently
  // selected context -- fully separate arrays as of 2026-08-06 (see
  // custom_presets_screenshots's doc comment on settings.rs::Settings),
  // mirroring activePresetField's own context switch above.
  const activeCustomPresetField = presetContext === "screenshot" ? "custom_presets_screenshots" : "custom_presets";
  const activeCustomPresets = settings[activeCustomPresetField];
  // Shown next to "Your presets" below -- both Built-in and Your-presets
  // share one combined visibility list (hence presetCount above being the
  // one true total), but calling out how many of *your own* saved presets
  // specifically are turned on is useful once that list grows past a
  // handful, same reasoning as the search box only appearing past 5.
  const customVisibleCount = activeCustomPresets.filter((p) =>
    activeVisiblePresets.includes(p.label)
  ).length;

  // Every label already in use *for this context* -- builtins are still a
  // shared namespace across both contexts (same underlying instruction
  // text either way), but custom presets no longer are, so "Recipes" can
  // now exist as a Text preset and, independently, as a different
  // Screenshots preset without colliding.
  const takenPresetLabels = new Set([...BUILTIN_PRESETS, ...activeCustomPresets.map((p) => p.label)]);
  const trimmedNewLabel = (
    newPresetLabelTouched ? newPresetLabel : newPresetInstruction.slice(0, MAX_PRESET_LABEL_LENGTH)
  ).trim();
  const newPresetLabelTaken = trimmedNewLabel.length > 0 && takenPresetLabels.has(trimmedNewLabel);

  async function addCustomPreset() {
    if (!settings) return;
    const instruction = newPresetInstruction.trim();
    const label = trimmedNewLabel;
    if (!instruction || !label || newPresetLabelTaken) return;

    // Auto-show it in whichever context (Text/Screenshots) is currently
    // selected -- same "show it somewhere or saving feels like a no-op"
    // reasoning as TransformBar's own confirmSavePreset.
    const currentVisible = settings[activePresetField];
    const nextVisible =
      currentVisible.length < MAX_VISIBLE_PRESETS ? [...currentVisible, label] : currentVisible;

    await update({
      [activeCustomPresetField]: [...activeCustomPresets, { label, instruction }],
      [activePresetField]: nextVisible,
    });

    setAddingPreset(false);
    setNewPresetInstruction("");
    setNewPresetLabel("");
    setNewPresetLabelTouched(false);
  }

  return (
    <div
      onKeyDown={(e) => e.stopPropagation()}
      className="flex-1 overflow-y-auto px-4 py-4 text-sm space-y-3 text-ink dark:text-cream"
    >
      <Section icon="ti-sparkles" title="Plan">
        {settings.tier === "pro" ? (
          <div>
            <p className="text-[13px] font-medium flex items-center gap-1.5">
              Pro
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark">
                ACTIVE
              </span>
            </p>
            <p className="text-inkMuted dark:text-inkMutedDark text-xs mt-0.5">
              Unlimited history, AI transform, AI filters, and semantic search.
            </p>
            <button
              onClick={openBillingPortal}
              disabled={portalLoading}
              className="mt-3 w-full text-[11.5px] px-3 py-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/[0.09] dark:hover:bg-white/[0.12] transition-colors disabled:opacity-50"
            >
              {portalLoading ? "Opening…" : "Manage subscription"}
            </button>
          </div>
        ) : checkoutPlan ? (
          <div>
            <p className="text-[13px] font-medium mb-1">Waiting for checkout…</p>
            <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-3">
              Finish checking out in your browser — this updates automatically within a few seconds, or click
              refresh below.
            </p>
            {checkoutError && (
              <p className="text-[12px] text-red-500 dark:text-red-400 mb-3">{checkoutError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={refreshNow}
                className="text-[11.5px] px-3 py-1.5 rounded-full bg-ink dark:bg-cream text-cream dark:text-charcoal font-medium"
              >
                I've finished checking out
              </button>
              <button
                onClick={() => {
                  stopPolling();
                  setCheckoutPlan(null);
                  setCheckoutError(null);
                }}
                className="text-[11.5px] px-3 py-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/[0.09] dark:hover:bg-white/[0.12] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-[13px] font-medium mb-1">Free</p>
            <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-3">
              Start a 7-day free trial of Pro — unlimited history, AI transform, AI filters, and semantic search.
              Card required, cancel anytime during the trial and you won't be charged.
            </p>
            {checkoutError && (
              <p className="text-[12px] text-red-500 dark:text-red-400 mb-3">{checkoutError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => startCheckout("monthly")}
                disabled={checkoutStarting !== null}
                className="flex-1 text-[12px] px-3 py-2 rounded-lg border border-borderLight dark:border-borderDark hover:bg-black/[0.03] dark:hover:bg-white/[0.05] transition-colors disabled:opacity-50 text-center"
              >
                {checkoutStarting === "monthly" ? "Opening…" : (
                  <>
                    <span className="font-medium">Monthly</span>
                    <span className="block text-inkMuted dark:text-inkMutedDark text-[11px]">$3.99/mo</span>
                  </>
                )}
              </button>
              <button
                onClick={() => startCheckout("annual")}
                disabled={checkoutStarting !== null}
                className="flex-1 text-[12px] px-3 py-2 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal font-medium disabled:opacity-50 text-center relative"
              >
                {checkoutStarting === "annual" ? (
                  "Opening…"
                ) : (
                  <>
                    <span className="font-medium">Annual</span>
                    <span className="block opacity-70 text-[11px]">$29/yr — save 40%</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section icon="ti-adjustments" title="General">
        <div className="space-y-4">
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
            {/* Caption dropped for Pro (2026-08-06) -- "Unlimited" above and
                "Pro has no history cap" below just said the same thing
                twice. Free still gets the caption since the value line alone
                ("50 items or 7 days...") doesn't explain *why* -- that it's
                fixed by plan rather than something to go looking for a
                setting to change. */}
            {settings.tier !== "pro" && (
              <p className="text-inkMuted dark:text-inkMutedDark text-xs mt-1 opacity-70">
                Fixed by plan, not editable — upgrade to Pro for unlimited history.
              </p>
            )}
          </div>

          <div>
            <label className="block text-inkMuted dark:text-inkMutedDark text-xs mb-1">
              Language
            </label>
            <select
              disabled
              value="en"
              className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 outline-none opacity-60 cursor-not-allowed"
            >
              <option value="en">English</option>
            </select>
            <p className="text-inkMuted dark:text-inkMutedDark text-xs mt-1 opacity-70">
              Only English is available right now — more languages are on the roadmap, not a
              current setting.
            </p>
          </div>
        </div>
      </Section>

      <Section icon="ti-palette" title="Appearance & Startup">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span>Launch at startup</span>
            <input
              type="checkbox"
              checked={settings.launch_at_startup}
              onChange={(e) => update({ launch_at_startup: e.target.checked })}
              className="w-4 h-4 accent-accent dark:accent-accentDark"
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
        </div>
      </Section>

      <Section
        icon="ti-filter"
        title="Filters"
        description="Rule-based category buttons for everyone, plus your own natural-language AI filters on Pro."
      >
        {/* Same built-in/custom split as AI Transform's presets above --
            categories are the fixed free-tier set, AI filters are the
            open-ended, Pro-only, potentially-long list a user builds up. */}
        <div className="grid grid-cols-2 gap-1.5 mb-2.5">
          <button
            onClick={() => setFilterTab("categories")}
            className={`py-1.5 rounded-lg text-[12.5px] transition-colors ${
              filterTab === "categories"
                ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            Categories
          </button>
          <button
            onClick={() => setFilterTab("ai")}
            className={`py-1.5 rounded-lg text-[12.5px] transition-colors ${
              filterTab === "ai"
                ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            AI filters{settings.custom_filters.length > 0 ? ` (${settings.custom_filters.length})` : ""}
          </button>
        </div>

        {filterTab === "categories" && (
          // Redesigned 2026-08-09 from a checkbox list to a grid of toggle
          // buttons -- same on/off semantics (still just writing
          // visible_categories), but each category now reads as a single
          // tappable icon+label chip instead of a separate checkbox input
          // next to plain text.
          <div className="grid grid-cols-2 gap-2">
            {ALL_CATEGORIES.map((c) => {
              const checked = settings.visible_categories.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => {
                    const next = checked
                      ? settings.visible_categories.filter((v) => v !== c.value)
                      : [...settings.visible_categories, c.value];
                    update({ visible_categories: next });
                  }}
                  // Fixed height (2026-08-09) -- "Bank account" wraps to two
                  // lines while every other label fits on one, which made
                  // that button taller than the rest of the grid. A set
                  // height plus wrapping keeps every pill identically sized
                  // regardless of label length.
                  className={`flex items-center justify-center gap-1 h-11 px-2 rounded-full text-[11.5px] leading-tight text-center border transition-colors ${
                    checked
                      ? "bg-accent/15 dark:bg-accentDark/20 border-accent/25 dark:border-accentDark/30 text-accent dark:text-accentDark font-medium"
                      : "bg-creamSurface dark:bg-charcoalSurface border-borderLight dark:border-borderDark text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                  }`}
                >
                  <i className={`ti ${c.icon} text-accent dark:text-accentDark text-[12px] shrink-0`} />
                  {c.label}
                </button>
              );
            })}
          </div>
        )}

        {filterTab === "ai" && (
          <div>
            {settings.tier !== "pro" ? (
              <div className="flex items-center gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3 py-3 text-[12.5px] text-inkMuted dark:text-inkMutedDark">
                <i className="ti ti-lock text-[13px]" />
                Upgrade to Pro to save your own natural-language filters (e.g. "things related to the Johnson project").
              </div>
            ) : (
              <>
                {settings.custom_filters.length === 0 && !addingFilter && (
                  <p className="text-inkMuted dark:text-inkMutedDark text-xs text-center py-3">
                    No AI filters yet — add one below, or from the filter dropdown in the main window.
                  </p>
                )}

                {settings.custom_filters.length > 5 && (
                  <div className="relative mb-2">
                    <i className="ti ti-search absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-inkMuted dark:text-inkMutedDark opacity-60" />
                    <input
                      value={filterSearch}
                      onChange={(e) => setFilterSearch(e.target.value)}
                      placeholder="Search your filters…"
                      className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg pl-7 pr-2.5 py-1.5 text-[12.5px] outline-none"
                    />
                  </div>
                )}

                {settings.custom_filters.length > 0 && (
                  <div className="max-h-48 overflow-y-auto overflow-x-hidden space-y-1 pr-1 mb-2">
                    {settings.custom_filters
                      .filter((f) => f.name.toLowerCase().includes(filterSearch.trim().toLowerCase()))
                      .map((f) => {
                        const expanded = expandedFilterName === f.name;
                        return (
                          <div
                            key={f.name}
                            onClick={() => setExpandedFilterName(expanded ? null : f.name)}
                            className="group rounded-lg px-2.5 py-1.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.05] cursor-pointer"
                          >
                            <div className="flex items-center gap-2">
                              <i className="ti ti-sparkles text-[11px] text-accent dark:text-accentDark shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] truncate">{f.name}</p>
                                <p
                                  className={`text-inkMuted dark:text-inkMutedDark text-[11px] ${
                                    expanded ? "whitespace-pre-wrap break-words" : "truncate"
                                  }`}
                                >
                                  {f.prompt}
                                </p>
                              </div>
                              <i
                                className={`ti ti-chevron-down text-[11px] text-inkMuted dark:text-inkMutedDark shrink-0 opacity-0 group-hover:opacity-60 transition-all ${
                                  expanded ? "rotate-180 !opacity-60" : ""
                                }`}
                              />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteFilter(f.name);
                                }}
                                title="Delete filter"
                                className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-red-500 dark:hover:!text-red-400 transition-opacity"
                              >
                                <i className="ti ti-trash text-[12px]" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    {filterSearch.trim() &&
                      !settings.custom_filters.some((f) =>
                        f.name.toLowerCase().includes(filterSearch.trim().toLowerCase())
                      ) && (
                        <p className="text-inkMuted dark:text-inkMutedDark text-xs text-center py-1">
                          No filters match "{filterSearch.trim()}"
                        </p>
                      )}
                  </div>
                )}

                {addingFilter ? (
                  <div className="space-y-1.5">
                    <input
                      autoFocus
                      value={newFilterName}
                      onChange={(e) => setNewFilterName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setAddingFilter(false);
                      }}
                      placeholder="Name (e.g. Recipes)"
                      className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
                    />
                    <textarea
                      value={newFilterPrompt}
                      onChange={(e) => setNewFilterPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setAddingFilter(false);
                      }}
                      placeholder="Match when... (e.g. everything that's a recipe for a dish)"
                      rows={2}
                      className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none resize-none"
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={saveNewFilter}
                        disabled={!newFilterName.trim() || !newFilterPrompt.trim()}
                        className="flex-1 text-[12px] py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal disabled:opacity-40"
                      >
                        Save filter
                      </button>
                      <button
                        onClick={() => setAddingFilter(false)}
                        className="px-2.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] text-[12px]"
                      >
                        <i className="ti ti-x text-[12px]" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingFilter(true)}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] text-accent dark:text-accentDark hover:bg-accent/10 dark:hover:bg-accentDark/15 transition-colors"
                  >
                    <i className="ti ti-plus text-[11px]" />
                    New AI filter
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </Section>

      <div ref={presetsRef}>
        <Section
          icon="ti-sparkles"
          title="AI Transform"
          description={`Choose up to ${MAX_VISIBLE_PRESETS} presets to show as one-click buttons in Transform -- separately for text clips and for screenshots, since a mix of built-in and your own saved ones makes sense differently for each.`}
        >
          {/* Redesigned 2026-08-03 -- the old layout stacked a Text/
              Screenshots switch, a combined "x/6" counter, *another*
              Built-in/Your-presets switch, and only then a checkbox list,
              which meant seeing your actual presets took two tab decisions
              first and the "shown" count never lined up with what was
              visibly checked on whichever tab happened to be open (see the
              earlier fix that added per-tab counts to patch that
              confusion). Flattened here into one always-visible list with
              plain section labels instead of a second layer of tabs, each
              row reading left-to-right as "name -> is it on," and a single
              counter up top that now actually matches what's checked below
              it since there's nothing hidden on another tab anymore. */}
          <p className="text-[11px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1.5">
            Show buttons for
          </p>
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            <button
              onClick={() => setPresetContext("text")}
              className={`py-1.5 rounded-lg text-[12.5px] transition-colors ${
                presetContext === "text"
                  ? "bg-black/[0.06] dark:bg-white/[0.09] text-ink dark:text-cream font-medium"
                  : "bg-black/[0.02] dark:bg-white/[0.03] text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
              }`}
            >
              Text clips
            </button>
            <button
              onClick={() => setPresetContext("screenshot")}
              className={`py-1.5 rounded-lg text-[12.5px] transition-colors ${
                presetContext === "screenshot"
                  ? "bg-black/[0.06] dark:bg-white/[0.09] text-ink dark:text-cream font-medium"
                  : "bg-black/[0.02] dark:bg-white/[0.03] text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
              }`}
            >
              Screenshots
            </button>
          </div>

          <div className="flex items-center justify-between mb-2.5 pb-2.5 border-b border-borderLight dark:border-borderDark">
            <span className="text-[12.5px] font-medium">
              {presetContext === "screenshot" ? "Screenshot" : "Text"} buttons shown
            </span>
            <span
              className={`text-[12px] font-medium ${
                presetCount >= MAX_VISIBLE_PRESETS
                  ? "text-accent dark:text-accentDark"
                  : "text-inkMuted dark:text-inkMutedDark"
              }`}
            >
              {presetCount}/{MAX_VISIBLE_PRESETS}
            </span>
          </div>

          {presetCapMsg && (
            <div className="mb-2.5 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3 py-2 text-[11.5px] text-accent dark:text-accentDark text-center font-medium">
              You can show up to {MAX_VISIBLE_PRESETS} at once — uncheck one first.
            </div>
          )}

          <p className="text-[11px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1.5">
            Built-in
          </p>
          {/* Redesigned 2026-08-09 -- capsule toggle buttons (same
              selected/unselected color language as the Categories grid
              above) instead of a checkbox list. A builtin's label doubles
              as its own instruction (see BUILTIN_PRESETS's doc comment), so
              there's nothing to expand here -- unlike "Your presets" below,
              which does get an expand chevron for its separate instruction
              text. */}
          <div className="space-y-1.5 mb-4">
            {eligibleBuiltins.map((label) => {
              const checked = activeVisiblePresets.includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => togglePresetVisible(label, !checked)}
                  className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] border transition-colors ${
                    checked
                      ? "bg-accent/15 dark:bg-accentDark/20 border-accent/25 dark:border-accentDark/30 text-accent dark:text-accentDark font-medium"
                      : "bg-creamSurface dark:bg-charcoalSurface border-borderLight dark:border-borderDark text-ink dark:text-cream hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                  }`}
                >
                  <i
                    className={`ti ti-sparkles text-[12px] shrink-0 ${
                      checked ? "text-accent dark:text-accentDark" : "text-inkMuted dark:text-inkMutedDark opacity-70"
                    }`}
                  />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
              Your presets
            </p>
            {activeCustomPresets.length > 0 && (
              <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">
                {customVisibleCount}/{activeCustomPresets.length} shown
              </span>
            )}
          </div>
          <div>
            {!addingPreset ? (
              <button
                onClick={() => setAddingPreset(true)}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-accent/10 dark:bg-accentDark/15 hover:bg-accent/20 dark:hover:bg-accentDark/25 transition-colors text-[12.5px] font-medium text-ink dark:text-cream py-1.5 mb-2.5"
              >
                <i className="ti ti-plus text-[11px]" />
                New preset
              </button>
            ) : (
              <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.05] p-2.5 mb-2.5 space-y-1.5">
                {/* Name above Instruction (2026-08-06, swapped from the
                    original instruction-first order) -- the name is the
                    short, glanceable label you'll actually recognize the
                    preset by later (it's what shows on the one-click button
                    in Transform), so it reads better as the "title" sitting
                    on top, with the longer instruction as supporting detail
                    below it -- same top-to-bottom hierarchy as everything
                    else in this app (title first, detail after). Renamed
                    from "Chip label" to "Name" at the same time -- "chip" is
                    internal terminology for the one-click button itself, not
                    a word this field needs to expose to explain what it is. */}
                <input
                  autoFocus
                  value={newPresetLabelTouched ? newPresetLabel : newPresetInstruction.slice(0, MAX_PRESET_LABEL_LENGTH)}
                  onChange={(e) => {
                    setNewPresetLabelTouched(true);
                    setNewPresetLabel(e.target.value.slice(0, MAX_PRESET_LABEL_LENGTH));
                  }}
                  maxLength={MAX_PRESET_LABEL_LENGTH}
                  placeholder="Name"
                  className="w-full bg-cream dark:bg-charcoal border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
                />
                <input
                  value={newPresetInstruction}
                  onChange={(e) => setNewPresetInstruction(e.target.value)}
                  placeholder="Instruction, e.g. “Translate into French”"
                  className="w-full bg-cream dark:bg-charcoal border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
                />
                {newPresetLabelTaken && (
                  <p className="text-red-500 dark:text-red-400 text-[11px]">
                    A preset named "{trimmedNewLabel}" already exists.
                  </p>
                )}
                <div className="flex gap-1.5">
                  <button
                    onClick={addCustomPreset}
                    disabled={!newPresetInstruction.trim() || !trimmedNewLabel || newPresetLabelTaken}
                    className="flex-1 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal text-[12px] font-medium py-1.5 disabled:opacity-40"
                  >
                    Save preset
                  </button>
                  <button
                    onClick={() => {
                      setAddingPreset(false);
                      setNewPresetInstruction("");
                      setNewPresetLabel("");
                      setNewPresetLabelTouched(false);
                    }}
                    className="px-3 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] text-[12px]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {activeCustomPresets.length === 0 ? (
              <p className="text-inkMuted dark:text-inkMutedDark text-xs text-center py-3">
                Presets you add here or save from Transform (via "Save as preset") will show up here.
              </p>
            ) : (
              <>
                {/* Search only kicks in once there's enough custom presets
                    that scanning the raw list stops being faster than
                    typing a few letters -- no point showing it for 2-3. */}
                {activeCustomPresets.length > 5 && (
                  <div className="relative mb-2">
                    <i className="ti ti-search absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-inkMuted dark:text-inkMutedDark opacity-60" />
                    <input
                      value={presetSearch}
                      onChange={(e) => setPresetSearch(e.target.value)}
                      placeholder="Search your presets…"
                      className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg pl-7 pr-2.5 py-1.5 text-[12.5px] outline-none"
                    />
                  </div>
                )}

                {/* Fixed max-height so 12+ saved presets scroll inside their
                    own box instead of pushing the whole settings panel
                    (and the Done button) further down the page -- this is
                    what replaces the old Built-in/Your-presets tab split's
                    "keep a dozen custom presets from burying the fixed
                    defaults" job now that both sections are always visible
                    at once. */}
                {/* Redesigned 2026-08-09 -- same capsule + color-on-select
                    language as Built-in above, plus an expand chevron
                    (mirrors the AI filters list further up) since a custom
                    preset, unlike a builtin, has a separate instruction
                    worth revealing on demand instead of only via a title=
                    tooltip. Clicking the row body toggles selected; the
                    chevron and trash are their own hit targets. */}
                <div className="max-h-56 overflow-y-auto overflow-x-hidden space-y-1.5 pr-1">
                  {activeCustomPresets
                    .filter((p) => p.label.toLowerCase().includes(presetSearch.trim().toLowerCase()))
                    .map((p) => {
                      const checked = activeVisiblePresets.includes(p.label);
                      const expanded = expandedPresetLabel === p.label;
                      return (
                        <div
                          key={p.label}
                          className={`group rounded-xl border transition-colors ${
                            checked
                              ? "bg-accent/15 dark:bg-accentDark/20 border-accent/25 dark:border-accentDark/30"
                              : "bg-creamSurface dark:bg-charcoalSurface border-borderLight dark:border-borderDark hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                          }`}
                        >
                          <div
                            onClick={() => togglePresetVisible(p.label, !checked)}
                            className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                          >
                            <i
                              className={`ti ti-sparkles text-[12px] shrink-0 ${
                                checked ? "text-accent dark:text-accentDark" : "text-inkMuted dark:text-inkMutedDark opacity-70"
                              }`}
                            />
                            <span
                              className={`flex-1 min-w-0 truncate text-[13px] ${
                                checked ? "text-accent dark:text-accentDark font-medium" : "text-ink dark:text-cream"
                              }`}
                            >
                              {p.label}
                            </span>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setExpandedPresetLabel(expanded ? null : p.label);
                              }}
                              title={expanded ? "Hide prompt" : "Show prompt"}
                              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                            >
                              <i
                                className={`ti ti-chevron-down text-[11px] transition-transform ${
                                  expanded ? "rotate-180" : ""
                                }`}
                              />
                            </button>
                            {/* Hover-reveal, same convention as every other
                                row action in the app -- preventDefault/
                                stopPropagation stops the click from also
                                toggling the row's own selected state. */}
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                setDeleteConfirmPos(clampMenuPosition(r.bottom + 4, r.right - 224, 224, 100));
                                setDeleteConfirmLabel(p.label);
                              }}
                              title="Delete preset"
                              className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-red-500 dark:hover:!text-red-400 text-inkMuted dark:text-inkMutedDark transition-opacity"
                            >
                              <i className="ti ti-trash text-[12px]" />
                            </button>
                          </div>
                          {expanded && (
                            <p className="px-3 pb-2.5 -mt-0.5 text-[11.5px] text-inkMuted dark:text-inkMutedDark whitespace-pre-wrap break-words">
                              {p.instruction}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  {presetSearch.trim() &&
                    !activeCustomPresets.some((p) =>
                      p.label.toLowerCase().includes(presetSearch.trim().toLowerCase())
                    ) && (
                      <p className="text-inkMuted dark:text-inkMutedDark text-xs text-center py-1">
                        No presets match "{presetSearch.trim()}"
                      </p>
                    )}
                </div>
              </>
            )}
          </div>
        </Section>
      </div>

      <Section
        icon="ti-code"
        title="Developer"
        description="Dev-only tools for testing -- see docs/billing-flow.md and server/README.md. This local toggle changes what the UI shows, but the server independently re-checks the real tier from its own database on every AI request, so this alone cannot unlock Pro features against a real deployed server."
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span>Local plan override (dev only)</span>
            <select
              value={settings.tier}
              onChange={(e) => update({ tier: e.target.value as "free" | "pro" })}
              className="bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2 py-1"
            >
              <option value="free">Free</option>
              <option value="pro">Pro</option>
            </select>
          </div>

          <div>
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
        </div>
      </Section>

      {/* Account moved to the bottom (2026-08-06, was the very first
          section) -- Log out being the first thing anyone sees on opening
          Settings read as an odd, slightly alarming default. Preferences
          people actually come here to change (hotkey, theme, presets,
          filters) now lead; account-level actions (sign out, delete
          account) sit at the end, the same "housekeeping last" convention
          most apps use. */}
      <Section icon="ti-user-circle" title="Account">
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-0.5">Signed in as</p>
            <p className="text-[13px] font-medium truncate">{settings.user_email || "—"}</p>
          </div>
          <button
            onClick={logOut}
            className="shrink-0 text-[11.5px] px-3 py-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/[0.09] dark:hover:bg-white/[0.12] transition-colors"
          >
            Log out
          </button>
        </div>

        <div>
          <p className="text-inkMuted dark:text-inkMutedDark text-xs mb-1">
            First name
            <span className="opacity-70"> — used for the "Good morning" greeting on Dashboard</span>
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
              }}
              placeholder="Your first name"
              maxLength={50}
              className="flex-1 min-w-0 bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 text-[13px] outline-none"
            />
            <button
              onClick={saveName}
              disabled={nameSaving || !nameInput.trim() || nameInput.trim() === settings.first_name}
              className="shrink-0 text-[11.5px] px-3 py-2 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal font-medium disabled:opacity-40"
            >
              {nameSaving ? "Saving…" : nameSaved ? "Saved" : "Save"}
            </button>
          </div>
          {nameError && <p className="text-[11.5px] text-red-500 dark:text-red-400 mt-1.5">{nameError}</p>}
        </div>

        <div className="mt-4 pt-3 border-t border-black/[0.06] dark:border-white/[0.08]">
          <button
            onClick={() => setShowDeleteModal(true)}
            className="text-[11.5px] text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 font-medium transition-colors"
          >
            Delete account
          </button>
        </div>
      </Section>

      <button
        onClick={onClose}
        className="w-full mt-4 bg-accent/15 dark:bg-accentDark/20 hover:bg-accent/25 dark:hover:bg-accentDark/30 transition-colors rounded-lg py-2"
      >
        Done
      </button>

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

      {showDeleteModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6"
            onClick={closeDeleteModal}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[320px] rounded-2xl bg-cream dark:bg-charcoalSurface shadow-2xl p-4"
            >
              <p className="text-[14px] font-semibold mb-1.5">Delete your account?</p>
              <p className="text-[12.5px] text-inkMuted dark:text-inkMutedDark leading-snug mb-3">
                This permanently deletes your FatClipboard account and cancels any active
                subscription. This can't be undone. Your local clip history on this device isn't
                affected.
              </p>
              <p className="text-[12px] text-inkMuted dark:text-inkMutedDark mb-1.5">
                Type <span className="font-medium text-ink dark:text-cream">{settings.user_email}</span> to
                confirm.
              </p>
              <input
                type="text"
                autoFocus
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmDeleteAccount();
                }}
                className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2 text-[13px] outline-none mb-1.5"
              />
              {deleteError && (
                <p className="text-[11.5px] text-red-500 dark:text-red-400 mb-1.5">{deleteError}</p>
              )}
              <div className="flex gap-1.5 mt-2">
                <button
                  onClick={closeDeleteModal}
                  className="flex-1 text-[12.5px] py-2 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeleteAccount}
                  disabled={
                    deleting || deleteConfirmInput.trim().toLowerCase() !== settings.user_email.toLowerCase()
                  }
                  className="flex-1 text-[12.5px] font-medium py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40"
                >
                  {deleting ? "Deleting…" : "Delete account"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
