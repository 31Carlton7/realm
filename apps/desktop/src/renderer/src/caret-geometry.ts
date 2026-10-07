import type { CaretPrefs, CaretShape } from "@realm/contracts";

/**
 * The arithmetic behind the app's caret (caret.ts), kept apart from the DOM so it can be held to
 * exact numbers: where the caret stands, what box each shape draws there, and when the platform's
 * own caret can be left to do it instead.
 */

/** A box in viewport px. */
export type Box = { left: number; top: number; width: number; height: number };

/** A character's box, with the character, as a Range over it measures. */
export type CharBox = Box & { char: string };

/**
 * Where a caret stands, in viewport px: the insertion point's x, the top and height of the font's
 * box on that line (ascent to descent — the height the platform draws its own caret at, and what a
 * Range over one character measures), and the character after it, which a block covers.
 */
export type CaretSpot = {
  x: number;
  top: number;
  height: number;
  /** The character after the caret; "" at the end of a line. */
  glyph: string;
  /** Its advance — or a typical character's where there is none, so a block at the end of a line
   *  still has a body. */
  glyphWidth: number;
};

/** How wide each bar is and how tall each underline, in CSS px. */
const BAR: Partial<Record<CaretShape, number>> = { line: 2, "line-thin": 1, pill: 3, beam: 3 };
const RULE: Partial<Record<CaretShape, number>> = { underline: 2, "underline-thin": 1 };

/** To the device pixel. A caret is one or two pixels wide, and one standing half a pixel off the grid
 *  is a two-pixel grey smear instead. */
export const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr;

/**
 * The box a shape draws at a spot.
 *
 * A one-pixel line starts AT the insertion point, as the platform's own does, so the thin line and
 * the native caret stand on the same pixel. A wider bar is centred on the point: it sits in the gap
 * between two glyphs rather than eating into the second. A block and an underline are the next
 * character's width, from its own left edge — the cell VS Code's block covers.
 */
export function caretBox(spot: CaretSpot, shape: CaretShape, dpr = 1): Box {
  const top = snap(spot.top, dpr);
  const height = snap(spot.height, dpr);
  const bar = BAR[shape];
  if (bar !== undefined) return { left: snap(bar === 1 ? spot.x : spot.x - bar / 2, dpr), top, width: bar, height };
  const left = snap(spot.x, dpr);
  const width = Math.max(1, snap(spot.glyphWidth, dpr));
  const rule = RULE[shape];
  if (rule !== undefined) return { left, top: snap(spot.top + spot.height - rule, dpr), width, height: rule };
  return { left, top, width, height };
}

/** Two boxes lie on one line when their tops are closer than half the shorter one's height. */
const sameLine = (a: Box, b: Box): boolean => Math.abs(a.top - b.top) < Math.min(a.height, b.height) / 2;

/**
 * Where the caret goes, from the characters on either side of it — `before` the one it follows,
 * `after` the one it precedes (a newline, a zero-width space a mirror ends on, or nothing at the end
 * of a field).
 *
 * The two agree on a line: the caret is the next character's left edge. They disagree only at a
 * soft wrap, where one offset is both the end of a line and the start of the next. The platform keeps
 * which one it means (its affinity) and exposes it to nobody, so the caller says: `upstream` is the
 * end of the line — what End, ⌘→ and a click past the last word leave — and otherwise it is the
 * start of the next, which is what typing past the edge leaves.
 */
export function spotBetween(before: CharBox | null, after: CharBox | null, opts: { upstream: boolean; typicalWidth: number }): CaretSpot | null {
  if (after && (!before || sameLine(before, after) || !opts.upstream)) {
    // A newline or a zero-width space marks a place, not a character a block could cover.
    const glyph = after.char === "\n" || after.width === 0 ? "" : after.char;
    return { x: after.left, top: after.top, height: after.height, glyph, glyphWidth: glyph ? after.width : opts.typicalWidth };
  }
  if (before) return { x: before.left + before.width, top: before.top, height: before.height, glyph: "", glyphWidth: opts.typicalWidth };
  return null;
}

/** Whether the soft-wrap question even arises: two neighbours on two lines. */
export const atSoftWrap = (before: Box | null, after: Box | null): boolean => !!before && !!after && !sameLine(before, after);

export function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

export const contains = (box: Box, x: number, y: number): boolean =>
  x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;

/** What this engine lets a stylesheet do to the native caret, asked of `CSS.supports`. */
export type CaretSupport = { shape: boolean; animation: boolean };

/**
 * The caret as it is drawn: what was chosen, held still where motion is off (Reduce motion, Low
 * power). The shape and colour are never motion and stay.
 */
export function drawnCaret(prefs: CaretPrefs, still: boolean): CaretPrefs {
  return still ? { ...prefs, animation: "solid", glide: false } : prefs;
}

/**
 * The platform's own caret, where it can be what was asked for — and null where only a drawn one can.
 *
 * Chromium's caret is a thin line that blinks, so that choice is the platform's on every engine.
 * `caret-shape` and `caret-animation` widen it where they exist: a block, an underline, or a caret
 * that holds still. Nothing native glides, and nothing native fades.
 */
export function nativeCaret(prefs: CaretPrefs, support: CaretSupport): { shape: "auto" | "block" | "underline"; animation: "auto" | "manual" } | null {
  if (prefs.glide) return null;
  const shape = prefs.shape === "line-thin" ? "auto"
    : support.shape && prefs.shape === "block" ? "block"
    : support.shape && prefs.shape === "underline" ? "underline" : null;
  const animation = prefs.animation === "blink" ? "auto" : support.animation && prefs.animation === "solid" ? "manual" : null;
  return shape && animation ? { shape, animation } : null;
}
