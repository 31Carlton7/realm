import { describe, expect, it } from "vitest";
import { fitFramebuffer, scaleLabel } from "./fit";

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

