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
import DateRangeCalendar from "./components/DateRangeCalendar";
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
  // Whether `selected` should actually paint a highlight -- true only once
  // the user has pressed an arrow key. Without this, `selected` (which
  // defaults to 0 on every load/refresh) painted the same hover-tinted
  // background on the top item permanently, even with the mouse nowhere
  // near it -- indistinguishable from actually hovering it. Handed back to
  // the mouse the instant it moves over any row (see onMouseEnter below) so
  // the two mechanisms never fight over which item looks "active."
  const [keyboardActive, setKeyboardActive] = useState(false);
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
  // Multi-select (2026-08-13, was a single string | null) -- the Filter
  // dropdown's category bubbles can now be toggled independently instead of
  // each pick replacing the last one. Kept as an array rather than a Set so
  // it's trivially JSON/deps-comparable; membership checks below just use
  // .includes()/.length.
  const [categoryFilters, setCategoryFilters] = useState<string[]>([]);
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

  // Text/Screenshots split-button dropdowns (2026-08-13) -- Filter/Date/
  // Stack used to be their own always-visible row; now each lives behind a
  // small options menu attached to the Text (all three) or Screenshots
  // (Date only, see below) pill's chevron, saving a full row of vertical
  // space. filterBtnRef/dateBtnRef above are re-pointed at the "Filter"/
  // "Date" items inside this menu so the existing category/date menu
  // positioning + click-away logic keeps working unmodified.
  const [showTextOptions, setShowTextOptions] = useState(false);
  const [textOptionsPos, setTextOptionsPos] = useState<{ top: number; left: number } | null>(null);
  const textOptionsBtnRef = useRef<HTMLButtonElement>(null);
  const textOptionsMenuRef = useRef<HTMLDivElement>(null);
  // Whole-pill refs (2026-08-13), separate from the chevron-only
  // textOptionsBtnRef/screenshotsOptionsBtnRef above -- used just for
  // measuring the pill's own left edge so the dropdown lines up under the
  // *pill*, not the window center (the previous positioning) or the
  // chevron's own narrow sliver (which would look off-center under the
  // wider pill).
  const textPillRef = useRef<HTMLDivElement>(null);
  const screenshotsPillRef = useRef<HTMLDivElement>(null);

  const [showScreenshotsOptions, setShowScreenshotsOptions] = useState(false);
  const [screenshotsOptionsPos, setScreenshotsOptionsPos] = useState<{ top: number; left: number } | null>(null);
  const screenshotsOptionsBtnRef = useRef<HTMLButtonElement>(null);
  const screenshotsOptionsMenuRef = useRef<HTMLDivElement>(null);

  // Screenshots' own Date filter (2026-08-13) -- list_screenshots has no
  // date param server-side, so this filters the already-fetched array
  // client-side in ScreenshotsPanel rather than round-tripping to Rust.
  const [screenshotsDateFrom, setScreenshotsDateFrom] = useState<string | null>(null);
  const [screenshotsDateTo, setScreenshotsDateTo] = useState<string | null>(null);
  const [screenshotsActiveDatePreset, setScreenshotsActiveDatePreset] = useState<string | null>(null);
  const [showScreenshotsDateMenu, setShowScreenshotsDateMenu] = useState(false);
  const [screenshotsDateMenuPos, setScreenshotsDateMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [screenshotsDateMenuView, setScreenshotsDateMenuView] = useState<"list" | "custom">("list");
  const screenshotsDateMenuRef = useRef<HTMLDivElement>(null);
  const screenshotsDateBtnRef = useRef<HTMLButtonElement>(null);

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

  function applyScreenshotsDatePreset(label: string, hours: number) {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    setScreenshotsDateFrom(from.toISOString());
    setScreenshotsDateTo(to.toISOString());
    setScreenshotsActiveDatePreset(label);
    setShowScreenshotsDateMenu(false);
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
        setKeyboardActive(false);
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
      setCategoryFilters([]);
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
    // Backend's get_history still only takes a single category (or none) --
    // multi-select is handled client-side below via filteredItems, so this
    // only narrows the backend query when there's exactly one selected
    // (keeps the free-tier result cap applying pre-filter, same as before).
    // With 2+ selected we fetch unfiltered and let filteredItems narrow it.
    refresh(query, categoryFilters.length === 1 ? categoryFilters[0] : null, dateFrom, dateTo);
  }, [query, categoryFilters, dateFrom, dateTo, refresh]);

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
          category: categoryFilters.length === 1 ? categoryFilters[0] : null,
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
  }, [query, searchMode, tier, categoryFilters, dateFrom, dateTo, activeCustomFilter, historyView]);

  useEffect(() => {
    if (!showCategoryMenu) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      // Also excludes the trigger button itself, not just the dropdown --
      // without this, clicking "Filter" again while it's open closed the
      // menu here (mousedown fires first) and then the button's own onClick
      // toggle immediately reopened it (since by the time click fires,
      // state already reads closed), netting out to "never closes." Filter
      // no longer has its own persistent trigger button (2026-08-13, moved
      // into the Text options dropdown) -- filterBtnRef.current is null once
      // that dropdown closes, so the exclusion is now optional rather than
      // required, otherwise a null ref would make this condition
      // permanently false and the menu would never close on outside click.
      if (
        categoryMenuRef.current &&
        !categoryMenuRef.current.contains(target) &&
        (!filterBtnRef.current || !filterBtnRef.current.contains(target))
      ) {
        setShowCategoryMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showCategoryMenu]);

  useEffect(() => {
    if (!showDateMenu) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      // Same fix as the category menu above -- exclude the "Date" trigger
      // button so its own onClick toggle is what closes the menu on a
      // second click, instead of racing this mousedown handler.
      if (
        dateMenuRef.current &&
        !dateMenuRef.current.contains(target) &&
        (!dateBtnRef.current || !dateBtnRef.current.contains(target))
      ) {
        setShowDateMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showDateMenu]);

  useEffect(() => {
    if (!showTextOptions) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      if (
        textOptionsMenuRef.current &&
        !textOptionsMenuRef.current.contains(target) &&
        textOptionsBtnRef.current &&
        !textOptionsBtnRef.current.contains(target)
      ) {
        setShowTextOptions(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showTextOptions]);

  useEffect(() => {
    if (!showScreenshotsOptions) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      if (
        screenshotsOptionsMenuRef.current &&
        !screenshotsOptionsMenuRef.current.contains(target) &&
        screenshotsOptionsBtnRef.current &&
        !screenshotsOptionsBtnRef.current.contains(target)
      ) {
        setShowScreenshotsOptions(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showScreenshotsOptions]);

  useEffect(() => {
    if (!showScreenshotsDateMenu) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      if (
        screenshotsDateMenuRef.current &&
        !screenshotsDateMenuRef.current.contains(target) &&
        // screenshotsDateBtnRef is never attached to an element (Date is
        // opened from inside the options dropdown, not its own persistent
        // button), so requiring it to be truthy made this condition always
        // false and the menu could never close on outside click (2026-08-13
        // fix -- same null-ref pattern already used for categoryMenu/
        // dateMenu above).
        (!screenshotsDateBtnRef.current || !screenshotsDateBtnRef.current.contains(target))
      ) {
        setShowScreenshotsDateMenu(false);
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [showScreenshotsDateMenu]);

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
    refresh(query, categoryFilters.length === 1 ? categoryFilters[0] : null, dateFrom, dateTo);
  }

  async function deleteItem(item: ClipItem) {
    await invoke("delete_history_item", { id: item.id });
    refresh(query, categoryFilters.length === 1 ? categoryFilters[0] : null, dateFrom, dateTo);
  }

  async function persistCustomFilters(next: CustomFilter[]) {
    const current = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { settings: { ...current, custom_filters: next } });
    setCustomFilters(next);
  }

  async function applyCustomFilter(filter: CustomFilter) {
    setCategoryFilters([]);
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

  // Client-side category narrowing on top of whatever base list applies --
  // needed because get_history only takes a single category (see refresh's
  // call sites above), so with 2+ categories selected the backend returns
  // everything and this is what actually applies the multi-select. Harmless
  // no-op when 0 or 1 categories are selected (backend already filtered).
  const categoryFilterSet = categoryFilters.length > 0 ? new Set(categoryFilters) : null;
  const filteredItems = (
    activeCustomFilter && customFilterIds
      ? items.filter((it) => customFilterIds.includes(it.id))
      : searchMode === "smart" && query.trim()
      ? sortedSmartResults.map((r) => r.item)
      : items
  ).filter((it) => !categoryFilterSet || categoryFilterSet.has(it.category));

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
      setKeyboardActive(true);
      setSelected((s) => Math.min(s + 1, filteredItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setKeyboardActive(true);
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
      className="w-full h-full rounded-r-xl bg-cream dark:bg-charcoal shadow-2xl flex flex-col overflow-hidden text-ink dark:text-cream"
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
        <div className="flex items-center gap-2">
          <img src={fatClipboardLogo} alt="FatClipboard" className="h-12 w-auto" />
          {/* Mirrors Dashboard's own sidebar tier badge (same accent-tinted
              pill, same "Pro" label) -- but only shown for Pro, not Free,
              since this docked panel has no room to spare for a badge that's
              just confirming the default tier. */}
          {tier === "pro" && (
            <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark">
              Pro
            </span>
          )}
        </div>
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
        <div className="flex-1 min-w-0 flex items-center rounded-full bg-pillTint dark:bg-charcoalSurface px-3.5 py-2 transition-colors">
          <i className="ti ti-search text-[13px] text-inkMuted dark:text-inkMutedDark mr-2 shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              (tab === "history" || tab === "transform") && searchMode === "smart"
                ? "Describe what you're looking for…"
                : tab === "history" && historyView === "screenshots"
                ? "Search screenshot text…"
                : tab === "transform"
                ? "Search your transform history…"
                : "Search clipboard history…"
            }
            // placeholder:text-[13px] (2026-08-13, was inheriting the
            // input's own text-[15px]) -- Smart mode's longer copy
            // ("Describe what you're looking for…") was wide enough at 15px
            // to run past the box's right edge and get hard-clipped (native
            // <input> placeholders don't get an ellipsis, they just cut off
            // mid-character). Only the placeholder shrinks; typed query text
            // stays at 15px.
            className="flex-1 min-w-0 bg-transparent outline-none text-[15px] placeholder:text-[13px] placeholder:text-inkMuted dark:placeholder:text-inkMutedDark"
          />
        </div>
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
            (tab === "history" || tab === "transform") ? "" : "opacity-0 pointer-events-none"
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
            tabIndex={tab === "history" || tab === "transform" ? 0 : -1}
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
          {/* pb-2.5 added (2026-08-13) -- History/Screenshots always had a
              buffer below this row for free, since the Text/Screenshots
              sub-toggle sits right under it with its own pt-1.5/pb-1.5 and
              button height. Transform and Folders have no such row, so
              without their own bottom padding here they had *zero* space
              between this row and their content -- TransformTab's own
              internal top padding couldn't make up for a missing row's
              worth of height. Putting the buffer here instead of relying on
              each panel's internal padding means all three tabs get the
              same breathing room underneath this row, consistently. */}
          <div className="grid grid-cols-3 gap-1.5 px-4 pt-2.5 pb-2.5">
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

          {/* History/Screenshots sub-toggle, redesigned 2026-08-13 as two
              split buttons instead of a plain 2-up toggle plus a separate
              Filter/Date/Stack row below it -- bigger and less rounded
              (rounded-lg, not rounded-full) per request, and each pill's
              trailing chevron opens a small options menu (Filter/Date/Stack
              for Text, just Date for Screenshots -- screenshots have no
              category filter yet) instead of those controls sitting always-
              visible in their own row. Saves a full row of vertical space.
              2026-08-15: wrapped both pills in a visible track
              (bg-black/[0.04]) -- previously the unselected pill had no
              background at all, just plain text floating next to the
              selected one's white card, so it read as unclear whether it
              was even a button and the selected/unselected split was hard
              to read at a glance. The gray track now gives the whole
              control a clear "segmented switch" shape in both themes, with
              the white/charcoalSurface pill popping against it exactly the
              way the selected tab already pops in Transform's Presets/
              Custom switcher. */}
          <AnimatePresence initial={false}>
            {tab === "history" && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
              >
            <div className="grid grid-cols-2 gap-1 mx-4 mt-1.5 mb-1.5 p-[3px] rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
              <div
                ref={textPillRef}
                className={`flex items-stretch rounded-lg transition-all overflow-hidden ${
                  historyView === "clips"
                    ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                    : "text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                }`}
              >
                <button
                  onClick={() => setHistoryView("clips")}
                  className="flex-1 text-center text-[12.5px] py-2 active:scale-[0.98] transition-transform"
                >
                  Text
                </button>
                <button
                  ref={textOptionsBtnRef}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!showTextOptions && textPillRef.current) {
                      // Aligned to the pill's own left edge (2026-08-13,
                      // was centered in the window) -- clamped so it can't
                      // run past the right edge on a narrow panel.
                      const r = textPillRef.current.getBoundingClientRect();
                      setTextOptionsPos({
                        top: r.bottom + 4,
                        left: Math.min(r.left, window.innerWidth - 168 - 8),
                      });
                    }
                    // Close the other pill's dropdown so only one is ever
                    // open at a time (2026-08-13 -- previously each chevron
                    // toggled independently, so both could be open at once).
                    setShowScreenshotsOptions(false);
                    setShowTextOptions((s) => !s);
                  }}
                  title="Filter, date, or stack options"
                  className="px-2.5 flex items-center justify-center hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                >
                  <i className={`ti ti-chevron-down text-[11px] transition-transform ${showTextOptions ? "rotate-180" : ""} ${
                    categoryFilters.length > 0 || activeCustomFilter !== null || dateFrom || dateTo || stackBuilderIds !== null
                      ? "text-accent dark:text-accentDark"
                      : ""
                  }`} />
                </button>
              </div>

              <div
                ref={screenshotsPillRef}
                className={`flex items-stretch rounded-lg transition-all overflow-hidden ${
                  historyView === "screenshots"
                    ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                    : "text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                }`}
              >
                <button
                  onClick={() => setHistoryView("screenshots")}
                  className="flex-1 text-center text-[12.5px] py-2 active:scale-[0.98] transition-transform"
                >
                  Screenshots
                </button>
                <button
                  ref={screenshotsOptionsBtnRef}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!showScreenshotsOptions && screenshotsPillRef.current) {
                      // Aligned to the pill's own left edge, same fix as
                      // Text's dropdown above.
                      const r = screenshotsPillRef.current.getBoundingClientRect();
                      setScreenshotsOptionsPos({
                        top: r.bottom + 4,
                        left: Math.min(r.left, window.innerWidth - 168 - 8),
                      });
                    }
                    setShowTextOptions(false);
                    setShowScreenshotsOptions((s) => !s);
                  }}
                  title="Date options"
                  className="px-2.5 flex items-center justify-center hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                >
                  <i className={`ti ti-chevron-down text-[11px] transition-transform ${showScreenshotsOptions ? "rotate-180" : ""} ${
                    screenshotsDateFrom || screenshotsDateTo ? "text-accent dark:text-accentDark" : ""
                  }`} />
                </button>
              </div>
            </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Text's options dropdown (2026-08-13) -- Filter/Date/Stack used
              to be their own always-visible row; now they're items here.
              Picking Filter or Date also switches historyView to "clips"
              first, since the menus they open (categoryMenu/dateMenu) only
              render inside the clips branch below -- without that, opening
              this dropdown while looking at Screenshots and picking "Filter"
              would set showCategoryMenu true with nothing mounted to show
              it. */}
          {showTextOptions &&
            textOptionsPos &&
            createPortal(
              <div
                ref={textOptionsMenuRef}
                style={{
                  position: "fixed",
                  top: textOptionsPos.top,
                  left: textOptionsPos.left,
                  backgroundColor: theme === "dark" ? "#262320" : "#FFFFFF",
                  opacity: 1,
                }}
                className="z-[9999] w-40 rounded-xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-1.5 text-ink dark:text-cream space-y-0.5"
              >
                <button
                  onClick={() => {
                    setShowTextOptions(false);
                    setHistoryView("clips");
                    if (textPillRef.current) {
                      // Aligned to the pill's left edge (2026-08-13, was
                      // centered in the window), same fix as the options
                      // dropdown itself -- w-64 (256px) here, not the
                      // options dropdown's 168px.
                      const r = textPillRef.current.getBoundingClientRect();
                      setCategoryMenuPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 256 - 8) });
                    }
                    setShowCategoryMenu(true);
                  }}
                  className={`w-full flex items-center gap-2 text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                    categoryFilters.length > 0 || activeCustomFilter !== null
                      ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                      : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  }`}
                >
                  <i className="ti ti-filter text-[13px]" />
                  Filter
                  {(categoryFilters.length > 0 || activeCustomFilter !== null) && (
                    <i className="ti ti-check text-[11px] ml-auto" />
                  )}
                </button>
                <button
                  onClick={() => {
                    setShowTextOptions(false);
                    setHistoryView("clips");
                    if (textPillRef.current) {
                      // Aligned to the pill's left edge, same fix as Filter
                      // above (w-60/240px here).
                      const r = textPillRef.current.getBoundingClientRect();
                      setDateMenuPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 240 - 8) });
                    }
                    setDateMenuView(!activeDatePreset && (dateFrom || dateTo) ? "custom" : "list");
                    setShowDateMenu(true);
                  }}
                  className={`w-full flex items-center gap-2 text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                    dateFrom || dateTo
                      ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                      : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  }`}
                >
                  <i className="ti ti-calendar text-[13px]" />
                  Date
                  {(dateFrom || dateTo) && <i className="ti ti-check text-[11px] ml-auto" />}
                </button>
                <button
                  onClick={() => {
                    setHistoryView("clips");
                    setStackBuilderIds((ids) => (ids === null ? [] : null));
                    setShowTextOptions(false);
                  }}
                  title="Select items to paste one after another, in order"
                  className={`w-full flex items-center gap-2 text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                    stackBuilderIds !== null
                      ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                      : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  }`}
                >
                  <i className="ti ti-list-numbers text-[13px]" />
                  Stack
                  {stackBuilderIds !== null && <i className="ti ti-check text-[11px] ml-auto" />}
                </button>
              </div>,
              document.body
            )}

          {/* Screenshots' options dropdown -- just Date for now (2026-08-13),
              see the task discussion: category filtering doesn't make as
              much sense here since it'd rely on possibly-empty/noisy OCR
              text, but a date range is exactly as meaningful as it is for
              Text. */}
          {showScreenshotsOptions &&
            screenshotsOptionsPos &&
            createPortal(
              <div
                ref={screenshotsOptionsMenuRef}
                style={{
                  position: "fixed",
                  top: screenshotsOptionsPos.top,
                  left: screenshotsOptionsPos.left,
                  backgroundColor: theme === "dark" ? "#262320" : "#FFFFFF",
                  opacity: 1,
                }}
                className="z-[9999] w-40 rounded-xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-1.5 text-ink dark:text-cream"
              >
                <button
                  onClick={() => {
                    setShowScreenshotsOptions(false);
                    setHistoryView("screenshots");
                    if (screenshotsPillRef.current) {
                      // Aligned to the pill's left edge, same fix as Text's
                      // Date menu above.
                      const r = screenshotsPillRef.current.getBoundingClientRect();
                      setScreenshotsDateMenuPos({
                        top: r.bottom + 4,
                        left: Math.min(r.left, window.innerWidth - 240 - 8),
                      });
                    }
                    setScreenshotsDateMenuView(
                      !screenshotsActiveDatePreset && (screenshotsDateFrom || screenshotsDateTo) ? "custom" : "list"
                    );
                    setShowScreenshotsDateMenu(true);
                  }}
                  className={`w-full flex items-center gap-2 text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                    screenshotsDateFrom || screenshotsDateTo
                      ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                      : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  }`}
                >
                  <i className="ti ti-calendar text-[13px]" />
                  Date
                  {(screenshotsDateFrom || screenshotsDateTo) && (
                    <i className="ti ti-check text-[11px] ml-auto" />
                  )}
                </button>
              </div>,
              document.body
            )}

          {/* Screenshots' actual date-range picker, opened from the options
              dropdown above -- same list/custom shape as Text's Date menu
              (DATE_PRESETS/applyScreenshotsDatePreset), kept as its own copy
              rather than shared state since it filters a completely separate
              list (screenshots, client-side in ScreenshotsPanel) from Text's
              server-side dateFrom/dateTo. */}
          {showScreenshotsDateMenu &&
            screenshotsDateMenuPos &&
            createPortal(
              <div
                ref={screenshotsDateMenuRef}
                style={{
                  position: "fixed",
                  top: screenshotsDateMenuPos.top,
                  left: screenshotsDateMenuPos.left,
                  backgroundColor: theme === "dark" ? "#262320" : "#FFFFFF",
                  opacity: 1,
                }}
                className="z-[9999] w-60 rounded-xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-1.5 text-ink dark:text-cream"
              >
                {screenshotsDateMenuView === "list" ? (
                  <div className="space-y-0.5">
                    {DATE_PRESETS.map((p) => {
                      const active = screenshotsActiveDatePreset === p.label;
                      return (
                        <button
                          key={p.label}
                          onClick={() => applyScreenshotsDatePreset(p.label, p.hours)}
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
                      onClick={() => setScreenshotsDateMenuView("custom")}
                      className={`w-full flex items-center justify-between text-left text-[12px] px-2.5 py-2 rounded-lg transition-colors ${
                        !screenshotsActiveDatePreset && (screenshotsDateFrom || screenshotsDateTo)
                          ? "bg-accent/20 dark:bg-accentDark/30 text-ink dark:text-cream font-medium"
                          : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                      }`}
                    >
                      Custom
                      <i className="ti ti-chevron-right text-[12px]" />
                    </button>
                    {(screenshotsDateFrom || screenshotsDateTo) && (
                      <button
                        onClick={() => {
                          setScreenshotsDateFrom(null);
                          setScreenshotsDateTo(null);
                          setScreenshotsActiveDatePreset(null);
                          setShowScreenshotsDateMenu(false);
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
                      onClick={() => setScreenshotsDateMenuView("list")}
                      className="flex items-center gap-1 text-[11px] text-inkMuted dark:text-inkMutedDark mb-1 hover:text-ink dark:hover:text-cream"
                    >
                      <i className="ti ti-chevron-left text-[11px]" />
                      Back
                    </button>
                    <DateRangeCalendar
                      from={!screenshotsActiveDatePreset ? screenshotsDateFrom : null}
                      to={!screenshotsActiveDatePreset ? screenshotsDateTo : null}
                      onChange={(f, t) => {
                        setScreenshotsActiveDatePreset(null);
                        setScreenshotsDateFrom(f);
                        setScreenshotsDateTo(t);
                      }}
                    />
                    <div className="flex gap-1.5 pt-1">
                      <button
                        onClick={() => {
                          setScreenshotsDateFrom(null);
                          setScreenshotsDateTo(null);
                          setScreenshotsActiveDatePreset(null);
                        }}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08]"
                      >
                        Clear
                      </button>
                      <button
                        onClick={() => setShowScreenshotsDateMenu(false)}
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
              query={query}
              searchMode={searchMode}
              pendingInput={pendingTransformInput}
              onConsumedPendingInput={() => setPendingTransformInput(null)}
              onManagePresets={(context) => {
                setPresetsJumpContext(context);
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
              dateFrom={screenshotsDateFrom}
              dateTo={screenshotsDateTo}
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
        {/* Filter/Date/Stack no longer have their own always-visible row
            (2026-08-13) -- they're now items in the Text split-button's
            options dropdown above (see textOptionsMenuRef's portal near the
            sub-toggle row). This wrapper just holds the smart-sort toggle
            plus the Date/Category menu portals those dropdown items open;
            it renders empty (no visible footprint) otherwise. */}
        <div className="shrink-0">
          {searchMode === "smart" && query.trim() && (
            <div className="mx-4 mt-2 mb-1 w-fit shrink-0 flex items-center rounded-full bg-black/[0.05] dark:bg-white/[0.07] p-0.5 text-[10.5px]">
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
                  backgroundColor: theme === "dark" ? "#262320" : "#FFFFFF",
                  opacity: 1,
                }}
                className="z-[9999] w-60 rounded-xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] p-1.5 text-ink dark:text-cream"
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
                    {/* One connected month-grid range picker (2026-08-13),
                        replacing the two separate native From/To date
                        inputs -- those opened two unrelated OS pickers with
                        no visual link between them, which read as confusing
                        for selecting a single range. */}
                    <DateRangeCalendar
                      from={!activeDatePreset ? dateFrom : null}
                      to={!activeDatePreset ? dateTo : null}
                      onChange={(f, t) => {
                        setActiveDatePreset(null);
                        setDateFrom(f);
                        setDateTo(t);
                      }}
                    />
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
                  backgroundColor: theme === "dark" ? "#262320" : "#FFFFFF",
                  opacity: 1,
                }}
                className="z-[9999] w-64 rounded-xl shadow-float dark:shadow-floatDark ring-1 ring-black/[0.06] dark:ring-white/[0.08] py-1.5 text-ink dark:text-cream"
              >
                <p className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
                  Presets
                </p>

                {/* "All" stays a full-width row (same list style as "Your
                    filters" below) so it reads as "clear the grid below"
                    rather than being just another same-sized bubble. */}
                {(() => {
                  const allActive = activeCustomFilter === null && categoryFilters.length === 0;
                  return (
                    <button
                      onClick={() => {
                        clearCustomFilter();
                        setCategoryFilters([]);
                        setShowCategoryMenu(false);
                      }}
                      className={`flex items-center gap-2 px-3.5 py-1.5 mx-1 mb-1.5 rounded-full text-[12px] text-left transition-colors ${
                        allActive
                          ? "bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
                          : "hover:bg-black/[0.07] dark:hover:bg-white/[0.09]"
                      }`}
                      style={{ width: "calc(100% - 0.5rem)" }}
                    >
                      {allActive ? (
                        <i className="ti ti-check text-[11px]" />
                      ) : (
                        <span className="w-[11px]" />
                      )}
                      <span className="flex-1 truncate">All</span>
                    </button>
                  );
                })()}

                {/* Category presets, redesigned 2026-08-10 to match
                    SettingsPanel's Categories grid -- icon + label bubbles,
                    2 per row, same color-on-select language. Scaled down
                    from Settings' h-11/text-[11.5px] to fit this dropdown's
                    narrower width, and capped at 6 regardless of how many a
                    user has enabled in Settings -- this is a quick-access
                    menu, not the full list (which still lives in Settings).
                    Multi-select (2026-08-13, was single-select) -- each
                    bubble toggles independently and the menu stays open
                    after a pick so several can be selected in one go; only
                    "All" above and clicking away close it. */}
                <div className="grid grid-cols-2 gap-1.5 px-1 mb-1">
                  {ALL_CATEGORIES.filter((f) => visibleCategories.includes(f.value))
                    .slice(0, 6)
                    .map((f) => {
                      const active = activeCustomFilter === null && categoryFilters.includes(f.value);
                      return (
                        <button
                          key={f.value}
                          onClick={() => {
                            clearCustomFilter();
                            setCategoryFilters((prev) =>
                              prev.includes(f.value)
                                ? prev.filter((c) => c !== f.value)
                                : [...prev, f.value]
                            );
                          }}
                          className={`flex items-center justify-center gap-1 h-9 px-1.5 rounded-full text-[10.5px] leading-tight text-center border transition-colors ${
                            active
                              ? "bg-accent/15 dark:bg-accentDark/20 border-accent/25 dark:border-accentDark/30 text-accent dark:text-accentDark font-medium"
                              : "bg-white dark:bg-charcoalSurface border-borderLight dark:border-borderDark text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                          }`}
                        >
                          <i className={`ti ${f.icon} text-accent dark:text-accentDark text-[11px] shrink-0`} />
                          <span className="truncate">{f.label}</span>
                        </button>
                      );
                    })}
                </div>

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

        {(categoryFilters.length > 0 || activeCustomFilter !== null || dateFrom || dateTo) && (
          <div className="flex items-center flex-wrap gap-1.5 px-4 pb-2 shrink-0">
            {categoryFilters.map((c) => (
              <span
                key={c}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark font-medium"
              >
                {ALL_CATEGORIES.find((f) => f.value === c)?.label ?? c}
                <button
                  onClick={() => setCategoryFilters((prev) => prev.filter((x) => x !== c))}
                  title="Clear this filter"
                  className="hover:opacity-70"
                >
                  <i className="ti ti-x text-[10px]" />
                </button>
              </span>
            ))}
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
                {/* text-[13px], matching the calendar icon in the Date
                    dropdown item that opens this filter (2026-08-13) -- was
                    text-[10px], same as this chip's other icons (ti-x,
                    ti-sparkles), but that made this one specifically read as
                    a different/smaller icon next to the dropdown's. */}
                <i className="ti ti-calendar text-[13px]" />
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
                  "Copy something to get started."
                )}
              </motion.div>
            )}
            {(() => {
              const renderRow = (entry: Entry, isLastInGroup: boolean) => {
                const { item, i } = entry;
                const active = hoverIndex !== null ? i === hoverIndex : keyboardActive && i === selected;
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
                      onMouseEnter={() => {
                        setHoverIndex(i);
                        setKeyboardActive(false);
                      }}
                      onMouseLeave={() => setHoverIndex(null)}
                      onClick={() =>
                        stackBuilderIds !== null
                          ? toggleStackItem(item.id)
                          : setExpandedId((id) => (id === item.id ? null : item.id))
                      }
                      className={`group relative flex items-start gap-2 px-3.5 py-3 cursor-pointer transition-colors ${
                        active ? "bg-accent/10 dark:bg-accentDark/15" : ""
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
                      <div className="rounded-xl bg-pillTint dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] hover:ring-accent/40 dark:hover:ring-accentDark/40 shadow-card dark:shadow-cardDark overflow-hidden transition-colors">
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
                      <div className="rounded-xl bg-pillTint dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] hover:ring-accent/40 dark:hover:ring-accentDark/40 shadow-card dark:shadow-cardDark overflow-hidden transition-colors">
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
