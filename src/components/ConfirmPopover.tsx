import { useEffect, useRef } from "react";

// Small floating "are you sure?" popover -- same click-away + fixed-position-
// via-portal pattern as FolderPicker/RowMenu (position comes from the
// trigger button's own getBoundingClientRect, routed through
// clampMenuPosition so it can't render off-screen). Added 2026-08-03 for
// preset deletion (Settings' custom-preset rows, and the trash icon on a
// custom preset chip in TransformBar/TransformTab), which all previously
// deleted on a single click with no way to back out of a misclick. Kept
// generic/reusable rather than preset-specific in case another destructive,
// hard-to-undo action wants the same confirm step later.
export default function ConfirmPopover({
  position,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  position: { top: number; left: number };
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-[9999] w-56 rounded-xl bg-cream dark:bg-charcoalSurface border border-borderLight dark:border-borderDark shadow-float dark:shadow-floatDark p-3"
    >
      <p className="text-[12.5px] leading-snug mb-2.5">{message}</p>
      <div className="flex gap-1.5">
        <button
          onClick={onCancel}
          className="flex-1 text-[12px] py-1.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 text-[12px] font-medium py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
