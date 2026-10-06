import { findLeaf, primaryLeaves, type Item, type Layout, type LayoutLeaf } from "@realm/contracts";

/**
 * What closing means in one pane — the answer ⌘W, the menu bar's Close, the palette and a pane's own
 * ⋯ menu all read, so none of them can name one thing and do another.
 *
 * A session is never closed. It is left the way it was reached, from the sidebar, and its transcript
 * outlives every pane that shows it, so the × on its bar went nowhere a click on another row does not
 * (the owner, 10-05: "I don't like having a close button at all for sessions"). What is put away is
 * the thing the keyboard is IN:
 *
 *  - a tab leaves the side panel, and stays in its space;
 *  - a pane of a split leaves the split and the panes beside it take its room — unless one beside it
 *    in its own split is an empty box, which is what goes instead: a session beside nothing is unsplit
 *    by dropping the nothing, and taking the session out would only leave an empty pane to fill;
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
  const shared = primaryLeaves(layout).some((p) => p.id !== leaf.id);
  if (leaf.itemId === null) return shared ? { kind: "empty", leafId: leaf.id } : null;
  const item = itemOf(leaf.itemId);
  if (item?.kind !== "session") return { kind: "pane", itemId: leaf.itemId };
  if (!shared) return { kind: "prompter", sessionId: item.refId };
  const box = emptyBeside(layout, leaf.id);
  return box ? { kind: "empty", leafId: box.id } : { kind: "unsplit", itemId: leaf.itemId };
}

/** An empty pane right beside `leafId` in its own split — the next, else the one before. */
function emptyBeside(l: Layout, leafId: string): LayoutLeaf | null {
  if (l.type === "leaf") return null;
  const at = l.children.findIndex((c) => c.type === "leaf" && c.id === leafId);
  if (at >= 0) {
    for (const c of [l.children[at + 1], l.children[at - 1]]) if (c?.type === "leaf" && !c.tabs && c.itemId === null) return c;
    return null;
  }
  for (const c of l.children) { const f = emptyBeside(c, leafId); if (f) return f; }
  return null;
}
