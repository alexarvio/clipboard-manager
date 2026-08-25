import { useEffect, useRef, useState } from "react";

// Shared by every place in the app that shows a preview of potentially-long
// text (History rows, Dashboard's feed, folder items, the Transform input
// box, the paste-queue preview): clamp to a fixed number of lines, and only
// show an explicit "Show more" / "Show less" toggle when the text actually
// overflows that clamp (measured via scrollHeight vs. clientHeight -- the
// DOM keeps the full text even while visually clipped, so this comparison
// is reliable without guessing from character count). Short text renders
// exactly as compact as before, with nothing extra to click.
//
// 2026-07-28: pulled out of FoldersPanel.tsx (where this pattern first
// appeared) into its own module so every clamped preview in the app gets the
// same explicit, discoverable "there's more, click to see it" affordance
// instead of some places clamping with no way to expand at all (Transform's
// Input box, the paste-queue preview) and others only expanding via an
// implicit whole-row click with no visual hint that it's possible (History,
// Dashboard's feed).
//
// Supports two modes:
//  - Uncontrolled (no `expanded`/`onToggleExpanded` passed): keeps its own
//    local expanded state. Used wherever nothing else needs to know or
//    control the expand state (Transform's Input box, PasteQueue, folder
//    items).
//  - Controlled (`expanded` + `onToggleExpanded` passed): defers to the
//    caller's own state instead. Used by History and Dashboard's feed, which
//    already track a single `expandedId` so clicking anywhere else on the
//    row (not just this toggle) also expands/collapses it -- the toggle
//    here just gives that same action a visible, labeled affordance too.
//
// `secret` (2026-08-25) adds a third, independent behavior on top of either
// mode: when true, the text renders blurred behind a "click to reveal"
// pill instead of its normal clamped preview, until clicked. Revealing is
// local state here (not lifted to the caller) -- it's the same idea as
// uncontrolled `expanded`, just for a different concern, and re-blurs for
// free whenever the row unmounts (tab switch, list re-filter, etc.) since
// nothing persists it. This is purely a display guard: the underlying data
// is unchanged, so copy/paste-back and everything else still works exactly
// as before, and callers decide whether to pass `secret` at all -- see
// App.tsx/Dashboard.tsx, which pass `item.is_secret` straight through.
export default function ClampedText({
  text,
  className,
  lines = 2,
  icon,
  expanded: expandedProp,
  onToggleExpanded,
  secret = false,
}: {
  text: string;
  className: string;
  lines?: 2 | 3 | 4;
  // Rendered inline right before the text (e.g. the template/placeholder
  // icon in folder items) -- kept inside the same clamped <p> since it's a
  // naturally-inline element and doesn't fight with line-clamp the way a
  // sibling flex container would.
  icon?: React.ReactNode;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  secret?: boolean;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const controlled = expandedProp !== undefined;
  const expanded = controlled ? expandedProp : localExpanded;

  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only meaningful while still clamped -- once expanded the element grows
    // to fit its content, so scrollHeight would always equal clientHeight.
    if (!expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const clampClass = lines === 2 ? "line-clamp-2" : lines === 3 ? "line-clamp-3" : "line-clamp-4";

  if (secret && !revealed) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setRevealed(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            setRevealed(true);
          }
        }}
        title="Click to reveal"
        className="relative cursor-pointer rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.09] transition-colors py-1.5"
      >
        <p
          aria-hidden="true"
          className={`${className} ${clampClass} blur-[6px] select-none pointer-events-none opacity-70`}
        >
          {icon}
          {text}
        </p>
        <div className="absolute inset-0 flex items-center gap-1.5 pl-0.5 text-[12px] font-medium text-inkMuted dark:text-inkMutedDark">
          <i className="ti ti-lock text-[13px]" />
          API key detected — click to reveal
        </div>
      </div>
    );
  }

  return (
    <div>
      <p ref={ref} className={`${className} ${expanded ? "" : clampClass}`}>
        {icon}
        {text}
      </p>
      {overflowing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            controlled ? onToggleExpanded?.() : setLocalExpanded((v) => !v);
          }}
          className="text-[10.5px] text-accent dark:text-accentDark font-medium hover:opacity-70 transition-opacity mt-0.5"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
