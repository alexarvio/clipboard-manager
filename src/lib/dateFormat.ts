// Shared date/time formatting for anything shown in a history-style feed --
// clip items, screenshots, the Dashboard's recent-activity list. Pulled out
// of App.tsx/Dashboard.tsx (which both had their own near-identical copies)
// so ScreenshotsPanel can use the exact same "Today"/"Yesterday" grouping and
// timestamp format the text History tab already uses, instead of inventing
// a third variant.

// Date + time to the minute, e.g. "Jun 18, 2:30 PM" -- seconds intentionally
// dropped since they're never useful for "when did I copy/capture this".
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Group label -- "Today" / "Yesterday" for the last two calendar days,
// otherwise a short weekday + date (e.g. "Wed, Jun 18"). Compares
// midnight-aligned dates rather than elapsed ms so an item from 12:05am
// still counts as "Today". `weekdayStyle` lets callers opt into the longer
// "Wednesday, Jun 18" form (Dashboard) instead of the compact one used in
// the narrower quick panel.
export function dateGroupLabel(iso: string, weekdayStyle: "short" | "long" = "short"): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const startOfDay = (dt: Date) => {
    const x = new Date(dt);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = startOfDay(d);
  if (day.getTime() >= today.getTime()) return "Today";
  if (day.getTime() >= yesterday.getTime()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: weekdayStyle, month: "short", day: "numeric" });
}
