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
export default function ClampedText({
  text,
  className,
  lines = 2,
  icon,
  expanded: expandedProp,
  onToggleExpanded,
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
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
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
