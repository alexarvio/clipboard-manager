import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Reorder, useDragControls } from "framer-motion";
import { invoke } from "../lib/tauriShim";
import { formatTimestamp } from "../lib/dateFormat";
import { clampMenuPosition } from "../lib/menuPosition";
import ClampedText from "./ClampedText";
import FolderPicker from "./FolderPicker";
import {
  extractPlaceholders,
  fillTemplate,
  insertPlaceholder,
  loadLastValues,
  saveLastValues,
} from "../lib/templates";

// Shared by both the "New item" and "Edit item" content textareas -- reads
// whatever's currently selected (or just the cursor position, if nothing
// is), hands it to insertPlaceholder, and re-syncs the controlled
// textarea's selection afterward. The rAF delay matters: the textarea is
// React-controlled, so calling setSelectionRange synchronously would still
// see the *old* value (this click's setValue hasn't re-rendered yet) and
// the browser would clamp the range against that shorter string.
function applyPlaceholderAtSelection(
  ref: React.RefObject<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void
) {
  const el = ref.current;
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const { text, cursorStart, cursorEnd } = insertPlaceholder(value, start, end);
  setValue(text);
  requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(cursorStart, cursorEnd);
  });
}

export interface Folder {
  id: number;
  name: string;
  created_at: string;
  item_count: number;
  pinned: boolean;
  // NULL/undefined = top-level folder. Subfolders (2026-07-19) reuse this
  // same shape with a self-referential parent, so a folder and a subfolder
  // are identical in every other respect (pinning, item limits, etc.).
  parent_id: number | null;
  // How many direct child folders this one has -- used to decide whether
  // to render a "Folders" section inside its detail view at all.
  subfolder_count: number;
}

export interface FolderItem {
  id: number;
  folder_id: number;
  title: string | null;
  content: string;
  created_at: string;
  // "text" (content holds the saved text) or "screenshot" (content is
  // unused; screenshot_id + thumb_data_uri point at the referenced row in
  // the screenshots table -- see db.rs's add_screenshot_to_folder). Folders
  // can freely mix both kinds; this is a per-item tag.
  kind: "text" | "screenshot";
  screenshot_id: number | null;
  thumb_data_uri: string | null;
}

const FREE_FOLDER_LIMIT = 3;

type View =
  | { kind: "list" }
  // `path` is the chain of folders from the top level down to the one
  // currently open (2026-07-19, for subfolders) -- path[path.length - 1] is
  // "this" folder, and Back pops one entry off instead of always returning
  // to the root list.
  | { kind: "detail"; path: Folder[] }
  | { kind: "edit"; path: Folder[]; item: FolderItem }
  // Shown instead of pasting immediately when a text item contains one or
  // more {{placeholder}} markers -- see lib/templates.ts.
  | { kind: "fillTemplate"; path: Folder[]; item: FolderItem; placeholders: string[] };

export default function FoldersPanel({
  onPasted,
  tier,
  openFolderId,
  onOpenedFolder,
  onMembershipsChanged,
  startCreating,
  onStartedCreating,
  onStartPasteQueue,
  onTransformItem,
}: {
  onPasted: () => void;
  tier: "free" | "pro";
  // Hands a text item's content to App.tsx's goToTransform, which jumps to
  // the standalone Transform tab with it pre-loaded (2026-08-03) --
  // replaces the in-place Transform overlay this panel used to render over
  // itself (see the removed transformingItem state below). Optional since
  // Dashboard.tsx also reuses this component but hasn't wired up its own
  // equivalent yet (its Home feed still uses a separate, not-yet-migrated
  // TransformBar sheet) -- the row's Transform action just silently no-ops
  // there for now rather than making this a hard requirement everywhere.
  onTransformItem?: (content: string) => void;
  // Set by the History tab's "saved in" indicator to jump straight into that
  // folder's detail view once it's available. onOpenedFolder clears it back
  // to null so re-clicking the same folder later still re-triggers the jump.
  openFolderId?: number | null;
  onOpenedFolder?: () => void;
  // Called after add/remove so the History tab's "already saved" indicators
  // stay in sync with changes made from inside the Folders tab.
  onMembershipsChanged?: () => void;
  // Set by the History tab's "New folder" option (inside the Add-to-folder
  // picker) to jump to the folder list with the inline name input already
  // open. onStartedCreating clears it back to false so it can re-trigger later.
  startCreating?: boolean;
  onStartedCreating?: () => void;
  // Multi-item sequential paste ("Stack" mode, 2026-07-19), same feature as
  // the History tab's Stack button -- App.tsx owns the actual pasteQueue
  // state (so it survives the panel hiding/showing regardless of which tab
  // is active), so this just hands over the ordered selection once the user
  // hits Start.
  onStartPasteQueue: (entries: { id: number; content: string }[]) => void;
}) {
  // Child folders of the *current* context -- top-level folders while
  // view.kind === "list", or the open folder's direct subfolders while
  // view.kind === "detail". Refetched whenever that context changes (see
  // the effect below) rather than kept as one big flat list, mirroring how
  // list_folders/db::list_folders scope by parent_id now.
  const [folders, setFolders] = useState<Folder[]>([]);
  // Root-level folders, kept as its own separate fetch (2026-08-08) from
  // `folders` above -- `folders` is scoped to "children of currentParentId"
  // (root while the list is collapsed, or a specific open folder's
  // subfolders once one is expanded), so it can't double as "the root list
  // to render rows for" once a folder is open. rootFolders always mirrors
  // parentId: null regardless of what's currently expanded, so the always-
  // visible root list (with an expanded folder's contents nested inline
  // below its own row -- see the merged "list"/"detail at path length 1"
  // render branch below) has something stable to map over.
  const [rootFolders, setRootFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<FolderItem[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [creating, setCreating] = useState(false);
  const newItemContentRef = useRef<HTMLTextAreaElement>(null);
  const [newName, setNewName] = useState("");
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const [newSubfolderName, setNewSubfolderName] = useState("");
  const [creatingItem, setCreatingItem] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemContent, setNewItemContent] = useState("");
  // null = "this folder" (the one currently open). Only ever set to a real
  // id when the open folder has subfolders and the user picks one in the
  // creatingItem form below.
  const [newItemTargetId, setNewItemTargetId] = useState<number | null>(null);
  // Popover state for "add this item to another folder" (2026-07-28) -- one
  // pair shared across all rows in this folder (only one can be open at a
  // time), same pattern History/Screenshots use for their own FolderPicker.
  const [itemFolderPickerFor, setItemFolderPickerFor] = useState<number | null>(null);
  const [itemFolderPickerPos, setItemFolderPickerPos] = useState<{ top: number; left: number } | null>(
    null
  );
  const [pinMsg, setPinMsg] = useState<"limit" | "pro" | null>(null);
  // Stack mode (2026-07-19) -- same ordered-selection UX as the History
  // tab's Stack button, scoped to whichever folder is currently open. null =
  // not building a selection; [] = building one, nothing tapped yet.
  const [stackBuilderIds, setStackBuilderIds] = useState<number[] | null>(null);
  // AI transform for folder items (2026-07-21) -- text items only, same
  // Pro-gated flow as the History tab's row menu. Used to render its own
  // in-place TransformBar overlay here; as of 2026-08-03 it just hands the
  // item's content to App.tsx's onTransformItem instead, which jumps to the
  // standalone Transform tab (see that prop's doc comment above).
  const [transformPaywall, setTransformPaywall] = useState(false);

  // Full-screen screenshot preview (2026-08-05) -- clicking a screenshot
  // item's image now expands into the same full-resolution zoom overlay the
  // Screenshots tab itself uses, instead of always jumping straight to the
  // Edit screen. Lives at this level (not inside FolderItemRow) so there's
  // one shared fetch/portal regardless of which row triggered it, same
  // pattern as ScreenshotsPanel's own previewItem/previewSrc.
  const [previewItem, setPreviewItem] = useState<FolderItem | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const previewRequestId = useRef<number | null>(null);

  async function openScreenshotPreview(item: FolderItem) {
    if (item.screenshot_id == null) return;
    previewRequestId.current = item.screenshot_id;
    setPreviewItem(item);
    setPreviewSrc(null);
    setPreviewError(false);
    try {
      const uri = await invoke<string>("get_screenshot_full", { id: item.screenshot_id });
      if (previewRequestId.current !== item.screenshot_id) return;
      setPreviewSrc(uri);
    } catch {
      if (previewRequestId.current !== item.screenshot_id) return;
      setPreviewError(true);
    }
  }

  function closeScreenshotPreview() {
    setPreviewItem(null);
    setPreviewSrc(null);
    setPreviewError(false);
  }

  const currentFolder = view.kind === "detail" ? view.path[view.path.length - 1] : null;
  const currentParentId = currentFolder ? currentFolder.id : null;

  async function refreshFolders(parentId: number | null) {
    const result = await invoke<Folder[]>("list_folders", { parentId });
    setFolders(result);
  }

  async function refreshRootFolders() {
    const result = await invoke<Folder[]>("list_folders", { parentId: null });
    setRootFolders(result);
  }

  async function refreshItems(folderId: number) {
    const result = await invoke<FolderItem[]>("list_folder_items", { folderId });
    setItems(result);
  }

  // Refetch the child-folder list whenever the current context (root vs. a
  // specific open folder) changes -- covers both navigating into a folder
  // and popping back out of one.
  useEffect(() => {
    refreshFolders(currentParentId);
    refreshRootFolders();
  }, [currentParentId]);

  useEffect(() => {
    if (openFolderId == null) return;
    // Fetched directly by id rather than found in the current `folders`
    // list, since that list is now scoped to one level -- the target folder
    // could be nested somewhere we haven't loaded. This does mean the jump
    // lands showing just that one folder as the path (no reconstructed
    // breadcrumb back through its real ancestors) -- a known simplification,
    // Back from here goes to the root list rather than a parent folder.
    invoke<Folder | null>("get_folder", { id: openFolderId }).then((folder) => {
      if (folder) {
        setView({ kind: "detail", path: [folder] });
        onOpenedFolder?.();
      }
    });
  }, [openFolderId]);

  useEffect(() => {
    if (!startCreating) return;
    setView({ kind: "list" });
    setCreating(true);
    onStartedCreating?.();
  }, [startCreating]);

  useEffect(() => {
    if (view.kind === "detail") refreshItems(view.path[view.path.length - 1].id);
  }, [view.kind === "detail" ? view.path[view.path.length - 1].id : null]);

  async function createFolder() {
    const name = newName.trim();
    if (!name) return;
    try {
      await invoke("create_folder", { name, parentId: null });
      setNewName("");
      setCreating(false);
      refreshRootFolders();
    } catch {
      // limit reached -- the card below already communicates this
      setCreating(false);
    }
  }

  async function createSubfolder(parent: Folder) {
    const name = newSubfolderName.trim();
    if (!name) return;
    try {
      await invoke("create_folder", { name, parentId: parent.id });
      setNewSubfolderName("");
      setCreatingSubfolder(false);
      refreshFolders(parent.id);
    } catch {
      setCreatingSubfolder(false);
    }
  }

  function openFolder(folder: Folder) {
    const basePath = view.kind === "detail" ? view.path : [];
    setStackBuilderIds(null);
    setView({ kind: "detail", path: [...basePath, folder] });
  }

  // Root list rows expand/collapse in place (2026-08-08) instead of always
  // pushing a new full-screen "detail" view -- clicking the folder that's
  // already open collapses it back to the plain list; clicking any other
  // root folder opens *that* one inline instead (only one expanded at a
  // time, same as before). Subfolders reached from inside an expanded
  // folder still use openFolder/goBack and render full-screen -- see the
  // view.path.length > 1 render branch below.
  function toggleRootFolder(folder: Folder) {
    if (view.kind === "detail" && view.path.length === 1 && view.path[0].id === folder.id) {
      setView({ kind: "list" });
      return;
    }
    setStackBuilderIds(null);
    setView({ kind: "detail", path: [folder] });
  }

  function goBack() {
    if (view.kind !== "detail" && view.kind !== "edit" && view.kind !== "fillTemplate") return;
    const path = view.path;
    setStackBuilderIds(null);
    if (path.length > 1) {
      setView({ kind: "detail", path: path.slice(0, -1) });
    } else {
      setView({ kind: "list" });
    }
  }

  // Toggles one item's membership in the in-progress stack selection --
  // mirrors App.tsx's toggleStackItem for the History tab: adds to the end
  // if not yet selected (so tap order = paste order), removes without
  // renumbering the rest if tapped again.
  function toggleStackItem(id: number) {
    setStackBuilderIds((ids) => {
      if (!ids) return ids;
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
    });
  }

  // Hands the selected items (in tap order) up to App.tsx's pasteQueue via
  // onStartPasteQueue. Screenshot items have no text content, so their
  // preview in the PasteQueue screen falls back to the title or a generic
  // label instead of showing blank.
  function startFolderStack() {
    if (!stackBuilderIds || stackBuilderIds.length === 0) return;
    const queue = stackBuilderIds
      .map((id) => items.find((it) => it.id === id))
      .filter((it): it is FolderItem => !!it)
      .map((it) => ({
        id: it.id,
        content: it.kind === "screenshot" ? it.title || "Screenshot" : it.content,
      }));
    if (queue.length === 0) return;
    onStartPasteQueue(queue);
    setStackBuilderIds(null);
  }

  async function pasteItem(item: FolderItem) {
    // Templates (see lib/templates.ts) intercept the normal paste flow --
    // show the fill-in screen instead of pasting the literal {{placeholder}}
    // text. Only text items can be templates; screenshots always paste
    // straight through.
    if (item.kind === "text") {
      const placeholders = extractPlaceholders(item.content);
      if (placeholders.length > 0 && view.kind === "detail") {
        setView({ kind: "fillTemplate", path: view.path, item, placeholders });
        return;
      }
    }
    try {
      await invoke("paste_folder_item", { id: item.id });
      onPasted();
    } catch {
      // e.g. the screenshot this item referenced got deleted from the
      // Screenshots tab in the meantime -- fail quietly rather than leaving
      // an unhandled rejection.
    }
  }

  // Pastes the template with its placeholders substituted -- the stored
  // folder item itself (item.content) is never modified, so the same
  // template is reusable next time with different values.
  async function pasteFilledTemplate(path: Folder[], item: FolderItem, values: Record<string, string>) {
    saveLastValues(item.id, values);
    const finalText = fillTemplate(item.content, values);
    await invoke("paste_text", { text: finalText });
    onPasted();
    setView({ kind: "detail", path });
  }

  // Text items go through update_folder_item (title + content); screenshot
  // items only have an editable title (see db.rs's update_folder_item_title
  // -- there's no text content to send back for those).
  async function saveItem(path: Folder[], item: FolderItem, title: string, content: string) {
    if (item.kind === "screenshot") {
      await invoke("update_folder_item_title", {
        id: item.id,
        title: title.trim() ? title.trim() : null,
      });
    } else {
      await invoke("update_folder_item", {
        id: item.id,
        title: title.trim() ? title.trim() : null,
        content,
      });
    }
    await refreshItems(path[path.length - 1].id);
    onMembershipsChanged?.();
    setView({ kind: "detail", path });
  }

  // 2026-07-28: previously always targeted `folder.id` (the currently open
  // folder) with no way to send a new item straight into one of its
  // subfolders instead -- reported as "if that folder has a subfolder I'm
  // never given the option to add it there". newItemTargetId defaults to
  // the open folder and is only ever shown as a choice when it actually has
  // subfolders to choose from (see the picker in the creatingItem form).
  async function addNewItem(folder: Folder) {
    const content = newItemContent.trim();
    if (!content) return;
    const targetId = newItemTargetId ?? folder.id;
    await invoke("add_to_folder", {
      folderId: targetId,
      content,
      title: newItemTitle.trim() ? newItemTitle.trim() : null,
    });
    setNewItemTitle("");
    setNewItemContent("");
    setCreatingItem(false);
    setNewItemTargetId(null);
    if (targetId === folder.id) refreshItems(folder.id);
    refreshFolders(currentParentId);
    refreshRootFolders();
    onMembershipsChanged?.();
  }

  async function removeItem(path: Folder[], item: FolderItem) {
    await invoke("delete_folder_item", { id: item.id });
    await refreshItems(path[path.length - 1].id);
    refreshFolders(currentParentId);
    refreshRootFolders();
    onMembershipsChanged?.();
    setView({ kind: "detail", path });
  }

  // Duplicate (2026-07-21) -- adds a second, independent copy of the item
  // into the same folder, right next to the copy/transform/delete row
  // actions. Reuses the same add_to_folder / add_screenshot_to_folder
  // commands the "New item" form and the History/Screenshots "save to
  // folder" pickers already call, just seeded with the existing item's own
  // content/title (or screenshot_id) instead of fresh input -- there's
  // nothing duplicate-specific on the server, this just calls the ordinary
  // "add" path twice with the same data.
  async function duplicateItem(folder: Folder, item: FolderItem) {
    if (item.kind === "screenshot") {
      if (item.screenshot_id == null) return;
      await invoke("add_screenshot_to_folder", {
        folderId: folder.id,
        screenshotId: item.screenshot_id,
        title: item.title,
      });
    } else {
      await invoke("add_to_folder", {
        folderId: folder.id,
        content: item.content,
        title: item.title,
      });
    }
    await refreshItems(folder.id);
    refreshFolders(currentParentId);
    refreshRootFolders();
    onMembershipsChanged?.();
  }

  // Copy an item into a *different* folder (2026-07-28) -- same idea as
  // duplicateItem above, just targeting whatever folder the user picks via
  // FolderPicker (which can now be nested subfolders too, not only
  // top-level ones -- see FolderPicker.tsx's drill-down). This was entirely
  // missing before: items inside a folder had no way to also live in
  // another folder short of manually recreating them there, unlike History
  // clips and Screenshots which have always had this. Non-destructive, like
  // every other "add to folder" action in the app -- the original stays put;
  // pair with Delete if what's actually wanted is a move.
  async function addItemToOtherFolder(item: FolderItem, targetFolderId: number) {
    if (item.kind === "screenshot") {
      if (item.screenshot_id == null) return;
      await invoke("add_screenshot_to_folder", {
        folderId: targetFolderId,
        screenshotId: item.screenshot_id,
        title: item.title,
      });
    } else {
      await invoke("add_to_folder", {
        folderId: targetFolderId,
        content: item.content,
        title: item.title,
      });
    }
    // Refresh whichever bits of UI could show a stale count/list: the
    // current level's subfolder item counts always, and this folder's own
    // item list too in the (fairly unusual) case someone picks the folder
    // they're already looking at as the destination.
    refreshFolders(currentParentId);
    refreshRootFolders();
    if (view.kind === "detail" && targetFolderId === view.path[view.path.length - 1].id) {
      refreshItems(targetFolderId);
    }
    onMembershipsChanged?.();
  }

  // Drag-to-reorder (2026-07-19) -- optimistic local reorder immediately,
  // then persist in the background. A failed persist just means the order
  // reverts next time this folder is reopened, which isn't worth surfacing
  // an error for.
  async function reorderItems(folder: Folder, newOrder: FolderItem[]) {
    setItems(newOrder);
    try {
      await invoke("reorder_folder_items", {
        folderId: folder.id,
        orderedIds: newOrder.map((i) => i.id),
      });
    } catch {
      // best effort, see above
    }
  }

  async function toggleFolderPin(folder: Folder) {
    try {
      const ok = await invoke<boolean>("toggle_folder_pin", { id: folder.id });
      if (!ok) {
        setPinMsg("limit");
        setTimeout(() => setPinMsg(null), 2200);
        return;
      }
      refreshFolders(currentParentId);
      refreshRootFolders();
    } catch {
      setPinMsg("pro");
      setTimeout(() => setPinMsg(null), 2600);
    }
  }

  // Root list, with whichever root folder is currently "open" expanding
  // inline directly below its own row instead of replacing the whole
  // screen (2026-08-08) -- see toggleRootFolder above. Covers both the
  // plain list (nothing expanded) and detail view whose path is exactly
  // one folder deep (that folder is expanded); a path more than one deep
  // means a subfolder was drilled into, which still gets the original
  // full-screen treatment further down.
  // parent_id check matters for the openFolderId jump-from-History-tab
  // effect above, which can land on a *subfolder* directly (path.length 1
  // doesn't necessarily mean "a root folder" there) -- those still need the
  // full-screen treatment below since they have no row in rootFolders to
  // nest under.
  const expandedRootFolder =
    view.kind === "detail" && view.path.length === 1 && view.path[0].parent_id === null
      ? view.path[0]
      : null;
  if (view.kind === "list" || expandedRootFolder) {
    const atLimit = tier !== "pro" && rootFolders.length >= FREE_FOLDER_LIMIT;
    return (
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {rootFolders.length === 0 && !creating && (
          <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10">
            No folders yet.
          </p>
        )}
        {rootFolders.map((folder) => (
          <div key={folder.id}>
            <FolderRow
              folder={folder}
              tier={tier}
              expanded={expandedRootFolder?.id === folder.id}
              onOpen={() => toggleRootFolder(folder)}
              onTogglePin={() => toggleFolderPin(folder)}
            />
            {expandedRootFolder?.id === folder.id &&
              renderFolderDetail([folder], folder, true)}
          </div>
        ))}

        {pinMsg === "limit" && (
          <div className="mx-1 mt-1 mb-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-[11.5px] text-inkMuted dark:text-inkMutedDark text-center">
            Pin limit reached (3) — unpin a folder first.
          </div>
        )}
        {pinMsg === "pro" && (
          <div className="mx-1 mt-1 mb-1 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3 py-2 text-[11.5px] text-accent dark:text-accentDark text-center font-medium">
            Pinning folders is a Pro feature — upgrade to use it.
          </div>
        )}

        {creating ? (
          <div className="flex items-center gap-1.5 px-3 py-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              placeholder="Folder name"
              className="flex-1 min-w-0 bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
            />
            <button
              onClick={createFolder}
              className="text-[12px] px-2 py-1.5 rounded-lg bg-accent/15 dark:bg-accentDark/20"
            >
              Add
            </button>
          </div>
        ) : atLimit ? (
          <div className="mx-1 mt-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 text-center">
            <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mb-0.5">
              {rootFolders.length} / {FREE_FOLDER_LIMIT} folders used
            </p>
            <p className="text-[11.5px] text-accent dark:text-accentDark font-medium">
              Upgrade for unlimited folders
            </p>
          </div>
        ) : (
          // Pro is unlimited (enforced server-side in create_folder), so this
          // button always shows for Pro even past the old Free cap of 3.
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
          >
            <i className="ti ti-folder-plus text-[14px]" />
            New folder
          </button>
        )}
      </div>
    );
  }

  // Extracted (2026-08-08) so the exact same body can render two ways: full
  // screen for a subfolder drilled into from an expanded root folder (path
  // more than one deep), or nested inline directly under a root folder's
  // own row (path exactly one deep -- see the merged list/expanded branch
  // above). `inline` only ever changes the outer sizing/scroll classes;
  // every handler, form, and the drag-reorder list below are identical
  // either way -- goBack() already collapses path-length-1 detail views
  // back to the plain list, which is exactly "collapse" for the inline
  // case too, so it needs no special-casing here.
  function renderFolderDetail(path: Folder[], folder: Folder, inline: boolean) {
    return (
      <div className={inline ? "relative" : "relative flex-1 min-h-0 flex flex-col overflow-hidden"}>
        {/* Name/item-count/back row is redundant when inline (2026-08-08) --
            the row this expands from already shows the folder's name and
            count, and clicking that same row again already collapses it.
            Full-screen (a drilled-into subfolder) still needs its own
            identity row since there's no row above it to fall back on.
            2026-08-10: that identity row used to also carry its own set of
            compact icon-only actions (a second, differently-styled copy of
            Stack/New folder/New item) -- reported as inconsistent with the
            labeled pill-button grid the inline/root view gets. Both views
            now share the exact same 3-column labeled-button grid below;
            only the identity row on top is conditional. */}
        {!inline && (
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
            <button onClick={goBack} title="Back">
              <i className="ti ti-chevron-left text-[14px] text-inkMuted dark:text-inkMutedDark" />
            </button>
            <span className="flex-1 text-[13px] font-medium truncate">{folder.name}</span>
            <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        <div className="grid grid-cols-3 gap-1.5 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
          <button
            onClick={() => setStackBuilderIds((ids) => (ids === null ? [] : null))}
            title="Select items to paste one after another, in order"
            className={`flex items-center justify-center gap-1 whitespace-nowrap text-[10px] px-1 py-1.5 rounded-full transition-colors ${
              stackBuilderIds !== null
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className="ti ti-list-numbers text-[12px]" />
            Stack
          </button>
          <button
            onClick={() => setCreatingSubfolder((c) => !c)}
            title="New subfolder"
            className={`flex items-center justify-center gap-1 whitespace-nowrap text-[10px] px-1 py-1.5 rounded-full transition-colors ${
              creatingSubfolder
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className="ti ti-folder-plus text-[12px]" />
            New folder
          </button>
          <button
            onClick={() => {
              setCreatingItem((c) => !c);
              setNewItemTargetId(null);
            }}
            title="New item"
            className={`flex items-center justify-center gap-1 whitespace-nowrap text-[10px] px-1 py-1.5 rounded-full transition-colors ${
              creatingItem
                ? "bg-accent/25 dark:bg-accentDark/35 text-ink dark:text-cream font-medium"
                : "bg-black/[0.05] dark:bg-white/[0.07] text-ink dark:text-cream hover:bg-black/[0.09] dark:hover:bg-white/[0.12]"
            }`}
          >
            <i className="ti ti-plus text-[12px]" />
            New item
          </button>
        </div>
        <div className={inline ? "px-2 py-2" : "flex-1 overflow-y-auto px-2 py-2"}>
          {creatingSubfolder && (
            <div className="flex items-center gap-1.5 px-1 pb-1.5 mb-1">
              <input
                autoFocus
                value={newSubfolderName}
                onChange={(e) => setNewSubfolderName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") createSubfolder(folder);
                  if (e.key === "Escape") {
                    setCreatingSubfolder(false);
                    setNewSubfolderName("");
                  }
                }}
                placeholder="Subfolder name"
                className="flex-1 min-w-0 bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
              />
              <button
                onClick={() => createSubfolder(folder)}
                className="text-[12px] px-2 py-1.5 rounded-lg bg-accent/15 dark:bg-accentDark/20"
              >
                Add
              </button>
            </div>
          )}
          {/* Subfolders render as their own section above this folder's own
              items -- same row component as the root folder list, just
              scoped to this folder's children. Only shown when there's
              something to show (existing subfolders, or the inline creator
              open), so folders with no subfolders look exactly like before.
              2026-07-27: grouped into the same bordered-card + hairline-
              divider treatment as History/Screenshots' boxed lists, instead
              of loose rows with just a gap between them, to match how the
              rest of the app organizes lists of things. */}
          {(folders.length > 0 || creatingSubfolder) && (
            <div className="mb-3">
              {folders.length > 0 && (
                <>
                  <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-1 mb-1">
                    Folders
                  </p>
                  <div className="rounded-2xl bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden mb-2">
                    {folders.map((sub, idx) => (
                      <div key={sub.id}>
                        <FolderRow
                          folder={sub}
                          tier={tier}
                          boxed
                          onOpen={() => openFolder(sub)}
                          onTogglePin={() => toggleFolderPin(sub)}
                        />
                        {idx < folders.length - 1 && (
                          <div className="mx-3 border-b border-black/[0.05] dark:border-white/[0.07]" />
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {items.length > 0 && (
                <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark px-1 mt-2 mb-1">
                  Items
                </p>
              )}
            </div>
          )}
          {creatingItem && (
            <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 mb-1.5 space-y-1.5">
              {/* Only shown when this folder actually has subfolders to
                  choose from -- otherwise "this folder" is the only option
                  anyway and the picker would just be noise. */}
              {folders.length > 0 && (
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
                    Add to
                  </label>
                  <select
                    value={newItemTargetId ?? folder.id}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setNewItemTargetId(v === folder.id ? null : v);
                    }}
                    className="w-full bg-white dark:bg-charcoalSurface border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
                  >
                    <option value={folder.id}>{folder.name} (this folder)</option>
                    {folders.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <input
                autoFocus
                value={newItemTitle}
                onChange={(e) => setNewItemTitle(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Title (optional)"
                className="w-full bg-white dark:bg-charcoalSurface border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
              />
              <div>
                <div className="flex items-center justify-end mb-1">
                  <button
                    type="button"
                    onClick={() =>
                      applyPlaceholderAtSelection(newItemContentRef, newItemContent, setNewItemContent)
                    }
                    title="Highlight a word (or a few) and click this to turn it into a fill-in-later placeholder -- or just click to insert one at the cursor"
                    className="flex items-center gap-1 text-[10px] text-accent dark:text-accentDark hover:opacity-70 transition-opacity"
                  >
                    <i className="ti ti-braces text-[10px]" />
                    Placeholder
                  </button>
                </div>
                <textarea
                  ref={newItemContentRef}
                  value={newItemContent}
                  onChange={(e) => setNewItemContent(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  rows={3}
                  placeholder="Content"
                  className="w-full bg-white dark:bg-charcoalSurface border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
                />
              </div>
              <div className="flex gap-1.5 justify-end">
                <button
                  onClick={() => {
                    setCreatingItem(false);
                    setNewItemTitle("");
                    setNewItemContent("");
                  }}
                  className="text-[11.5px] px-2 py-1 text-inkMuted dark:text-inkMutedDark"
                >
                  Cancel
                </button>
                <button
                  onClick={() => addNewItem(folder)}
                  className="text-[11.5px] px-2.5 py-1 rounded-lg bg-accent/15 dark:bg-accentDark/20"
                >
                  Add
                </button>
              </div>
            </div>
          )}
          {items.length === 0 && !creatingItem && folders.length === 0 && !creatingSubfolder && (
            <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10">
              Nothing saved here yet.
            </p>
          )}
          {/* Drag-to-reorder (2026-07-19): Reorder.Group tracks `items` by
              object identity, so onReorder just needs to persist whatever
              order it hands back. Dragging is initiated only from the grip
              handle (see FolderItemRow) so it doesn't fight with the row's
              click-to-edit or the paste button's own click handler.
              2026-07-27: wrapped in the same bordered-card container as the
              Folders section above, with hairline dividers between rows
              (rendered inside each FolderItemRow, since Reorder.Item has to
              stay the direct child here) instead of each row floating with
              its own margin/rounded corners. */}
          {items.length > 0 && (
            <div className="rounded-2xl bg-creamSurface dark:bg-charcoalSurface ring-1 ring-black/[0.15] dark:ring-white/[0.15] shadow-card dark:shadow-cardDark overflow-hidden">
              <Reorder.Group
                as="div"
                axis="y"
                values={items}
                onReorder={(newOrder) => reorderItems(folder, newOrder)}
              >
                {items.map((item, idx) => (
                  <FolderItemRow
                    key={item.id}
                    item={item}
                    tier={tier}
                    isLast={idx === items.length - 1}
                    stackMode={stackBuilderIds !== null}
                    stackPos={stackBuilderIds?.indexOf(item.id) ?? -1}
                    onToggleStack={toggleStackItem}
                    onPasteItem={pasteItem}
                    onEditItem={(item) => setView({ kind: "edit", path, item })}
                    onExpandScreenshot={openScreenshotPreview}
                    onTransformItem={(item) => {
                      if (tier !== "pro") {
                        setTransformPaywall(true);
                        setTimeout(() => setTransformPaywall(false), 2600);
                        return;
                      }
                      onTransformItem?.(item.content);
                    }}
                    onRemoveItem={(item) => removeItem(path, item)}
                    onDuplicateItem={(item) => duplicateItem(folder, item)}
                    pickerOpen={itemFolderPickerFor === item.id}
                    onOpenFolderPicker={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setItemFolderPickerPos(clampMenuPosition(r.bottom + 4, r.right - 208, 208));
                      setItemFolderPickerFor((id) => (id === item.id ? null : item.id));
                    }}
                    onClosePicker={() => setItemFolderPickerFor(null)}
                    pickerPosition={itemFolderPickerPos}
                    onAddToFolder={(targetId) => addItemToOtherFolder(item, targetId)}
                    onCreateNewFolderFromPicker={() => {
                      setItemFolderPickerFor(null);
                      setView({ kind: "list" });
                      setCreating(true);
                    }}
                  />
                ))}
              </Reorder.Group>
            </div>
          )}
        </div>

        {transformPaywall && (
          <div className="mx-3 mb-2 rounded-lg bg-accent/10 dark:bg-accentDark/15 px-3 py-2 text-[11.5px] text-accent dark:text-accentDark text-center font-medium shrink-0">
            AI transform is a Pro feature — upgrade to use it.
          </div>
        )}

        {/* The in-place Transform overlay that used to live here is gone as
            of 2026-08-03 -- clicking Transform on a folder item now jumps to
            the standalone Transform tab instead (see the onTransformItem
            prop above and App.tsx's goToTransform), same change made to
            History and Screenshots. */}

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
              onClick={startFolderStack}
              disabled={stackBuilderIds.length === 0}
              className="text-[11.5px] font-medium px-3 py-1.5 rounded-lg bg-ink dark:bg-cream text-cream dark:text-charcoal disabled:opacity-40"
            >
              Start
            </button>
          </div>
        )}

        {/* Full-resolution screenshot preview, same treatment as the
            Screenshots tab's own expand modal -- see openScreenshotPreview
            above. */}
        {previewItem &&
          createPortal(
            <div
              className="fixed inset-0 z-[9999] bg-black/75 flex flex-col items-center justify-center p-6 gap-3"
              onClick={closeScreenshotPreview}
            >
              <div
                className="flex items-center gap-2 text-white/90 text-[12px]"
                onClick={(e) => e.stopPropagation()}
              >
                <span>{formatTimestamp(previewItem.created_at)}</span>
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
                    pasteItem(previewItem);
                    closeScreenshotPreview();
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-white text-charcoal text-[12.5px] font-medium px-4 py-2"
                >
                  <i className="ti ti-copy text-[13px]" />
                  Copy & paste
                </button>
                <button
                  onClick={closeScreenshotPreview}
                  className="rounded-lg bg-white/10 hover:bg-white/15 transition-colors text-white/90 text-[12.5px] px-4 py-2"
                >
                  Close
                </button>
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }

  // Only ever reached for a subfolder drilled into from an already-expanded
  // root folder (path more than one deep) -- path length exactly 1 returns
  // early above via the merged list/expanded branch, rendered inline there
  // instead.
  if (view.kind === "detail") {
    const path = view.path;
    return renderFolderDetail(path, path[path.length - 1], false);
  }

  if (view.kind === "fillTemplate") {
    const { path, item, placeholders } = view;
    return (
      <FillTemplate
        path={path}
        item={item}
        placeholders={placeholders}
        onSubmit={pasteFilledTemplate}
        onCancel={() => setView({ kind: "detail", path })}
      />
    );
  }

  // view.kind === "edit"
  const { path, item } = view;
  return (
    <EditItem
      path={path}
      item={item}
      onSave={saveItem}
      onRemove={removeItem}
      onBack={() => setView({ kind: "detail", path })}
      onPaste={pasteItem}
    />
  );
}

// One row in a folder listing -- used both for the root folder list and for
// the "Folders" section inside a folder's detail view (subfolders,
// 2026-07-19), so the two look and behave identically.
function FolderRow({
  folder,
  tier,
  onOpen,
  onTogglePin,
  // Root list rows aren't inside a bordered card (each just floats with its
  // own gap), but detail-view rows now live inside one shared card with
  // hairline dividers between them (2026-07-27) -- so the margin and
  // corner-rounding that made sense standalone would look wrong stacked
  // against a sibling and a shared outer border. Defaults to the original
  // standalone look so the root list is unaffected.
  boxed = false,
  // Root list only (2026-08-08) -- true while this folder's contents are
  // expanded inline directly below this row (see toggleRootFolder/
  // renderFolderDetail). Swaps the trailing chevron to point down and
  // gives the row a resting tint instead of only-on-hover, so it stays
  // visually distinct from its siblings while open, the same way the
  // active pill treatment elsewhere in the app marks "this one's selected".
  expanded = false,
}: {
  folder: Folder;
  tier: "free" | "pro";
  onOpen: () => void;
  onTogglePin: () => void;
  boxed?: boolean;
  expanded?: boolean;
}) {
  return (
    <div
      onClick={onOpen}
      className={`group flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors ${
        expanded
          ? "bg-black/[0.03] dark:bg-white/[0.05]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      } ${boxed ? "" : "rounded-xl mb-1"}`}
    >
      <i className="ti ti-folder text-[15px] text-accent dark:text-accentDark" />
      <span className="flex-1 text-[13px] truncate">{folder.name}</span>
      <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">
        {folder.item_count}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
        className={`text-xs shrink-0 transition-opacity ${
          folder.pinned
            ? "opacity-100 text-accent dark:text-accentDark"
            : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
        }`}
        title={folder.pinned ? "Unpin" : tier === "pro" ? "Pin" : "Pin folders — Pro only"}
      >
        <i className={folder.pinned ? "ti ti-pinned-filled text-[13px]" : "ti ti-pin text-[13px]"} />
      </button>
      <i
        className={`ti ${expanded ? "ti-chevron-down" : "ti-chevron-right"} text-[13px] text-inkMuted dark:text-inkMutedDark`}
      />
    </div>
  );
}

// One row in a folder's item list -- its own component (rather than inlined
// in the items.map above) because drag-to-reorder needs a per-row
// useDragControls hook, which can only be called inside a component.
//
// 2026-07-27 restructure: rows now live inside one shared bordered card (see
// the Reorder.Group wrapper above) with a hairline divider between them,
// matching how History/Screenshots organize their boxed lists -- so
// Reorder.Item itself is now just a plain, unstyled wrapper (framer-motion
// needs it to be the direct child of Reorder.Group), and the actual
// row padding/hover-highlight/click-target lives on an inner div, with the
// divider rendered as a sibling after it inside the same Reorder.Item.
// Also: text items with no title used to render their content in muted gray
// with no other line, which read as "quieter"/less important than a titled
// item's bold heading + muted preview -- now an untitled item's content is
// the full-contrast headline instead (same convention History rows use:
// content itself is normal-weight ink text, muted is reserved for metadata),
// so every row has consistent visual weight regardless of whether it has a
// title. A timestamp line was also added under every row's text, since
// History and Screenshots both show one and this was the one boxed list in
// the app without it.
function FolderItemRow({
  item,
  tier,
  isLast,
  stackMode,
  stackPos,
  onToggleStack,
  onPasteItem,
  onEditItem,
  onExpandScreenshot,
  onTransformItem,
  onRemoveItem,
  onDuplicateItem,
  pickerOpen,
  onOpenFolderPicker,
  onClosePicker,
  pickerPosition,
  onAddToFolder,
  onCreateNewFolderFromPicker,
}: {
  item: FolderItem;
  tier: "free" | "pro";
  isLast: boolean;
  // Stack mode (2026-07-19): while true, clicking the row toggles it into
  // the ordered paste-queue selection instead of opening the edit view, and
  // the leading grip button and the right-side action icons (2026-07-21:
  // copy/transform/delete, moved here from a mix of "always visible" and
  // "only reachable via Edit" -- see the History tab's row actions, which
  // this now matches) are hidden entirely rather than left clickable
  // underneath the stack-selection UI.
  stackMode: boolean;
  stackPos: number;
  onToggleStack: (id: number) => void;
  onPasteItem: (item: FolderItem) => void;
  onEditItem: (item: FolderItem) => void;
  // 2026-08-05: clicking a screenshot item's image expands the same
  // full-resolution zoom overlay the Screenshots tab uses, instead of
  // always jumping to Edit -- Edit is still reachable via the rest of the
  // row (title/timestamp area) same as before.
  onExpandScreenshot: (item: FolderItem) => void;
  onTransformItem: (item: FolderItem) => void;
  onRemoveItem: (item: FolderItem) => void;
  onDuplicateItem: (item: FolderItem) => void;
  // Add-to-another-folder (2026-07-28) -- the picker's open/position state
  // lives one level up in FoldersPanel (only one row's popover can be open
  // at a time, same as History/Screenshots' own FolderPicker usage), so this
  // row just reports clicks and renders the portal when it's the open one.
  pickerOpen: boolean;
  onOpenFolderPicker: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onClosePicker: () => void;
  pickerPosition: { top: number; left: number } | null;
  onAddToFolder: (targetFolderId: number) => void | Promise<void>;
  onCreateNewFolderFromPicker: () => void;
}) {
  const dragControls = useDragControls();
  const [thumbBroken, setThumbBroken] = useState(false);
  const hasPlaceholder = item.kind === "text" && extractPlaceholders(item.content).length > 0;

  return (
    <Reorder.Item as="div" value={item} dragListener={false} dragControls={dragControls}>
      <div
        onClick={() => (stackMode ? onToggleStack(item.id) : onEditItem(item))}
        className="group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
      >
        {stackMode ? (
          <span
            className={`shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium ${
              stackPos !== -1
                ? "bg-accent dark:bg-accentDark text-cream dark:text-charcoal"
                : "bg-black/[0.06] dark:bg-white/[0.09] text-inkMuted dark:text-inkMutedDark"
            }`}
          >
            {stackPos !== -1 ? stackPos + 1 : ""}
          </span>
        ) : (
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              dragControls.start(e);
            }}
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
            className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-inkMuted dark:text-inkMutedDark opacity-0 group-hover:opacity-60 transition-opacity"
          >
            <i className="ti ti-grip-vertical text-[13px]" />
          </button>
        )}
        {/* 2026-08-05 restructure: title/content now gets the row's full
            width on its own line(s) -- previously the right-side icon
            cluster was a flex sibling of the content on the *same* line,
            which squeezed a `truncate`d title down to whatever space was
            left over (visibly cutting off a screenshot's title, as reported
            -- "Title Screen..." for something longer). Timestamp + icons now
            share a second row underneath instead, matching the convention
            History (App.tsx) and Screenshots (ScreenshotsPanel.tsx) already
            use: full-width content up top, metadata-left/icons-right below. */}
        <div className="flex-1 min-w-0">
          {item.kind === "screenshot" ? (
            // 2026-08-05: matches the Screenshots tab's own card layout
            // (ScreenshotsPanel.tsx's renderRow) instead of a small
            // thumbnail-in-a-row -- a full-width image up top (click to
            // expand into the same full-resolution zoom overlay), title
            // underneath where that tab shows its OCR excerpt.
            <>
              {/* Title above the image (2026-08-05) -- same top-to-bottom
                  order as text items (title, then content), rather than
                  the image leading with the title read as a caption under
                  it. */}
              <p className="text-[12.5px] font-medium leading-snug break-words line-clamp-2">
                {item.title || "Screenshot"}
              </p>
              {item.thumb_data_uri && !thumbBroken ? (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onExpandScreenshot(item);
                  }}
                  title="Click to expand"
                  className="group/img relative mt-2 rounded-lg overflow-hidden cursor-pointer h-32"
                >
                  <img
                    src={item.thumb_data_uri}
                    alt=""
                    onError={() => setThumbBroken(true)}
                    className="w-full h-full object-cover bg-black/[0.05] dark:bg-white/[0.07]"
                    draggable={false}
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/img:bg-black/20 transition-colors">
                    <i className="ti ti-zoom-in text-white text-[18px] opacity-0 group-hover/img:opacity-90 transition-opacity" />
                  </div>
                </div>
              ) : (
                // Falls back to a plain icon tile instead of the browser's
                // broken-image glyph when the referenced screenshot is
                // missing or its thumbnail failed to load (e.g. it was
                // deleted from the Screenshots tab after being saved here).
                <div
                  className="mt-2 h-32 rounded-lg bg-black/[0.05] dark:bg-white/[0.07] flex items-center justify-center"
                  title="Original screenshot unavailable"
                >
                  <i className="ti ti-photo-off text-[18px] text-inkMuted dark:text-inkMutedDark" />
                </div>
              )}
            </>
          ) : item.title ? (
            <>
              <p className="flex items-center gap-1 text-[12.5px] font-medium leading-snug break-words">
                <span className="break-words">{item.title}</span>
                {hasPlaceholder && (
                  <i
                    className="ti ti-writing text-[11px] text-accent dark:text-accentDark shrink-0"
                    title="Template -- fill in details before pasting"
                  />
                )}
              </p>
              <ClampedText
                text={item.content}
                className="text-[11.5px] text-inkMuted dark:text-inkMutedDark leading-snug whitespace-pre-wrap break-words mt-0.5"
              />
            </>
          ) : (
            <ClampedText
              text={item.content}
              className="text-[12.5px] leading-snug whitespace-pre-wrap break-words"
              icon={
                hasPlaceholder && (
                  <i
                    className="ti ti-writing text-[11px] text-accent dark:text-accentDark mr-1"
                    title="Template -- fill in details before pasting"
                  />
                )
              }
            />
          )}

          {/* Metadata (left) + quick actions (right), sharing one row below
              the content -- same layout History/Screenshots use, so the
              icon cluster never competes with the title/content for width. */}
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-[10.5px] text-inkMuted dark:text-inkMutedDark min-w-0">
              {formatTimestamp(item.created_at)}
            </p>
            {/* Copy + delete for every item, folder-add (2026-07-28, copy
                this item into another folder) right after Duplicate since
                they're both "make another copy of this" actions, just
                same-folder vs. a different one, and AI transform for text
                items only (there's nothing to transform on a screenshot).
                No pin here: folder items don't support pinning at all,
                unlike History/Screenshots rows. */}
            {!stackMode && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onPasteItem(item);
                  }}
                  title="Paste now"
                  className="shrink-0 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark hover:!opacity-100 hover:text-ink dark:hover:text-cream transition-opacity"
                >
                  <i className="ti ti-copy text-[13px]" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicateItem(item);
                  }}
                  title="Duplicate"
                  className="shrink-0 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark hover:!opacity-100 hover:text-ink dark:hover:text-cream transition-opacity"
                >
                  <i className="ti ti-copy-plus text-[13px]" />
                </button>
                <button
                  onClick={onOpenFolderPicker}
                  title="Add to another folder"
                  className={`shrink-0 transition-opacity ${
                    pickerOpen
                      ? "opacity-100 text-accent dark:text-accentDark"
                      : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-inkMuted dark:text-inkMutedDark"
                  }`}
                >
                  <i className="ti ti-folder-plus text-[13px]" />
                </button>
                {item.kind === "text" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTransformItem(item);
                    }}
                    title={tier === "pro" ? "Transform with AI" : "AI transform — Pro only"}
                    className="shrink-0 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark hover:!opacity-100 hover:text-accent dark:hover:text-accentDark transition-opacity"
                  >
                    <i className={tier === "pro" ? "ti ti-sparkles text-[13px]" : "ti ti-lock text-[13px]"} />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveItem(item);
                  }}
                  title="Delete"
                  className="shrink-0 opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark hover:!opacity-100 hover:text-red-500 dark:hover:text-red-400 transition-opacity"
                >
                  <i className="ti ti-trash text-[13px]" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {pickerOpen &&
        pickerPosition &&
        createPortal(
          <FolderPicker
            position={pickerPosition}
            onClose={onClosePicker}
            onAdd={async (folderId) => {
              await onAddToFolder(folderId);
              onClosePicker();
            }}
            onCreateNewFolder={onCreateNewFolderFromPicker}
          />,
          document.body
        )}
      {!isLast && <div className="mx-3 border-b border-black/[0.05] dark:border-white/[0.07]" />}
    </Reorder.Item>
  );
}

// Shown right before pasting a template item (see lib/templates.ts) --
// one text field per unique {{placeholder}}, in first-appearance order.
// Values are remembered per item (see loadLastValues/saveLastValues) so
// re-sending a similar snippet doesn't mean retyping the same details.
function FillTemplate({
  path,
  item,
  placeholders,
  onSubmit,
  onCancel,
}: {
  path: Folder[];
  item: FolderItem;
  placeholders: string[];
  onSubmit: (path: Folder[], item: FolderItem, values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => loadLastValues(item.id));
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  function submit() {
    onSubmit(path, item, values);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
        <button onClick={onCancel}>
          <i className="ti ti-chevron-left text-[14px] text-inkMuted dark:text-inkMutedDark" />
        </button>
        <span className="flex-1 text-[13px] font-medium truncate">
          {item.title || "Fill in template"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        <div className="bg-black/[0.03] dark:bg-white/[0.05] rounded-lg px-2.5 py-2">
          <ClampedText
            text={item.content}
            lines={3}
            className="text-[11px] text-inkMuted dark:text-inkMutedDark leading-snug whitespace-pre-wrap break-words"
          />
        </div>
        {placeholders.map((name, i) => (
          <div key={name}>
            <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
              {name}
            </p>
            <input
              ref={i === 0 ? firstInputRef : undefined}
              id={`tpl-field-${i}`}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  if (i === placeholders.length - 1) {
                    submit();
                  } else {
                    document.getElementById(`tpl-field-${i + 1}`)?.focus();
                  }
                }
                if (e.key === "Escape") onCancel();
              }}
              className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </div>
        ))}
        <button
          onClick={submit}
          className="w-full flex items-center justify-center gap-1.5 bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium mt-1"
        >
          <i className="ti ti-copy text-[13px]" />
          Paste
        </button>
      </div>
    </div>
  );
}

function EditItem({
  path,
  item,
  onSave,
  onRemove,
  onBack,
  onPaste,
}: {
  path: Folder[];
  item: FolderItem;
  onSave: (path: Folder[], item: FolderItem, title: string, content: string) => void;
  onRemove: (path: Folder[], item: FolderItem) => void;
  onBack: () => void;
  onPaste: (item: FolderItem) => void;
}) {
  const [title, setTitle] = useState(item.title ?? "");
  const [content, setContent] = useState(item.content);
  const isScreenshot = item.kind === "screenshot";
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // 2026-08-05: this used to just show item.thumb_data_uri (capped at
  // THUMBNAIL_MAX_WIDTH=320px, see db.rs) stretched into an aspect-video
  // box with object-cover -- small, often blurry once stretched, and
  // cropped rather than showing the whole image. Fetches the same
  // full-resolution image the Screenshots tab's own preview uses
  // (get_screenshot_full), so a screenshot saved into a folder gets the
  // same quality/size treatment as it would in the Screenshots tab itself,
  // not a degraded copy. Falls back to the thumbnail while loading (or if
  // the fetch fails) so there's never a blank box.
  const [fullSrc, setFullSrc] = useState<string | null>(null);
  const [fullError, setFullError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fullRequestId = useRef<number | null>(null);

  useEffect(() => {
    if (!isScreenshot || item.screenshot_id == null) return;
    const id = item.screenshot_id;
    fullRequestId.current = id;
    setFullSrc(null);
    setFullError(false);
    invoke<string>("get_screenshot_full", { id })
      .then((uri) => {
        if (fullRequestId.current !== id) return;
        setFullSrc(uri);
      })
      .catch(() => {
        if (fullRequestId.current !== id) return;
        setFullError(true);
      });
  }, [isScreenshot, item.screenshot_id]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
        <button onClick={onBack}>
          <i className="ti ti-chevron-left text-[14px] text-inkMuted dark:text-inkMutedDark" />
        </button>
        <span className="flex-1 text-[13px] font-medium">
          {isScreenshot ? "Edit screenshot" : "Edit item"}
        </span>
      </div>

      {/* Scrollable so the Save button below stays reachable even when the
          window is short -- previously this content + a flex-1 spacer could
          push Save past the bottom of the window with no way to scroll to it.
          The Content field itself is now flex-1 (2026-07-19, was a fixed
          5-row textarea) so it actually fills the generous vertical space
          this panel has instead of looking cramped in a small box. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-2.5">
        {/* Title always comes first, then Content -- same order for both
            kinds, so the edit screen has one consistent shape whether the
            item is text or a screenshot. Content just renders differently
            underneath: a textarea for text, a read-only image preview for
            a screenshot (there's nothing to type there). */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Title
          </p>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Optional"
            className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark">
              Content
            </p>
            {!isScreenshot && (
              <button
                type="button"
                onClick={() => applyPlaceholderAtSelection(contentRef, content, setContent)}
                title="Highlight a word (or a few) and click this to turn it into a fill-in-later placeholder -- or just click to insert one at the cursor"
                className="flex items-center gap-1 text-[10px] text-accent dark:text-accentDark hover:opacity-70 transition-opacity"
              >
                <i className="ti ti-braces text-[10px]" />
                Placeholder
              </button>
            )}
          </div>
          {isScreenshot ? (
            <div
              onClick={() => setExpanded(true)}
              title="Click to expand"
              className="group relative w-full h-[38vh] min-h-[180px] rounded-xl bg-black/90 flex items-center justify-center overflow-hidden cursor-pointer"
            >
              {fullError && !item.thumb_data_uri ? (
                <p className="text-white/70 text-[12px]">Couldn't load this screenshot.</p>
              ) : (
                <img
                  src={fullSrc ?? item.thumb_data_uri ?? ""}
                  alt=""
                  className="max-w-full max-h-full object-contain"
                  draggable={false}
                />
              )}
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                <i className="ti ti-zoom-in text-white text-[20px] opacity-0 group-hover:opacity-90 transition-opacity" />
              </div>
            </div>
          ) : (
            <textarea
              ref={contentRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full flex-1 min-h-[220px] bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
            />
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => onPaste(item)}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-accentFill dark:bg-accentFillDark text-accent dark:text-accentDark text-[12px] font-medium py-2"
          >
            <i className="ti ti-copy text-[13px]" />
            Paste now
          </button>
          <button
            onClick={() => onRemove(path, item)}
            className="rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3 text-inkMuted dark:text-inkMutedDark"
            title="Remove from folder"
          >
            <i className="ti ti-trash text-[14px]" />
          </button>
        </div>

        {/* Save lives in the normal scrolling flow now, right under Paste/
            Delete -- same as the Title/Content fields above it -- instead of
            a separate flex footer bar, so there's nothing height/overflow-
            dependent about whether it's visible. */}
        <button
          onClick={() => onSave(path, item, title, content)}
          className="w-full shrink-0 bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium"
        >
          Save
        </button>
      </div>

      {/* Full-screen zoom, same treatment as the Screenshots tab's own
          preview modal -- lets a screenshot saved into a folder be inspected
          at true full resolution, not just the enlarged-but-still-320px-wide
          box above. */}
      {expanded &&
        isScreenshot &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] bg-black/75 flex flex-col items-center justify-center p-6 gap-3"
            onClick={() => setExpanded(false)}
          >
            <div
              className="max-w-full max-h-[80vh] flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {fullError && !item.thumb_data_uri ? (
                <p className="text-white/80 text-[13px]">Couldn't load this screenshot.</p>
              ) : (
                <img
                  src={fullSrc ?? item.thumb_data_uri ?? ""}
                  alt=""
                  className="max-w-full max-h-[80vh] rounded-lg shadow-2xl object-contain"
                  draggable={false}
                />
              )}
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="rounded-lg bg-white/10 hover:bg-white/15 transition-colors text-white/90 text-[12.5px] px-4 py-2"
            >
              Close
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
