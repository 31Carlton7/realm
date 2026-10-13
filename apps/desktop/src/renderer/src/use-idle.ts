import { useEffect, useState } from "react";

/** What says a person is at the window: the pointer, the keyboard, a scroll. */
const INPUT = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

/** Half a minute: long enough that reading a reply never trips it, short enough to matter on battery. */
export const IDLE_AFTER_MS = 30_000;

/**
 * Whether nobody has touched the window for `after` ms while `watching` — true until the next input.
 *
 * A focused window is not a watched one. Realm sits in front for hours while its person reads, thinks
 * or looks at another screen, and every loop on it — the orb beside a tool in flight costs about five
 * points of CPU each (the 2026-10-12 power audit) — ran the whole time. One timer per window, re-armed only when it
 * fires, so a pointer moving across the window costs a timestamp and nothing else.
 */
export function useIdle(watching: boolean, after = IDLE_AFTER_MS): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!watching) return;
    let last = Date.now();
    let timer = 0;
    let isIdle = false;
    const check = () => {
      const left = after - (Date.now() - last);
      if (left > 0) { timer = window.setTimeout(check, left); return; }
      timer = 0;
      isIdle = true;
      setIdle(true);
    };
    const input = () => {
      last = Date.now();
      if (isIdle) { isIdle = false; setIdle(false); }
      if (!timer) timer = window.setTimeout(check, after);
    };
    setIdle(false);
    timer = window.setTimeout(check, after);
    for (const type of INPUT) window.addEventListener(type, input, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const type of INPUT) window.removeEventListener(type, input, { capture: true });
    };
  }, [watching, after]);
  return watching && idle;
}
