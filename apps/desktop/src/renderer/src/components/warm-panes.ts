/**
 * The sessions a main pane keeps mounted, hidden, after it stops showing them, so going back to one
 * shows the tree it has (its scroll, its draft, no fetch) instead of building it again.
 *
 * `recent` is the order they were shown, newest last, and decides which one goes past the cap.
 * `order` is the order they are mounted in and never changes for the ones that stay: React moves a
 * keyed child by taking it out of the document, and that loses every scroll offset inside it.
 */
export type WarmPanes = { order: readonly string[]; recent: readonly string[] };

/** The one showing and the three before it. A live check sets `realm.warmSessions` (read at launch)
 *  to measure against fewer. */
export const WARM_SESSIONS = Number(globalThis.localStorage?.getItem("realm.warmSessions")) || 4;

/** What a pane keeps once it shows `showing`. `keep` says whether an item it kept may stay: one that
 *  is gone, or is not a session, or is now on screen in another pane, may not. */
export function nextWarmPanes(prev: WarmPanes | undefined, showing: string | null, keep: (id: string) => boolean, max = WARM_SESSIONS): WarmPanes {
  const kept = (prev?.recent ?? []).filter((id) => id !== showing && keep(id));
  const recent = [...kept, ...(showing ? [showing] : [])].slice(-max);
  const order = [...(prev?.order ?? []).filter((id) => recent.includes(id)), ...recent.filter((id) => !prev?.order.includes(id))];
  return { order, recent };
}
