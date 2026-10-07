import {
  PANE_MIN, findLeaf, findPanel, mainOf, mainRoom, minRoomOf, panelWidthIn, splitFits,
  type Layout, type LayoutLeaf, type Room,
} from "@realm/contracts";

/**
 * The view's room, as the pane host measured it, and what it decides.
 *
 * Splits have no count any more (contracts/view.ts); the limit is room. A pane is never drawn below
 * `PANE_MIN`, so a split that would leave one there is not offered — the palette and the pane's menu
 * draw it unavailable with the sentence below, and the key and the menu bar, which cannot draw
 * anything, say it in a toast. The panel gives way before any pane: it narrows to its floor, and past
 * that it steps aside — still open, every tab live, shown in the panes' place when someone asks for it.
 *
 * Room is a fact about the window, so it comes from the pane host's own box (`viewRoom`), and an
 * unmeasured one (jsdom, the first frame) decides nothing: everything fits.
 */
export type RoomState = {
  layout: Layout | null;
  view: { zoomedLeafId: string | null; panelShare?: number } | null;
  viewRoom: Room | null;
  sidePanesHidden: boolean;
};

/** The panel's share as drawn: the root's, which a sheet's snap may hold below the remembered one
 *  for as long as the sheet is up (no-overlay.ts), else the view's own. */
export function drawnShare(s: Pick<RoomState, "layout" | "view">): number | undefined {
  const l = s.layout;
  if (l?.type === "split" && l.children.length === 2 && l.children[1]!.type === "leaf" && l.children[1]!.tabs) return l.sizes[1]! / 100;
  return s.view?.panelShare;
}

/** What the main panes need while they are drawn: the zoomed pane alone, or every one of them. Null
 *  while the panel itself fills the host. */
function drawnNeed(l: Layout, zoomed: LayoutLeaf | null): Room | null {
  if (zoomed?.tabs) return null;
  return minRoomOf(zoomed ?? mainOf(l));
}

/**
 * Where the panel stands: `beside` the main panes at `width`; `away`, put away by the toggle; `aside`,
 * stepping aside for want of room; `full`, filling the host (⌥⌘B, ⌘⇧F in it); `none`, nothing open.
 */
export type PanelPlace = { kind: "beside"; width: number } | { kind: "away" | "aside" | "full" | "none" };

export function panelPlace(s: RoomState): PanelPlace {
  const l = s.layout;
  const panel = l ? findPanel(l) : null;
  if (!l || !panel) return { kind: "none" };
  const zoomed = s.view?.zoomedLeafId ? findLeaf(l, s.view.zoomedLeafId) : null;
  if (zoomed?.id === panel.id) return { kind: "full" };
  if (s.sidePanesHidden) return { kind: "away" };
  const need = drawnNeed(l, zoomed);
  // Unmeasured: half, as the default says, until the host has a size.
  if (!s.viewRoom || !need) return { kind: "beside", width: 0 };
  const width = panelWidthIn(s.viewRoom, need, drawnShare(s));
  return width === null ? { kind: "aside" } : { kind: "beside", width };
}

/** Whether the panel is drawn beside the main panes — what takes its floor out of their room. */
export function panelBeside(s: RoomState): boolean {
  return panelPlace(s).kind === "beside";
}

/**
 * Why splitting the pane `leafId` stands for along `dir` is not offered, or null when it is. Asked of
 * the room the panes have now: all of the host, less the panel's floor while it is beside them.
 */
export function splitRefusal(s: RoomState, leafId: string | null, dir: "row" | "col", sidebarOpen = false): string | null {
  const l = s.layout;
  if (!l || !s.viewRoom) return null;
  const beside = panelBeside(s);
  if (splitFits(l, leafId, dir, mainRoom(s.viewRoom, beside))) return null;
  const where = dir === "row" ? "beside it" : "below it";
  if (beside && splitFits(l, leafId, dir, s.viewRoom)) {
    return `No room for another pane ${where} with the side panel out. Put the panel away or widen the window.`;
  }
  const floor = dir === "row" ? `${PANE_MIN.width} points wide` : `${PANE_MIN.height} points tall`;
  return `No room for another pane ${where}: each needs to be ${floor}. Widen the window${sidebarOpen ? ", fold the sidebar" : ""} or take a pane out of the split.`;
}
