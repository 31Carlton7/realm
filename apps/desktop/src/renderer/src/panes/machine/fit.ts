/**
 * How a guest's framebuffer is laid into a pane (Plan 25 W3). Pure, and the arithmetic is shared by
 * two things that must never disagree: where the screen is DRAWN, and where a click LANDS.
 *
 * A scale and its inverse that drift apart is a pane that clicks in the wrong place — the failure
 * with no visible symptom, because the picture looks perfectly correct while every press goes
 * somewhere else. `fit.test.ts` holds them together with a round trip rather than by inspection.
 */

/** How the framebuffer is sized into the box. */
export type FitMode =
  /** Whole screen, letterboxed, at whatever ratio it takes. The default: a remote screen is a thing
   *  you want all of. */
  | "fit"
  /** One framebuffer pixel per DEVICE pixel. Sharp, and the only mode where `image-rendering:
   *  pixelated` is honest — everywhere else there is genuine resampling to show. */
  | "actual";

export type Framebuffer = { width: number; height: number };
/** The pane's own content box, in CSS pixels, as `getBoundingClientRect` reports it. */
export type Box = { width: number; height: number };

export type Fit = {
  /** Framebuffer pixels → DEVICE pixels. This is the ratio that decides sharpness. */
  deviceScale: number;
  /** What to set on the canvas, in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Letterbox offsets inside the box, in CSS pixels — the canvas is centred. */
  offsetX: number;
  offsetY: number;
  /** True when `deviceScale` is a whole number ≥ 1, which is what makes guest text crisp. Drives
   *  nothing but the pane bar's percentage, which says whether you are reading a resampled image. */
  crisp: boolean;
};

/**
 * The integer-snap coverage floor.
 *
 * Snapping the device ratio to a whole number is what makes a guest's text sharp — a 1.87× scale
 * resamples every glyph edge. But snapping DOWN always would waste arbitrary amounts of the pane, so
 * it only happens when the snapped size still fills at least this much of the box's smaller
 * dimension. Below that the resampled-but-large picture is the better answer, and the bar says so.
 */
export const SNAP_COVERAGE = 0.92;

/**
 * Lay a framebuffer into a box.
 *
 * The bug this exists to prevent, and it is the reason `dpr` is a parameter at all: noVNC sizes its
 * backing store to the framebuffer and then CSS-scales the canvas. So the ratio that decides
 * SHARPNESS is framebuffer→device pixels, while the number that has to be written into `style.width`
 * is in CSS pixels. Computing the whole thing in CSS pixels — the obvious way — gives every Retina
 * user a softened screen at a scale that looks, in the code, like exactly 1.
 */
export function fitFramebuffer(fb: Framebuffer, box: Box, dpr: number, mode: FitMode = "fit"): Fit {
  const d = dpr > 0 ? dpr : 1;
  if (fb.width <= 0 || fb.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { deviceScale: 1, cssWidth: 0, cssHeight: 0, offsetX: 0, offsetY: 0, crisp: true };
  }
  let deviceScale: number;
  if (mode === "actual") {
    deviceScale = 1;
  } else {
    const raw = Math.min((box.width * d) / fb.width, (box.height * d) / fb.height);
    const snapped = Math.floor(raw);
    // Snap only when the whole-number ratio still fills the box — otherwise a 1.99× fit would drop
    // to 1× and waste half the pane for the sake of a sharpness nobody asked to pay that much for.
    deviceScale = snapped >= 1 && snapped / raw >= SNAP_COVERAGE ? snapped : raw;
  }
  const cssWidth = (fb.width * deviceScale) / d;
  const cssHeight = (fb.height * deviceScale) / d;
  return {
    deviceScale,
    cssWidth, cssHeight,
    // Centred, and never negative: in `actual` mode the screen can be larger than the pane, and a
    // negative offset would push the top-left of the guest out of reach behind the pane's own edge.
    offsetX: Math.max(0, (box.width - cssWidth) / 2),
    offsetY: Math.max(0, (box.height - cssHeight) / 2),
    crisp: Number.isInteger(deviceScale) && deviceScale >= 1,
  };
}

/**
 * A point in the PANE's coordinates → the framebuffer pixel under it, or null when the point is in
 * the letterbox rather than on the screen.
 *
 * Null rather than a clamp, deliberately. A click in the letterbox is a click on nothing, and
 * clamping it would send a press to the guest's outermost pixel — which on a desktop is a menu bar,
 * a dock or a window's close button. The one place a clamp is right is a DRAG that leaves the
 * canvas, and that is the caller's business: a drag has to keep reporting so the button can be
 * released in the guest, which is why `toFramebufferClamped` exists beside this.
 */
export function toFramebuffer(fit: Fit, fb: Framebuffer, point: { x: number; y: number }, dpr: number): { x: number; y: number } | null {
  const d = dpr > 0 ? dpr : 1;
  const x = ((point.x - fit.offsetX) * d) / fit.deviceScale;
  const y = ((point.y - fit.offsetY) * d) / fit.deviceScale;
  if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

/** The same map, clamped into the screen — for a drag that has left the canvas and still has a
 *  button held down. A drag that stopped reporting at the edge would leave that button DOWN in the
 *  guest, which is the worst possible thing to leave behind on somebody else's Mac. */
export function toFramebufferClamped(fit: Fit, fb: Framebuffer, point: { x: number; y: number }, dpr: number): { x: number; y: number } {
  const d = dpr > 0 ? dpr : 1;
  const x = ((point.x - fit.offsetX) * d) / fit.deviceScale;
  const y = ((point.y - fit.offsetY) * d) / fit.deviceScale;
  return {
    x: Math.min(fb.width - 1, Math.max(0, Math.floor(x))),
    y: Math.min(fb.height - 1, Math.max(0, Math.floor(y))),
  };
}

/** The inverse: a framebuffer pixel → its centre in the pane's coordinates. What the agent cursor's
 *  overlay is positioned by, so the mark is placed by the SAME arithmetic the input used. */
export function toPane(fit: Fit, point: { x: number; y: number }, dpr: number): { x: number; y: number } {
  const d = dpr > 0 ? dpr : 1;
  return {
    x: fit.offsetX + ((point.x + 0.5) * fit.deviceScale) / d,
    y: fit.offsetY + ((point.y + 0.5) * fit.deviceScale) / d,
  };
}

/** The pane bar's percentage. Absent at 1:1 in device terms, because "100%" on every pane is a
 *  number nobody reads; present otherwise, because a user reading small text needs to know whether
 *  they are looking at a resampled image. */
export function scaleLabel(fit: Fit, dpr: number): string | null {
  const d = dpr > 0 ? dpr : 1;
  const cssScale = fit.deviceScale / d;
  if (Math.abs(cssScale - 1) < 0.005) return null;
  return `${Math.round(cssScale * 100)}%`;
}
