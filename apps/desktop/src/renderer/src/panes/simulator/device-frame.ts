/**
 * The frame Realm draws around a simulator's picture, and the arithmetic that makes it fit.
 *
 * The stream is the SCREEN and nothing else — no bezel, no rail, and (this is the one that catches
 * people) no Dynamic Island either: on a modern phone the island is black pixels the system draws
 * into the framebuffer, so it arrives inside the picture. What is missing from the stream is the
 * hardware around it, and Realm does not draw that hardware. It draws its OWN surface around the
 * picture: one of the app's raised panels, with the screen inset into it. A rail in brushed metal
 * with nubs for the volume keys was a picture of a phone laid under a picture of a phone, and it
 * looked like neither this app nor that device.
 *
 * What is still read off the real hardware is the SCREEN's corner, because that corner is in the
 * picture whether Realm agrees with it or not. Everything else here is a fraction of the screen's
 * short edge rather than a pixel count, because the picture is scaled to whatever the pane can
 * spare: a 14px border is right at full size and a third of the device at thumbnail size.
 */

import type { SimulatorScreen } from "@realm/contracts";
import { fitFramebuffer, type Box, type Fit } from "../machine/fit";

/** What kind of hardware the picture is of. Derived from the screen's proportions rather than from
 *  the device's NAME: a name table is a list of every product Apple has shipped and a promise to
 *  keep listing them, where the aspect ratio of a phone is a fact about phones. */
export type DeviceShape = "phone" | "tablet" | "square";

/**
 * The corner radius of the display itself, as a fraction of the screen's short edge.
 *
 * Phone: iPhone 17's display corner is 55pt on a 393pt-wide screen. Every notched iPhone since the X
 * lands within a point of that ratio, which is why one number covers the range.
 * Tablet: an 11-inch iPad's is 18pt on 834pt — a much gentler corner, and using the phone's here is
 * what makes a framed iPad look like a toy.
 * Square (a watch): 30%, near enough a rounded square.
 */
const SCREEN_RADIUS_RATIO: Record<DeviceShape, number> = { phone: 0.14, tablet: 0.0216, square: 0.3 };

/** The border's thickness, as a fraction of the short edge. One number for every device: this is
 *  Realm's own frame, and a frame that thinned itself for an iPad would be claiming to be that
 *  iPad's aluminium. Thick enough to read as a surface the screen is set into rather than as an
 *  outline drawn around it. */
const BORDER_RATIO = 0.045;

/** Below this the border stops being a surface and becomes an outline; above it, a thumbnail-sized
 *  device would wear a frame thicker than its own screen. */
const BORDER_MIN = 6;
const BORDER_MAX = 24;

/** The border a picture with this short edge wears, in whole CSS pixels. Whole, because a fractional
 *  padding puts the picture a fraction of a pixel off centre and the two sides of the frame then
 *  render a hair apart — which is exactly where a seam shows. */
const borderFor = (short: number): number => Math.round(Math.min(BORDER_MAX, Math.max(BORDER_MIN, short * BORDER_RATIO)));

/**
 * Which hardware the proportions say this is.
 *
 * The thresholds sit in the empty space between the real families: every iPhone since the X is
 * 0.46–0.50 short/long, every iPad 0.70–0.77, and a watch is 0.82+. Anything between is a device
 * Realm has not met, and `tablet` is the forgiving answer — a gentle corner on an unknown screen
 * looks like a screen, where a phone's 14% corner would eat the content.
 */
export function deviceShape(screen: SimulatorScreen): DeviceShape {
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  if (long <= 0) return "tablet";
  const ratio = short / long;
  if (ratio < 0.6) return "phone";
  return ratio > 0.8 ? "square" : "tablet";
}

export type FrameMetrics = {
  /** The border's thickness on every side, CSS px. */
  bezel: number;
  /** The picture's own corner, CSS px — what the clip path is built from. */
  screenRadius: number;
  /** The frame's outer corner, CSS px. */
  outerRadius: number;
  /** The frame's box, CSS px: the picture plus a border on each side. */
  width: number;
  height: number;
};

/**
 * The device's own display corner, in CSS pixels, for a picture of this size.
 *
 * Half the short edge is the ceiling a radius may ever have — past it the "corner" is the whole side
 * and the shape stops being a rounded rectangle at all. A watch at 30% never reaches it; the clamp is
 * here for a screen with proportions nobody has shipped yet.
 */
export function screenRadiusFor(screen: SimulatorScreen, cssWidth: number, cssHeight: number): number {
  const short = Math.min(cssWidth, cssHeight);
  if (short <= 0) return 0;
  return Math.round(Math.min(short / 2, short * SCREEN_RADIUS_RATIO[deviceShape(screen)]));
}

/**
 * The frame around a picture of this size.
 *
 * `outerRadius = screenRadius + bezel` is not a taste decision — design.md requires nested radii to
 * be concentric, and two corners that are merely both round are visibly non-parallel along the arc.
 * It is also the difference between a screen set into a surface and a rectangle someone rounded
 * twice.
 *
 * Sizes of zero are passed through as zero: a pane mid-layout has no box yet, and inventing a border
 * for a picture with no size would draw an empty frame with nothing in it.
 */
export function frameMetrics(
  screen: SimulatorScreen,
  cssWidth: number,
  cssHeight: number,
  /* The thickness, when the caller has already settled it. `fitFramed` has: the picture it hands in
     is the one that was fitted into the room this border left, so deriving a second, thinner border
     from it would leave the device sitting inside a pane it had already been measured to fill. */
  bezel: number = borderFor(Math.min(cssWidth, cssHeight)),
): FrameMetrics {
  if (cssWidth <= 0 || cssHeight <= 0) return { bezel: 0, screenRadius: 0, outerRadius: 0, width: 0, height: 0 };
  const screenRadius = screenRadiusFor(screen, cssWidth, cssHeight);
  return {
    bezel,
    screenRadius,
    outerRadius: screenRadius + bezel,
    width: cssWidth + bezel * 2,
    height: cssHeight + bezel * 2,
  };
}

/**
 * Lay the picture into the pane WITH its frame, so the whole device fits rather than the screen.
 *
 * Two passes, because the border's thickness is a fraction of the picture and the picture is what
 * the border leaves. The first pass sizes the picture to the whole pane and settles the thickness
 * from it; the second fits the picture into what that thickness leaves, and KEEPS it. Deriving a
 * second border from the smaller picture is the tempting third pass and it is wrong twice over: the
 * device would sit a few pixels inside a pane it had just been measured to fill, and the two numbers
 * can chase each other — a thinner border admits a larger picture, which asks for a thicker border.
 * What it costs is a border a pixel or two thicker than the final picture would have asked for —
 * an eighth of the border nobody can see, against the four pixels of device size the third pass
 * would have thrown away.
 */
export function fitFramed(screen: SimulatorScreen, box: Box, dpr: number): { fit: Fit; frame: FrameMetrics } {
  const bare = fitFramebuffer(screen, box, dpr);
  const bezel = borderFor(Math.min(bare.cssWidth, bare.cssHeight));
  const inner = { width: box.width - bezel * 2, height: box.height - bezel * 2 };
  const loose = fitFramebuffer(screen, inner, dpr);
  /* Floored to whole CSS pixels, which is what keeps the border even. A picture 400.0000001px wide
     sits a hair proud of a 400px border on one side and a hair short on the other, and that is
     exactly where a seam shows. It also makes the frame's own box integral, so "the device fits in
     the pane" is a true statement rather than one that is true to within float dust. Nothing
     downstream needs the fraction: the picture is sized from these numbers, and input is mapped
     from the picture's own measured rect (`normalizedPoint`) rather than from the scale. */
  const fit = { ...loose, cssWidth: Math.floor(loose.cssWidth), cssHeight: Math.floor(loose.cssHeight) };
  return { fit, frame: frameMetrics(screen, fit.cssWidth, fit.cssHeight, bezel) };
}
