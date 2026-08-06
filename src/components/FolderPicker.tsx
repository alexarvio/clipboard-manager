import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauriShim";
import type { Folder } from "./FoldersPanel";

export default function FolderPicker({
  position,
  savedIn = [],
  onClose,
  onAdd,
  onOpenFolder,
  onCreateNewFolder,
}: {
  position: { top: number; left: number };
  savedIn?: { id: number; name: string }[];
  onClose: () => void;
  // What "add to this folder" actually does is up to the caller -- History
  // rows add a text clip (add_to_folder), ScreenshotsPanel adds a reference
  // to a screenshot (add_screenshot_to_folder), and folder items (2026-07-28)
  // add a copy of themselves into another folder. Keeping that here instead
  // of hardcoding a single invoke() call is what lets every one of those
  // share one picker/dropdown instead of near-duplicate components.
  onAdd: (folderId: number) => void | Promise<void>;
  onOpenFolder?: (folderId: number) => void;
  // Routes the user to the Folders tab with the "new folder" name input
  // already open, instead of trying to create a folder inline here.
  onCreateNewFolder?: () => void;
}) {
  // 2026-07-28: the picker used to only ever list top-level folders, with a
  // comment noting subfolders "aren't reachable from here" as a known gap --
  // that's exactly what got reported (you could never pick a subfolder as a
  // save target from History/Screenshots/folder items, only from inside the
  // Folders tab itself after manually navigating there first). Now it's a
  // tiny drill-down browser: `stack` is the breadcrumb from root down to
  // whatever level is currently showing, and clicking a folder's chevron
  // browses into its children instead of picking it immediately. Clicking
  // the folder's name/icon still picks it as the destination right away, at
  // any depth -- browsing and picking are two different, clearly separate
  // click targets on the same row.
  const [stack, setStack] = useState<{ id: number | null; name: string }[]>([
    { id: null, name: "All folders" },
  ]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const current = stack[stack.length - 1];

  useEffect(() => {
    invoke<Folder[]>("list_folders", { parentId: current.id }).then(setFolders).catch(console.error);
  }, [current.id]);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [onClose]);

  async function addTo(folderId: number) {
    await onAdd(folderId);
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-[9999] w-52 rounded-xl bg-cream dark:bg-charcoalSurface border border-borderLight dark:border-borderDark shadow-float dark:shadow-floatDark py-1"
    >
      {savedIn.length > 0 && (
        <div className="px-3 py-1.5 border-b border-borderLight dark:border-borderDark mb-1">
          <p className="text-[10px] uppercase tracking-wide text-inkMuted dark:text-inkMutedDark mb-1">
            Saved in
          </p>
          {savedIn.map((f) => (
            <button
              key={f.id}
              onClick={() => onOpenFolder?.(f.id)}
              className="w-full flex items-center gap-2 py-0.5 text-[12px] text-left text-accent dark:text-accentDark hover:underline"
              title="Open this folder"
            >
              <span className="relative inline-flex shrink-0">
                <i className="ti ti-folder-plus text-[12px]" />
                <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center w-2 h-2 rounded-full bg-cream dark:bg-charcoalSurface">
                  <i className="ti ti-check text-accent dark:text-accentDark text-[6px] leading-none" />
                </span>
              </span>
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Breadcrumb -- only shown once browsed past the root, so the common
          case (picking a top-level folder) looks exactly like before. */}
      {stack.length > 1 && (
        <button
          onClick={() => setStack((s) => s.slice(0, -1))}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream text-left border-b border-borderLight dark:border-borderDark mb-1"
        >
          <i className="ti ti-chevron-left text-[11px]" />
          <span className="truncate">{current.name}</span>
        </button>
      )}
      {/* Picks the folder currently being browsed itself as the destination
          -- needed once you've drilled in, since a folder's own row (with
          its pick vs. browse split) only shows up one level up, among its
          siblings. */}
      {stack.length > 1 && current.id !== null && (
        <button
          onClick={() => addTo(current.id as number)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-accent dark:text-accentDark hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <i className="ti ti-folder-check text-[12px]" />
          <span className="truncate">Save in "{current.name}"</span>
        </button>
      )}

      {folders.length === 0 && (
        <p className="text-[11px] text-inkMuted dark:text-inkMutedDark px-3 py-2">
          {stack.length > 1 ? "No subfolders here." : "No folders yet — create one from the Folders tab."}
        </p>
      )}
      {folders.map((f) => (
        <div key={f.id} className="flex items-center">
          <button
            onClick={() => addTo(f.id)}
            className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          >
            <i className="ti ti-folder text-[12px] text-accent dark:text-accentDark shrink-0" />
            <span className="truncate">{f.name}</span>
          </button>
          {f.subfolder_count > 0 && (
            <button
              onClick={() => setStack((s) => [...s, { id: f.id, name: f.name }])}
              title="Browse subfolders"
              className="shrink-0 px-2 py-1.5 text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream"
            >
              <i className="ti ti-chevron-right text-[12px]" />
            </button>
          )}
        </div>
      ))}
      {stack.length === 1 && (
        <div className="mt-1 pt-1 border-t border-borderLight dark:border-borderDark">
          <button
            onClick={() => onCreateNewFolder?.()}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-accent dark:text-accentDark hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          >
            <i className="ti ti-folder-plus text-[12px]" />
            <span className="truncate">New folder</span>
          </button>
        </div>
      )}
    </div>
  );
}
