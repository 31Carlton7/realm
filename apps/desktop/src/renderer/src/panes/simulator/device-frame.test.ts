import { describe, expect, it } from "vitest";
import { deviceShape, fitFramed, frameMetrics } from "./device-frame";

/** The real framebuffers, so the thresholds are checked against devices rather than against the
 *  numbers that were written to satisfy them. */
const IPHONE_17 = { width: 1206, height: 2622, orientation: "portrait" };
const IPHONE_SE = { width: 750, height: 1334, orientation: "portrait" };
const IPAD_11 = { width: 1668, height: 2388, orientation: "portrait" };
const WATCH = { width: 396, height: 484, orientation: "portrait" };

describe("deviceShape", () => {
  it("reads the hardware off the proportions, not off a table of product names", () => {
    expect(deviceShape(IPHONE_17)).toBe("phone");
    expect(deviceShape(IPHONE_SE)).toBe("phone");
    expect(deviceShape(IPAD_11)).toBe("tablet");
    expect(deviceShape(WATCH)).toBe("square");
  });

  it("a rotated device is the same device", () => {
    // Landscape arrives as a framebuffer with the axes swapped, and a frame that grew a phone's 14%
    // corner in portrait and a tablet's 2% in landscape would re-shape itself mid-rotation.
    for (const s of [IPHONE_17, IPAD_11, WATCH]) {
      expect(deviceShape({ ...s, width: s.height, height: s.width })).toBe(deviceShape(s));
    }
  });

  it("an unfamiliar screen gets the forgiving corner, not the phone's", () => {
    // 4:3-ish, between the families. A phone's corner on one of these eats the content.
    expect(deviceShape({ width: 1024, height: 1366, orientation: "portrait" })).toBe("tablet");
  });
});

describe("frameMetrics", () => {
  it("nests the two corners concentrically — outer = inner + the border between them", () => {
    /* THE MUTANT this exists for: pick the outer radius by eye (say `inner * 1.3`). Both corners are
       round, the frame looks almost right, and the two arcs are visibly non-parallel along the
       curve — design.md's rule about nested radii, which is a rule because the eye catches it. */
    for (const box of [[240, 520], [390, 844], [120, 260], [900, 1200]] as const) {
      const m = frameMetrics(IPHONE_17, box[0], box[1]);
      expect(m.outerRadius, `${box[0]}×${box[1]}`).toBe(m.screenRadius + m.bezel);
    }
  });

  it("the frame is the picture plus one border on each side", () => {
    const m = frameMetrics(IPHONE_17, 300, 652);
    expect(m.width).toBe(300 + m.bezel * 2);
    expect(m.height).toBe(652 + m.bezel * 2);
  });

  it("the border and the corner scale with the picture — a thumbnail is the same device", () => {
    const big = frameMetrics(IPHONE_17, 400, 869);
    const small = frameMetrics(IPHONE_17, 200, 435);
    expect(big.bezel).toBeGreaterThan(small.bezel);
    // Same ratio of corner to width at both sizes, within the rounding to whole pixels.
    expect(Math.abs(big.screenRadius / 400 - small.screenRadius / 200)).toBeLessThan(0.02);
  });

  it("keeps the border inside the range where it still reads as a surface", () => {
    expect(frameMetrics(IPHONE_17, 40, 87).bezel).toBeGreaterThanOrEqual(6);
    expect(frameMetrics(IPAD_11, 2000, 2862).bezel).toBeLessThanOrEqual(24);
  });

  it("a tablet gets a tablet's corner, which is most of what makes it read as one", () => {
    const phone = frameMetrics(IPHONE_17, 300, 652);
    const tablet = frameMetrics(IPAD_11, 300, 430);
    expect(phone.screenRadius / 300).toBeGreaterThan(tablet.screenRadius / 300 * 4);
  });

  it("no box yet is no frame — not a border around nothing", () => {
    expect(frameMetrics(IPHONE_17, 0, 0)).toEqual({ bezel: 0, screenRadius: 0, outerRadius: 0, width: 0, height: 0 });
  });

  it("a radius can never run past half the short edge, whatever proportions arrive", () => {
    const m = frameMetrics(WATCH, 200, 240);
    expect(m.screenRadius).toBeLessThanOrEqual(100);
  });
});

describe("fitFramed", () => {
  /* The property, not the passes: whatever the box, the whole DEVICE fits in it. A one-pass fit
     sizes the picture to the box and then adds a border, and the frame hangs out of the pane by up
     to two borders — which on a small pane is the device's own edge clipped off. */
  it("puts the whole frame inside the box, at every size and on every shape", () => {
    const boxes = [
      { width: 300, height: 700 }, { width: 1200, height: 400 }, { width: 96, height: 96 },
      { width: 640, height: 480 }, { width: 400, height: 2000 },
    ];
    for (const screen of [IPHONE_17, IPAD_11, WATCH]) {
      for (const box of boxes) {
        for (const dpr of [1, 2]) {
          const { frame } = fitFramed(screen, box, dpr);
          expect(frame.width, `${screen.width}×${screen.height} in ${box.width}×${box.height} @${dpr}`).toBeLessThanOrEqual(box.width);
          expect(frame.height).toBeLessThanOrEqual(box.height);
        }
      }
    }
  });

  it("gives up only the border — the picture is still as large as what is left allows", () => {
    const box = { width: 400, height: 900 };
    const { fit, frame } = fitFramed(IPHONE_17, box, 2);
    expect(fit.cssWidth).toBeGreaterThan(0);
    expect(frame.width).toBe(fit.cssWidth + frame.bezel * 2);
    /* On the axis that CONSTRAINS it, the device fills the box to within a pixel or two of rounding.
       The other axis is letterboxed, and by however much a phone's proportions differ from the
       pane's — asserting on that one would be asserting the aspect ratio of an iPhone. */
    const slack = Math.min(box.width - frame.width, box.height - frame.height);
    expect(slack).toBeGreaterThanOrEqual(0);
    /* Three pixels is the whole budget the two passes can spend: one to the floor that squares the
       picture off, and two more when the second pass derives a rail a pixel thinner on each side
       than the one the box was reserved for. Anything beyond that is the fit giving up room. */
    expect(slack).toBeLessThanOrEqual(3);
  });

  it("a box with no room is no picture and no frame, rather than a negative one", () => {
    const { fit, frame } = fitFramed(IPHONE_17, { width: 0, height: 0 }, 2);
    expect(fit.cssWidth).toBe(0);
    expect(frame.width).toBe(0);
  });
});
