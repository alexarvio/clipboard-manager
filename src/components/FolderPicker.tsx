import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Folder } from "./FoldersPanel";

export default function FolderPicker({
  content,
  onClose,
  onAdded,
}: {
  content: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<Folder[]>("list_folders").then(setFolders).catch(console.error);
  }, []);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [onClose]);

  async function addTo(folderId: number) {
    await invoke("add_to_folder", { folderId, content, title: null });
    onAdded();
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-2 top-7 z-10 w-44 rounded-xl bg-cream dark:bg-charcoalSurface border border-borderLight dark:border-borderDark shadow-lg py-1"
    >
      {folders.length === 0 && (
        <p className="text-[11px] text-inkMuted dark:text-inkMutedDark px-3 py-2">
          No folders yet — create one from the Folders tab.
        </p>
      )}
      {folders.map((f) => (
        <button
          key={f.id}
          onClick={() => addTo(f.id)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <i className="ti ti-folder text-[12px] text-accent dark:text-accentDark" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </div>
  );
}
