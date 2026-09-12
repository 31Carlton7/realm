/**
 * How wide the sidebar may be, and what it is before anyone says.
 *
 * The default is also the number in tokens.css, and the two are different facts rather than one
 * repeated: the token is what a renderer that never reached this module paints, and this is what the
 * store hydrates when the setting is absent. They agree so that boot does not visibly re-lay the
 * shell out.
 *
 * The ceiling is the part with a judgement in it. design.md: "Keep persistent navigation narrow and
 * stable. Do not make the sidebar the loudest surface." The window cannot go below 900px wide
 * (main/index.ts sets minWidth), so 400 is the widest the column can be while the panes beside it
 * still have 500 — enough for a transcript at its own reading measure. Past that the nav would be
 * competing with the work for the window, which is the thing the rule above forbids.
 *
 * The floor is where the rows stop being rows: a session item is an icon, a title and a status dot,
 * and under about 200px the title is ellipsis for most of its length. A column narrower than that is
 * what the collapse toggle is for.
 */
export const SIDEBAR_WIDTH = { min: 200, default: 280, max: 400 } as const;

/** Snapped to whole pixels: the width lands on a CSS variable that a hairline border and a row of
 *  icons are positioned against, and a fractional column puts that seam on a half pixel. */
export const clampSidebarWidth = (px: number): number =>
  Number.isFinite(px) ? Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px))) : SIDEBAR_WIDTH.default;
