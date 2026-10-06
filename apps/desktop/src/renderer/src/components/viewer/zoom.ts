/**
 * Zoom for the media viewer's pictures, as numbers: what "fit" comes to for a picture in a box, and
 * where a press of + or − goes from wherever the scale is now.
 *
 * Pure, so the rules a person feels — fit never blows a small picture up, a step always moves, the
 * picture under the pointer stays under it — are tested without a window.
 */

/** The rungs + and − move between. Preview's own, near enough: the familiar fractions below 100%,
 *  then whole multiples, and nothing past 8× — a pixel that big is a coloured square. */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** "fit", or a scale against the picture's own pixels. */
export type Zoom = "fit" | number;
export type Size = { w: number; h: number };

/** The scale that fits `natural` inside `box`, and never above 1: fitting a 64px icon to a window is
 *  how an icon becomes a smear, and the lightbox before this was measured not doing it. */
export function fitScale(natural: Size, box: Size): number {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  return Math.min(1, box.w / natural.w, box.h / natural.h);
}

export const scaleOf = (zoom: Zoom, natural: Size, box: Size): number => (zoom === "fit" ? fitScale(natural, box) : zoom);

/** One press of + (1) or − (-1) from `scale`: the next rung that is actually further that way, so a
 *  fit of 0.66 steps to 0.67 only if that is a change anybody could see. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  const eps = 0.005;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale + eps) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - eps) ?? MIN_ZOOM;
}

export const clampZoom = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

/** The readout: a whole percentage, as every image viewer prints it. */
export const zoomLabel = (scale: number): string => `${Math.round(scale * 100)}%`;

/**
 * Where the scroller has to be after a zoom so the point under the pointer is still under it.
 *
 * `at` is the pointer in the scroller's own box. The picture sits centred in a canvas at least as
 * big as the box, so a picture smaller than the box has a margin of half the difference either side,
 * and that margin changes with the scale too — it is the reason this cannot be one multiplication.
 */
export function anchoredScroll(i: {
  at: { x: number; y: number }; scroll: { left: number; top: number };
  natural: Size; box: Size; from: number; to: number;
}): { left: number; top: number } {
  const margin = (scale: number, axis: "w" | "h") => Math.max(0, (i.box[axis] - i.natural[axis] * scale) / 2);
  const px = (i.scroll.left + i.at.x - margin(i.from, "w")) / i.from;
  const py = (i.scroll.top + i.at.y - margin(i.from, "h")) / i.from;
  return {
    left: Math.max(0, px * i.to + margin(i.to, "w") - i.at.x),
    top: Math.max(0, py * i.to + margin(i.to, "h") - i.at.y),
  };
}
