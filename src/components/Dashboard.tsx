import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "../lib/tauriShim";
import { ALL_CATEGORIES } from "../lib/categories";
import { dateGroupLabel, formatTimestamp } from "../lib/dateFormat";
import FoldersPanel from "./FoldersPanel";
import SettingsPanel from "./SettingsPanel";
import AuthGate from "./AuthGate";
import Onboarding from "./Onboarding";
import TransformBar from "./TransformBar";
import fatClipboardLogo from "../assets/fatclipboard-logo.png";
import ClampedText from "./ClampedText";

// The Dashboard window (src-tauri/tauri.conf.json label "dashboard", opened
// via the tray icon click / "Open Dashboard" menu item -- see open_dashboard
// in main.rs) is deliberately separate from the docked quick-access panel
// (App.tsx / window label "main"). The quick panel is for fast search-and-
// paste; this is the slower, browsable "how am I using Clip" view -- account
// info + activity stats, modeled on Wispr Flow's own main app window (left
// nav sidebar, welcome header, recent-activity feed, stats stacked on the
// right).
//
// All four sidebar tabs are real now:
// - Home: welcome header + recent-activity feed + a compact stat stack.
// - Insights: the fuller stats view -- bigger tiles, category breakdown,
//   the streak heatmap.
// - Folders / Settings: these aren't reimplemented here -- they reuse
//   FoldersPanel/SettingsPanel verbatim, the same components the quick
//   panel uses. Same backend commands, same SQLite connection (see AppState
//   in main.rs), so anything created/changed here shows up in the quick
//   panel too, and vice versa -- there's only one underlying data store.
//   They're just narrower components dropped into a centered column here
//   since they were originally styled for the ~1/5-screen-width quick panel.

interface DashboardStats {
  total_clips_saved: number;
  transforms_run: number;
  total_screenshots_saved: number;
  // Lifetime running total, survives history trimming (see db.rs's own
  // comment on bump_lifetime_by) -- not derivable from the trimmed clip
  // list itself, so it comes from the backend as its own field rather than
  // being computed client-side like streak/weekly/busiest-day below.
  total_characters_captured: number;
  categories: { category: string; count: number }[];
  daily_activity: { date: string; count: number }[];
  // Highest-usage presets first, only ones that have actually been clicked
  // at least once (see transform_clip's preset_label param in main.rs).
  top_presets: { label: string; count: number }[];
  folders: {
    folder_count: number;
    item_count: number;
    most_used_folder: { name: string; count: number } | null;
  };
}

interface ClipEntry {
  id: number;
  content: string;
  pinned: boolean;
  created_at: string;
  category: string;
  is_secret?: boolean;
}

function categoryLabel(value: string): string {
  if (!value || value === "text") return "Text";
  return ALL_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

// Current streak = consecutive active days counting back from the most
// recent day that actually had activity. Mirrors Wispr's own rule: the
// streak doesn't extend into today just because today exists on the
// calendar -- it only counts if today already has activity, otherwise it
// counts back from yesterday.
function computeStreak(daily: { date: string; count: number }[]): number {
  const arr = [...daily];
  let i = arr.length - 1;
  if (i >= 0 && arr[i].count === 0) i--;
  let streak = 0;
  while (i >= 0 && arr[i].count > 0) {
    streak++;
    i--;
  }
  return streak;
}

// Longest run of consecutive active days anywhere in the window, not just
// the current trailing one computeStreak finds -- same zero-filled
// daily_activity array, just scanned for the best run instead of stopping
// at the first gap. Since the backend only ever returns 84 days (see
// get_dashboard_stats's `days` param in main.rs), this is a "longest streak
// in the last 12 weeks" not a true lifetime record -- a reasonable
// approximation for a clipboard tool where streaks rarely run that long
// anyway, and matches exactly what the heatmap below it visualizes.
function computeLongestStreak(daily: { date: string; count: number }[]): number {
  let longest = 0;
  let current = 0;
  for (const day of daily) {
    if (day.count > 0) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

// Trailing 7-day windows (today back 6 days vs. the 7 days before that)
// rather than calendar weeks -- avoids a Sunday-vs-Monday start-of-week
// argument and reads naturally either way ("the last 7 days" is
// unambiguous, "this week" isn't for everyone).
function computeWeeklyComparison(daily: { date: string; count: number }[]): {
  thisWeek: number;
  lastWeek: number;
} {
  const last7 = daily.slice(-7);
  const prev7 = daily.slice(-14, -7);
  return {
    thisWeek: last7.reduce((sum, d) => sum + d.count, 0),
    lastWeek: prev7.reduce((sum, d) => sum + d.count, 0),
  };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Which day of the week has the most total activity across the whole
// window -- parses each YYYY-MM-DD as a local date (not UTC, to match how
// the backend generated these dates from chrono::Local) and buckets by
// getDay(). Returns null rather than "Sunday" by default when there's no
// activity at all yet, so the UI can show an honest "not enough data"
// state instead of a misleading day.
function computeBusiestWeekday(daily: { date: string; count: number }[]): string | null {
  const totals = new Array(7).fill(0);
  for (const day of daily) {
    const [y, m, d] = day.date.split("-").map(Number);
    const weekday = new Date(y, m - 1, d).getDay();
    totals[weekday] += day.count;
  }
  const max = Math.max(...totals);
  if (max === 0) return null;
  return WEEKDAY_NAMES[totals.indexOf(max)];
}

function heatColor(count: number, max: number, isDark: boolean): string {
  if (count === 0) return isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const intensity = Math.min(1, count / Math.max(max, 1));
  const accent = isDark ? "183,169,255" : "124,111,227"; // accentDark / accent (FatClipboard violet, 2026-08-12)
  const alpha = 0.25 + intensity * 0.65;
  return `rgba(${accent},${alpha})`;
}

// Primary nav (what you're browsing) vs. account-level actions (Settings /
// Help / Log out) are split into two groups now -- Settings used to live in
// this same list, mixed in with Home/Insights/Folders, which read oddly
// next to a Log out action that has nowhere else to live. ACCOUNT_ITEMS
// renders as its own small section pinned to the bottom of the sidebar,
// below the Upgrade-to-Pro card, separated by a hairline -- the common
// "navigation up top, account stuff at the bottom" split (Notion, Slack,
// etc.) rather than everything in one flat list.
const NAV_ITEMS = [
  { key: "home", label: "Home", icon: "ti-layout-grid" },
  { key: "insights", label: "Insights", icon: "ti-chart-bar" },
  { key: "folders", label: "Folders", icon: "ti-folder" },
];

// Local device time, not server time -- a greeting is about the moment the
// person is actually looking at the screen, and Clip has no reason to know
// or care what time zone the server itself runs in.
function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function Dashboard() {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [tier, setTier] = useState<"free" | "pro">("free");
  const [firstName, setFirstName] = useState("");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [history, setHistory] = useState<ClipEntry[]>([]);
  const [nav, setNav] = useState("home");
  // Same first-use gate as App.tsx's quick panel -- see main.rs's needs_auth
  // check. null = "haven't checked get_settings yet", "" = logged out.
  const [authToken, setAuthToken] = useState<string | null>(null);
  // Same onboarding gate as App.tsx -- see settings.rs::onboarding_complete.
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  // Recent-activity feed row interactions (added alongside Copy/Edit buttons):
  // expandedId -- click-to-expand a row past its 2-line clamp when the full
  // text doesn't fit, mirroring the "extend the box" request; transformingId
  // -- drives the bottom TransformBar panel, reusing the exact same
  // component/pattern FoldersPanel.tsx uses for its own row-level "Transform
  // with AI" action, since that's the only mechanism anywhere in this app
  // for modifying a clip's text (there's no raw in-place text editor for
  // History items -- only Folder items get a dedicated Edit screen); copiedId
  // -- brief "Copied" feedback after the Copy button fires.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [transformingId, setTransformingId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // Bottom-of-sidebar "Help & about" popover -- there's no dedicated help
  // screen anywhere in the app yet, so this stays a lightweight inline
  // panel (app name/version + a feedback mailto) rather than a new nav
  // route. Swap the placeholder support address once a real domain/support
  // inbox exists (see the earlier domain-naming conversation).
  const [showHelp, setShowHelp] = useState(false);
  // Same fail-safe-blurred default and reasoning as App.tsx's blurSecrets.
  const [blurSecrets, setBlurSecrets] = useState(true);
  // One-shot "what's new" banner -- see App.tsx's updateNotice for the full
  // explanation. Whichever window (this one or the quick panel) asks first
  // each launch is the one that shows it.
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const settings = await invoke<{
        theme: "dark" | "light";
        tier: "free" | "pro";
        auth_token?: string;
        first_name?: string;
        onboarding_complete?: boolean;
        blur_secrets?: boolean;
      }>("get_settings");
      setTheme(settings.theme);
      setTier(settings.tier);
      setAuthToken(settings.auth_token ?? "");
      setFirstName(settings.first_name ?? "");
      setOnboardingComplete(settings.onboarding_complete ?? false);
      setBlurSecrets(settings.blur_secrets ?? true);

      invoke<string | null>("take_update_notice")
        .then((v) => v && setUpdateNotice(v))
        .catch(console.error);

      if (!settings.auth_token) return;

      const [dashboardStats, recent] = await Promise.all([
        invoke<DashboardStats>("get_dashboard_stats"),
        invoke<ClipEntry[]>("get_history", {
          query: "",
          category: null,
          dateFrom: null,
          dateTo: null,
        }),
      ]);
      setStats(dashboardStats);
      setHistory(recent.slice(0, 40));
    })();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const streak = useMemo(() => (stats ? computeStreak(stats.daily_activity) : 0), [stats]);
  const longestStreak = useMemo(
    () => (stats ? computeLongestStreak(stats.daily_activity) : 0),
    [stats]
  );
  const weeklyComparison = useMemo(
    () => (stats ? computeWeeklyComparison(stats.daily_activity) : { thisWeek: 0, lastWeek: 0 }),
    [stats]
  );
  const busiestWeekday = useMemo(
    () => (stats ? computeBusiestWeekday(stats.daily_activity) : null),
    [stats]
  );
  const totalCategoryCount = useMemo(
    () => (stats?.categories ?? []).reduce((sum, c) => sum + c.count, 0),
    [stats]
  );
  const maxCategoryCount = useMemo(
    () => Math.max(1, ...(stats?.categories.map((c) => c.count) ?? [1])),
    [stats]
  );
  const maxDailyCount = useMemo(
    () => Math.max(1, ...(stats?.daily_activity.map((d) => d.count) ?? [1])),
    [stats]
  );

  // Sets the OS clipboard without simulating Ctrl+V (see copy_to_clipboard's
  // doc comment in main.rs) -- this window has no "hand control back to
  // whatever app was focused" moment the way the docked quick-panel does, so
  // there's nothing to paste into.
  // Same auth_logout command SettingsPanel's own "Log out" button calls --
  // duplicated here (rather than reused) since this is a plain sidebar
  // button, not the full SettingsPanel component.
  async function logOut() {
    await invoke("auth_logout");
    setAuthToken("");
  }

  async function copyItem(item: ClipEntry) {
    await invoke("copy_to_clipboard", { text: item.content });
    setCopiedId(item.id);
    setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1500);
  }

  const transformingItem = history.find((h) => h.id === transformingId) ?? null;

  const feedGroups = useMemo(() => {
    const groups: { label: string; entries: ClipEntry[] }[] = [];
    const indexByLabel = new Map<string, number>();
    for (const item of history) {
      const label = dateGroupLabel(item.created_at, "long");
      let idx = indexByLabel.get(label);
      if (idx === undefined) {
        idx = groups.length;
        indexByLabel.set(label, idx);
        groups.push({ label, entries: [] });
      }
      groups[idx].entries.push(item);
    }
    return groups;
  }, [history]);

  // 12-week (84-day) contribution-style grid, oldest-first columns.
  const heatmapWeeks = useMemo(() => {
    if (!stats) return [];
    const days = stats.daily_activity;
    const weeks: { date: string; count: number }[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }
    return weeks;
  }, [stats]);

  if (authToken === null) {
    // Still waiting on the initial get_settings call -- render nothing
    // rather than guessing (see the same tri-state pattern in App.tsx).
    return <div className="h-screen w-screen bg-cream dark:bg-charcoal" />;
  }

  if (authToken === "") {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-cream dark:bg-charcoal">
        <div className="w-full max-w-[320px]">
          <AuthGate
            onAuthenticated={(settings) => {
              setAuthToken(settings.auth_token);
              setTheme(settings.theme);
              setTier(settings.tier);
              setFirstName(settings.first_name ?? "");
              setOnboardingComplete(settings.onboarding_complete);
              // Load stats/history now that we're actually signed in --
              // mirrors the effect above, which skipped this while logged out.
              Promise.all([
                invoke<DashboardStats>("get_dashboard_stats"),
                invoke<ClipEntry[]>("get_history", {
                  query: "",
                  category: null,
                  dateFrom: null,
                  dateTo: null,
                }),
              ]).then(([dashboardStats, recent]) => {
                setStats(dashboardStats);
                setHistory(recent.slice(0, 40));
              });
            }}
          />
        </div>
      </div>
    );
  }

  if (!onboardingComplete) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-cream dark:bg-charcoal">
        <div className="w-full max-w-[360px]">
          <Onboarding onDone={(newTheme) => { setTheme(newTheme); setOnboardingComplete(true); }} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex bg-cream dark:bg-charcoal text-ink dark:text-cream overflow-hidden">
      {/* One-shot "what's new" toast -- fixed/overlaid rather than inline
          so it shows above whichever nav section (Home, Insights, etc.) is
          active, instead of needing to be duplicated into each one. */}
      <AnimatePresence>
        {updateNotice && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3.5 py-2 text-[12.5px] text-accent dark:text-accentDark font-medium shadow-card dark:shadow-cardDark"
          >
            <i className="ti ti-sparkles text-[13px]" />
            <span>Updated to v{updateNotice}</span>
            <button
              onClick={() => setUpdateNotice(null)}
              className="ml-1 opacity-70 hover:opacity-100 transition-opacity"
              title="Dismiss"
            >
              <i className="ti ti-x text-[12px]" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {/* --- Sidebar ------------------------------------------------- */}
      <aside className="w-56 shrink-0 border-r border-borderLight dark:border-borderDark flex flex-col p-4">
        <div className="flex items-center gap-2 px-1 mb-6">
          <img src={fatClipboardLogo} alt="FatClipboard" className="h-5 w-auto" />
          <span
            className={`ml-auto text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
              tier === "pro"
                ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark"
                : "bg-black/[0.06] dark:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark"
            }`}
          >
            {tier === "pro" ? "Pro" : "Free"}
          </span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setNav(item.key)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] text-left transition-colors ${
                nav === item.key
                  ? "bg-accent/10 dark:bg-accentDark/15 text-accent dark:text-accentDark font-medium"
                  : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06] text-ink dark:text-cream"
              }`}
            >
              <i className={`ti ${item.icon} text-[15px]`} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {tier !== "pro" && (
          <div className="rounded-xl bg-accentFill dark:bg-accentFillDark p-3.5 mb-2">
            <p className="text-[12px] font-medium mb-1">Unlock unlimited history + AI</p>
            <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mb-2.5">
              Upgrade to Pro for unlimited clips, folders, and AI transforms.
            </p>
            <button
              onClick={() => setNav("settings")}
              className="w-full text-[12px] py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal font-medium"
            >
              Upgrade to Pro
            </button>
          </div>
        )}

        {/* Account section -- Settings / Help / Log out, split out from the
            Home/Insights/Folders nav above by a hairline so account-level
            actions read as a distinct group instead of just more pages. */}
        <div className="border-t border-borderLight dark:border-borderDark pt-2 -mx-1 px-1 relative">
          <button
            onClick={() => setNav("settings")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] text-left transition-colors ${
              nav === "settings"
                ? "bg-accent/10 dark:bg-accentDark/15 text-accent dark:text-accentDark font-medium"
                : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06] text-ink dark:text-cream"
            }`}
          >
            <i className="ti ti-settings text-[15px]" />
            Settings
          </button>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06] text-ink dark:text-cream"
          >
            <i className="ti ti-help-circle text-[15px]" />
            Help &amp; about
          </button>
          <button
            onClick={logOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06] text-ink dark:text-cream"
          >
            <i className="ti ti-logout text-[15px]" />
            Log out
          </button>

          {showHelp && (
            <div className="absolute bottom-full left-1 mb-2 w-64 rounded-xl bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.06] dark:ring-white/[0.08] shadow-float dark:shadow-floatDark p-4 z-10">
              <div className="flex items-center gap-2 mb-2">
                <img src={fatClipboardLogo} alt="FatClipboard" className="h-4 w-auto" />
                <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">v0.1.0</span>
              </div>
              <p className="text-[12px] text-inkMuted dark:text-inkMutedDark mb-3">
                Copy, transform, and organize everything you copy.
              </p>
              <a
                href="mailto:support@clipapp.io"
                className="block w-full text-center text-[12px] py-1.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors"
              >
                Contact support
              </a>
            </div>
          )}
        </div>
      </aside>

      {/* --- Main content --------------------------------------------- */}
      <main className="flex-1 min-h-0 flex flex-col">
        {nav === "home" && (
          <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto p-8">
            <h1 className="text-[22px] font-semibold mb-1">
              {timeOfDayGreeting()}
              {firstName ? `, ${firstName}` : ""}.
            </h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark mb-7">
              Here's how you've been using FatClipboard.
            </p>

            <div className="grid grid-cols-[2fr_1fr] gap-6 items-start">
              {/* Recent activity feed */}
              <div>
                <h2 className="text-[13px] font-medium text-inkMuted dark:text-inkMutedDark uppercase tracking-wide mb-3">
                  Recent activity
                </h2>
                {feedGroups.length === 0 && (
                  <p className="text-[13px] text-inkMuted dark:text-inkMutedDark">
                    Nothing copied yet -- start using FatClipboard and it'll show up here.
                  </p>
                )}
                {/* One boxed card per date, rows divided by hairlines inside
                    it -- same treatment as the quick panel's Pinned/Today
                    sections in App.tsx (rounded card, tinted background,
                    subtle ring, dividers between rows instead of gaps
                    between separate little boxes), so the two feeds read as
                    the same product instead of two different list styles. */}
                {feedGroups.map((group) => (
                  <div key={group.label} className="mb-5">
                    <p className="text-[11px] font-medium text-inkMuted dark:text-inkMutedDark mb-2">
                      {group.label}
                    </p>
                    <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden">
                      {group.entries.map((item, idx) => {
                        const isExpanded = expandedId === item.id;
                        return (
                        <div key={item.id} className="group">
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                            className="flex items-start gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
                          >
                            {/* Date+time now sits below the content, same
                                layout as the quick panel's History rows
                                (formatTimestamp -- "Jun 18, 2:30 PM" --
                                under the text, not a separate time column
                                to the left). min-w-0 alongside flex-1 is
                                what actually lets the content line-clamp
                                instead of overflowing -- flex-1 alone
                                doesn't let a flex child shrink past its
                                intrinsic content width (same bug as the
                                quick panel's search input, fixed earlier).
                                Clicking the row toggles expandedId so the
                                clamp lifts and the full text shows, for
                                items that don't fit in two lines. */}
                            <div className="flex-1 min-w-0">
                              <ClampedText
                                text={item.content}
                                lines={2}
                                className="text-[13px] leading-snug whitespace-pre-wrap break-words"
                                expanded={isExpanded}
                                onToggleExpanded={() =>
                                  setExpandedId((cur) => (cur === item.id ? null : item.id))
                                }
                                secret={blurSecrets && !!item.is_secret}
                              />
                              <p className="text-[10.5px] text-inkMuted dark:text-inkMutedDark mt-1">
                                {formatTimestamp(item.created_at)}
                              </p>
                            </div>

                            {/* Hover-reveal Copy / Edit(-with-AI) actions --
                                same opacity-0 -> group-hover:opacity
                                convention used for row actions everywhere
                                else in this app (History rows, folder item
                                rows, screenshot tiles). stopPropagation so
                                clicking a button doesn't also toggle the
                                row's own expand/collapse. */}
                            <div className="shrink-0 flex items-center gap-1 pt-0.5">
                              {item.category && item.category !== "text" && (
                                <span className="text-[10px] text-inkMuted dark:text-inkMutedDark mr-1">
                                  {categoryLabel(item.category)}
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyItem(item);
                                }}
                                title="Copy"
                                className={`w-6 h-6 flex items-center justify-center rounded-md transition-opacity ${
                                  copiedId === item.id
                                    ? "opacity-100 text-accent dark:text-accentDark"
                                    : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark"
                                }`}
                              >
                                <i className={`ti ${copiedId === item.id ? "ti-check" : "ti-copy"} text-[14px]`} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTransformingId(item.id);
                                }}
                                title="Edit with AI"
                                className="w-6 h-6 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark transition-opacity"
                              >
                                <i className="ti ti-sparkles text-[14px]" />
                              </button>
                            </div>
                          </div>
                          {idx !== group.entries.length - 1 && (
                            <div className="mx-3.5 border-b border-black/[0.05] dark:border-white/[0.07]" />
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Compact stat stack -- the fuller breakdown (category bars,
                  heatmap) lives in Insights so Home stays quick to scan,
                  same split as Wispr's own Home vs. Your Usage tabs. */}
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[26px] font-semibold leading-none">
                    {stats ? stats.total_clips_saved.toLocaleString() : "--"}
                  </span>
                  <span className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    clips saved
                  </span>
                </div>
                <div className="h-px bg-borderLight dark:bg-borderDark my-3" />
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[26px] font-semibold leading-none">
                    {stats ? stats.transforms_run.toLocaleString() : "--"}
                  </span>
                  <span className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    AI transforms run
                  </span>
                </div>
                <div className="h-px bg-borderLight dark:bg-borderDark my-3" />
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[26px] font-semibold leading-none">{streak}</span>
                  <span className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    day streak
                  </span>
                </div>
                {tier === "pro" && (
                  <>
                    <div className="h-px bg-borderLight dark:bg-borderDark my-3" />
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[26px] font-semibold leading-none">
                        {stats ? stats.total_screenshots_saved.toLocaleString() : "--"}
                      </span>
                      <span className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                        screenshots saved
                      </span>
                    </div>
                  </>
                )}
                <button
                  onClick={() => setNav("insights")}
                  className="w-full mt-3.5 text-[12px] py-1.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors"
                >
                  View full insights
                </button>
              </div>
            </div>
          </div>
          <AnimatePresence>
            {transformingItem && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "58%", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="shrink-0 overflow-hidden border-t border-borderLight dark:border-borderDark bg-creamSurface dark:bg-charcoalSurface"
              >
                <TransformBar
                  content={transformingItem.content}
                  onDone={() => setTransformingId(null)}
                  onCancel={() => setTransformingId(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>
          </div>
        )}

        {nav === "insights" && (
          <div className="flex-1 overflow-y-auto p-8">
            <h1 className="text-[22px] font-semibold mb-1">Insights</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark mb-7">
              How you're using FatClipboard, in more detail.
            </p>

            <div className={`grid gap-4 mb-4 ${tier === "pro" ? "grid-cols-5" : "grid-cols-4"}`}>
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[28px] font-semibold leading-none mb-1.5">
                  {stats ? stats.total_clips_saved.toLocaleString() : "--"}
                </p>
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">clips saved</p>
              </div>
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[28px] font-semibold leading-none mb-1.5">
                  {stats ? stats.transforms_run.toLocaleString() : "--"}
                </p>
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                  AI transforms run
                </p>
              </div>
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[28px] font-semibold leading-none mb-1.5">
                  {stats
                    ? new Intl.NumberFormat(undefined, {
                        notation: "compact",
                        maximumFractionDigits: 1,
                      }).format(stats.total_characters_captured)
                    : "--"}
                </p>
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                  characters captured
                </p>
              </div>
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[28px] font-semibold leading-none mb-1.5">{streak}</p>
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                  day streak
                  {/* Only shown once it actually differs from the current
                      streak -- "3 day streak, longest 3 days" is just noise
                      the moment you're already at your record. */}
                  {longestStreak > streak && (
                    <span className="opacity-70"> · longest {longestStreak}</span>
                  )}
                </p>
              </div>
              {tier === "pro" && (
                <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                  <p className="text-[28px] font-semibold leading-none mb-1.5">
                    {stats ? stats.total_screenshots_saved.toLocaleString() : "--"}
                  </p>
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    screenshots saved
                  </p>
                </div>
              )}
            </div>

            {/* This week vs. last week + busiest day -- both pure client-side
                reductions over the same daily_activity array the heatmap
                below already renders (see computeWeeklyComparison/
                computeBusiestWeekday), no extra backend query needed. */}
            <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4 mb-4 flex items-center gap-6">
              <div>
                <p className="text-[20px] font-semibold leading-none mb-1.5 flex items-center gap-1.5">
                  {weeklyComparison.thisWeek.toLocaleString()}
                  {stats && weeklyComparison.thisWeek !== weeklyComparison.lastWeek && (
                    <span
                      className={`text-[11px] font-medium px-1.5 py-[1px] rounded-full ${
                        weeklyComparison.thisWeek > weeklyComparison.lastWeek
                          ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark"
                          : "bg-black/[0.05] dark:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark"
                      }`}
                    >
                      {weeklyComparison.thisWeek > weeklyComparison.lastWeek ? "↑" : "↓"}{" "}
                      {weeklyComparison.lastWeek === 0
                        ? "new"
                        : `${Math.round(
                            (Math.abs(weeklyComparison.thisWeek - weeklyComparison.lastWeek) /
                              weeklyComparison.lastWeek) *
                              100
                          )}%`}
                    </span>
                  )}
                </p>
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                  clips saved, last 7 days
                </p>
              </div>
              {busiestWeekday && (
                <div className="pl-6 border-l border-black/[0.06] dark:border-white/[0.08]">
                  <p className="text-[20px] font-semibold leading-none mb-1.5">{busiestWeekday}</p>
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">busiest day</p>
                </div>
              )}
            </div>

            {/* Category breakdown */}
            <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4 mb-4">
              <p className="text-[12px] font-medium mb-3">Where your clips come from</p>
              {(stats?.categories.length ?? 0) === 0 && (
                <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                  Not enough data yet.
                </p>
              )}
              <div className="space-y-2">
                {stats?.categories.slice(0, 8).map((c, idx) => (
                  <div key={c.category} className="flex items-center gap-2">
                    <span className="text-[11px] w-24 shrink-0 truncate text-inkMuted dark:text-inkMutedDark">
                      {categoryLabel(c.category)}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.07] overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(6, (c.count / maxCategoryCount) * 100)}%`,
                          // FatClipboard violet (2026-08-12) -- same
                          // accent/accentDark hex values as
                          // tailwind.config.js, just inlined since this is
                          // a computed style, not a static class.
                          backgroundColor:
                            idx === 0
                              ? theme === "dark"
                                ? "#FD105E"
                                : "#313851"
                              : idx <= 2
                              ? theme === "dark"
                                ? "rgba(183,169,255,0.55)"
                                : "rgba(124,111,227,0.55)"
                              : theme === "dark"
                              ? "rgba(183,169,255,0.3)"
                              : "rgba(124,111,227,0.3)",
                        }}
                      />
                    </div>
                    <span className="text-[11px] w-16 text-right text-inkMuted dark:text-inkMutedDark">
                      {c.count}
                      {totalCategoryCount > 0 && (
                        <span className="opacity-70">
                          {" "}
                          ({Math.round((c.count / totalCategoryCount) * 100)}%)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Folders + top presets, side by side -- two smaller cards
                rather than one, since they're unrelated stats that both
                happen to be short lists. */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[12px] font-medium mb-3">Folders</p>
                {!stats || stats.folders.folder_count === 0 ? (
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    No folders yet.
                  </p>
                ) : (
                  <div className="space-y-2 text-[12px]">
                    <div className="flex items-center justify-between">
                      <span className="text-inkMuted dark:text-inkMutedDark">Folders</span>
                      <span className="font-medium">{stats.folders.folder_count.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-inkMuted dark:text-inkMutedDark">Items filed</span>
                      <span className="font-medium">{stats.folders.item_count.toLocaleString()}</span>
                    </div>
                    {stats.folders.most_used_folder && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-inkMuted dark:text-inkMutedDark">Most used</span>
                        <span className="font-medium truncate">
                          {stats.folders.most_used_folder.name} ({stats.folders.most_used_folder.count})
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
                <p className="text-[12px] font-medium mb-3">Top presets used</p>
                {!stats || stats.top_presets.length === 0 ? (
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    Not enough data yet.
                  </p>
                ) : (
                  <div className="space-y-2 text-[12px]">
                    {stats.top_presets.slice(0, 5).map((p) => (
                      <div key={p.label} className="flex items-center justify-between gap-2">
                        <span className="truncate">{p.label}</span>
                        <span className="text-inkMuted dark:text-inkMutedDark shrink-0">
                          {p.count.toLocaleString()}×
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Streak heatmap */}
            <div className="rounded-xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
              <p className="text-[12px] font-medium mb-3">Activity, last 12 weeks</p>
              <div className="flex gap-[3px] overflow-x-auto pb-1">
                {heatmapWeeks.map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-[3px]">
                    {week.map((day) => (
                      <div
                        key={day.date}
                        title={`${day.date}: ${day.count} clip${day.count === 1 ? "" : "s"}`}
                        className="w-3 h-3 rounded-[3px]"
                        style={{
                          backgroundColor: heatColor(day.count, maxDailyCount, theme === "dark"),
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {nav === "folders" && (
          <div className="flex-1 min-h-0 flex flex-col p-8">
            <h1 className="text-[22px] font-semibold mb-1">Folders</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark mb-5">
              Same folders as the quick panel -- anything you add or remove here shows up
              there too.
            </p>
            {/* Full-width now (2026-08-07) -- this used to sit in a centered
                max-w-md column (a leftover from FoldersPanel's original home,
                the ~320px-wide docked quick panel), which left this whole
                view looking like a narrow strip floating in the middle of an
                otherwise full-width window, unlike Home's activity feed
                right next to it in the sidebar. Same ring/shadow card
                treatment as Home's activity feed now too, not just the width
                -- bg-creamSurface + rounded-xl alone (no ring/shadow) read
                flatter than every other card on this page. */}
            <div className="flex-1 min-h-0 flex flex-col bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark rounded-xl overflow-hidden">
              {/* onStartPasteQueue is required by FoldersPanel but has no
                  meaning here: sequential ("Stack") paste is driven by the
                  quick panel's hotkey/hide cycle (see App.tsx's pasteQueue),
                  which this window has no equivalent of. A no-op keeps
                  "Start" from throwing; FoldersPanel still clears its own
                  selection afterwards. */}
              <FoldersPanel onPasted={() => {}} tier={tier} onStartPasteQueue={() => {}} />
            </div>
          </div>
        )}

        {nav === "settings" && (
          <div className="flex-1 min-h-0 flex flex-col p-8">
            <h1 className="text-[22px] font-semibold mb-1">Settings</h1>
            <p className="text-[13px] text-inkMuted dark:text-inkMutedDark mb-5">
              Same settings as the quick panel -- changes here apply everywhere.
            </p>
            <div className="w-full flex-1 min-h-0 flex flex-col bg-creamSurface dark:bg-charcoalSurface rounded-xl overflow-hidden">
              <SettingsPanel
                onClose={() => setNav("home")}
                onThemeChange={setTheme}
                onTierChange={setTier}
                onFirstNameChange={setFirstName}
                onLoggedOut={() => setAuthToken("")}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
