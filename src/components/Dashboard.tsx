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
import fatClipboardLogo from "../assets/fatclipboard-wordmark.png";
import ClampedText from "./ClampedText";

// The Dashboard window (src-tauri/tauri.conf.json label "dashboard", opened
// via the tray icon click / "Open Dashboard" menu item -- see open_dashboard
// in main.rs) is deliberately separate from the docked quick-access panel
// (App.tsx / window label "main"). The quick panel is for fast search-and-
// paste; this is the slower, browsable "how am I using Clip" view.
//
// The four sidebar destinations:
// - Home: greeting, a stat row above the fold, the recent-activity feed and
//   a right rail (pinned clips, most-used folder, a jump to Insights).
// - Insights: the fuller stats view -- tiles, a three-up strip, the category
//   breakdown, top presets, and the 12-week heatmap.
// - Folders: a two-pane browser. The folder list on the left is local to
//   this file; the contents pane is FoldersPanel driven by openFolderId, so
//   every folder action (rename, add, stack, delete) keeps its existing
//   behaviour and its existing backend commands.
// - Settings: SettingsPanel, in the design's 720px column.
//
// Folders and Settings share their components with the quick panel, so they
// share the same SQLite connection (see AppState in main.rs): anything
// changed in one window shows up in the other.

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

// Only the fields the left-hand folder list needs. list_folders returns
// more (parent_id, subfolder_count) -- see db.rs -- but the contents pane is
// FoldersPanel's job, so this list stays deliberately thin.
interface FolderSummary {
  id: number;
  name: string;
  item_count: number;
  pinned: boolean;
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

// The accent as raw channels, matching tailwind.config.js's `accent` and
// `accentDark`. These are the ONLY colour literals in this file, and they
// exist because the heatmap and the category bars need the accent at a
// computed alpha per cell -- a ramp Tailwind can't express as a class.
// Everything else uses the palette classes.
//
// These used to be the pre-rebrand violet (124,111,227 / 183,169,255), which
// survived the 2026-08-31 palette swap because it was inlined here rather
// than living in the config like every other colour.
const ACCENT_RGB = { light: "49,56,81", dark: "253,16,94" };

function heatColor(count: number, max: number, isDark: boolean): string {
  if (count === 0) return isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const intensity = Math.min(1, count / Math.max(max, 1));
  const rgb = isDark ? ACCENT_RGB.dark : ACCENT_RGB.light;
  return `rgba(${rgb},${0.22 + intensity * 0.7})`;
}

// Top category at full strength, the next two at 0.55, the tail at 0.30 --
// enough to rank them without turning the card into eight different colours.
function categoryBarColor(idx: number, isDark: boolean): string {
  const rgb = isDark ? ACCENT_RGB.dark : ACCENT_RGB.light;
  const alpha = idx === 0 ? 1 : idx <= 2 ? 0.55 : 0.3;
  return `rgba(${rgb},${alpha})`;
}

// Primary nav (what you're browsing) vs. account-level actions (Settings /
// theme / Log out) are split into two groups -- Settings used to live in
// this same list, mixed in with Home/Insights/Folders, which read oddly
// next to a Log out action that has nowhere else to live.
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

const CARD =
  "rounded-2xl border border-borderLight dark:border-borderDark bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark";
const NAV_ROW = "flex items-center gap-[11px] rounded-xl px-[11px] py-[9px] text-[13px] text-left transition-colors";
const NAV_IDLE = "text-ink dark:text-cream hover:bg-black/[0.04] dark:hover:bg-white/[0.05]";
const NAV_ACTIVE = "bg-accent/10 dark:bg-accentDark/15 text-accent dark:text-accentDark font-semibold";
const LABEL = "text-[11.5px] font-medium uppercase tracking-[0.07em] text-inkMuted dark:text-inkMutedDark";

// Shared by Home's "Last 7 days" tile and Insights' three-up strip. Returns
// null when there's nothing to compare against, so neither caller has to
// special-case an empty first week.
function DeltaChip({ thisWeek, lastWeek }: { thisWeek: number; lastWeek: number }) {
  if (thisWeek === lastWeek) return null;
  const up = thisWeek > lastWeek;
  const pct =
    lastWeek === 0
      ? "new"
      : `${Math.round((Math.abs(thisWeek - lastWeek) / lastWeek) * 100)}%`;
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-[2px] text-[11px] font-medium ${
        up
          ? "bg-accent/10 dark:bg-accentDark/15 text-accent dark:text-accentDark"
          : "bg-black/[0.05] dark:bg-white/[0.08] text-inkMuted dark:text-inkMutedDark"
      }`}
    >
      {up ? "↑" : "↓"} {pct}
    </span>
  );
}

// min-w-0 matters on every one of these: they're grid items, and without it
// a long figure pushes the track wider than its share and the row runs off
// the window edge (see the handoff's "Layout traps").
function StatTile({
  label,
  icon,
  value,
  trailing,
}: {
  label: string;
  icon?: string;
  value: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <span className="truncate text-[11.5px] text-inkMuted dark:text-inkMutedDark">{label}</span>
        {trailing ?? <i className={`ti ${icon} shrink-0 text-[14px] text-inkFaint dark:text-inkFaintDark`} />}
      </div>
      <div className="text-[27px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [tier, setTier] = useState<"free" | "pro">("free");
  const [firstName, setFirstName] = useState("");

  // Re-evaluated every minute and whenever the window comes back into view.
  // This window is hidden and shown rather than remounted, so a greeting
  // computed once at render stayed "Good morning" all afternoon (2026-09-03).
  const [greeting, setGreeting] = useState(timeOfDayGreeting);
  useEffect(() => {
    const update = () => setGreeting(timeOfDayGreeting());
    const timer = setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [history, setHistory] = useState<ClipEntry[]>([]);
  const [nav, setNav] = useState("home");
  // Same first-use gate as App.tsx's quick panel -- see main.rs's needs_auth
  // check. null = "haven't checked get_settings yet", "" = logged out.
  const [authToken, setAuthToken] = useState<string | null>(null);
  // Same onboarding gate as App.tsx -- see settings.rs::onboarding_complete.
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  // Recent-activity feed row interactions: expandedId -- click-to-expand a
  // row past its 2-line clamp; transformingId -- drives the bottom
  // TransformBar drawer, the same component/pattern FoldersPanel uses for
  // its own row-level "Transform with AI"; copiedId -- brief "Copied"
  // feedback after the Copy button fires.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [transformingId, setTransformingId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // Bottom-of-sidebar "Help & about" popover -- there's no dedicated help
  // screen anywhere in the app yet, so this stays a lightweight inline panel
  // rather than a new nav route.
  const [showHelp, setShowHelp] = useState(false);
  // Same fail-safe-blurred default and reasoning as App.tsx's blurSecrets.
  const [blurSecrets, setBlurSecrets] = useState(true);
  // One-shot "what's new" banner -- see App.tsx's updateNotice for the full
  // explanation. Whichever window asks first each launch shows it.
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  // Folders screen: the left pane's list, and which folder the right pane
  // (FoldersPanel) is showing.
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [startCreatingFolder, setStartCreatingFolder] = useState(false);

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

  // Top-level folders for the left pane. Reloaded whenever the Folders
  // screen is entered so a folder created in the right pane (or in the quick
  // panel, which writes to the same database) shows up without a restart.
  function loadFolders() {
    invoke<FolderSummary[]>("list_folders", { parentId: null })
      .then((list) => {
        setFolders(list);
        // Keep a folder selected: FoldersPanel renders its own folder list
        // when nothing is open, which would duplicate the left pane.
        setSelectedFolderId((cur) =>
          cur != null && list.some((f) => f.id === cur) ? cur : list[0]?.id ?? null
        );
      })
      .catch(console.error);
  }

  useEffect(() => {
    if (nav === "folders" && authToken) loadFolders();
  }, [nav, authToken]);

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
  const pinnedClips = useMemo(() => history.filter((h) => h.pinned).slice(0, 2), [history]);

  // Sets the OS clipboard without simulating Ctrl+V (see copy_to_clipboard's
  // doc comment in main.rs) -- this window has no "hand control back to
  // whatever app was focused" moment the way the docked quick panel does.
  async function copyItem(item: ClipEntry) {
    await invoke("copy_to_clipboard", { text: item.content });
    setCopiedId(item.id);
    setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1500);
  }

  // Same auth_logout command SettingsPanel's own "Log out" button calls --
  // duplicated here (rather than reused) since this is a plain sidebar
  // button, not the full SettingsPanel component.
  async function logOut() {
    await invoke("auth_logout");
    setAuthToken("");
  }

  const transformingItem = history.find((h) => h.id === transformingId) ?? null;
  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;

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
      {/* One-shot "what's new" toast -- fixed/overlaid rather than inline so
          it shows above whichever nav section is active, instead of needing
          to be duplicated into each one. */}
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
      <aside className="w-[228px] shrink-0 border-r border-borderLight dark:border-borderDark flex flex-col pt-[18px] px-[14px] pb-[14px]">
        <div className="flex items-center gap-2 px-1 mb-5">
          {/* The wordmark is the logo, not an accent: its pink stays pink in
              both themes and is never re-themed. */}
          <img src={fatClipboardLogo} alt="FatClipboard" className="h-4 w-auto" />
          <span
            className={`ml-auto shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.07em] ${
              tier === "pro"
                ? "bg-accentFill dark:bg-accentFillDark text-accent dark:text-accentDark"
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
              className={`${NAV_ROW} ${nav === item.key ? NAV_ACTIVE : NAV_IDLE}`}
            >
              <i className={`ti ${item.icon} text-[16px]`} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {tier !== "pro" && (
          <div className="rounded-2xl bg-accentFill dark:bg-accentFillDark p-3.5 mb-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold mb-1">
              <i className="ti ti-sparkles text-[13px] text-accent dark:text-accentDark" />
              Unlimited history + AI
            </p>
            <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mb-2.5">
              Unlimited clips, folders, and AI transforms.
            </p>
            <button
              onClick={() => setNav("settings")}
              className="w-full rounded-lg bg-ink dark:bg-cream py-1.5 text-[12px] font-semibold text-cream dark:text-charcoal"
            >
              Upgrade to Pro
            </button>
          </div>
        )}

        {/* Account group -- Settings / theme / Help / Log out, split from the
            Home/Insights/Folders nav above by a hairline so account-level
            actions read as a distinct group instead of just more pages. */}
        <div className="relative border-t border-borderLight dark:border-borderDark pt-2">
          <button
            onClick={() => setNav("settings")}
            className={`w-full ${NAV_ROW} ${nav === "settings" ? NAV_ACTIVE : NAV_IDLE}`}
          >
            <i className="ti ti-settings text-[16px]" />
            Settings
          </button>
          {/* The theme control is reachable from the sidebar now rather than
              only from inside Settings. It writes through save_settings, the
              same command SettingsPanel's own toggle uses, so the two stay in
              agreement and the choice survives a restart. */}
          <button
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              invoke("save_settings", { settings: { theme: next } }).catch(console.error);
            }}
            className={`w-full ${NAV_ROW} ${NAV_IDLE}`}
          >
            <i className="ti ti-contrast text-[16px]" />
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className={`w-full ${NAV_ROW} ${NAV_IDLE}`}
          >
            <i className="ti ti-help-circle text-[16px]" />
            Help &amp; about
          </button>
          <button onClick={logOut} className={`w-full ${NAV_ROW} ${NAV_IDLE}`}>
            <i className="ti ti-logout text-[16px]" />
            Log out
          </button>

          {showHelp && (
            <div className="absolute bottom-full left-1 mb-2 w-64 rounded-2xl border border-borderLight dark:border-borderDark bg-creamSurface dark:bg-charcoalSurface shadow-float dark:shadow-floatDark p-4 z-10">
              <div className="flex items-center gap-2 mb-2">
                <img src={fatClipboardLogo} alt="FatClipboard" className="h-3.5 w-auto" />
                <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">v0.1.0</span>
              </div>
              <p className="text-[12px] text-inkMuted dark:text-inkMutedDark mb-3">
                Copy, transform, and organize everything you copy.
              </p>
              <a
                href="mailto:support@clipapp.io"
                className="block w-full rounded-lg bg-black/[0.05] dark:bg-white/[0.08] py-1.5 text-center text-[12px] transition-colors hover:bg-black/[0.08] dark:hover:bg-white/[0.12]"
              >
                Contact support
              </a>
            </div>
          )}
        </div>
      </aside>

      {/* --- Main content --------------------------------------------- */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {nav === "home" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-w-0 overflow-y-auto px-9 pt-[34px] pb-10">
              {/* Header row: greeting, and the streak as a card-height pill.
                  nowrap + shrink-0 on the pill, or it breaks onto two lines
                  as the window narrows. */}
              <div className="flex items-start justify-between gap-5 mb-6">
                <div className="min-w-0">
                  <h1 className="text-[23px] font-semibold tracking-[-0.015em]">
                    {greeting}
                    {firstName ? `, ${firstName}` : ""}.
                  </h1>
                  <p className="mt-1 text-[13.5px] text-inkMuted dark:text-inkMutedDark">
                    Here's how you've been using FatClipboard.
                  </p>
                </div>
                {streak > 0 && (
                  <div
                    className={`${CARD} shrink-0 whitespace-nowrap flex items-center gap-2 px-3.5 py-2.5 text-[12.5px]`}
                  >
                    <i className="ti ti-flame text-[14px] text-accent dark:text-accentDark" />
                    <span>
                      <strong className="font-semibold">{streak}-day</strong> streak
                    </span>
                  </div>
                )}
              </div>

              {/* Stat row, above the fold. This is the main structural change:
                  the stats used to be a vertical stack in the right column,
                  so the greeting was immediately followed by a wall of feed. */}
              <div
                className={`grid gap-3 mb-6 ${
                  tier === "pro"
                    ? "grid-cols-[repeat(4,minmax(0,1fr))]"
                    : "grid-cols-[repeat(3,minmax(0,1fr))]"
                }`}
              >
                <StatTile
                  label="Clips saved"
                  icon="ti-clipboard"
                  value={stats ? stats.total_clips_saved.toLocaleString() : "--"}
                />
                <StatTile
                  label="AI transforms"
                  icon="ti-sparkles"
                  value={stats ? stats.transforms_run.toLocaleString() : "--"}
                />
                {tier === "pro" && (
                  <StatTile
                    label="Screenshots"
                    icon="ti-camera"
                    value={stats ? stats.total_screenshots_saved.toLocaleString() : "--"}
                  />
                )}
                <StatTile
                  label="Last 7 days"
                  value={weeklyComparison.thisWeek.toLocaleString()}
                  trailing={
                    stats ? (
                      <DeltaChip
                        thisWeek={weeklyComparison.thisWeek}
                        lastWeek={weeklyComparison.lastWeek}
                      />
                    ) : undefined
                  }
                />
              </div>

              <div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] gap-[22px] items-start">
                {/* Recent activity feed */}
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <h2 className={LABEL}>Recent activity</h2>
                  </div>
                  {feedGroups.length === 0 && (
                    <p className="text-[13px] text-inkMuted dark:text-inkMutedDark">
                      Nothing copied yet -- start using FatClipboard and it'll show up here.
                    </p>
                  )}
                  {feedGroups.map((group) => (
                    <div key={group.label} className="mb-5">
                      <p className="mb-2 text-[11.5px] font-medium text-inkMuted dark:text-inkMutedDark">
                        {group.label}
                      </p>
                      <div className={`${CARD} overflow-hidden`}>
                        {group.entries.map((item, idx) => {
                          const isExpanded = expandedId === item.id;
                          return (
                            <div
                              key={item.id}
                              role="button"
                              tabIndex={0}
                              onClick={() =>
                                setExpandedId((cur) => (cur === item.id ? null : item.id))
                              }
                              className={`group flex cursor-pointer items-start gap-3 px-4 py-[13px] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05] ${
                                idx !== 0
                                  ? "border-t border-black/[0.07] dark:border-white/[0.07]"
                                  : ""
                              }`}
                            >
                              {/* min-w-0 alongside flex-1 is what actually lets
                                  the content clamp instead of overflowing --
                                  flex-1 alone doesn't let a flex child shrink
                                  past its intrinsic content width. */}
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
                                <p className="mt-1 text-[10.5px] text-inkFaint dark:text-inkFaintDark">
                                  {formatTimestamp(item.created_at)}
                                </p>
                              </div>

                              {item.category && item.category !== "text" && (
                                <span className="shrink-0 whitespace-nowrap rounded-full bg-pillTint dark:bg-pillTintDark px-2 py-[3px] text-[10px] text-inkMuted dark:text-inkMutedDark">
                                  {categoryLabel(item.category)}
                                </span>
                              )}

                              {/* Hover-reveal actions -- same opacity-0 ->
                                  group-hover convention used for row actions
                                  everywhere else. stopPropagation so clicking
                                  a button doesn't also toggle the row's own
                                  expand/collapse. */}
                              <div className="shrink-0 flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyItem(item);
                                  }}
                                  title="Copy"
                                  className={`flex h-6 w-6 items-center justify-center rounded-md transition-opacity ${
                                    copiedId === item.id
                                      ? "opacity-100 text-accent dark:text-accentDark"
                                      : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkFaint dark:text-inkFaintDark"
                                  }`}
                                >
                                  <i
                                    className={`ti ${
                                      copiedId === item.id ? "ti-check" : "ti-copy"
                                    } text-[15px]`}
                                  />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTransformingId(item.id);
                                  }}
                                  title="Edit with AI"
                                  className="flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 text-inkFaint dark:text-inkFaintDark"
                                >
                                  <i className="ti ti-sparkles text-[15px]" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setNav("folders");
                                  }}
                                  title="Add to a folder"
                                  className="flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 text-inkFaint dark:text-inkFaintDark"
                                >
                                  <i className="ti ti-folder-plus text-[15px]" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Right rail. min-w-0 on the column and on each card, or the
                    Pinned card's long URLs push it past the window edge. */}
                <div className="min-w-0 flex flex-col gap-3">
                  <div className={`${CARD} min-w-0 p-4`}>
                    <p className={`${LABEL} mb-2.5`}>Pinned</p>
                    {pinnedClips.length === 0 ? (
                      <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                        Nothing pinned yet.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2.5">
                        {pinnedClips.map((item) => (
                          <div key={item.id} className="flex items-start gap-2.5 min-w-0">
                            <i className="ti ti-pinned-filled mt-[2px] shrink-0 text-[13px] text-accent dark:text-accentDark" />
                            <div className="min-w-0">
                              <div className="truncate text-[13px]">{item.content}</div>
                              <div className="text-[10.5px] text-inkFaint dark:text-inkFaintDark">
                                {categoryLabel(item.category)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className={`${CARD} min-w-0 p-4`}>
                    <p className={`${LABEL} mb-2.5`}>Most used folder</p>
                    {stats?.folders.most_used_folder ? (
                      <>
                        <div className="flex items-start gap-2.5 min-w-0 mb-3">
                          <i className="ti ti-folder mt-[2px] shrink-0 text-[13px] text-accent dark:text-accentDark" />
                          <div className="min-w-0">
                            <div className="truncate text-[13px]">
                              {stats.folders.most_used_folder.name}
                            </div>
                            <div className="text-[10.5px] text-inkFaint dark:text-inkFaintDark">
                              {stats.folders.most_used_folder.count} of {stats.folders.item_count}{" "}
                              items filed
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => setNav("folders")}
                          className="w-full rounded-lg bg-black/[0.05] dark:bg-white/[0.08] py-1.5 text-[12px] transition-colors hover:bg-black/[0.08] dark:hover:bg-white/[0.12]"
                        >
                          Open folders
                        </button>
                      </>
                    ) : (
                      <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                        No folders yet.
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => setNav("insights")}
                    className={`${CARD} min-w-0 flex items-center justify-between gap-2 px-4 py-3 text-[12.5px] font-medium transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]`}
                  >
                    View full insights
                    <i className="ti ti-arrow-right shrink-0 text-[15px] text-accent dark:text-accentDark" />
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
          <div className="flex-1 min-w-0 overflow-y-auto px-9 pt-[34px] pb-10">
            <h1 className="text-[23px] font-semibold tracking-[-0.015em]">Insights</h1>
            <p className="mt-1 mb-6 text-[13.5px] text-inkMuted dark:text-inkMutedDark">
              How you're using FatClipboard, in more detail.
            </p>

            <div
              className={`grid gap-3 mb-3 ${
                tier === "pro"
                  ? "grid-cols-[repeat(5,minmax(0,1fr))]"
                  : "grid-cols-[repeat(4,minmax(0,1fr))]"
              }`}
            >
              <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
                <p className="text-[29px] font-semibold leading-none tracking-[-0.02em] mb-2">
                  {stats ? stats.total_clips_saved.toLocaleString() : "--"}
                </p>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">clips saved</p>
              </div>
              <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
                <p className="text-[29px] font-semibold leading-none tracking-[-0.02em] mb-2">
                  {stats ? stats.transforms_run.toLocaleString() : "--"}
                </p>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                  AI transforms run
                </p>
              </div>
              <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
                <p className="text-[29px] font-semibold leading-none tracking-[-0.02em] mb-2">
                  {stats
                    ? new Intl.NumberFormat(undefined, {
                        notation: "compact",
                        maximumFractionDigits: 1,
                      }).format(stats.total_characters_captured)
                    : "--"}
                </p>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                  characters captured
                </p>
              </div>
              <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
                <p className="text-[29px] font-semibold leading-none tracking-[-0.02em] mb-2">
                  {streak}
                </p>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                  day streak
                  {/* Only shown once it actually differs from the current
                      streak -- "3 day streak, longest 3" is just noise the
                      moment you're already at your record. */}
                  {longestStreak > streak && (
                    <span className="text-inkFaint dark:text-inkFaintDark">
                      {" "}
                      · longest {longestStreak}
                    </span>
                  )}
                </p>
              </div>
              {tier === "pro" && (
                <div className={`${CARD} min-w-0 px-4 py-[14px]`}>
                  <p className="text-[29px] font-semibold leading-none tracking-[-0.02em] mb-2">
                    {stats ? stats.total_screenshots_saved.toLocaleString() : "--"}
                  </p>
                  <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                    screenshots saved
                  </p>
                </div>
              )}
            </div>

            {/* Three-up strip. All three are pure client-side reductions over
                the same daily_activity array the heatmap renders -- no extra
                backend query. */}
            <div className={`${CARD} mb-3 grid grid-cols-[repeat(3,minmax(0,1fr))]`}>
              <div className="min-w-0 px-[34px] py-5">
                <div className="flex items-center gap-2 mb-1.5">
                  <i className="ti ti-calendar-week shrink-0 text-[16px] text-inkFaint dark:text-inkFaintDark" />
                  <span className="text-[21px] font-semibold leading-none tracking-[-0.02em]">
                    {weeklyComparison.thisWeek.toLocaleString()}
                  </span>
                  {stats && (
                    <DeltaChip
                      thisWeek={weeklyComparison.thisWeek}
                      lastWeek={weeklyComparison.lastWeek}
                    />
                  )}
                </div>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                  clips saved, last 7 days
                </p>
              </div>
              <div className="min-w-0 border-l border-black/[0.07] dark:border-white/[0.07] px-[34px] py-5">
                <div className="flex items-center gap-2 mb-1.5">
                  <i className="ti ti-trending-up shrink-0 text-[16px] text-inkFaint dark:text-inkFaintDark" />
                  <span className="truncate text-[21px] font-semibold leading-none tracking-[-0.02em]">
                    {busiestWeekday ?? "--"}
                  </span>
                </div>
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark">busiest day</p>
              </div>
              <div className="min-w-0 border-l border-black/[0.07] dark:border-white/[0.07] px-[34px] py-5">
                <div className="flex items-center gap-2 mb-1.5">
                  <i className="ti ti-folder shrink-0 text-[16px] text-inkFaint dark:text-inkFaintDark" />
                  <span className="text-[21px] font-semibold leading-none tracking-[-0.02em]">
                    {stats ? stats.folders.folder_count.toLocaleString() : "--"}
                  </span>
                </div>
                <p className="truncate text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                  folders · {stats ? stats.folders.item_count.toLocaleString() : "--"} items filed
                </p>
              </div>
            </div>

            {/* Category breakdown + top presets */}
            <div className="grid grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-3 mb-3">
              <div className={`${CARD} min-w-0 p-4`}>
                <p className="mb-3 text-[11.5px] font-semibold">Where your clips come from</p>
                {(stats?.categories.length ?? 0) === 0 && (
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    Not enough data yet.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {stats?.categories.slice(0, 8).map((c, idx) => (
                    <div key={c.category} className="flex items-center gap-2.5">
                      <span className="w-[82px] shrink-0 truncate text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                        {categoryLabel(c.category)}
                      </span>
                      <div className="h-2 flex-1 min-w-0 overflow-hidden rounded-full bg-pillTint dark:bg-pillTintDark">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(4, (c.count / maxCategoryCount) * 100)}%`,
                            backgroundColor: categoryBarColor(idx, theme === "dark"),
                          }}
                        />
                      </div>
                      {/* One 82px column per the design, but count and pct
                          are separate cells with their own gap -- run
                          together as plain text ("17 9%") they read as one
                          number. */}
                      <span className="flex w-[82px] shrink-0 items-baseline justify-end gap-2 whitespace-nowrap text-[11.5px] text-inkMuted dark:text-inkMutedDark">
                        <span>{c.count.toLocaleString()}</span>
                        {totalCategoryCount > 0 && (
                          <span className="text-inkFaint dark:text-inkFaintDark">
                            {Math.round((c.count / totalCategoryCount) * 100)}%
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${CARD} min-w-0 p-4`}>
                <p className="mb-3 text-[11.5px] font-semibold">Top presets used</p>
                {!stats || stats.top_presets.length === 0 ? (
                  <p className="text-[12px] text-inkMuted dark:text-inkMutedDark">
                    Not enough data yet.
                  </p>
                ) : (
                  <div>
                    {stats.top_presets.slice(0, 5).map((p, idx) => (
                      <div
                        key={p.label}
                        className={`flex items-center justify-between gap-2 py-2 text-[12.5px] ${
                          idx !== stats.top_presets.slice(0, 5).length - 1
                            ? "border-b border-black/[0.07] dark:border-white/[0.07]"
                            : ""
                        }`}
                      >
                        <span className="truncate">{p.label}</span>
                        <span className="shrink-0 whitespace-nowrap text-inkMuted dark:text-inkMutedDark">
                          {p.count.toLocaleString()}×
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Streak heatmap */}
            <div className={`${CARD} p-4`}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[11.5px] font-semibold">Activity, last 12 weeks</p>
                <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px] text-inkFaint dark:text-inkFaintDark">
                  Less
                  <span className="h-[11px] w-[11px] rounded-[3px] bg-pillTint dark:bg-pillTintDark" />
                  {[0.3, 0.58, 0.86].map((a) => (
                    <span
                      key={a}
                      className="h-[11px] w-[11px] rounded-[3px]"
                      style={{
                        backgroundColor: `rgba(${
                          theme === "dark" ? ACCENT_RGB.dark : ACCENT_RGB.light
                        },${a})`,
                      }}
                    />
                  ))}
                  More
                </div>
              </div>
              <div className="flex gap-1 overflow-x-auto pb-1">
                {heatmapWeeks.map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-1">
                    {week.map((day) => (
                      <div
                        key={day.date}
                        title={`${day.date}: ${day.count} clip${day.count === 1 ? "" : "s"}`}
                        className="h-[13px] w-[13px] shrink-0 rounded-[3px]"
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
          <div className="flex-1 min-w-0 min-h-0 flex flex-col px-9 pt-[34px] pb-10">
            <div className="mb-5 flex items-start justify-between gap-5">
              <div className="min-w-0">
                <h1 className="text-[23px] font-semibold tracking-[-0.015em]">Folders</h1>
                <p className="mt-1 text-[13.5px] text-inkMuted dark:text-inkMutedDark">
                  Same folders as the quick panel -- changes here show up there too.
                </p>
              </div>
              {/* Hands off to FoldersPanel's own create flow rather than
                  duplicating it, so naming, validation and the free-tier
                  folder cap all keep their existing behaviour. */}
              <button
                onClick={() => setStartCreatingFolder(true)}
                className="shrink-0 whitespace-nowrap flex items-center gap-1.5 rounded-lg bg-accent dark:bg-accentDark px-3 py-2 text-[12.5px] font-semibold text-white"
              >
                <i className="ti ti-folder-plus text-[14px]" />
                New folder
              </button>
            </div>

            {/* Two-pane browser. The left list is local to this file; the
                right pane is FoldersPanel driven by openFolderId, which is
                the prop it already had for the quick panel's jump-from-
                History flow. A folder stays selected at all times, because
                FoldersPanel renders its own folder list when nothing is
                open and that would duplicate the left pane. */}
            <div className="grid flex-1 min-h-0 grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-3">
              <div className={`${CARD} min-w-0 flex flex-col overflow-hidden p-2`}>
                <div className="flex-1 overflow-y-auto">
                  {folders.length === 0 ? (
                    <p className="p-3 text-[12px] text-inkMuted dark:text-inkMutedDark">
                      No folders yet.
                    </p>
                  ) : (
                    folders.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setSelectedFolderId(f.id)}
                        className={`w-full ${NAV_ROW} ${
                          selectedFolderId === f.id
                            ? "bg-accentFill dark:bg-accentFillDark text-accent dark:text-accentDark font-semibold"
                            : NAV_IDLE
                        }`}
                      >
                        <i className="ti ti-folder shrink-0 text-[15px]" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-[11.5px] text-inkFaint dark:text-inkFaintDark">
                          {f.item_count}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className={`${CARD} min-w-0 flex flex-col overflow-hidden`}>
                <FoldersPanel
                  onPasted={() => {}}
                  tier={tier}
                  contentsOnly
                  openFolderId={selectedFolderId}
                  onOpenedFolder={() => {}}
                  onMembershipsChanged={loadFolders}
                  startCreating={startCreatingFolder}
                  onStartedCreating={() => setStartCreatingFolder(false)}
                  /* onStartPasteQueue is required by FoldersPanel but has no
                     meaning here: sequential ("Stack") paste is driven by the
                     quick panel's hotkey/hide cycle, which this window has no
                     equivalent of. A no-op keeps "Start" from throwing. */
                  onStartPasteQueue={() => {}}
                />
              </div>
            </div>
            {selectedFolder === null && folders.length > 0 && (
              <p className="mt-2 text-[11.5px] text-inkFaint dark:text-inkFaintDark">
                Pick a folder to see what's in it.
              </p>
            )}
          </div>
        )}

        {nav === "settings" && (
          <div className="flex-1 min-w-0 min-h-0 flex flex-col px-9 pt-[34px] pb-10">
            <h1 className="text-[23px] font-semibold tracking-[-0.015em]">Settings</h1>
            <p className="mt-1 mb-5 text-[13.5px] text-inkMuted dark:text-inkMutedDark">
              Same settings as the quick panel -- changes here apply everywhere.
            </p>
            {/* The design's 720px reading column. SettingsPanel keeps its own
                grouping: it carries a good deal more than the four groups in
                the handoff (saved presets, email verification, plan changes,
                account deletion), and rebuilding it as four cards here would
                have dropped those. Deliberately *not* wrapped in CARD -- the
                panel already renders one card per group, and nesting those
                inside an outer card reads as a double border. */}
            <div className="w-full max-w-[720px] flex-1 min-h-0 flex flex-col overflow-hidden">
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
