import { useRef } from "react";

/** Which transcript items get §6's 180ms enter animation.
 *
 *  The spec is "new items only; `initial=false` on mount". Two things follow, and both are load-
 *  bearing:
 *
 *  1. Everything present at the first observation is seeded as *already seen*. Mounting a pane,
 *     switching back to a session, or restoring a saved transcript therefore animates nothing — the
 *     history was not just written, it was already there.
 *  2. Once a key has been marked as entering it keeps that mark for the tracker's whole life. The
 *     mark drives a CSS class, and a CSS animation restarts when the class is re-added and aborts
 *     when it is removed mid-flight — so anything that re-renders during those 180ms (a streaming
 *     delta, a scroll, a status flip) would otherwise cut the animation off or replay it. Keeping
 *     the mark is what makes "new items only" survive re-rendering.
 *
 *  A key that disappears and comes back — a permission card while the session status flips away from
 *  waiting_permission and back — stays seen: it is the same item returning, not a new one. */
export type EnterTracker = { observe: (keys: readonly string[]) => ReadonlySet<string> };

export function createEnterTracker(): EnterTracker {
  const seen = new Set<string>();
  const entering = new Set<string>();
  let seeded = false;
  return {
    observe(keys) {
      for (const k of keys) {
        if (!seen.has(k)) { seen.add(k); if (seeded) entering.add(k); }
      }
      seeded = true;
      return entering;
    },
  };
}

/** Per-component-instance tracker. Returns a predicate over the keys just observed. */
export function useEnterTracker(keys: readonly string[]): (key: string) => boolean {
  const ref = useRef<EnterTracker | null>(null);
  ref.current ??= createEnterTracker();
  const entering = ref.current.observe(keys);
  return (key) => entering.has(key);
}
