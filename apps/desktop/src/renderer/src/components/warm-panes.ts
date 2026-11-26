/**
 * The sessions a pane keeps drawn after it stops showing them.
 *
 * A session pane is expensive to build: its transcript's markdown and tool cards, the backdrop's
 * canvas, a dozen reads for the prompter. Rebuilding it on every click in the sidebar was most of
 * the wait in a switch, a quarter of a second on a warm one. So a pane keeps the last few sessions it
 * showed mounted and hidden, as the side panel keeps its browser tabs, and going back to one shows
 * the tree it already has: no fetch, no render, its scroll and its draft as they were.
 *
 * `recent` is the order they were shown, the newest last, and says which one goes when there are too
 * many. `order` is the order they are mounted in, which never changes for the ones that stay: React
 * moves a keyed child by taking it out of the document and putting it back, and that loses the
 * scroll offset of everything inside it.
 */
export type WarmPanes = { order: readonly string[]; recent: readonly string[] };

/** The one showing and the three before it. */
export const WARM_SESSIONS = 4;

/** What a pane keeps once it shows `showing`. `keep` says whether an item it kept may stay: one that
 *  is gone, or is not a session, or is now on screen in another pane, may not. */
export function nextWarmPanes(prev: WarmPanes | undefined, showing: string | null, keep: (id: string) => boolean, max = WARM_SESSIONS): WarmPanes {
  const kept = (prev?.recent ?? []).filter((id) => id !== showing && keep(id));
  const recent = [...kept, ...(showing ? [showing] : [])].slice(-max);
  const order = [...(prev?.order ?? []).filter((id) => recent.includes(id)), ...recent.filter((id) => !prev?.order.includes(id))];
  return { order, recent };
}
