import ClampedText from "./ClampedText";

// A queue entry only needs an id (to tell the backend what to paste) and
// content (to preview it here) -- deliberately lighter than ClipItem so this
// same screen can drive a sequence built from either History items
// (paste_item) or folder items (paste_folder_item); see App.tsx's
// pasteQueueKind, which decides which command each entry's id gets sent to.
export interface QueueEntry {
  id: number;
  content: string;
}

// Shown instead of the normal search/history view whenever a paste sequence
// is active (see App.tsx's pasteQueue/pasteQueueIndex). The queue is built by
// selecting items in "Stack" mode in the History view (or, since 2026-07-19,
// inside a folder's detail view too), then persists across the panel hiding/
// showing (App.tsx never unmounts, it's just slid off-screen -- see
// closeWithAnimation), so pressing the hotkey again after each paste picks up
// right where the sequence left off, one item at a time, without needing to
// search and click each one individually.
export default function PasteQueue({
  items,
  index,
  onPasteNext,
  onCancel,
}: {
  items: QueueEntry[];
  index: number;
  onPasteNext: () => void;
  onCancel: () => void;
}) {
  const current = items[index];
  if (!current) return null;

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 text-ink dark:text-cream">
      <i className="ti ti-list-numbers text-[22px] text-accent dark:text-accentDark mb-2" />
      <p className="text-[11.5px] text-inkMuted dark:text-inkMutedDark mb-3">
        Pasting {index + 1} of {items.length}
      </p>
      <div className="w-full max-w-[280px] rounded-xl bg-pillTint dark:bg-charcoalSurface ring-1 ring-transparent hover:ring-accent/40 dark:hover:ring-accentDark/40 transition-colors px-3.5 py-3 mb-4">
        <ClampedText
          text={current.content}
          lines={4}
          className="text-[13px] leading-snug whitespace-pre-wrap break-words"
        />
      </div>
      <button
        onClick={onPasteNext}
        autoFocus
        className="w-full max-w-[280px] flex items-center justify-center gap-1.5 bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium mb-2"
      >
        <i className="ti ti-copy text-[13px]" />
        Paste this
      </button>
      <button
        onClick={onCancel}
        className="text-[11.5px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream transition-colors"
      >
        Cancel sequence
      </button>
    </div>
  );
}
