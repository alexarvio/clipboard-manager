import { useState } from "react";

interface DateRangeCalendarProps {
  from: string | null; // "YYYY-MM-DD"
  to: string | null; // "YYYY-MM-DD"
  onChange: (from: string | null, to: string | null) => void;
}

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function toIso(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fromIso(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Single-calendar range picker (2026-08-13), replacing the old two separate
 * "From"/"To" native <input type="date"> fields -- those opened two
 * different OS date pickers and had nothing to do with each other visually,
 * which the user found confusing for picking a *range*. This is one month
 * grid: first click sets the start, second click sets the end (and the days
 * between get a connected highlight, like a normal date-range picker), a
 * third click starts a new range. Shared between Text's and Screenshots'
 * Date menus, which previously duplicated this markup.
 */
export default function DateRangeCalendar({ from, to, onChange }: DateRangeCalendarProps) {
  const initial = from ? fromIso(from) : to ? fromIso(to) : new Date();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth()); // 0-11

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function goPrevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }
  function goNextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function handleDayClick(iso: string) {
    if (!from || (from && to)) {
      // Starting a fresh range (nothing selected yet, or a complete range
      // was already selected -- a new click always starts over rather than
      // adjusting the old range).
      onChange(iso, null);
    } else if (iso < from) {
      // Clicked before the existing start -- that becomes the new start.
      onChange(iso, from);
    } else {
      onChange(from, iso);
    }
  }

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayIso = toIso(new Date());

  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toIso(new Date(viewYear, viewMonth, d)));

  return (
    <div>
      <div className="flex items-center justify-between px-0.5 mb-1.5">
        <button
          onClick={goPrevMonth}
          title="Previous month"
          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.09]"
        >
          <i className="ti ti-chevron-left text-[12px]" />
        </button>
        <span className="text-[12px] font-medium">{monthLabel}</span>
        <button
          onClick={goNextMonth}
          title="Next month"
          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.09]"
        >
          <i className="ti ti-chevron-right text-[12px]" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {WEEKDAY_LABELS.map((w, i) => (
          <div
            key={i}
            className="h-6 flex items-center justify-center text-[9.5px] font-medium text-inkMuted dark:text-inkMutedDark"
          >
            {w}
          </div>
        ))}

        {cells.map((iso, i) => {
          if (!iso) return <div key={i} />;
          const isStart = iso === from;
          const isEnd = iso === to;
          const isEndpoint = isStart || isEnd;
          const inRange = !!from && !!to && iso > from && iso < to;
          const isToday = iso === todayIso;
          return (
            <div key={i} className="relative h-7 flex items-center justify-center">
              {/* Connecting bar behind the day number so a multi-day range
                  reads as one continuous pill instead of separate dots. */}
              {(inRange || (isEndpoint && from !== to)) && (
                <div
                  className={`absolute inset-y-0.5 bg-accent/15 dark:bg-accentDark/20 ${
                    isStart ? "left-1/2 right-0" : isEnd ? "left-0 right-1/2" : "inset-x-0"
                  }`}
                />
              )}
              <button
                onClick={() => handleDayClick(iso)}
                className={`relative w-7 h-7 flex items-center justify-center rounded-full text-[11px] transition-colors ${
                  isEndpoint
                    ? "bg-accent dark:bg-accentDark text-white dark:text-charcoal font-medium"
                    : inRange
                    ? "text-accent dark:text-accentDark hover:bg-black/[0.06] dark:hover:bg-white/[0.09]"
                    : isToday
                    ? "ring-1 ring-accent/40 dark:ring-accentDark/40 hover:bg-black/[0.06] dark:hover:bg-white/[0.09]"
                    : "hover:bg-black/[0.06] dark:hover:bg-white/[0.09]"
                }`}
              >
                {parseInt(iso.slice(8), 10)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
