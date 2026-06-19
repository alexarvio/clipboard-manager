import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import SettingsPanel from "./components/SettingsPanel";
import TransformBar from "./components/TransformBar";
import FoldersPanel from "./components/FoldersPanel";
import FolderPicker from "./components/FolderPicker";

export interface ClipItem {
  id: number;
  content: string;
  pinned: boolean;
  created_at: string;
  category: string;
}

// Pro-only history filter chips. Value is what's sent to get_history's
// `category` param (undefined/null means "no filter" -- see db::search's
// `?2 IS NULL OR ...` SQL).
const CATEGORY_FILTERS: { label: string; value: string | null }[] = [
  { label: "All", value: null },
  { label: "Link", value: "link" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Address", value: "address" },
  { label: "Bank account", value: "bank_account" },
];

const appWindow = getCurrentWindow();

// Date + time to the minute, e.g. "Jun 18, 2:30 PM" -- seconds intentionally
// dropped since they're never useful for "when did I copy this".
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function App() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ClipItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [transformingId, setTransformingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [tab, setTab] = useState<"history" | "folders">("history");
  const [folderPickerFor, setFolderPickerFor] = useState<number | null>(null);
  const [pinLimitMsg, setPinLimitMsg] = useState(false);
  const [tier, setTier] = useState<"free" | "pro">("free");
  const [paywallMsg, setPaywallMsg] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  // Position for the portaled category dropdown (see below) -- computed from
  // the Filter button's actual screen position right before opening, since
  // the menu now renders at document.body level instead of inline.
  const [categoryMenuPos, setCategoryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const categoryMenuRef = useRef<HTMLDivElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  // The item currently loaded into the bottom transform panel, derived from
  // transformingId rather than captured per-row -- this is what lets the
  // panel swap content when a different item's sparkle icon is clicked
  // instead of needing to close and reopen.
  const activeTransformItem = items.find((it) => it.id === transformingId) ?? null;

  // Load the persisted theme + tier once. Tier has no real billing behind it
  // yet (see settings.rs) -- it's just the flag that already gates
  // transform_clip server-side and the sparkle icon here.
  useEffect(() => {
    invoke<{ theme: "dark" | "light"; tier: "free" | "pro" }>("get_settings")
      .then((s) => {
        setTheme(s.theme);
        setTier(s.tier);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Slides the panel back off the left edge before actually hiding the
  // window, instead of just popping out of existence.
  const SLIDE_MS = 200;
  function closeWithAnimation() {
    setOpen(false);
    setTimeout(() => {
      appWindow.hide();
    }, SLIDE_MS);
  }

  const refresh = useCallback(async (q: string, category: string | null) => {
    try {
      const result = await invoke<ClipItem[]>("get_history", { query: q, category });
      setItems(result);
      setSelected(0);
    } catch (e) {
      console.error("get_history failed", e);
    }
  }, []);

  // Re-fetch + refocus every time the panel becomes visible. These two events
  // are emitted explicitly by the Rust side (see toggle_panel / Focused(false)
  // in main.rs) rather than relying on the webview's own focus-changed event,
  // which fires unreliably on a transparent/always-on-top/skip-taskbar window
  // like this one -- that unreliability was leaving the panel's content
  // permanently slid off-screen with nothing visible but the window shadow.
  useEffect(() => {
    const unlistenOpen = appWindow.listen("panel-open", () => {
      setQuery("");
      setShowSettings(false);
      setTransformingId(null);
      setTab("history");
      setFolderPickerFor(null);
      setCopiedId(null);
      setExpandedId(null);
      setCategoryFilter(null);
      setOpen(true);
      refresh("", null);
      setTimeout(() => inputRef.current?.focus(), 30);
    });
    const unlistenCloseRequest = appWindow.listen("panel-close-request", () => {
      closeWithAnimation();
    });
    refresh("", null);
    inputRef.current?.focus();
    return () => {
      unlistenOpen.then((unlisten) => unlisten());
      unlistenCloseRequest.then((unlisten) => unlisten());
    };
  }, [refresh]);

  useEffect(() => {
    refresh(query, categoryFilter);
  }, [query, categoryFilter, refresh]);

  // Close the category dropdown on outside click, same pattern as
  // FolderPicker's click-away handling.
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

  // How long the "Copied" check stays visible before the panel slides away --
  // long enough to register, short enough not to feel sluggish.
  const COPY_FEEDBACK_MS = 320;
  async function pasteAndHide(item: ClipItem) {
    setCopiedId(item.id);
    await invoke("paste_item", { id: item.id });
    setTimeout(closeWithAnimation, COPY_FEEDBACK_MS);
  }

  async function togglePin(item: ClipItem) {
    const ok = await invoke<boolean>("toggle_pin", { id: item.id });
    if (!ok) {
      setPinLimitMsg(true);
      setTimeout(() => setPinLimitMsg(false), 2200);
      return;
    }
    refresh(query, categoryFilter);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      closeWithAnimation();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[hoverIndex !== null ? hoverIndex : selected];
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
      {/* title bar / search */}
      <div className="flex items-center gap-2 px-4 py-3.5 shadow-[0_1px_0_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)]">
        <i className="ti ti-search text-[14px] text-inkMuted dark:text-inkMutedDark" />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clipboard history…"
          className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-inkMuted dark:placeholder:text-inkMutedDark"
        />
        <button
          onClick={() => setShowSettings((s) => !s)}
          className="text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors p-1.5 rounded-full hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          title="Settings"
        >
          <i className="ti ti-settings text-[15px]" />
        </button>
      </div>

      {showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onThemeChange={setTheme}
          onTierChange={setTier}
        />
      ) : (
        <>
          <div className="flex gap-1 px-2.5 pt-2.5">
            <button
              onClick={() => setTab("history")}
              className={`flex-1 text-center text-[11.5px] py-1.5 rounded-full transition-all ${
                tab === "history"
                  ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                  : "text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              }`}
            >
              History
            </button>
            <button
              onClick={() => setTab("folders")}
              className={`flex-1 text-center text-[11.5px] py-1.5 rounded-full transition-all ${
                tab === "folders"
                  ? "font-medium bg-white dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                  : "text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              }`}
            >
              Folders
            </button>
          </div>

          {tab === "folders" ? (
            <FoldersPanel onPasted={closeWithAnimation} tier={tier} />
          ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center px-2.5 pt-2 pb-1 shrink-0">
          <button
            ref={filterBtnRef}
            onClick={() => {
              if (!showCategoryMenu && filterBtnRef.current) {
                const r = filterBtnRef.current.getBoundingClientRect();
                setCategoryMenuPos({ top: r.bottom + 4, left: r.left });
              }
              setShowCategoryMenu((s) => !s);
            }}
            className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full transition-colors ${
              categoryFilter !== null
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium hover:bg-accent/35 dark:hover:bg-accentDark/45"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-inkMuted dark:text-inkMutedDark hover:bg-black/[0.09] dark:hover:bg-white/[0.12] hover:text-ink dark:hover:text-cream"
            }`}
          >
            <i className="ti ti-filter text-[12px]" />
            {categoryFilter !== null
              ? CATEGORY_FILTERS.find((f) => f.value === categoryFilter)?.label ?? "Filter"
              : "Filter"}
            <i className={`ti ti-chevron-down text-[10px] transition-transform ${showCategoryMenu ? "rotate-180" : ""}`} />
          </button>

          {showCategoryMenu &&
            categoryMenuPos &&
            createPortal(
              <div
                ref={categoryMenuRef}
                style={{
                  position: "fixed",
                  top: categoryMenuPos.top,
                  left: categoryMenuPos.left,
                  // Inline, theme-driven solid color rather than relying on
                  // bg-cream/dark:bg-charcoalSurface utility classes -- this
                  // dropdown is portaled to document.body specifically to
                  // dodge stacking-context bleed-through, so its opacity
                  // shouldn't depend on Tailwind's cascade at all. If this
                  // still looks see-through, the cause isn't CSS ordering.
                  backgroundColor: theme === "dark" ? "#262320" : "#F2EEE3",
                  opacity: 1,
                }}
                className="z-[9999] w-48 rounded-2xl shadow-xl ring-1 ring-black/[0.06] dark:ring-white/[0.08] py-1.5"
              >
                {CATEGORY_FILTERS.map((f) => {
                  const active = categoryFilter === f.value;
                  const locked = tier !== "pro" && f.value !== null;
                  return (
                    <button
                      key={f.label}
                      onClick={() => {
                        if (locked) {
                          setPaywallMsg(true);
                          setTimeout(() => setPaywallMsg(false), 2600);
                          setShowCategoryMenu(false);
                          return;
                        }
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
                      {locked ? (
                        <i className="ti ti-lock text-[11px] text-inkMuted dark:text-inkMutedDark" />
                      ) : active ? (
                        <i className="ti ti-check text-[11px]" />
                      ) : (
                        <span className="w-[11px]" />
                      )}
                      <span className="flex-1 truncate">{f.label}</span>
                    </button>
                  );
                })}
              </div>,
              document.body
            )}
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <AnimatePresence initial={false}>
            {items.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-12"
              >
                {query ? (
                  "No matches."
                ) : (
                  <>
                    Copy something to get{" "}
                    <span className="font-serif italic text-ink dark:text-cream">started</span>.
                  </>
                )}
              </motion.div>
            )}
            {items.map((item, i) => (
              <div key={item.id}>
                {i === 0 && item.pinned && (
                  <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-3 pt-1 pb-1.5">
                    Pinned
                  </p>
                )}
                {!item.pinned && (i === 0 || items[i - 1].pinned) && items.some((it) => it.pinned) && (
                  <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-3 pt-2 pb-1.5">
                    Recent
                  </p>
                )}
                <motion.div
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onMouseEnter={() => setHoverIndex(i)}
                  onMouseLeave={() => setHoverIndex(null)}
                  onClick={() => setExpandedId((id) => (id === item.id ? null : item.id))}
                  className={`group relative flex items-start gap-2 rounded-2xl px-3.5 py-3 cursor-pointer mb-1.5 transition-all ${
                    (hoverIndex !== null ? i === hoverIndex : i === selected)
                      ? "bg-creamSurface dark:bg-charcoalSurface shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.07]"
                      : ""
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-[13.5px] leading-snug whitespace-pre-wrap break-words ${
                        expandedId === item.id ? "" : "line-clamp-3"
                      }`}
                    >
                      {item.content}
                    </p>
                    <p className="text-[10.5px] text-inkMuted dark:text-inkMutedDark mt-1">
                      {formatTimestamp(item.created_at)}
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      pasteAndHide(item);
                    }}
                    className="text-xs shrink-0 mt-0.5 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark transition-opacity"
                    title="Copy & paste"
                  >
                    <i className="ti ti-copy text-[14px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tier !== "pro") {
                        setPaywallMsg(true);
                        setTimeout(() => setPaywallMsg(false), 2600);
                        return;
                      }
                      setTransformingId((id) => (id === item.id ? null : item.id));
                    }}
                    className={`text-xs shrink-0 mt-0.5 transition-opacity ${
                      tier !== "pro"
                        ? "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                        : transformingId === item.id
                        ? "opacity-100 text-accent dark:text-accentDark"
                        : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                    }`}
                    title={tier === "pro" ? "Transform with AI" : "AI transform — Pro only"}
                  >
                    <i className={tier === "pro" ? "ti ti-sparkles text-[14px]" : "ti ti-lock text-[14px]"} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setFolderPickerFor((id) => (id === item.id ? null : item.id));
                    }}
                    className={`text-xs shrink-0 mt-0.5 transition-opacity ${
                      folderPickerFor === item.id
                        ? "opacity-100 text-accent dark:text-accentDark"
                        : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                    }`}
                    title="Add to folder"
                  >
                    <i className="ti ti-folder-plus text-[14px]" />
                  </button>
                  {folderPickerFor === item.id && (
                    <FolderPicker
                      content={item.content}
                      onClose={() => setFolderPickerFor(null)}
                      onAdded={() => setFolderPickerFor(null)}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(item);
                    }}
                    className={`text-xs shrink-0 mt-0.5 transition-opacity ${
                      item.pinned
                        ? "opacity-100 text-amber-500 dark:text-amber-300"
                        : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
                    }`}
                    title={item.pinned ? "Unpin" : "Pin"}
                  >
                    <i className={item.pinned ? "ti ti-star-filled text-[14px]" : "ti ti-star text-[14px]"} />
                  </button>
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
                {i < items.length - 1 && items[i + 1].pinned === item.pinned && (
                  <div className="mx-4 border-b border-black/[0.05] dark:border-white/[0.07]" />
                )}
              </div>
            ))}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {transformingId !== null && activeTransformItem && (
            <motion.div
              initial={{ height: "0%", opacity: 0 }}
              animate={{ height: "58%", opacity: 1 }}
              exit={{ height: "0%", opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 overflow-hidden border-t border-borderLight dark:border-borderDark bg-black/[0.02] dark:bg-white/[0.03]"
            >
              <TransformBar
                key={transformingId}
                content={activeTransformItem.content}
                onCancel={() => setTransformingId(null)}
                onDone={() => {
                  setTransformingId(null);
                  closeWithAnimation();
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </div>
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
            AI transform is a Pro feature — upgrade to use it.
          </motion.div>
        )}
      </AnimatePresence>

      <div className="px-4 py-2.5 text-[11px] text-inkMuted dark:text-inkMutedDark shadow-[0_-1px_0_rgba(0,0,0,0.05)] dark:shadow-[0_-1px_0_rgba(255,255,255,0.05)] flex justify-between">
        <span>↑↓ navigate</span>
        <span>↵ paste</span>
        <span>esc close</span>
      </div>
    </motion.div>
  );
}
