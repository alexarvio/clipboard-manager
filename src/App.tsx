import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke, getCurrentWindow } from "./lib/tauriShim";
import { AnimatePresence, motion } from "framer-motion";
import SettingsPanel from "./components/SettingsPanel";
import AuthGate from "./components/AuthGate";
import Onboarding from "./components/Onboarding";
import FoldersPanel from "./components/FoldersPanel";
import ScreenshotsPanel from "./components/ScreenshotsPanel";
import TransformTab from "./components/TransformTab";
import FolderPicker from "./components/FolderPicker";
import PasteQueue, { type QueueEntry } from "./components/PasteQueue";
import ClampedText from "./components/ClampedText";
import { ALL_CATEGORIES } from "./lib/categories";
import { formatTimestamp, dateGroupLabel } from "./lib/dateFormat";
import { clampMenuPosition } from "./lib/menuPosition";
import fatClipboardLogo from "./assets/fatclipboard-logo.png";

export interface ClipItem {
  id: number;
  content: string;
  pinned: boolean;
  created_at: string;
  category: string;
}

export interface CustomFilter {
  name: string;
  prompt: string;
}

interface SemanticMatch {
  id: number;
  score: number;
}

const appWindow = getCurrentWindow();

export default function App() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ClipItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [jumpToPresets, setJumpToPresets] = useState(false);
  // Which of Settings' two independent preset-visibility tabs "manage
  // presets" should land on -- text clips or screenshots, depending on
  // which Transform panel the user clicked it from. See TransformBar's
  // `context` prop and SettingsPanel's own presetContext state.
  const [presetsJumpContext, setPresetsJumpContext] = useState<"text" | "screenshot">("text");
  // Content handed over to the Transform tab when "Transform" is clicked on
  // an existing History row, screenshot, or folder item -- see goToTransform
  // below and TransformTab's pendingInput prop. Replaces the old in-place
  // TransformBar sheet those views used to open over themselves with jumping
  // straight to Transform's full-size layout instead.
  const [pendingTransformInput, setPendingTransformInput] = useState<{
    content: string;
    seed: number;
    // Set when this came from a screenshot's OCR'd text (see
    // ScreenshotsPanel's onTransformItem) -- lets TransformTab show the
    // actual screenshot above its Input box instead of the hand-off looking
    // like a plain text paste with no visual link back to its source.
    sourceImage?: { thumb_data_uri: string; width: number; height: number; screenshot_id: number };
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  // Screenshots moved from its own top-level tab into a History sub-toggle
  // (2026-07-22) -- "Transform" took its old slot instead, as a standalone
  // freeform AI-transform tool (see TransformTab.tsx) rather than something
  // tied to an existing clip/folder item. historyView switches between the
  // text-clip list and the screenshot grid *within* the History tab.
  const [tab, setTab] = useState<"history" | "transform" | "folders">("history");
  const [historyView, setHistoryView] = useState<"clips" | "screenshots">("clips");
  const [folderPickerFor, setFolderPickerFor] = useState<number | null>(null);
  const [folderPickerPos, setFolderPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [folderMemberships, setFolderMemberships] = useState<
    Map<string, { id: number; name: string }[]>
  >(new Map());
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  const [requestNewFolder, setRequestNewFolder] = useState(false);
  const [stackBuilderIds, setStackBuilderIds] = useState<number[] | null>(null);
  const [pasteQueue, setPasteQueue] = useState<QueueEntry[] | null>(null);
  const [pasteQueueIndex, setPasteQueueIndex] = useState(0);
  const [pasteQueueKind, setPasteQueueKind] = useState<"history" | "folder">("history");
  // Text vs Smart search are now separate, explicit modes rather than a
  // silent merge (see semantic_search's doc comment in main.rs for why the
  // old merge-with-a-sparkle-icon approach was indistinguishable from a bug
  // when the semantic threshold was miscalibrated). Text is always the
  // default on open; Smart is Pro-gated the same way custom filters are.
  const [searchMode, setSearchMode] = useState<"text" | "smart">("text");
  const [smartResults, setSmartResults] = useState<{ item: ClipItem; score: number }[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);
  // Within Smart mode: rank by relevance score (default -- the whole point
  // of semantic search) or fall back to the same chronological order as
  // plain History, for when you remember roughly when you copied something
  // more than how well it matches.
  const [smartSortBy, setSmartSortBy] = useState<"score" | "recent">("score");

  const refreshFolderMemberships = useCallback(() => {
    invoke<{ content: string; folder_id: number; folder_name: string }[]>(
      "list_folder_memberships"
    )
      .then((rows) => {
        const map = new Map<string, { id: number; name: string }[]>();
        for (const r of rows) {
          const list = map.get(r.content) ?? [];
          list.push({ id: r.folder_id, name: r.folder_name });
          map.set(r.content, list);
        }
        setFolderMemberships(map);
      })
      .catch(console.error);
  }, []);
  const [pinLimitMsg, setPinLimitMsg] = useState(false);
  const [tier, setTier] = useState<"free" | "pro">("free");
  const [paywallMsg, setPaywallMsg] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [showDateMenu, setShowDateMenu] = useState(false);
  const [dateMenuPos, setDateMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [activeDatePreset, setActiveDatePreset] = useState<string | null>(null);
  const [dateMenuView, setDateMenuView] = useState<"list" | "custom">("list");
  const dateBtnRef = useRef<HTMLButtonElement>(null);
  const dateMenuRef = useRef<HTMLDivElement>(null);
  const [visibleCategories, setVisibleCategories] = useState<string[]>([
    "link",
    "email",
    "phone",
    "address",
    "bank_account",
  ]);
  const [customFilters, setCustomFilters] = useState<CustomFilter[]>([]);
  const [activeCustomFilter, setActiveCustomFilter] = useState<string | null>(null);
  const [customFilterIds, setCustomFilterIds] = useState<number[] | null>(null);
  const [customFilterLoading, setCustomFilterLoading] = useState(false);
  const [customFilterError, setCustomFilterError] = useState<string | null>(null);
  const [addingCustomFilter, setAddingCustomFilter] = useState(false);
  const [newFilterName, setNewFilterName] = useState("");
  const [newFilterPrompt, setNewFilterPrompt] = useState("");
  const [categoryMenuPos, setCategoryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const categoryMenuRef = useRef<HTMLDivElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  // Jumps to the Transform tab with `content` pre-loaded -- see
  // pendingTransformInput above and TransformTab's pendingInput prop.
  // `Date.now()` as the seed (not derived from content) is what makes
  // clicking Transform again on the very same item still re-apply it.
  // `sourceImage` (only passed from ScreenshotsPanel) carries the
  // screenshot's own thumbnail through so Transform can show it.
  function goToTransform(
    content: string,
    sourceImage?: { thumb_data_uri: string; width: number; height: number; screenshot_id: number }
  ) {
    setPendingTransformInput({ content, seed: Date.now(), sourceImage });
    setTab("transform");
  }

  useEffect(() => {
    invoke<{
      theme: "dark" | "light";
      tier: "free" | "pro";
      custom_filters?: CustomFilter[];
      visible_categories?: string[];
      auth_token?: string;
      user_email?: string;
      onboarding_complete?: boolean;
    }>("get_settings")
      .then((s) => {
        setTheme(s.theme);
        setTier(s.tier);
        setCustomFilters(s.custom_filters ?? []);
        if (s.visible_categories) setVisibleCategories(s.visible_categories);
        setAuthToken(s.auth_token ?? "");
        setUserEmail(s.user_email ?? "");
        setOnboardingComplete(s.onboarding_complete ?? false);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const SLIDE_MS = 200;
  function closeWithAnimation() {
    setOpen(false);
    setTimeout(() => {
      appWindow.hide();
    }, SLIDE_MS);
  }

  function dayBoundIso(date: string | null, endOfDay: boolean): string | null {
    if (!date) return null;
    if (date.includes("T")) return date;
    return `${date}T${endOfDay ? "23:59:59.999" : "00:00:00"}`;
  }

  const DATE_PRESETS: { label: string; hours: number }[] = [
    { label: "Last 24 hours", hours: 24 },
    { label: "Last week", hours: 24 * 7 },
    { label: "Last month", hours: 24 * 30 },
  ];

  function applyDatePreset(label: string, hours: number) {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    setDateFrom(from.toISOString());
    setDateTo(to.toISOString());
    setActiveDatePreset(label);
    setShowDateMenu(false);
  }

  const refresh = useCallback(
    async (q: string, category: string | null, from: string | null, to: string | null) => {
      try {
        const result = await invoke<ClipItem[]>("get_history", {
          query: q,
          category,
          // camelCase to match Tauri's default rename_all for command args
          // (get_history's Rust params are date_from/date_to) -- same
          // convention as folderId/parentId/orderedIds elsewhere in this file.
          dateFrom: dayBoundIso(from, false),
          dateTo: dayBoundIso(to, true),
        });
        setItems(result);
        setSelected(0);
      } catch (e) {
        console.error("get_history failed", e);
      }
    },
    []
  );

  useEffect(() => {
    const unlistenOpen = appWindow.listen("panel-open", () => {
      setQuery("");
      setShowSettings(false);
      setFolderPickerFor(null);
      setCopiedId(null);
      setExpandedId(null);
      setCategoryFilter(null);
      setActiveCustomFilter(null);
      setCustomFilterIds(null);
      setCustomFilterError(null);
      setDateFrom(null);
      setDateTo(null);
      setActiveDatePreset(null);
      setDateMenuView("list");
      setSearchMode("text");
      setSmartResults([]);
      setSmartError(null);
      setSmartSortBy("score");
      setStackBuilderIds(null);
      setOpen(true);
      refresh("", null, null, null);
      refreshFolderMemberships();
      setTimeout(() => inputRef.current?.focus(), 30);
    });
    const unlistenCloseRequest = appWindow.listen("panel-close-request", () => {
      closeWithAnimation();
    });
    refresh("", null, null, null);
    refreshFolderMemberships();
    inputRef.current?.focus();
    return () => {
      unlistenOpen.then((unlisten) => unlisten());
      unlistenCloseRequest.then((unlisten) => unlisten());
    };
  }, [refresh, refreshFolderMemberships]);

  useEffect(() => {
    refresh(query, categoryFilter, dateFrom, dateTo);
  }, [query, categoryFilter, dateFrom, dateTo, refresh]);

  useEffect(() => {
    // Smart mode is a standalone search, not an addition to the substring
    // results in `items` -- see searchMode's doc comment above. Clearing out
    // when the mode/query/filters don't call for it keeps filteredItems'
    // fallback to `items` unambiguous. Also skipped entirely while browsing
    // Screenshots (historyView === "screenshots") -- that subview runs its
    // own Smart search against semantic_search_screenshots instead (see
    // ScreenshotsPanel), so this effect firing too would just be a wasted,
    // duplicate semantic_search call against clip_items.
    if (
      searchMode !== "smart" ||
      tier !== "pro" ||
      activeCustomFilter ||
      !query.trim() ||
      historyView !== "clips"
    ) {
      setSmartResults([]);
      setSmartError(null);
      setSmartLoading(false);
      return;
    }
    let cancelled = false;
    setSmartLoading(true);
    setSmartError(null);
    const handle = setTimeout(async () => {
      try {
        const matches = await invoke<SemanticMatch[]>("semantic_search", { query });
        if (cancelled) return;
        if (matches.length === 0) {
          setSmartResults([]);
          return;
        }
        const all = await invoke<ClipItem[]>("get_history", {
          query: "",
          category: categoryFilter,
          dateFrom: dayBoundIso(dateFrom, false),
          dateTo: dayBoundIso(dateTo, true),
        });
        if (cancelled) return;
        const byId = new Map(all.map((it) => [it.id, it]));
        const resolved = matches
          .map((m) => {
            const item = byId.get(m.id);
            return item ? { item, score: m.score } : null;
          })
          .filter((x): x is { item: ClipItem; score: number } => !!x);
        setSmartResults(resolved);
      } catch (e) {
        if (!cancelled) {
          setSmartResults([]);
          setSmartError(typeof e === "string" ? e : "Smart search failed.");
        }
      } finally {
        if (!cancelled) setSmartLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, searchMode, tier, categoryFilter, dateFrom, dateTo, activeCustomFilter, historyView]);

  useEffect(() => {
    if (!showCategoryMenu) return;
    function onClickAway(e: MouseEvent) {
      if (categoryMenuRef.current && !categoryMenuRef.current.contains(e.target as Node)) {
        setShowCategoryMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showCategoryMenu]);

  useEffect(() => {
    if (!showDateMenu) return;
    function onClickAway(e: MouseEvent) {
      if (dateMenuRef.current && !dateMenuRef.current.contains(e.target as Node)) {
        setShowDateMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showDateMenu]);

  const COPY_FEEDBACK_MS = 320;
  async function pasteAndHide(item: ClipItem) {
    setCopiedId(item.id);
    await invoke("paste_item", { id: item.id });
    setTimeout(closeWithAnimation, COPY_FEEDBACK_MS);
  }

  function toggleStackItem(id: number) {
    setStackBuilderIds((ids) => {
      if (!ids) return ids;
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
    });
  }

  function startPasteQueue() {
    if (!stackBuilderIds || stackBuilderIds.length === 0) return;
    // Resolved against filteredItems (what's actually on screen), not the raw
    // `items` substring-search result -- in Smart mode the visible rows come
    // from smartResults, which are fetched separately and generally aren't in
    // `items` at all, so looking them up there silently dropped every
    // meaning-only row the user had just tapped.
    const queue = stackBuilderIds
      .map((id) => filteredItems.find((it) => it.id === id))
      .filter((it): it is ClipItem => !!it);
    if (queue.length === 0) return;
    setPasteQueue(queue);
    setPasteQueueIndex(0);
    setPasteQueueKind("history");
    setStackBuilderIds(null);
    closeWithAnimation();
  }

  function startFolderPasteQueue(entries: QueueEntry[]) {
    if (entries.length === 0) return;
    setPasteQueue(entries);
    setPasteQueueIndex(0);
    setPasteQueueKind("folder");
    closeWithAnimation();
  }

  async function pasteQueueNext() {
    if (!pasteQueue) return;
    const current = pasteQueue[pasteQueueIndex];
    if (!current) return;
    if (pasteQueueKind === "folder") {
      await invoke("paste_folder_item", { id: current.id });
    } else {
      await invoke("paste_item", { id: current.id });
    }
    const next = pasteQueueIndex + 1;
    if (next >= pasteQueue.length) {
      setPasteQueue(null);
      setPasteQueueIndex(0);
    } else {
      setPasteQueueIndex(next);
    }
    closeWithAnimation();
  }

  function cancelPasteQueue() {
    setPasteQueue(null);
    setPasteQueueIndex(0);
    closeWithAnimation();
  }

  async function togglePin(item: ClipItem) {
    const ok = await invoke<boolean>("toggle_pin", { id: item.id });
    if (!ok) {
      setPinLimitMsg(true);
      setTimeout(() => setPinLimitMsg(false), 2200);
      return;
    }
    refresh(query, categoryFilter, dateFrom, dateTo);
  }

  async function deleteItem(item: ClipItem) {
    await invoke("delete_history_item", { id: item.id });
    refresh(query, categoryFilter, dateFrom, dateTo);
  }

  async function persistCustomFilters(next: CustomFilter[]) {
    const current = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { settings: { ...current, custom_filters: next } });
    setCustomFilters(next);
  }

  async function applyCustomFilter(filter: CustomFilter) {
    setCategoryFilter(null);
    setActiveCustomFilter(filter.name);
    setCustomFilterIds(null);
    setCustomFilterError(null);
    setCustomFilterLoading(true);
    setShowCategoryMenu(false);
    try {
      const ids = await invoke<number[]>("filter_by_ai", { prompt: filter.prompt });
      setCustomFilterIds(ids);
    } catch (e) {
      setCustomFilterError(typeof e === "string" ? e : "AI filter failed.");
      setActiveCustomFilter(null);
      setCustomFilterIds(null);
    } finally {
      setCustomFilterLoading(false);
    }
  }

  function clearCustomFilter() {
    setActiveCustomFilter(null);
    setCustomFilterIds(null);
    setCustomFilterError(null);
  }

  async function deleteCustomFilter(name: string) {
    if (activeCustomFilter === name) clearCustomFilter();
    await persistCustomFilters(customFilters.filter((f) => f.name !== name));
  }

  async function saveNewCustomFilter() {
    const name = newFilterName.trim();
    const prompt = newFilterPrompt.trim();
    if (!name || !prompt) return;
    const next = [...customFilters.filter((f) => f.name !== name), { name, prompt }];
    await persistCustomFilters(next);
    setAddingCustomFilter(false);
    setNewFilterName("");
    setNewFilterPrompt("");
    applyCustomFilter({ name, prompt });
  }

  const sortedSmartResults =
    smartSortBy === "recent"
      ? [...smartResults].sort(
          (a, b) => new Date(b.item.created_at).getTime() - new Date(a.item.created_at).getTime()
        )
      : smartResults; // already best-score-first from the backend

  const filteredItems =
    activeCustomFilter && customFilterIds
      ? items.filter((it) => customFilterIds.includes(it.id))
      : searchMode === "smart" && query.trim()
      ? sortedSmartResults.map((r) => r.item)
      : items;

  const smartScoreById = new Map(smartResults.map((r) => [r.item.id, r.score]));

  type Entry = { item: ClipItem; i: number };
  const pinnedEntries: Entry[] = [];
  const dateGroups: { label: string; entries: Entry[] }[] = [];
  const groupIndexByLabel = new Map<string, number>();
  filteredItems.forEach((item, i) => {
    if (item.pinned) {
      pinnedEntries.push({ item, i });
      return;
    }
    const label = dateGroupLabel(item.created_at);
    let idx = groupIndexByLabel.get(label);
    if (idx === undefined) {
      idx = dateGroups.length;
      groupIndexByLabel.set(label, idx);
      dateGroups.push({ label, entries: [] });
    }
    dateGroups[idx].entries.push({ item, i });
  });

  function onKeyDown(e: React.KeyboardEvent) {
    // This handler is bound to the outermost wrapping div (see the
    // motion.div below), so it's active even while AuthGate/Onboarding are
    // being shown instead of the actual history view -- it was hijacking
    // Enter presses meant to submit the login form: e.preventDefault() ran
    // unconditionally below, cancelling the browser's native form-submit
    // default action, and if any stale `items`/`selected` state happened to
    // still be sitting around from before a log-out, it would go on to
    // actually paste-and-hide the window instead of logging in. Bail out
    // entirely unless we're actually past auth + onboarding and showing the
    // real history UI.
    if (!authToken || !onboardingComplete) return;
    // Stack-paste mode replaces the whole tab area regardless of which tab
    // is "underneath" it (it can be started from Folders too), so this
    // check has to come before the tab/historyView guard below.
    if (pasteQueue) {
      if (e.key === "Enter") {
        e.preventDefault();
        pasteQueueNext();
      } else if (e.key === "Escape") {
        cancelPasteQueue();
      }
      return;
    }
    if (e.key === "Escape") {
      closeWithAnimation();
      return;
    }
    // Everything below assumes the text-clip list is what's on screen --
    // Folders, Transform, and the Screenshots sub-view all handle their own
    // keys (or don't need to), so arrow/Enter shouldn't reach into stale
    // `filteredItems`/`selected` state meant for a list that isn't even
    // visible right now.
    if (tab !== "history" || historyView !== "clips") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filteredItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filteredItems[hoverIndex !== null ? hoverIndex : selected];
      if (item) pasteAndHide(item);
    }
  }

  return (
    <motion.div
      onKeyDown={onKeyDown}
      initial={false}
      animate={open ? "open" : "closed"}
      variants={{ open: { x: 0 }, closed: { x: "-100%" } }}
      transition={{ duration: SLIDE_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
      className="w-full h-full rounded-r-[20px] bg-cream dark:bg-charcoal shadow-2xl flex flex-col overflow-hidden text-ink dark:text-cream"
    >
      {authToken === null ? (
        <div />
      ) : authToken === "" ? (
        <AuthGate
          onAuthenticated={(settings) => {
            setAuthToken(settings.auth_token);
            setUserEmail(settings.user_email);
            setTheme(settings.theme);
            setTier(settings.tier);
            setOnboardingComplete(settings.onboarding_complete);
          }}
        />
      ) : !onboardingComplete ? (
        <Onboarding onDone={(newTheme) => { setTheme(newTheme); setOnboardingComplete(true); }} />
      ) : (
        <>
      {/* Brand row, split out from the search bar below on 2026-07-21 --
          the clipboard icon was eating horizontal space the search row
          needed for the Text/Smart toggle + settings gear to all fit
          without clipping. Now holds the real FatClipboard wordmark
          (2026-07-27) -- logo's own coral/green colors read fine against
          both cream and charcoal, so no separate light/dark variant needed. */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-4 pt-1.5 pb-1 shrink-0"
      >
        {/* Tripled in size and left-aligned (2026-07-27, was centered with a
            spacer balancing the settings gear) -- justify-between here
            instead, so the logo just starts at the row's left padding and
            the gear stays pinned to the right without needing that spacer. */}
        <img src={fatClipboardLogo} alt="FatClipboard" className="h-12 w-auto" />
        <button
          onClick={() => setShowSettings((s) => !s)}
          className="shrink-0 text-ink dark:text-cream transition-colors p-1.5 rounded-full hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          title="Settings"
        >
          <i className="ti ti-settings text-[15px]" />
        </button>
      </div>
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 px-4 pb-3 pt-0.5 shadow-[0_1px_0_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)]"
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            tab === "history" && searchMode === "smart"
              ? "Describe what you're looking for…"
              : tab === "history" && historyView === "screenshots"
              ? "Search screenshot text…"
              : "Search clipboard history…"
          }
          className="flex-1 min-w-0 bg-transparent outline-none text-[15px] placeholder:text-inkMuted dark:placeholder:text-inkMutedDark"
        />
        {/* Explicit two-icon segmented control rather than one icon that
            silently swaps meaning -- a single magnifying glass that turns
            into sparkles on click isn't discoverable (a new user has no
            reason to think the search icon is clickable at all). Showing
            both options side by side, with the active one highlighted,
            makes "there are two modes, this is a toggle" legible at a
            glance instead of something you have to stumble into. Settings
            moved up to the brand row above (2026-07-21), so this now sits
            alone on the trailing edge of the search row.
            Always rendered now (2026-07-22 was conditional on tab/historyView,
            removed entirely outside History+clips) -- unmounting it let the
            search input's flex-1 expand to fill the freed-up width, so the
            whole row visibly shifted every time you switched to/from
            History. Kept mounted at a fixed size and just faded out instead,
            so the input's width -- and therefore everything in this row --
            never changes across tabs. */}
        <div
          className={`shrink-0 flex items-center rounded-full bg-black/[0.05] dark:bg-white/[0.07] p-0.5 gap-0.5 transition-opacity ${
            tab === "history" ? "" : "opacity-0 pointer-events-none"
          }`}
          title={searchMode === "smart" ? "Smart (semantic) search is on" : "Exact text search is on"}
        >
          <button
            onClick={() => setSearchMode("text")}
            title="Search exact text"
            tabIndex={tab === "history" ? 0 : -1}
            className={`flex items-center justify-center w-6 h-6 rounded-full transition-colors active:scale-[0.97] ${
              searchMode === "text"
                ? "bg-cream dark:bg-charcoal text-ink dark:text-cream shadow-sm"
                : "text-ink dark:text-cream"
            }`}
          >
            <i className="ti ti-search text-[13px]" />
          </button>
          <button
            onClick={() => {
              if (tier !== "pro") {
                setPaywallMsg(true);
                setTimeout(() => setPaywallMsg(false), 2600);
                return;
              }
              setSearchMode("smart");
            }}
            title={
              tier !== "pro"
                ? "Smart (semantic) search is a Pro feature"
                : "Search by meaning, not just exact words"
            }
            tabIndex={tab === "history" ? 0 : -1}
            className={`relative flex items-center justify-center w-6 h-6 rounded-full transition-colors active:scale-[0.97] ${
              searchMode === "smart"
                ? "bg-accent/25 dark:bg-accentDark/35 text-accent dark:text-accentDark shadow-sm"
                : "text-ink dark:text-cream"
            }`}
          >
            <i className="ti ti-sparkles text-[13px]" />
            {tier !== "pro" && (
              <i className="ti ti-lock absolute -bottom-0.5 -right-0.5 text-[7px] leading-none text-inkMuted dark:text-inkMutedDark bg-cream dark:bg-charcoal rounded-full p-[1px]" />
            )}
          </button>
        </div>
      </div>

      {pasteQueue && pasteQueueIndex < pasteQueue.length ? (
        <PasteQueue
          items={pasteQueue}
          index={pasteQueueIndex}
          onPasteNext={pasteQueueNext}
          onCancel={cancelPasteQueue}
        />
      ) : showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onThemeChange={setTheme}
          onTierChange={setTier}
          onVisibleCategoriesChange={setVisibleCategories}
          scrollToPresets={jumpToPresets}
          onScrolledToPresets={() => setJumpToPresets(false)}
          initialPresetContext={presetsJumpContext}
          onLoggedOut={() => setAuthToken("")}
          activeCustomFilter={activeCustomFilter}
          onApplyCustomFilter={applyCustomFilter}
          onClearCustomFilter={clearCustomFilter}
        />
      ) : (
        <>
          {/* CSS grid with a fixed 3-column track (2026-07-22), shared by
              this row, the sub-toggle below it, and the Filter/Date/Stack
              row further down -- flex-1 doesn't work here because each row
              divides *its own* full width by *its own* item count (3 here,
              2 in the sub-toggle), so per-item widths differ between rows
              even though every row still fills the same full row width.
              Grid columns are sized off this row's 3 items; the sub-toggle
              below reuses the identical grid-cols-3 but only places buttons
              in 2 of the 3 columns, so each of its items is exactly as wide
              as History/Transform/Folders here -- same fill-the-row
              behavior, same per-item width, actually aligned. */}
          <div className="grid grid-cols-3 gap-1.5 px-4 pt-2.5">
            <button
              onClick={() => setTab("history")}
              className={`text-[11.5px] py-1.5 rounded-full transition-all active:scale-[0.97] ${
                tab === "history"
                  ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                  : "text-ink dark:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              }`}
            >
              History
            </button>
            <button
              onClick={() => setTab("transform")}
              className={`flex items-center justify-center gap-1 text-[11.5px] py-1.5 rounded-full transition-all active:scale-[0.97] ${
                tab === "transform"
                  ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                  : "text-ink dark:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              }`}
            >
              Transform
              {tier !== "pro" && <i className="ti ti-lock text-[9px]" />}
            </button>
            <button
              onClick={() => setTab("folders")}
              className={`text-[11.5px] py-1.5 rounded-full transition-all active:scale-[0.97] ${
                tab === "folders"
                  ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                  : "text-ink dark:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              }`}
            >
              Folders
            </button>
          </div>

          {/* History/Screenshots sub-toggle -- Screenshots used to be its own
              top-level tab; it moved here (2026-07-22) since it's still
              fundamentally "something you copied," just images instead of
              text, and Transform needed the top-level slot more (it's not
              tied to any specific item). Only rendered under the History
              tab, directly below the primary tab row and above the
              Filter/Date/Stack row, which only applies to the clips view.
              Its own grid-cols-2 (2026-07-22) rather than reusing the
              3-column grid above -- History/Screenshots should split the
              *full* row 50/50, not sit in 2 of 3 columns sized for the
              tab row above and leave the third column empty. */}
          {/* Animated height collapse rather than an instant unmount
              (2026-07-22) -- this whole row only applies to History, so it
              can't just be faded-in-place like the search toggle above
              (that would leave permanent dead space on Transform/Folders).
              Animating height 0<->auto instead means switching tabs still
              slides smoothly rather than snapping the rows below it up/down
              a fixed number of pixels instantly. */}
          <AnimatePresence initial={false}>
            {tab === "history" && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
              >
            {/* pb-0.5 (2026-08-06): the active pill's ring-1/shadow-sm render
                a hair outside its own border box, which this motion.div's
                animated height (measured to exactly fit the content) doesn't
                account for -- without this buffer, overflow-hidden sliced
                off that outer sliver right at the bottom, flattening the
                pill's bottom-rounded corners instead of a small visual glitch
                nobody would notice. */}
            <div className="grid grid-cols-2 gap-1.5 px-4 pt-1.5 pb-0.5">
              {/* Same active-pill treatment as the History/Transform/Folders
                  row above it now (white/charcoalSurface + shadow + ring,
                  2026-08-03) -- this sub-toggle used to get a flatter,
                  dimmer tinted-black active state, which read as a visibly
                  different (lesser) tab style one level down instead of the
                  same kind of control. Label changed from "History" to
                  "Text" at the same time -- with the tab above it already
                  called History, "History > History / Screenshots" said
                  History twice for what's actually "History > Text /
                  Screenshots". */}
              <button
                onClick={() => setHistoryView("clips")}
                className={`text-center text-[10.5px] py-1 rounded-full transition-all active:scale-[0.97] ${
                  historyView === "clips"
                    ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                    : "text-ink dark:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                }`}
              >
                Text
              </button>
              <button
                onClick={() => setHistoryView("screenshots")}
                className={`flex items-center justify-center gap-1 text-[10.5px] py-1 rounded-full transition-all active:scale-[0.97] ${
                  historyView === "screenshots"
                    ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                    : "text-ink dark:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                }`}
              >
                Screenshots
              </button>
            </div>
              </motion.div>
            )}
          </AnimatePresence>

          {tab === "folders" ? (
            <FoldersPanel
              key="folders"
              onPasted={closeWithAnimation}
              tier={tier}
              openFolderId={openFolderId}
              onOpenedFolder={() => setOpenFolderId(null)}
              onMembershipsChanged={refreshFolderMemberships}
              startCreating={requestNewFolder}
              onStartedCreating={() => setRequestNewFolder(false)}
              onStartPasteQueue={startFolderPasteQueue}
              onTransformItem={goToTransform}
            />
          ) : tab === "transform" ? (
            <TransformTab
              key="transform"
              tier={tier}
              pendingInput={pendingTransformInput}
              onConsumedPendingInput={() => setPendingTransformInput(null)}
              onManagePresets={() => {
                setPresetsJumpContext("text");
                setJumpToPresets(true);
                setShowSettings(true);
              }}
              onOpenFolder={(folderId) => {
                setOpenFolderId(folderId);
                setTab("folders");
              }}
              onCreateNewFolder={() => {
                setRequestNewFolder(true);
                setTab("folders");
              }}
            />
          ) : historyView === "screenshots" ? (
            <ScreenshotsPanel
              key="screenshots"
              tier={tier}
              query={query}
              searchMode={searchMode}
              onPasted={closeWithAnimation}
              onOpenFolder={(folderId) => {
                setOpenFolderId(folderId);
                setTab("folders");
              }}
              onCreateNewFolder={() => {
                setRequestNewFolder(true);
                setTab("folders");
              }}
              onTransformItem={goToTransform}
            />
          ) : (
        <div key="history" className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Same grid-cols-3 as the tab row and sub-toggle above (see the
            comment on the tab row) -- this row also has exactly 3 items, so
            it already lined up with the tab row above by construction, but
            grid keeps all three rows on one consistent alignment mechanism
            instead of two different ones that happen to agree. */}
        <div className="grid grid-cols-3 gap-1.5 px-4 pt-2 pb-1 shrink-0">
          <button
            ref={filterBtnRef}
            onClick={() => {
              if (!showCategoryMenu && filterBtnRef.current) {
                const r = filterBtnRef.current.getBoundingClientRect();
                // Centered in the window rather than anchored to the
                // button's own left edge (2026-07-21) -- this menu is a
                // fixed w-60 (240px), and on a narrow docked panel,
                // anchoring to r.left routinely pushed it past the window's
                // right edge with nothing clamping it back on-screen.
                setCategoryMenuPos({ top: r.bottom + 4, left: Math.max(8, (window.innerWidth - 240) / 2) });
              }
              setShowCategoryMenu((s) => !s);
            }}
            className={`flex items-center justify-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full transition-colors active:scale-[0.97] ${
              categoryFilter !== null || activeCustomFilter !== null
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium hover:bg-accent/35 dark:hover:bg-accentDark/45"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className={activeCustomFilter ? "ti ti-sparkles text-[12px]" : "ti ti-filter text-[12px]"} />
            {activeCustomFilter
              ? activeCustomFilter
              : categoryFilter !== null
              ? ALL_CATEGORIES.find((f) => f.value === categoryFilter)?.label ?? "Filter"
              : "Filter"}
            <i className={`ti ti-chevron-down text-[10px] transition-transform ${showCategoryMenu ? "rotate-180" : ""}`} />
          </button>

          <button
            ref={dateBtnRef}
            onClick={() => {
              if (!showDateMenu && dateBtnRef.current) {
                const r = dateBtnRef.current.getBoundingClientRect();
                // Same centering fix as the Filter menu above -- see that
                // comment. Same w-60 (240px) width.
                setDateMenuPos({ top: r.bottom + 4, left: Math.max(8, (window.innerWidth - 240) / 2) });
              }
              setDateMenuView(!activeDatePreset && (dateFrom || dateTo) ? "custom" : "list");
              setShowDateMenu((s) => !s);
            }}
            className={`flex items-center justify-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full transition-colors active:scale-[0.97] ${
              dateFrom || dateTo
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium hover:bg-accent/35 dark:hover:bg-accentDark/45"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className="ti ti-calendar text-[12px]" />
            {/* Always just "Date" now (2026-07-21) -- the highlighted
                background already signals "a filter is active" on its own,
                and cramming the actual date range into this small pill blew
                it up to multiple lines. The real range is what the active-
                filter chip right below this row is for. */}
            Date
            <i className={`ti ti-chevron-down text-[10px] transition-transform ${showDateMenu ? "rotate-180" : ""}`} />
          </button>

          <button
            onClick={() => setStackBuilderIds((ids) => (ids === null ? [] : null))}
            title="Select items to paste one after another, in order"
            className={`flex items-center justify-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full transition-colors active:scale-[0.97] ${
              stackBuilderIds !== null
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium hover:bg-accent/35 dark:hover:bg-accentDark/45"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className="ti ti-list-numbers text-[12px]" />
            Stack
          </button>

          {searchMode === "smart" && query.trim() && (
            <div className="shrink-0 flex items-center rounded-full bg-black/[0.05] dark:bg-white/[0.07] p-0.5 text-[10.5px]">
              <button
                onClick={() => setSmartSortBy("score")}
                title="Sort by how well each result matches"
                className={`px-2.5 py-1 rounded-full transition-colors active:scale-[0.97] ${
                  smartSortBy === "score"
                    ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium"
                    : "text-ink dark:text-cream"
                }`}
              >
                Relevance
              </button>
              <button
                onClick={() => setSmartSortBy("recent")}
                title="Sort chronologically, like History"
                className={`px-2.5 py-1 rounded-full transition-colors active:scale-[0.97] ${
                  smartSortBy === "recent"
                    ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium"
                    : "text-ink dark:text-cream"
                }`}
              >
                Recent
              </button>
            </div>
          )}

          {showDateMenu &&
            dateMenuPos &&
            createPortal(
              <div
                ref={dateMenuRef}
                style={{
                  position: "fixed",
                  top: dateMenuPos.top,
                  left: dateMenuPos.left,
                  backgroundColor: theme === "dark" ? "#262320" : "#F2EEE3",
                  opacity: 1,
                }}
                className="z-[9999] w-60 rounded-2xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-1.5 text-ink dark:text-cream"
              >
                {dateMenuView === "list" ? (
                  <div className="space-y-0.5">
                    {DATE_PRESETS.map((p) => {
                      const active = activeDatePreset === p.label;
                      return (
                        <button
                          key={p.label}
                          onClick={() => applyDatePreset(p.label, p.hours)}
                          className={`w-full flex items-center justify-between text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                            active
                              ? "bg-accent/20 dark:bg-accentDark/30 text-ink dark:text-cream font-medium"
                              : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                          }`}
                        >
                          {p.label}
                          {active && <i className="ti ti-check text-[12px]" />}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setDateMenuView("custom")}
                      className={`w-full flex items-center justify-between text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                        !activeDatePreset && (dateFrom || dateTo)
                          ? "bg-accent/20 dark:bg-accentDark/30 text-ink dark:text-cream font-medium"
                          : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                      }`}
                    >
                      Custom
                      <i className="ti ti-chevron-right text-[12px]" />
                    </button>
                    {(dateFrom || dateTo) && (
                      <button
                        onClick={() => {
                          setDateFrom(null);
                          setDateTo(null);
                          setActiveDatePreset(null);
                          setShowDateMenu(false);
                        }}
                        className="w-full text-left text-[12px] px-2.5 py-2 rounded-lg text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                      >
                        Clear date filter
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="p-1.5 space-y-2">
                    <button
                      onClick={() => setDateMenuView("list")}
                      className="flex items-center gap-1 text-[11px] text-inkMuted dark:text-inkMutedDark mb-1 hover:text-ink dark:hover:text-cream"
                    >
                      <i className="ti ti-chevron-left text-[11px]" />
                      Back
                    </button>
                    <div>
                      <label className="block text-[10px] text-inkMuted dark:text-inkMutedDark mb-1">
                        From
                      </label>
                      <input
                        type="date"
                        value={!activeDatePreset ? dateFrom ?? "" : ""}
                        onChange={(e) => {
                          setActiveDatePreset(null);
                          setDateFrom(e.target.value || null);
                        }}
                        className="w-full bg-black/[0.05] dark:bg-white/[0.07] rounded-lg px-2 py-1.5 text-[12px] outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-inkMuted dark:text-inkMutedDark mb-1">
                        To
                      </label>
                      <input
                        type="date"
                        value={!activeDatePreset ? dateTo ?? "" : ""}
                        onChange={(e) => {
                          setActiveDatePreset(null);
                          setDateTo(e.target.value || null);
                        }}
                        className="w-full bg-black/[0.05] dark:bg-white/[0.07] rounded-lg px-2 py-1.5 text-[12px] outline-none"
                      />
                    </div>
                    <div className="flex gap-1.5 pt-1">
                      <button
                        onClick={() => {
                          setDateFrom(null);
                          setDateTo(null);
                          setActiveDatePreset(null);
                        }}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08]"
                      >
                        Clear
                      </button>
                      <button
                        onClick={() => setShowDateMenu(false)}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>,
              document.body
            )}

          {showCategoryMenu &&
            categoryMenuPos &&
            createPortal(
              <div
                ref={categoryMenuRef}
                style={{
                  position: "fixed",
                  top: categoryMenuPos.top,
                  left: categoryMenuPos.left,
                  backgroundColor: theme === "dark" ? "#262320" : "#F2EEE3",
                  opacity: 1,
                }}
                className="z-[9999] w-60 rounded-2xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] py-1.5 text-ink dark:text-cream"
              >
                <p className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
                  Presets
                </p>

                {[{ label: "All", value: null as string | null }, ...ALL_CATEGORIES.filter((f) => visibleCategories.includes(f.value))].map((f) => {
                  const active = activeCustomFilter === null && categoryFilter === f.value;
                  return (
                    <button
                      key={f.label}
                      onClick={() => {
                        clearCustomFilter();
                        setCategoryFilter(f.value);
                        setShowCategoryMenu(false);
                      }}
                      className={`flex items-center gap-2 px-3.5 py-1.5 mx-1 rounded-full text-[12px] text-left transition-colors ${
                        active
                          ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                          : "hover:bg-black/[0.07] dark:hover:bg-white/[0.09]"
                      }`}
                      style={{ width: "calc(100% - 0.5rem)" }}
                    >
                      {active ? (
                        <i className="ti ti-check text-[11px]" />
                      ) : (
                        <span className="w-[11px]" />
                      )}
                      <span className="flex-1 truncate">{f.label}</span>
                    </button>
                  );
                })}

                <div className="my-1.5 border-t border-black/[0.06] dark:border-white/[0.08]" />
                <p className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
                  Your filters
                </p>

                {customFilters.map((f) => {
                  const active = activeCustomFilter === f.name;
                  const locked = tier !== "pro";
                  return (
                    <div key={f.name} className="group relative mx-1">
                      <button
                        onClick={() => {
                          if (locked) {
                            setPaywallMsg(true);
                            setTimeout(() => setPaywallMsg(false), 2600);
                            setShowCategoryMenu(false);
                            return;
                          }
                          applyCustomFilter(f);
                        }}
                        title={f.prompt}
                        className={`flex items-center gap-2 pl-3.5 pr-7 py-1.5 rounded-full text-[12px] text-left transition-colors ${
                          active
                            ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                            : "hover:bg-black/[0.07] dark:hover:bg-white/[0.09]"
                        }`}
                        style={{ width: "100%" }}
                      >
                        {locked ? (
                          <i className="ti ti-lock text-[11px] text-inkMuted dark:text-inkMutedDark" />
                        ) : active ? (
                          <i className="ti ti-check text-[11px]" />
                        ) : (
                          <i className="ti ti-sparkles text-[11px] text-accent dark:text-accentDark" />
                        )}
                        <span className="flex-1 truncate">{f.name}</span>
                      </button>
                      <button
                        onClick={() => deleteCustomFilter(f.name)}
                        title="Delete filter"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:!text-red-500 dark:hover:!text-red-400 transition-opacity"
                      >
                        <i className="ti ti-trash text-[10px]" />
                      </button>
                    </div>
                  );
                })}

                {addingCustomFilter ? (
                  <div className="mx-2 mt-1 mb-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={newFilterName}
                      onChange={(e) => setNewFilterName(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Escape") setAddingCustomFilter(false);
                      }}
                      placeholder="Name (e.g. Recipes)"
                      className="w-full bg-black/[0.05] dark:bg-white/[0.07] rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                    />
                    <textarea
                      value={newFilterPrompt}
                      onChange={(e) => setNewFilterPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Escape") setAddingCustomFilter(false);
                      }}
                      placeholder="Match when... (e.g. everything that's a recipe for a dish)"
                      rows={2}
                      className="w-full bg-black/[0.05] dark:bg-white/[0.07] rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={saveNewCustomFilter}
                        disabled={!newFilterName.trim() || !newFilterPrompt.trim()}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal disabled:opacity-40"
                      >
                        Save filter
                      </button>
                      <button
                        onClick={() => setAddingCustomFilter(false)}
                        className="px-2.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] text-[11px]"
                      >
                        <i className="ti ti-x text-[12px]" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      if (tier !== "pro") {
                        setPaywallMsg(true);
                        setTimeout(() => setPaywallMsg(false), 2600);
                        setShowCategoryMenu(false);
                        return;
                      }
                      setAddingCustomFilter(true);
                    }}
                    className="flex items-center gap-2 px-3.5 py-1.5 mx-1 mt-0.5 rounded-full text-[12px] text-left text-accent dark:text-accentDark hover:bg-accent/10 dark:hover:bg-accentDark/15 transition-colors"
                    style={{ width: "calc(100% - 0.5rem)" }}
                  >
                    <i className={tier !== "pro" ? "ti ti-lock text-[11px]" : "ti ti-plus text-[11px]"} />
                    <span>New AI filter</span>
                  </button>
                )}
              </div>,
              document.body
            )}
        </div>

        {(categoryFilter !== null || activeCustomFilter !== null || dateFrom || dateTo) && (
          <div className="flex items-center flex-wrap gap-1.5 px-4 pb-2 shrink-0">
            {categoryFilter !== null && (
              <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium">
                {ALL_CATEGORIES.find((f) => f.value === categoryFilter)?.label ?? categoryFilter}
                <button
                  onClick={() => setCategoryFilter(null)}
                  title="Clear this filter"
                  className="hover:opacity-70"
                >
                  <i className="ti ti-x text-[10px]" />
                </button>
              </span>
            )}
            {activeCustomFilter !== null && (
              <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium">
                <i className="ti ti-sparkles text-[10px]" />
                {activeCustomFilter}
                <button onClick={clearCustomFilter} title="Clear this filter" className="hover:opacity-70">
                  <i className="ti ti-x text-[10px]" />
                </button>
              </span>
            )}
            {(dateFrom || dateTo) && (
              <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium">
                <i className="ti ti-calendar text-[10px]" />
                {activeDatePreset ?? `${dateFrom ?? "…"} – ${dateTo ?? "…"}`}
                <button
                  onClick={() => {
                    setDateFrom(null);
                    setDateTo(null);
                    setActiveDatePreset(null);
                  }}
                  title="Clear this filter"
                  className="hover:opacity-70"
                >
                  <i className="ti ti-x text-[10px]" />
                </button>
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          <AnimatePresence initial={false}>
            {customFilterLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-12"
              >
                Matching with AI…
              </motion.div>
            )}
            {!customFilterLoading && smartLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-12"
              >
                Searching by meaning…
              </motion.div>
            )}
            {!customFilterLoading && !smartLoading && filteredItems.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-12"
              >
                {activeCustomFilter ? (
                  "No matches for this filter."
                ) : searchMode === "smart" && smartError ? (
                  smartError
                ) : searchMode === "smart" && query ? (
                  "Nothing similar enough found."
                ) : query ? (
                  "No matches."
                ) : (
                  <>
                    Copy something to get{" "}
                    <span className="font-serif italic text-ink dark:text-cream">started</span>.
                  </>
                )}
              </motion.div>
            )}
            {(() => {
              const renderRow = (entry: Entry, isLastInGroup: boolean) => {
                const { item, i } = entry;
                const active = hoverIndex !== null ? i === hoverIndex : i === selected;
                const savedInFolders = folderMemberships.get(item.content) ?? [];
                const stackPos = stackBuilderIds?.indexOf(item.id) ?? -1;
                return (
                  <div key={item.id}>
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      onMouseEnter={() => setHoverIndex(i)}
                      onMouseLeave={() => setHoverIndex(null)}
                      onClick={() =>
                        stackBuilderIds !== null
                          ? toggleStackItem(item.id)
                          : setExpandedId((id) => (id === item.id ? null : item.id))
                      }
                      className={`group relative flex items-start gap-2 px-3.5 py-3 cursor-pointer transition-colors ${
                        active ? "bg-creamSurface dark:bg-charcoalSurface" : ""
                      }`}
                    >
                      {stackBuilderIds !== null && (
                        <span
                          className={`shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium ${
                            stackPos !== -1
                              ? "bg-accent dark:bg-accentDark text-cream dark:text-charcoal"
                              : "bg-black/[0.06] dark:bg-white/[0.09] text-inkMuted dark:text-inkMutedDark"
                          }`}
                        >
                          {stackPos !== -1 ? stackPos + 1 : ""}
                        </span>
                      )}
                      {/* Full-width now (2026-08-03 experiment) -- the four
                          action icons used to sit as flex siblings next to
                          this column, which meant the text (and the "n%
                          match" badge on its timestamp line) never got to
                          use the row's full width even when there was
                          nothing to its right. They now share the timestamp
                          line itself (justify-between, both wrapped in one
                          flex row below) instead of floating independently
                          -- an earlier version absolutely-positioned them at
                          a fixed bottom offset, which didn't reliably land
                          them at the same baseline as the date text since
                          "distance from the row's bottom edge" isn't the
                          same thing as "vertically centered with this
                          specific line." Being actual flex siblings on the
                          same line guarantees that alignment regardless of
                          how many icons show or how tall the date text
                          ends up being. */}
                      <div className="flex-1 min-w-0">
                        <ClampedText
                          text={item.content}
                          lines={3}
                          className="text-[13.5px] leading-snug whitespace-pre-wrap break-words"
                          expanded={expandedId === item.id}
                          onToggleExpanded={() =>
                            setExpandedId((id) => (id === item.id ? null : item.id))
                          }
                        />
                        <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="text-[10.5px] text-inkMuted dark:text-inkMutedDark flex items-center gap-1 min-w-0">
                          {formatTimestamp(item.created_at)}
                          {searchMode === "smart" && smartScoreById.has(item.id) && (
                            <span
                              className="flex items-center gap-0.5 text-accent dark:text-accentDark font-medium"
                              title="Semantic match score"
                            >
                              <i className="ti ti-sparkles text-[9px]" />
                              {Math.round((smartScoreById.get(item.id) ?? 0) * 100)}% match
                            </span>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          pasteAndHide(item);
                        }}
                        className="text-xs shrink-0 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark transition-opacity"
                        title="Copy & paste"
                      >
                        <i className="ti ti-copy text-[14px]" />
                      </button>
                      {/* Pin sits right next to Folder (2026-07-21) -- both
                          are "where does this item live" controls (pinned
                          section vs. saved-in-a-folder), so grouping them
                          reads more clearly than having Copy split them
                          apart. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(item);
                        }}
                        // Unlike Screenshots' persistent pinned star, History
                        // rows stay hover-only for every action icon (copy,
                        // transform, folder, delete, and pin) to keep the
                        // row's resting state clean/uncluttered -- pin is
                        // still itself the toggle, it just only shows up
                        // when you hover the row, same as its siblings.
                        className={`text-xs shrink-0 opacity-0 transition-opacity ${
                          item.pinned
                            ? "group-hover:opacity-100 text-accent dark:text-accentDark"
                            : "group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                        }`}
                        title={item.pinned ? "Unpin" : "Pin"}
                      >
                        <i className={item.pinned ? "ti ti-pinned-filled text-[14px]" : "ti ti-pin text-[14px]"} />
                      </button>
                      {/* Transform moved inline (2026-08-03), matching
                          Screenshots' now-fully-inline icon row -- it used to
                          live behind the "..." menu below along with Delete,
                          but there's clearly room for both full icon sets
                          side by side now that Screenshots' row also shows
                          five icons directly. Same tier-gate/paywall
                          behavior as before, just triggered straight from
                          its own icon instead of a menu item. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (tier !== "pro") {
                            setPaywallMsg(true);
                            setTimeout(() => setPaywallMsg(false), 2600);
                            return;
                          }
                          goToTransform(item.content);
                        }}
                        className="text-xs shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark transition-opacity"
                        title={tier === "pro" ? "Transform with AI" : "AI transform — Pro only"}
                      >
                        <i className="ti ti-sparkles text-[14px]" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          setFolderPickerPos(clampMenuPosition(r.bottom + 4, r.right - 192, 192));
                          setFolderPickerFor((id) => (id === item.id ? null : item.id));
                        }}
                        className={`relative text-xs shrink-0 transition-opacity ${
                          folderPickerFor === item.id || savedInFolders.length > 0
                            ? "opacity-100 text-accent dark:text-accentDark"
                            : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                        }`}
                        title={
                          savedInFolders.length > 0
                            ? `Saved in ${savedInFolders.map((f) => f.name).join(", ")}`
                            : "Add to folder"
                        }
                      >
                        <i className="ti ti-folder-plus text-[14px]" />
                        {savedInFolders.length > 0 && folderPickerFor !== item.id && (
                          <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center w-2.5 h-2.5 rounded-full bg-cream dark:bg-charcoalSurface">
                            <i className="ti ti-check text-accent dark:text-accentDark text-[8px] leading-none" />
                          </span>
                        )}
                      </button>
                      {folderPickerFor === item.id &&
                        folderPickerPos &&
                        createPortal(
                          <FolderPicker
                            savedIn={savedInFolders}
                            position={folderPickerPos}
                            onClose={() => setFolderPickerFor(null)}
                            onAdd={async (folderId) => {
                              await invoke("add_to_folder", {
                                folderId,
                                content: item.content,
                                title: null,
                              });
                              setFolderPickerFor(null);
                              refreshFolderMemberships();
                            }}
                            onOpenFolder={(folderId) => {
                              setFolderPickerFor(null);
                              setOpenFolderId(folderId);
                              setTab("folders");
                            }}
                            onCreateNewFolder={() => {
                              setFolderPickerFor(null);
                              setRequestNewFolder(true);
                              setTab("folders");
                            }}
                          />,
                          document.body
                        )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteItem(item);
                        }}
                        className="text-xs shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark hover:!text-red-500 dark:hover:!text-red-400 transition-opacity"
                        title="Delete"
                      >
                        <i className="ti ti-trash text-[14px]" />
                      </button>
                        </div>
                        </div>
                      </div>
                      <AnimatePresence>
                        {copiedId === item.id && (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.12 }}
                            className="absolute inset-0 rounded-xl bg-ink/95 dark:bg-cream/95 flex items-center justify-center gap-1.5 text-cream dark:text-charcoal text-[12.5px] font-medium"
                          >
                            <i className="ti ti-check text-[14px]" />
                            Copied
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                    {!isLastInGroup && (
                      <div className="mx-4 border-b border-black/[0.05] dark:border-white/[0.07]" />
                    )}
                  </div>
                );
              };

              return (
                <>
                  {pinnedEntries.length > 0 && (
                    <div className="mb-3">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-3 pb-1.5">
                        Pinned
                      </p>
                      <div className="rounded-2xl bg-white/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden">
                        {pinnedEntries.map((entry, idx) =>
                          renderRow(entry, idx === pinnedEntries.length - 1)
                        )}
                      </div>
                    </div>
                  )}
                  {dateGroups.map((group) => (
                    <div key={group.label} className="mb-3">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-3 pb-1.5">
                        {group.label}
                      </p>
                      <div className="rounded-2xl bg-white/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden">
                        {group.entries.map((entry, idx) =>
                          renderRow(entry, idx === group.entries.length - 1)
                        )}
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* The in-place Transform sheet that used to live here (a full-
            height overlay running TransformBar over the History list) is
            gone as of 2026-08-03 -- clicking Transform on a row now jumps to
            the standalone Transform tab instead (see goToTransform above),
            which has a lot more room to work with than a sheet squeezed into
            this popup ever did. */}

        {stackBuilderIds !== null && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-t border-borderLight dark:border-borderDark">
            <span className="flex-1 text-[11.5px] text-inkMuted dark:text-inkMutedDark">
              {stackBuilderIds.length === 0
                ? "Tap items in the order you want them pasted"
                : `${stackBuilderIds.length} selected`}
            </span>
            <button
              onClick={() => setStackBuilderIds(null)}
              className="text-[11.5px] px-2.5 py-1.5 rounded-lg text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={startPasteQueue}
              disabled={stackBuilderIds.length === 0}
              className="text-[11.5px] font-medium px-3 py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal disabled:opacity-40"
            >
              Start
            </button>
          </div>
        )}
        </div>
          )}
        </>
      )}
        </>
      )}

      <AnimatePresence>
        {pinLimitMsg && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-3 mb-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-[11.5px] text-inkMuted dark:text-inkMutedDark text-center"
          >
            Pin limit reached (3) — unpin something first.
          </motion.div>
        )}
        {paywallMsg && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-3 mb-2 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3 py-2 text-[11.5px] text-accent dark:text-accentDark text-center font-medium"
          >
            That's a Pro feature — upgrade to use it.
          </motion.div>
        )}
        {customFilterError && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-3 mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] text-red-500 dark:text-red-400 text-center"
          >
            {customFilterError}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
