import { samasanteLens } from "./vendor/lens-samasante";

/** The box a lens is drawn for, in CSS px: the glass layer's size and its corner radius. */
export type LensShape = { width: number; height: number; radius: number };

/** One SVG filter primitive, as React props (`in2`, `xChannelSelector`, `stdDeviation`). */
export type FilterPrimitive = { tag: string; props: Record<string, string | number>; children?: FilterPrimitive[] };

export type GlassLens = {
  name: string;
  /** The filter graph for a box of this shape, in user-space px, or null when no map can be drawn. */
  primitives(shape: LensShape): FilterPrimitive[] | null;
};

/** The lens the prompter wears. samasante's over glisse's, on cost: one small map redrawn only on a
 *  resize, against glisse's map cache that never frees and a subtree observer that would fire on
 *  every streamed token. */
export const PROMPTER_LENS: GlassLens = samasanteLens;
