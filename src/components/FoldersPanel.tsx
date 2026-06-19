import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Folder {
  id: number;
  name: string;
  created_at: string;
  item_count: number;
  pinned: boolean;
}

export interface FolderItem {
  id: number;
  folder_id: number;
  title: string | null;
  content: string;
  created_at: string;
}

const FREE_FOLDER_LIMIT = 3;

type View =
  | { kind: "list" }
  | { kind: "detail"; folder: Folder }
  | { kind: "edit"; folder: Folder; item: FolderItem };

export default function FoldersPanel({
  onPasted,
  tier,
}: {
  onPasted: () => void;
  tier: "free" | "pro";
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<FolderItem[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingItem, setCreatingItem] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemContent, setNewItemContent] = useState("");
  const [pinMsg, setPinMsg] = useState<"limit" | "pro" | null>(null);

  async function refreshFolders() {
    const result = await invoke<Folder[]>("list_folders");
    setFolders(result);
  }

  async function refreshItems(folderId: number) {
    const result = await invoke<FolderItem[]>("list_folder_items", { folderId });
    setItems(result);
  }

  useEffect(() => {
    refreshFolders();
  }, []);

  useEffect(() => {
    if (view.kind === "detail") refreshItems(view.folder.id);
  }, [view.kind === "detail" ? view.folder.id : null]);

  async function createFolder() {
    const name = newName.trim();
    if (!name) return;
    try {
      await invoke("create_folder", { name });
      setNewName("");
      setCreating(false);
      refreshFolders();
    } catch {
      // limit reached -- the card below already communicates this
      setCreating(false);
    }
  }

  async function pasteItem(item: FolderItem) {
    await invoke("paste_folder_item", { id: item.id });
    onPasted();
  }

  async function saveItem(folder: Folder, item: FolderItem, title: string, content: string) {
    await invoke("update_folder_item", {
      id: item.id,
      title: title.trim() ? title.trim() : null,
      content,
    });
    await refreshItems(folder.id);
    setView({ kind: "detail", folder });
  }

  async function addNewItem(folder: Folder) {
    const content = newItemContent.trim();
    if (!content) return;
    await invoke("add_to_folder", {
      folderId: folder.id,
      content,
      title: newItemTitle.trim() ? newItemTitle.trim() : null,
    });
    setNewItemTitle("");
    setNewItemContent("");
    setCreatingItem(false);
    refreshItems(folder.id);
    refreshFolders();
  }

  async function removeItem(folder: Folder, item: FolderItem) {
    await invoke("delete_folder_item", { id: item.id });
    await refreshItems(folder.id);
    refreshFolders();
    setView({ kind: "detail", folder });
  }

  async function toggleFolderPin(folder: Folder) {
    try {
      const ok = await invoke<boolean>("toggle_folder_pin", { id: folder.id });
      if (!ok) {
        setPinMsg("limit");
        setTimeout(() => setPinMsg(null), 2200);
        return;
      }
      refreshFolders();
    } catch {
      setPinMsg("pro");
      setTimeout(() => setPinMsg(null), 2600);
    }
  }

  if (view.kind === "list") {
    const atLimit = tier !== "pro" && folders.length >= FREE_FOLDER_LIMIT;
    return (
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {folders.length === 0 && !creating && (
          <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10">
            No folders yet.
          </p>
        )}
        {folders.map((folder) => (
          <div
            key={folder.id}
            onClick={() => setView({ kind: "detail", folder })}
            className="group flex items-center gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer mb-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
          >
            <i className="ti ti-folder text-[15px] text-accent dark:text-accentDark" />
            <span className="flex-1 text-[13px] truncate">{folder.name}</span>
            <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">
              {folder.item_count}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFolderPin(folder);
              }}
              className={`text-xs shrink-0 transition-opacity ${
                folder.pinned
                  ? "opacity-100 text-amber-500 dark:text-amber-300"
                  : "opacity-0 group-hover:opacity-60 text-inkMuted dark:text-inkMutedDark"
              }`}
              title={folder.pinned ? "Unpin" : tier === "pro" ? "Pin" : "Pin folders — Pro only"}
            >
              <i className={folder.pinned ? "ti ti-star-filled text-[13px]" : "ti ti-star text-[13px]"} />
            </button>
            <i className="ti ti-chevron-right text-[13px] text-inkMuted dark:text-inkMutedDark" />
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
              className="flex-1 bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
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
              {folders.length} / {FREE_FOLDER_LIMIT} folders used
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

  if (view.kind === "detail") {
    const folder = view.folder;
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
          <button onClick={() => setView({ kind: "list" })}>
            <i className="ti ti-chevron-left text-[14px] text-inkMuted dark:text-inkMutedDark" />
          </button>
          <span className="flex-1 text-[13px] font-medium truncate">{folder.name}</span>
          <span className="text-[11px] text-inkMuted dark:text-inkMutedDark">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => setCreatingItem((c) => !c)}
            title="New item"
            className="text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
          >
            <i className="ti ti-plus text-[15px]" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {creatingItem && (
            <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 mb-1.5 space-y-1.5">
              <input
                autoFocus
                value={newItemTitle}
                onChange={(e) => setNewItemTitle(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Title (optional)"
                className="w-full bg-white dark:bg-charcoalSurface border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
              />
              <textarea
                value={newItemContent}
                onChange={(e) => setNewItemContent(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                rows={3}
                placeholder="Content"
                className="w-full bg-white dark:bg-charcoalSurface border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
              />
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
          {items.length === 0 && !creatingItem && (
            <p className="text-inkMuted dark:text-inkMutedDark text-sm text-center mt-10">
              Nothing saved here yet.
            </p>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => setView({ kind: "edit", folder, item })}
              className="group flex items-start gap-2 rounded-xl px-3 py-2.5 cursor-pointer mb-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  pasteItem(item);
                }}
                title="Paste now"
                className="mt-0.5 shrink-0 text-accent dark:text-accentDark"
              >
                <i className="ti ti-copy text-[13px]" />
              </button>
              <div className="flex-1 min-w-0">
                {item.title && (
                  <p className="text-[12px] font-medium leading-snug truncate">{item.title}</p>
                )}
                <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark leading-snug line-clamp-2 whitespace-pre-wrap break-words">
                  {item.content}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // view.kind === "edit"
  const { folder, item } = view;
  return <EditItem folder={folder} item={item} onSave={saveItem} onRemove={removeItem} onBack={() => setView({ kind: "detail", folder })} onPaste={pasteItem} />;
}

function EditItem({
  folder,
  item,
  onSave,
  onRemove,
  onBack,
  onPaste,
}: {
  folder: Folder;
  item: FolderItem;
  onSave: (folder: Folder, item: FolderItem, title: string, content: string) => void;
  onRemove: (folder: Folder, item: FolderItem) => void;
  onBack: () => void;
  onPaste: (item: FolderItem) => void;
}) {
  const [title, setTitle] = useState(item.title ?? "");
  const [content, setContent] = useState(item.content);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-borderLight dark:border-borderDark">
        <button onClick={onBack}>
          <i className="ti ti-chevron-left text-[14px] text-inkMuted dark:text-inkMutedDark" />
        </button>
        <span className="flex-1 text-[13px] font-medium">Edit item</span>
      </div>

      {/* Scrollable so the Save button below stays reachable even when the
          window is short -- previously this content + a flex-1 spacer could
          push Save past the bottom of the window with no way to scroll to it. */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2.5">
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
        <div>
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Content
          </p>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            rows={5}
            className="w-full bg-black/[0.03] dark:bg-white/[0.05] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12px] outline-none resize-none"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onPaste(item)}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-accentFill dark:bg-accentFillDark text-accent dark:text-accentDark text-[12px] font-medium py-2"
          >
            <i className="ti ti-copy text-[13px]" />
            Paste now
          </button>
          <button
            onClick={() => onRemove(folder, item)}
            className="rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3 text-inkMuted dark:text-inkMutedDark"
            title="Remove from folder"
          >
            <i className="ti ti-trash text-[14px]" />
          </button>
        </div>
      </div>

      <div className="shrink-0 px-3 py-2.5 border-t border-borderLight dark:border-borderDark">
        <button
          onClick={() => onSave(folder, item, title, content)}
          className="w-full bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2 text-[12.5px] font-medium"
        >
          Save
        </button>
      </div>
    </div>
  );
}
