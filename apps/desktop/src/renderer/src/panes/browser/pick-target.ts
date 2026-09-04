import { allItems, findLeafOfItem, type Item, type Layout } from "@realm/contracts";

/**
 * Which session's composer a picked element lands in.
 *
 * A pick happens in a browser pane, so by the time it resolves the focused leaf is the BROWSER's —
 * there is no "current composer" to ask. The rule is therefore structural rather than historical: of
 * the sessions open in the group the user is looking at, prefer the one in the focused leaf (which is
 * the browser's own only when a session is not focused, so this is really "the session they last
 * clicked into"), and otherwise take the first in layout order. Layout order is left-to-right,
 * top-to-bottom, which is where a one-session-plus-one-browser split puts the obvious answer.
 *
 * The ITEM comes back rather than the session id because the pane has to name where the chip went:
 * with two sessions open, "added it to the prompter" does not say which prompter.
 *
 * Null means no session is open in this group at all, and the pane says so rather than picking a
 * session from another group the user cannot see receiving it.
 */
export function sessionForPick(items: readonly Item[], layout: Layout | null, focusedLeafId: string | null): Item | null {
  if (!layout) return null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const open = allItems(layout).map((id) => byId.get(id)).filter((i): i is Item => i?.kind === "session");
  if (open.length === 0) return null;
  return open.find((i) => findLeafOfItem(layout, i.id)?.id === focusedLeafId) ?? open[0]!;
}
