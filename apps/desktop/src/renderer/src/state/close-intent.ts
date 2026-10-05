import { findLeaf, primaryLeaves, type Item, type Layout } from "@realm/contracts";

/**
 * What closing means in one pane — the answer ⌘W, the menu bar's Close, the palette and a pane's own
 * ⋯ menu all read, so none of them can name one thing and do another.
 *
 * A session is never closed. It is left the way it was reached, from the sidebar, and its transcript
 * outlives every pane that shows it, so the × on its bar went nowhere a click on another row does not
 * (the owner, 10-05: "I don't like having a close button at all for sessions"). What is put away is
 * the thing the keyboard is IN:
 *
 *  - a tab leaves its side pane, and stays in its space;
 *  - a pane of a split leaves the split and the other takes the window — unless the other is an empty
 *    box, which is what goes instead: a session beside nothing is unsplit by dropping the nothing,
 *    and taking the session out would only leave an empty pane to fill;
 *  - an empty pane goes, when there is a pane beside it;
 *  - a session alone closes nothing. The keyboard goes to its prompter, where the next action is,
 *    rather than the key doing nothing anyone can see.
 *
 * A pane holding anything else — a terminal or a diff someone dragged out of a strip — closes as its
 * own bar says it does, and the last one leaves a fresh prompter behind it (`closeFromLayout`).
 */
export type CloseIntent =
  | { kind: "tab"; itemId: string }
  | { kind: "empty"; leafId: string }
  | { kind: "unsplit"; itemId: string }
  | { kind: "pane"; itemId: string }
  | { kind: "prompter"; sessionId: string };

export function closeIntent(layout: Layout | null, leafId: string | null, itemOf: (itemId: string) => Item | undefined): CloseIntent | null {
  const leaf = layout && leafId ? findLeaf(layout, leafId) : null;
  if (!layout || !leaf) return null;
  if (leaf.tabs) return leaf.itemId ? { kind: "tab", itemId: leaf.itemId } : null;
  const other = primaryLeaves(layout).find((p) => p.id !== leaf.id) ?? null;
  if (leaf.itemId === null) return other ? { kind: "empty", leafId: leaf.id } : null;
  const item = itemOf(leaf.itemId);
  if (item?.kind !== "session") return { kind: "pane", itemId: leaf.itemId };
  if (!other) return { kind: "prompter", sessionId: item.refId };
  return other.itemId === null ? { kind: "empty", leafId: other.id } : { kind: "unsplit", itemId: leaf.itemId };
}
