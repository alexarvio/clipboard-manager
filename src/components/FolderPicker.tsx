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
  promptForTitle,
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
  // `title` is only ever non-undefined when promptForTitle is on and the
  // user actually typed something into the prompt below -- callers that
  // don't pass promptForTitle (or pass it false) can ignore the second
  // argument entirely, same as before this existed.
  onAdd: (folderId: number, title?: string | null) => void | Promise<void>;
  onOpenFolder?: (folderId: number) => void;
  // Routes the user to the Folders tab with the "new folder" name input
  // already open, instead of trying to create a folder inline here.
  onCreateNewFolder?: () => void;
  // Whether picking a folder should stop for a moment to ask for a title
  // before actually saving (see the pendingFolder step below). Defaults on
  // -- the three "save something new into a folder" call sites (History,
  // Screenshots, Transform) want it; FoldersPanel's own "copy to another
  // folder"/"move" pickers pass false since those items already have
  // whatever title they had, and re-asking would just be re-prompting for
  // something that already has an answer.
  promptForTitle?: boolean;
}) {
  const shouldPromptForTitle = promptForTitle ?? true;
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

  // Second step, shown after a folder is picked (only when
  // shouldPromptForTitle) instead of saving immediately: a quick "give it a
  // title" prompt. Non-null means "a folder was picked, waiting on the
  // title input" -- the folder list/browser above is replaced by the
  // prompt while this is set, rather than the two coexisting.
  const [pendingFolder, setPendingFolder] = useState<{ id: number; name: string } | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<Folder[]>("list_folders", { parentId: current.id }).then(setFolders).catch(console.error);
  }, [current.id]);

  useEffect(() => {
    if (pendingFolder) titleInputRef.current?.focus();
  }, [pendingFolder]);

  async function confirmSave() {
    if (!pendingFolder) return;
    const trimmed = titleInput.trim();
    await onAdd(pendingFolder.id, trimmed ? trimmed : null);
  }

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // Clicking away mid-title-prompt still saves (with whatever title was
      // typed, or none) rather than silently dropping the save -- the
      // folder was already committed to the moment it was picked; the
      // title is an optional add-on, not something that should make the
      // whole action reversible by clicking elsewhere.
      if (pendingFolder) {
        confirmSave();
      } else {
        onClose();
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, pendingFolder, titleInput]);

  async function addTo(folderId: number, name: string) {
    if (shouldPromptForTitle) {
      setPendingFolder({ id: folderId, name });
    } else {
      await onAdd(folderId);
    }
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-[9999] w-52 rounded-xl bg-cream dark:bg-charcoalSurface border border-borderLight dark:border-borderDark shadow-float dark:shadow-floatDark py-1"
    >
      {pendingFolder ? (
        // Title prompt -- shown in place of the folder browser once a
        // folder's been picked (see addTo/shouldPromptForTitle). Enter
        // saves, Escape backs out to the folder list without saving yet
        // (picking a folder again just re-opens this same prompt).
        <div className="px-3 py-2">
          <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mb-1.5">
            Save in <span className="text-ink dark:text-cream font-medium">"{pendingFolder.name}"</span>
          </p>
          <input
            ref={titleInputRef}
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPendingFolder(null);
                setTitleInput("");
              }
            }}
            placeholder="Add a title (optional)"
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-2.5 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-accent dark:focus:ring-accentDark"
          />
          <div className="flex items-center justify-end gap-3 mt-1.5">
            <button
              onClick={() => {
                setPendingFolder(null);
                setTitleInput("");
              }}
              className="text-[11.5px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream"
            >
              Back
            </button>
            <button
              onClick={() => confirmSave()}
              className="text-[11.5px] font-medium text-accent dark:text-accentDark hover:opacity-70"
            >
              {titleInput.trim() ? "Save" : "Skip & save"}
            </button>
          </div>
        </div>
      ) : (
        <>
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
          onClick={() => addTo(current.id as number, current.name)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-accent dark:text-accentDark hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <i className="ti ti-folder-check text-[12px]" />
          <span className="truncate">Save in "{current.name}"</span>
        </button>
      )}

      {folders.length === 0 && (
        <p className="text-[11px] text-inkMuted dark:text-inkMutedDark px-3 py-2">
          {stack.length > 1 ? "No subfolders here." : "No folders yet. Create one from the Folders tab."}
        </p>
      )}
      {folders.map((f) => (
        <div key={f.id} className="flex items-center">
          <button
            onClick={() => addTo(f.id, f.name)}
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
        </>
      )}
    </div>
  );
}
