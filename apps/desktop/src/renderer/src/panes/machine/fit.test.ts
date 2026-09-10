import { describe, expect, it } from "vitest";
import { SNAP_COVERAGE, fitFramebuffer, scaleLabel, toFramebuffer, toFramebufferClamped, toPane } from "./fit";

describe("fitting a framebuffer into a pane", () => {
  /**
   * The named bug, and it is worth stating plainly because the wrong version LOOKS right.
   *
   * noVNC sizes its backing store to the framebuffer and CSS-scales the canvas, so the ratio that
   * decides sharpness is framebuffer→DEVICE pixels while the number written into `style.width` is in
   * CSS pixels. Compute the whole thing in CSS pixels — the obvious way — and a 2× display gets a
   * screen resampled to half resolution at a scale that reads, in the code, as exactly 1.
   */
  it("computes the ratio in device pixels and the size in CSS pixels", () => {
    // A 1440x900 guest in a 720x450 box at 2x fits EXACTLY, one framebuffer pixel per device pixel.
    const fit = fitFramebuffer({ width: 1440, height: 900 }, { width: 720, height: 450 }, 2);
    expect(fit.deviceScale).toBe(1);
    expect(fit.cssWidth).toBe(720);
    expect(fit.cssHeight).toBe(450);
    expect(fit.crisp).toBe(true);
    // Dropping the `* dpr` gives 0.5 here, and a picture at half the resolution the display can show.
    expect(fit.deviceScale).not.toBe(0.5);
  });

  it("letterboxes on the axis with room to spare, and centres what is left", () => {
    // 16:9 into a 4:3 box: width-bound, bars top and bottom.
    const fit = fitFramebuffer({ width: 1600, height: 900 }, { width: 800, height: 800 }, 1);
    expect(fit.cssWidth).toBe(800);
    expect(fit.cssHeight).toBe(450);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(175);
  });

  it("snaps to a whole device ratio only when that still fills the pane", () => {
    // 2.4x raw → 2x costs 17% of the box, which is more than the floor allows. No snap.
    const loose = fitFramebuffer({ width: 400, height: 300 }, { width: 960, height: 720 }, 1);
    expect(loose.deviceScale).toBeCloseTo(2.4, 5);
    expect(loose.crisp).toBe(false);

    // 2.02x raw → 2x costs 1%, well inside the floor. Snapped, and the guest's text is sharp.
    const tight = fitFramebuffer({ width: 400, height: 300 }, { width: 808, height: 606 }, 1);
    expect(tight.deviceScale).toBe(2);
    expect(tight.crisp).toBe(true);
  });

  it("never snaps below 1 — a screen shown smaller than half size is not a sharpness decision", () => {
    const fit = fitFramebuffer({ width: 1920, height: 1080 }, { width: 400, height: 300 }, 1);
    expect(fit.deviceScale).toBeLessThan(1);
    expect(fit.deviceScale).toBeGreaterThan(0);
    expect(fit.crisp).toBe(false);
  });

  it("`actual` is one framebuffer pixel per device pixel, whatever the box", () => {
    const fit = fitFramebuffer({ width: 1920, height: 1080 }, { width: 400, height: 300 }, 2, "actual");
    expect(fit.deviceScale).toBe(1);
    expect(fit.cssWidth).toBe(960);
    // Larger than the pane, so it pans rather than letterboxing — and the offsets stay at 0 rather
    // than going negative, which would push the guest's top-left behind the pane's own edge where
    // nothing could ever reach it.
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(0);
  });

  it("answers something harmless before there is a framebuffer or a box to measure", () => {
    for (const [fb, box] of [
      [{ width: 0, height: 0 }, { width: 800, height: 600 }],
      [{ width: 800, height: 600 }, { width: 0, height: 0 }],
    ] as const) {
      const fit = fitFramebuffer(fb, box, 2);
      expect(fit.cssWidth).toBe(0);
      expect(Number.isFinite(fit.deviceScale)).toBe(true);
    }
  });
});

describe("where a click lands", () => {
  it("maps the pane's own coordinates onto the framebuffer", () => {
    const fb = { width: 1600, height: 900 };
    const fit = fitFramebuffer(fb, { width: 800, height: 800 }, 1);   // 0.5x, 175px bars
    expect(toFramebuffer(fit, fb, { x: 400, y: 400 }, 1)).toEqual({ x: 800, y: 450 });
    expect(toFramebuffer(fit, fb, { x: 0, y: 175 }, 1)).toEqual({ x: 0, y: 0 });
  });

  /* The letterbox is not the screen. Clamping a click there instead of refusing it sends a press to
     the guest's outermost pixel — which on a desktop is a menu bar, a dock, or a window's close
     button. Refusing costs a user nothing; clamping costs them whatever was under the corner. */
  it("refuses a point in the letterbox rather than clamping it onto the edge", () => {
    const fb = { width: 1600, height: 900 };
    const fit = fitFramebuffer(fb, { width: 800, height: 800 }, 1);
    expect(toFramebuffer(fit, fb, { x: 400, y: 10 }, 1)).toBeNull();
    expect(toFramebuffer(fit, fb, { x: 400, y: 790 }, 1)).toBeNull();
    expect(toFramebuffer(fit, fb, { x: -5, y: 400 }, 1)).toBeNull();
  });

  /* …and the one place a clamp IS right. A drag that leaves the canvas must keep reporting, or the
     button stays DOWN in the guest — the worst thing to leave behind on somebody else's Mac. */
  it("clamps instead, for a drag that has left the canvas with a button held", () => {
    const fb = { width: 1600, height: 900 };
    const fit = fitFramebuffer(fb, { width: 800, height: 800 }, 1);
    expect(toFramebufferClamped(fit, fb, { x: -500, y: -500 }, 1)).toEqual({ x: 0, y: 0 });
    expect(toFramebufferClamped(fit, fb, { x: 5000, y: 5000 }, 1)).toEqual({ x: 1599, y: 899 });
  });

  /**
   * The round trip, across every mode × DPR × aspect.
   *
   * This is the test the whole module is shaped for. `fitFramebuffer` decides where the screen is
   * DRAWN and `toFramebuffer` decides where a click LANDS, and a sign flipped in one of them is
   * invisible: the picture is still correct, and only the presses go somewhere else. Nothing short
   * of walking a point out and back can notice.
   */
  it("survives a round trip through the pane and back, at every scale", () => {
    const frames = [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 1080, height: 1920 }, { width: 640, height: 480 }];
    const boxes = [{ width: 900, height: 700 }, { width: 400, height: 900 }, { width: 1600, height: 400 }, { width: 808, height: 606 }];
    const failures: string[] = [];
    for (const fb of frames) {
      for (const box of boxes) {
        for (const dpr of [1, 2, 3]) {
          for (const mode of ["fit", "actual"] as const) {
            const fit = fitFramebuffer(fb, box, dpr, mode);
            for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: fb.width - 1, y: fb.height - 1 }, { x: (fb.width / 3) | 0, y: (fb.height / 7) | 0 }]) {
              const back = toFramebuffer(fit, fb, toPane(fit, p, dpr), dpr);
              if (back?.x !== p.x || back?.y !== p.y) {
                failures.push(`${fb.width}x${fb.height} in ${box.width}x${box.height} @${dpr}x ${mode}: (${p.x},${p.y}) → ${JSON.stringify(back)}`);
              }
            }
          }
        }
      }
    }
    expect(failures, "a framebuffer pixel did not survive the trip out to the pane and back").toEqual([]);
  });

  it("puts a framebuffer pixel at the CENTRE of where it is drawn, not its corner", () => {
    const fb = { width: 100, height: 100 };
    const fit = fitFramebuffer(fb, { width: 400, height: 400 }, 1);   // 4x
    // Pixel (0,0) occupies 0..4 in the pane, so its centre is 2 — not 0, which is its edge and would
    // put the agent's cursor half a pixel outside the pixel it is marking.
    expect(toPane(fit, { x: 0, y: 0 }, 1)).toEqual({ x: 2, y: 2 });
  });
});

describe("the pane bar's scale", () => {
  it("says nothing at 1:1, and a percentage whenever there is resampling to declare", () => {
    const fb = { width: 800, height: 600 };
    expect(scaleLabel(fitFramebuffer(fb, { width: 800, height: 600 }, 1), 1)).toBeNull();
    // A 2x display showing a guest at one framebuffer pixel per device pixel is 50% in CSS terms,
    // and saying so is the point: the picture is sharp AND half-size, and both are worth knowing.
    expect(scaleLabel(fitFramebuffer(fb, { width: 400, height: 300 }, 2), 2)).toBe("50%");
    expect(scaleLabel(fitFramebuffer(fb, { width: 1600, height: 1200 }, 1), 1)).toBe("200%");
  });
});

describe("the snap floor", () => {
  it("is a coverage fraction, not a scale threshold", () => {
    // Named so the constant cannot quietly become "snap whenever the ratio is above 1.5", which
    // would waste a third of a pane on a 1.6x fit.
    expect(SNAP_COVERAGE).toBeGreaterThan(0.5);
    expect(SNAP_COVERAGE).toBeLessThan(1);
  });
});
