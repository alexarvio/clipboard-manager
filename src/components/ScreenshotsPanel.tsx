import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../lib/tauriShim";
import { formatTimestamp, dateGroupLabel } from "../lib/dateFormat";
import { clampMenuPosition } from "../lib/menuPosition";
import FolderPicker from "./FolderPicker";
import ClampedText from "./ClampedText";

export interface ScreenshotItem {
  id: number;
  width: number;
  height: number;
  pinned: boolean;
  created_at: string;
  thumb_data_uri: string;
  // Text recognized by local Windows OCR shortly after capture (see
  // src-tauri/src/ocr.rs) -- null while OCR hasn't finished yet, or found
  // nothing. Powers keyword search (below), Smart search, and the Transform
  // action, which all operate on this text rather than the image itself.
  ocr_text: string | null;
}

interface ScreenshotSemanticMatch {
  screenshot: ScreenshotItem;
  score: number;
}

const PIN_LIMIT = 3;

// Screenshots are Pro-only end to end -- the Rust watcher never captures
// them at all on Free (see main.rs), and list_screenshots/paste_screenshot/
// toggle_screenshot_pin all reject with an error if tier isn't "pro" (see
// db.rs's "Screenshots (Pro-only)" section). This component mirrors that:
// Free tier sees a locked upsell card instead of ever calling list_screenshots,
// same pattern as TransformBar not rendering at all for Free (per
// docs/free-vs-pro.md).
export default function ScreenshotsPanel({
  tier,
  query = "",
  searchMode = "text",
  dateFrom = null,
  dateTo = null,
  onPasted,
  onOpenFolder,
  onCreateNewFolder,
  onTransformItem,
}: {
  tier: "free" | "pro";
  // Both driven by the shared search bar in App.tsx -- see that file's
  // search-mode toggle, which now stays visible/active for this subtab too
  // (previously only showed for historyView === "clips").
  query?: string;
  searchMode?: "text" | "smart";
  // Screenshots' own Date filter (2026-08-13, from the Screenshots options
  // dropdown in App.tsx) -- ISO strings, applied client-side below since
  // list_screenshots has no date param server-side (unlike get_history's
  // dateFrom/dateTo, which Text's Filter/Date/Stack dropdown uses).
  dateFrom?: string | null;
  dateTo?: string | null;
  onPasted?: () => void;
  // Same routing pattern as the History tab's FolderPicker usage in App.tsx
  // -- lets "open this folder" / "create a new folder" jump straight to the
  // Folders tab instead of trying to reimplement folder browsing here.
  onOpenFolder?: (folderId: number) => void;
  onCreateNewFolder?: () => void;
  // Hands a screenshot's OCR'd text to App.tsx's goToTransform, which jumps
  // to the standalone Transform tab with it pre-loaded (2026-08-03) --
  // replaces the old in-place Transform panel this component used to open
  // over itself (see the removed transformingId/activeTransformItem state
  // and overlay below). onManagePresets is gone too -- that button lived
  // inside the removed TransformBar instance, and Transform tab wires its
  // own directly in App.tsx now.
  //
  // The second arg carries the screenshot's own thumbnail + dimensions
  // along with its OCR'd text (2026-08-03 fix) -- the first cut of this
  // hand-off only passed the text, which meant jumping to Transform lost
  // all visual reference to *which* screenshot you were transforming (it
  // just looked like a plain pasted-text run, indistinguishable from
  // Transform's freeform mode). TransformTab renders this as a small image
  // preview above its Input box when present.
  onTransformItem?: (
    content: string,
    sourceImage?: { thumb_data_uri: string; width: number; height: number; screenshot_id: number }
  ) => void;
}) {
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinMsg, setPinMsg] = useState<"limit" | null>(null);
  // Shown briefly when a Free-tier user clicks Transform -- same "check
  // client-side, show a transient message" pattern as History's RowMenu
  // (see App.tsx's onTransform), rather than opening TransformBar and
  // letting transform_clip fail server-side with a less specific error.
  const [transformPaywallMsg, setTransformPaywallMsg] = useState(false);
  // Smart (semantic) search results -- a standalone ranked list, same
  // "separate mode, not merged" reasoning as App.tsx's clip smart search
  // (see semantic_search's doc comment in main.rs).
  const [smartResults, setSmartResults] = useState<ScreenshotSemanticMatch[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);
  // The item currently open in the full-size preview modal, if any -- kept
  // separate from `screenshots` since the modal fetches its own full-res
  // image on demand (see get_screenshot_full) rather than the panel holding
  // every screenshot at full resolution just in case one gets expanded.
  const [previewItem, setPreviewItem] = useState<ScreenshotItem | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  // Screenshot id -> the folder(s) it's already saved in -- same idea as
  // App.tsx's content-keyed folderMemberships map for text clips, just keyed
  // by screenshot id instead since screenshots have no content string to
  // match against (see db.rs's list_screenshot_folder_memberships).
  const [memberships, setMemberships] = useState<Map<number, { id: number; name: string }[]>>(
    new Map()
  );
  const [folderPickerFor, setFolderPickerFor] = useState<number | null>(null);
  const [folderPickerPos, setFolderPickerPos] = useState<{ top: number; left: number } | null>(
    null
  );
  // Tracks which screenshot's full-res image is the *most recently
  // requested* one -- openPreview has no other way to tell an in-flight
  // get_screenshot_full call apart from a newer one. Without this, clicking
  // one screenshot and then quickly clicking a different one before the
  // first request finishes could let the slower response land last and
  // silently overwrite the preview with the wrong image, while the
  // timestamp/dimensions shown (read from previewItem, not previewSrc)
  // would still correctly describe the second one -- a real mismatch, not
  // just a flicker.
  const previewRequestId = useRef<number | null>(null);

  async function refresh(q: string = "") {
    setLoading(true);
    try {
      const result = await invoke<ScreenshotItem[]>("list_screenshots", {
        query: q.trim() ? q : null,
      });
      setScreenshots(result);
    } catch {
      // Pro check failed server-side -- shouldn't normally happen since we
      // don't call this at all on Free, but fail quietly either way.
      setScreenshots([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshMemberships() {
    try {
      const rows = await invoke<{ screenshot_id: number; folder_id: number; folder_name: string }[]>(
        "list_screenshot_folder_memberships"
      );
      const map = new Map<number, { id: number; name: string }[]>();
      for (const r of rows) {
        const list = map.get(r.screenshot_id) ?? [];
        list.push({ id: r.folder_id, name: r.folder_name });
        map.set(r.screenshot_id, list);
      }
      setMemberships(map);
    } catch {
      setMemberships(new Map());
    }
  }

  useEffect(() => {
    refreshMemberships();

    // One-time-per-mount catch-up: OCR only ever runs automatically at
    // capture time, so any screenshot saved before this feature existed in a
    // working build never got OCR'd and would otherwise sit unsearchable
    // (and with a permanently-dim Transform icon) forever. Cheap to call on
    // every mount -- see backfill_screenshot_ocr's doc comment in main.rs,
    // it only ever touches screenshots that are still genuinely unprocessed.
    // Local/free like the rest of capture+OCR (see docs/free-vs-pro.md), so
    // this runs on both tiers now, not just Pro.
    (async () => {
      try {
        const processed = await invoke<number>("backfill_screenshot_ocr");
        if (processed > 0) refresh(query);
      } catch {
        // OCR errored out -- fail quietly, same as every other screenshots
        // command here.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text-mode list (and keyword search) -- re-fetches whenever the shared
  // query changes, same as History's own refresh effect. Skipped while in
  // Smart mode, which has its own effect below. Free/Pro split (2026-08-01):
  // viewing and keyword-searching screenshots is free like text history, so
  // this no longer checks tier -- only the Smart-search effect below and
  // the Transform action stay Pro-gated.
  useEffect(() => {
    if (searchMode === "smart") {
      // Nothing to fetch here in Smart mode -- but `loading` starts out true,
      // so bailing without clearing it left the whole panel stuck on
      // "Loading…" (the early return below happens before the Smart results
      // ever render) whenever Screenshots was opened while Smart was active.
      setLoading(false);
      return;
    }
    refresh(query);
  }, [query, searchMode]);

  // Smart (semantic) search -- mirrors App.tsx's clip smart-search effect:
  // debounced, cancellable, cleared out whenever the mode/query stop calling
  // for it. See semantic_search_screenshots's doc comment in main.rs for why
  // this also lazily embeds any not-yet-embedded screenshots before ranking.
  // Still Pro-only -- this is the AI-backed half of the feature.
  useEffect(() => {
    if (tier !== "pro" || searchMode !== "smart" || !query.trim()) {
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
        const matches = await invoke<ScreenshotSemanticMatch[]>("semantic_search_screenshots", { query });
        if (!cancelled) setSmartResults(matches);
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
  }, [tier, query, searchMode]);

  async function paste(item: ScreenshotItem) {
    await invoke("paste_screenshot", { id: item.id });
    onPasted?.();
  }

  async function remove(item: ScreenshotItem) {
    await invoke("delete_screenshot", { id: item.id });
    setScreenshots((s) => s.filter((i) => i.id !== item.id));
    setSmartResults((s) => s.filter((m) => m.screenshot.id !== item.id));
    if (previewItem?.id === item.id) closePreview();
    refreshMemberships();
  }

  async function togglePin(item: ScreenshotItem) {
    try {
      const ok = await invoke<boolean>("toggle_screenshot_pin", { id: item.id });
      if (!ok) {
        setPinMsg("limit");
        setTimeout(() => setPinMsg(null), 2200);
        return;
      }
      refresh(query);
    } catch {
      // Pro check failed -- shouldn't happen since the tab is locked on Free.
    }
  }

  async function openPreview(item: ScreenshotItem) {
    previewRequestId.current = item.id;
    setPreviewItem(item);
    setPreviewSrc(null);
    setPreviewError(false);
    try {
      const fullDataUri = await invoke<string>("get_screenshot_full", { id: item.id });
      // Bail out if a newer openPreview call has started since this one --
      // see previewRequestId's own comment above.
      if (previewRequestId.current !== item.id) return;
      setPreviewSrc(fullDataUri);
    } catch {
      if (previewRequestId.current !== item.id) return;
      setPreviewError(true);
    }
  }

  function closePreview() {
    setPreviewItem(null);
    setPreviewSrc(null);
    setPreviewError(false);
  }

  // Screenshots itself is free on both tiers now (2026-08-01 split, see
  // docs/free-vs-pro.md) -- capturing, viewing, pasting, pinning, keyword
  // search, and filing into folders are all local. Only the AI-backed
  // pieces (Transform below, and the Smart-search effect above) still check
  // tier and paywall individually, the same way a Free-tier custom AI
  // filter attempt does in History -- there's no reason to lock the whole
  // tab out when most of what it does costs nothing to run.

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-inkMuted dark:text-inkMutedDark">
        Loading…
      </div>
    );
  }

  // Same "Pinned, then grouped by day" layout as the text History tab (see
  // App.tsx), so the two tabs feel like the same product rather than
  // Screenshots being an ungrouped afterthought.
  // Client-side date filter (2026-08-13) -- applied here rather than at
  // fetch time so pin state / OCR backfill etc. don't need to know about it.
  // Preset ranges (App.tsx's applyScreenshotsDatePreset) arrive as full ISO
  // timestamps already, but the custom-range date inputs pass bare
  // "YYYY-MM-DD" strings -- same padding App.tsx's dayBoundIso does for
  // Text's own dateFrom/dateTo before those hit the backend, needed here too
  // since a bare date otherwise string-compares as *before* every timestamp
  // on that same day (breaking dateTo in particular -- every item from the
  // selected end day would get excluded).
  function dayBoundIso(date: string | null, endOfDay: boolean): string | null {
    if (!date) return null;
    if (date.includes("T")) return date;
    return `${date}T${endOfDay ? "23:59:59.999" : "00:00:00"}`;
  }
  const boundedDateFrom = dayBoundIso(dateFrom, false);
  const boundedDateTo = dayBoundIso(dateTo, true);
  function inDateRange(item: ScreenshotItem) {
    if (boundedDateFrom && item.created_at < boundedDateFrom) return false;
    if (boundedDateTo && item.created_at > boundedDateTo) return false;
    return true;
  }
  const dateFilteredScreenshots = dateFrom || dateTo ? screenshots.filter(inDateRange) : screenshots;
  const pinned = dateFilteredScreenshots.filter((s) => s.pinned);
  const unpinned = dateFilteredScreenshots.filter((s) => !s.pinned);
  const dateGroups: { label: string; items: ScreenshotItem[] }[] = [];
  const groupIndexByLabel = new Map<string, number>();
  for (const item of unpinned) {
    const label = dateGroupLabel(item.created_at);
    let idx = groupIndexByLabel.get(label);
    if (idx === undefined) {
      idx = dateGroups.length;
      groupIndexByLabel.set(label, idx);
      dateGroups.push({ label, items: [] });
    }
    dateGroups[idx].items.push(item);
  }

  // Restructured (2026-08-03) into a card layout, same "give the content
  // room to breathe" pass just applied to History rows -- the previous
  // version squeezed a small thumbnail, a hover-only icon row, the date,
  // the dimensions, and a single-line truncated OCR excerpt all into one
  // tight horizontal strip. Now the screenshot gets its own full-width
  // block up top (bigger, and the obvious click target for the expand
  // modal), the OCR excerpt below it uses the same ClampedText affordance
  // as every other clamped preview in the app (clamp + explicit "Show
  // more"), and date/dimensions/icons share one line at the bottom, same
  // alignment fix as History's row (icons as real flex siblings on the
  // date's own line, not independently positioned).
  function renderRow(item: ScreenshotItem, isLast: boolean, score?: number) {
    const savedIn = memberships.get(item.id) ?? [];
    return (
      <div key={item.id}>
        <div className="group relative px-3 py-2.5 hover:bg-accent/10 dark:hover:bg-accentDark/15 transition-colors">
          {/* A plain cropped rectangle (object-cover, no black letterbox
              backdrop) rather than the letterboxed square used briefly here
              before -- same idea as the small "From a screenshot" preview
              card in TransformTab, just scaled up to card size instead of
              icon size, since this row also needs to fit the date, size,
              expandable OCR text, and the icon row underneath. */}
          <div
            onClick={() => openPreview(item)}
            title="Click to expand"
            className="group/img relative rounded-lg overflow-hidden cursor-pointer h-32"
          >
            <img
              src={item.thumb_data_uri}
              alt=""
              className="w-full h-full object-cover bg-black/[0.05] dark:bg-white/[0.08]"
              draggable={false}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/img:bg-black/20 transition-colors">
              <i className="ti ti-zoom-in text-white text-[18px] opacity-0 group-hover/img:opacity-90 transition-opacity" />
            </div>
          </div>

          {item.ocr_text && (
            <div className="mt-2">
              <ClampedText
                text={item.ocr_text.replace(/\s+/g, " ").trim()}
                lines={3}
                className="text-[12px] leading-snug text-inkMuted dark:text-inkMutedDark italic"
              />
            </div>
          )}

          {/* Size on top, date below (2026-08-03) -- stacked instead of
              side by side on one line, with the icon cluster vertically
              centered against the whole two-line block rather than pinned
              to just one of the two lines. */}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="text-[10.5px] text-inkMuted dark:text-inkMutedDark min-w-0">
              <p className="flex items-center gap-1.5">
                <span>
                  {item.width}×{item.height}
                </span>
                {typeof score === "number" && (
                  <span className="text-[10px] px-1.5 py-[1px] rounded-full bg-accent/15 dark:bg-accentDark/20 text-accent dark:text-accentDark shrink-0">
                    {Math.round(score * 100)}% match
                  </span>
                )}
              </p>
              <p className="mt-0.5">{formatTimestamp(item.created_at)}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  paste(item);
                }}
                title="Copy & paste"
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark transition-opacity"
              >
                <i className="ti ti-copy text-[14px]" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(item);
                }}
                title={item.pinned ? "Unpin" : "Pin"}
                // Hover-only, same convention as History rows -- a
                // screenshot's presence in the "Pinned" section up top
                // already shows it's pinned, so a second, permanently-lit
                // badge here would be redundant.
                className={`opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity ${
                  item.pinned ? "text-accent dark:text-accentDark" : "text-inkMuted dark:text-inkMutedDark"
                }`}
              >
                <i className={item.pinned ? "ti ti-pinned-filled text-[14px]" : "ti ti-pin text-[14px]"} />
              </button>
              <button
                onClick={(e) => {
                  // Always stop propagation, even when there's no OCR text
                  // yet -- previously this button was `disabled` with
                  // pointer-events-none when !item.ocr_text, which meant the
                  // click fell straight through to the row's own onClick
                  // instead of doing nothing. Kept as a plain (non-disabled)
                  // button so it always swallows its own click; the no-op
                  // case just declines to open the panel.
                  e.stopPropagation();
                  if (!item.ocr_text) return;
                  if (tier !== "pro") {
                    setTransformPaywallMsg(true);
                    setTimeout(() => setTransformPaywallMsg(false), 2600);
                    return;
                  }
                  onTransformItem?.(item.ocr_text, {
                    thumb_data_uri: item.thumb_data_uri,
                    width: item.width,
                    height: item.height,
                    screenshot_id: item.id,
                  });
                }}
                title={
                  !item.ocr_text
                    ? "Transform with AI (no text found in this screenshot yet)"
                    : tier !== "pro"
                    ? "Transform with AI is a Pro feature"
                    : "Transform with AI"
                }
                className={`transition-opacity ${
                  !item.ocr_text
                    ? "opacity-0 group-hover:opacity-20 cursor-default text-inkMuted dark:text-inkMutedDark"
                    : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark"
                }`}
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
                title={savedIn.length > 0 ? `Saved in ${savedIn.map((f) => f.name).join(", ")}` : "Add to folder"}
                className={`relative transition-opacity ${
                  savedIn.length > 0 || folderPickerFor === item.id
                    ? "opacity-100 text-accent dark:text-accentDark"
                    : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark"
                }`}
              >
                <i className="ti ti-folder-plus text-[14px]" />
                {savedIn.length > 0 && folderPickerFor !== item.id && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center w-2.5 h-2.5 rounded-full bg-cream dark:bg-charcoalSurface">
                    <i className="ti ti-check text-accent dark:text-accentDark text-[8px] leading-none" />
                  </span>
                )}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(item);
                }}
                title="Delete"
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark hover:!text-red-500 dark:hover:!text-red-400 transition-opacity"
              >
                <i className="ti ti-trash text-[14px]" />
              </button>
            </div>
          </div>

          {folderPickerFor === item.id &&
            folderPickerPos &&
            createPortal(
              <FolderPicker
                savedIn={savedIn}
                position={folderPickerPos}
                onClose={() => setFolderPickerFor(null)}
                onAdd={async (folderId) => {
                  await invoke("add_screenshot_to_folder", {
                    folderId,
                    screenshotId: item.id,
                    title: null,
                  });
                  setFolderPickerFor(null);
                  refreshMemberships();
                }}
                onOpenFolder={(folderId) => {
                  setFolderPickerFor(null);
                  onOpenFolder?.(folderId);
                }}
                onCreateNewFolder={() => {
                  setFolderPickerFor(null);
                  onCreateNewFolder?.();
                }}
              />,
              document.body
            )}
        </div>
        {!isLast && <div className="mx-3 border-b border-black/[0.05] dark:border-white/[0.07]" />}
      </div>
    );
  }

  const showSmart = searchMode === "smart" && query.trim().length > 0;

  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
    {/* pt-3 instead of the plain py-2 this used to have (2026-08-06) --
        widens the gap between the Text/Screenshots toggle row above (in
        App.tsx) and the first card here (Pinned or the first date group),
        so the toggle pill's own ring/shadow has clear room and doesn't read
        as touching/overlapping the card below it. */}
    <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
      {transformPaywallMsg && (
        <div className="mx-1 mt-1 mb-2 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3 py-2 text-[11.5px] text-accent dark:text-accentDark text-center font-medium">
          Transform with AI is a Pro feature — upgrade to use it on screenshots.
        </div>
      )}
      {showSmart ? (
        // Smart (semantic) search over screenshots' OCR'd text -- a
        // standalone ranked list, same "separate mode, not merged into the
        // grouped view" reasoning as History's own Smart search.
        smartLoading ? (
          <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10 px-4">
            Searching…
          </p>
        ) : smartError ? (
          <p className="text-red-500 dark:text-red-400 text-[12.5px] text-center mt-10 px-4">
            {smartError}
          </p>
        ) : (dateFrom || dateTo ? smartResults.filter((m) => inDateRange(m.screenshot)) : smartResults)
            .length === 0 ? (
          <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10 px-4">
            No screenshots match "{query}".
          </p>
        ) : (
          <div className="mb-3">
            <div className="rounded-xl bg-creamSurface/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] hover:ring-accent/40 dark:hover:ring-accentDark/40 shadow-card dark:shadow-cardDark overflow-hidden transition-colors">
              {(dateFrom || dateTo ? smartResults.filter((m) => inDateRange(m.screenshot)) : smartResults).map(
                (m, idx, arr) => renderRow(m.screenshot, idx === arr.length - 1, m.score)
              )}
            </div>
          </div>
        )
      ) : (
        <>
          {dateFilteredScreenshots.length === 0 &&
            (query.trim() ? (
              <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10 px-4">
                No screenshots match "{query}".
              </p>
            ) : dateFrom || dateTo ? (
              <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10 px-4">
                No screenshots in that date range.
              </p>
            ) : (
              <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10 px-4">
                No screenshots yet -- take one (Win+Shift+S or PrintScreen) and it'll show up here.
              </p>
            ))}

          {pinMsg === "limit" && (
            <div className="mx-1 mt-1 mb-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-[11.5px] text-inkMuted dark:text-inkMutedDark text-center">
              Pin limit reached ({PIN_LIMIT}) — unpin one first.
            </div>
          )}

          {pinned.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-1 pb-1.5">
                Pinned
              </p>
              {/* Same boxed-group treatment as History's Pinned/date sections
                  (rounded card, tinted background, hairline ring) so screenshots
                  taken the same day read as one grouped card instead of a bare
                  grid floating under a label. */}
              <div className="rounded-xl bg-creamSurface/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] hover:ring-accent/40 dark:hover:ring-accentDark/40 shadow-card dark:shadow-cardDark overflow-hidden transition-colors">
                {pinned.map((item, idx) => renderRow(item, idx === pinned.length - 1))}
              </div>
            </div>
          )}

          {dateGroups.map((group) => (
            <div key={group.label} className="mb-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-1 pb-1.5">
                {group.label}
              </p>
              <div className="rounded-xl bg-creamSurface/70 dark:bg-charcoalSurface/70 ring-1 ring-black/[0.15] dark:ring-white/[0.15] hover:ring-accent/40 dark:hover:ring-accentDark/40 shadow-card dark:shadow-cardDark overflow-hidden transition-colors">
                {group.items.map((item, idx) => renderRow(item, idx === group.items.length - 1))}
              </div>
            </div>
          ))}
        </>
      )}

      {previewItem &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] bg-black/75 flex flex-col items-center justify-center p-6 gap-3"
            onClick={closePreview}
          >
            <div
              className="flex items-center gap-2 text-white/90 text-[12px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span>{formatTimestamp(previewItem.created_at)}</span>
              <span className="opacity-50">
                {previewItem.width}×{previewItem.height}
              </span>
            </div>

            <div
              className="max-w-full max-h-[70vh] flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {previewError ? (
                <p className="text-white/80 text-[13px]">Couldn't load this screenshot.</p>
              ) : previewSrc ? (
                <img
                  src={previewSrc}
                  alt=""
                  className="max-w-full max-h-[70vh] rounded-lg shadow-2xl object-contain"
                  draggable={false}
                />
              ) : (
                <p className="text-white/70 text-[13px]">Loading…</p>
              )}
            </div>

            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  paste(previewItem);
                  closePreview();
                }}
                className="flex items-center gap-1.5 rounded-lg bg-white text-charcoal text-[12.5px] font-medium px-4 py-2"
              >
                <i className="ti ti-copy text-[13px]" />
                Copy & paste
              </button>
              <button
                onClick={closePreview}
                className="rounded-lg bg-white/10 hover:bg-white/15 transition-colors text-white/90 text-[12.5px] px-4 py-2"
              >
                Close
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>

    {/* The in-place Transform overlay that used to live here (full-height,
        showing the image above a docked TransformBar) is gone as of
        2026-08-03 -- clicking Transform on a screenshot now jumps to the
        standalone Transform tab instead (see App.tsx's goToTransform),
        which has room for the full Input/Instruction/Output layout instead
        of a panel squeezed into this popup. */}
    </div>
  );
}
