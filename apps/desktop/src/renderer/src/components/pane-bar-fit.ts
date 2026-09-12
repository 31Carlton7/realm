import { useEffect, useState, type RefObject } from "react";

/**
 * How many of a pane kind's own actions its bar can still draw as buttons.
 *
 * This is the last rung of a ladder styles.css already climbs. A pane bar that runs out of width
 * gives things up in priority order — the per-kind meta first (the model and the cost are on the
 * composer's own chips anyway), then the back/forward trail (⌘[ and ⌘] still work) — and what it was
 * protecting each time is the TITLE, because in a split the title is the only thing telling two
 * sessions apart. Under about 380px those two rungs ran out and the cluster on the right kept its
 * full width regardless, so a session pane with six actions in it squeezed the title to nothing and
 * then started clipping the actions themselves.
 *
 * So the actions give way too, one at a time, into the ⋯ menu that is already there. Nothing is
 * lost: an action that leaves the bar arrives in the menu with its name spelled out, which is more
 * than the glyph it left behind ever said.
 *
 * MEASURED, not a breakpoint. A pane is any width its split makes it, and `@container` could hide
 * these but could not tell the menu which ones it had hidden — the menu would have to list all of
 * them all the time, which is the duplicate control the bar already refuses to carry. One number
 * decides both halves, so the bar and the menu cannot disagree about where an action is.
 */

/** The nav pair after its -8 margin (48), the kind glyph (14), the three 8px gaps between them (24),
 *  and the trailing ⋯ + × with their gap (58).
 *
 *  NOT the bar's 28px of padding, and that is the one number here it is easy to get wrong: a
 *  `ResizeObserver` reports the CONTENT box, so the padding is already out of the width this is
 *  subtracted from. Including it cost every rung a whole action — measured on the built app, a 430px
 *  pane drew three of its actions where the arithmetic said four.
 *
 *  Measured at the width where this rung starts to matter: below 380px, where `.panel-meta` is
 *  already gone (styles.css) and is therefore not in the sum either. */
export const BAR_CHROME = 144;
/** The narrowest title worth keeping: about thirteen characters before the ellipsis. This is the
 *  number the whole budget exists to protect — spend it on a sixth glyph and the bar is back to
 *  telling you nothing about which pane you are looking at. */
export const TITLE_MIN = 120;
/** One action: a 28px button and the 2px gap that follows it. */
export const ACTION_W = 30;

/** The budget, as a pure function of the bar's width — exported so a test can walk the ladder
 *  without a layout engine, which jsdom does not have. */
export function actionsThatFit(width: number): number {
  // A width of 0 is "not measured yet", not "a bar with no room". Answering 0 there would draw every
  // pane's actions into its menu for one frame on every mount, which reads as the bar flickering.
  if (width <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((width - BAR_CHROME - TITLE_MIN) / ACTION_W));
}

/**
 * The bar's width, observed. `ResizeObserver` rather than the window's own resize: a pane changes
 * width when a SPLIT moves or a sidebar collapses, and neither of those is a window resize.
 */
export function useActionBudget(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return actionsThatFit(width);
}
