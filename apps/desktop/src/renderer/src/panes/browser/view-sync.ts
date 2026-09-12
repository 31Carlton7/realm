import { isRealmPaneDrag, REALM_ITEM_TYPE } from "../../components/drag-types";

/**
 * The browser pane's bounds-discipline decisions (Plan 11 W1), kept pure so the research's known tax
 * — native-view bounds trailing the DOM — has its mitigation logic under test rather than smeared
 * through effect wiring in the component.
 */

/** How long after mount the pane counts as "settling": the pane-slot's rl-settle enter animation
 *  (150ms translateY) moves the placeholder's rect, and bounds synced mid-tween would leave the
 *  native view parked where a frame of the animation was. Padded slightly past the animation. */
export const SETTLE_MS = 180;

export type ViewSyncFlags = {
  /** The pane sits in a visible leaf (PaneProps.visible). */
  paneVisible: boolean;
  /**
   * An app-level page (Settings, Library, Notifications, …) is open over the workspace.
   *
   * A native `WebContentsView` paints over ALL dom, so a DOM overlay cannot cover one — and unlike a
   * sheet, which is a card with room beside it, the page overlay covers the whole pane host and
   * leaves no complement to snap a browser into. Hiding is the only honest answer: opening Settings
   * with a browser pane behind it left the page reachable only where the browser did not happen to
   * be. The view keeps running and comes back at the same rect when the page closes.
   */
  pageOverlay: boolean;
  /** A sidebar/pane item drag is in flight — drags are on the do-NOT-animate list, and the view
   *  hides outright rather than trailing the placeholder (research mitigation). */
  dragging: boolean;
  /** Mount settle elapsed (see SETTLE_MS). */
  settled: boolean;
  /** The view has something on it. Before the first navigation the pane shows its DOM empty state
   *  and the native view stays hidden — no about:blank flash over a themed pane. */
  hasUrl: boolean;
};

/** THE visibility verdict, sent to main with every bounds sync. */
export function shouldShowView(f: ViewSyncFlags): boolean {
  return f.paneVisible && !f.pageOverlay && !f.dragging && f.settled && f.hasUrl;
}

/** Is this drag one of ours? Existing items and the new-session row carry custom MIME types;
 *  OS file drags must not blank the browser view. */
export { REALM_ITEM_TYPE };
export function isRealmItemDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return isRealmPaneDrag(e);
}
