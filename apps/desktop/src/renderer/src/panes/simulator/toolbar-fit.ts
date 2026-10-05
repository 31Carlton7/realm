/**
 * What the device's toolbar can still draw at the width its pane gives it.
 *
 * The pane bar's ladder (components/pane-bar-fit.ts), climbed by a smaller bar: a side pane can be a
 * fifth of the window, and a toolbar that kept its full width there would clip its own buttons. So it
 * gives things up in a stated order. The resolution goes first — it is the device's, not something
 * anyone acts on — then the state's word, leaving its dot. Then the buttons, from the end: Rotate, then
 * the elements overlay, then Screenshot, and Home last. The overflow never goes, and what a narrow pane
 * takes off the toolbar is the first thing in it, by name.
 *
 * MEASURED, not a breakpoint, for pane-bar-fit's reason: CSS could hide a button but could not tell
 * the overflow which ones it had hidden. One number decides both halves.
 */

export type StatusFit = "full" | "word" | "dot";

/** The pill's own 2px each side, the 1px rule between the state and the buttons with its 4px either
 *  side, the overflow's 28px button, and the 2px gaps on both sides of the rule and before the
 *  overflow. */
export const TOOLBAR_CHROME = 45;
/** One of the toolbar's buttons: 28px and the 2px gap before it. */
export const TOOLBAR_BUTTON = 30;
/** The state at each rung: the dot alone, the dot and its word ("Live"), and the word with the
 *  device's resolution in mono — four digits a side, the longest any device here reports. */
export const STATUS_W: Record<StatusFit, number> = { full: 122, word: 56, dot: 25 };

/** The fit, as a pure function of the width — exported so a test can walk the ladder without a
 *  layout engine. */
export function toolbarFit(width: number, buttons: number): { status: StatusFit; keep: number } {
  // 0 is "not measured yet": drawing everything into the overflow for one frame reads as a flicker.
  if (width <= 0) return { status: "full", keep: buttons };
  for (const status of ["full", "word", "dot"] as const) {
    if (TOOLBAR_CHROME + STATUS_W[status] + buttons * TOOLBAR_BUTTON <= width) return { status, keep: buttons };
  }
  const keep = Math.floor((width - TOOLBAR_CHROME - STATUS_W.dot) / TOOLBAR_BUTTON);
  return { status: "dot", keep: Math.max(0, Math.min(buttons, keep)) };
}
