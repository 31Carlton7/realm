import { PAGE_REF_IDS, type Item } from "@realm/contracts";

/**
 * Pages, not objects: the sidebar's destination pages plus a space's own Overview. Their `refId` is
 * a well-known sentinel rather than a row (PAGE_REF_IDS), so there is nothing behind the item to
 * lose — deleting one and re-opening it from the sidebar produces the identical page.
 *
 * A session's Agents tab is one too, though its `refId` is the session's: it is a VIEW of that
 * session's sub-agents with nothing of its own under it, and its side pane's "+" makes it again,
 * identical, the next time it is asked for.
 */
export const PAGE_KINDS: ReadonlySet<Item["kind"]> = new Set<Item["kind"]>([
  ...(Object.keys(PAGE_REF_IDS) as Item["kind"][]), "space-page", "agents",
]);

/**
 * The kinds whose bar closes by DELETING rather than lifting the item out of the layout.
 *
 * A layout-only close leaves the row behind in the space, which is right for a session or a diff —
 * a transcript and a checkout outlive any pane that showed them, and the rule that closing must
 * never imply deletion is about exactly those. It is wrong for everything here: a destination page
 * is a view with no object under it, and a terminal, browser or documents pane is a thing you
 * opened at a moment and are done with. Closing those left a drift of rows nobody asked to keep,
 * so the bar offers the delete outright — named, wearing a trash, and (where there IS something
 * under it) two-step. The layout-only close stays reachable, on ⌘W and in the ⋯ menu.
 */
export const DELETES_ON_CLOSE: ReadonlySet<Item["kind"]> = new Set<Item["kind"]>([
  ...PAGE_KINDS, "terminal", "browser", "documents",
]);
