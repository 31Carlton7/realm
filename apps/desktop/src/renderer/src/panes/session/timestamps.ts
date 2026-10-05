import { useEffect, useState } from "react";

/**
 * When something in the transcript happened, said the way a person asks it: a clock time for today,
 * "Yesterday" and a clock time for the day before, and the date for anything older — with the year
 * only once it is not this one. "7:38 PM", "Yesterday 7:38 PM", "Oct 2, 7:38 PM".
 *
 * The moment is always the EVENT's own timestamp. `now` decides only which of those shapes it is
 * said in, never what time it says: a transcript replayed from last week reads last week's clock.
 * Locale formatting, because a clock is one of the few things here that is the reader's convention
 * rather than ours.
 */
export function stampLabel(ts: number, now: number): string {
  const at = new Date(ts);
  const clock = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = daysBetween(at, new Date(now));
  if (days === 0) return clock;
  if (days === 1) return `Yesterday ${clock}`;
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return `${date}, ${clock}`;
}

/** The same moment in full, for the tooltip: weekday, date, year and the clock to the second. The
 *  short label drops all of that by design, and this is where a reader who needs it finds it. */
export function stampTitle(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
}

/** Calendar days from `a` to `b`, by the local calendar rather than by 24-hour spans: 11:50 PM and
 *  12:05 AM are a day apart, and a day with a clock change in it is still one day. */
function daysBetween(a: Date, b: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(b) - start(a)) / 86_400_000);
}

/**
 * The reader's "now", for choosing a label's shape — and a re-render at the next local midnight, so
 * a transcript left open overnight stops calling yesterday's messages "today".
 *
 * State rather than a `Date.now()` read in the render: every label on screen is chosen against the
 * SAME moment, so two lines a pixel apart can never disagree about which day it is.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    // A second past, so the re-render lands on the new day rather than on the last tick of the old.
    const timer = setTimeout(() => setNow(Date.now()), midnight.getTime() - Date.now() + 1000);
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}
