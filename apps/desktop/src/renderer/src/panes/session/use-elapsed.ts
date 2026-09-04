import { useEffect, useState } from "react";

/** Milliseconds since `since`, re-read once a second while `live` and frozen the moment it stops.
 *
 *  The interval is the part that matters: a transcript can hold hundreds of these at once, so the
 *  clock has to stop with the work it measures rather than run for as long as the pane is open. */
export function useElapsed(since: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return Math.max(0, now - since);
}
