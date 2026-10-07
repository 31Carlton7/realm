import { describe, expect, it } from "vitest";
import { normalizedPoint } from "./sim-input";

describe("normalizedPoint", () => {
  /** The picture, wherever the layout put it — inside a rail, inside a letterbox, inside a pane. */
  const rect = { left: 50, top: 100, width: 300, height: 600 };

  it("maps a point on the picture to the device's own 0..1", () => {
    expect(normalizedPoint(rect, { clientX: 200, clientY: 400 }, false)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPoint(rect, { clientX: 50, clientY: 100 }, false)).toEqual({ x: 0, y: 0 });
  });

  it("is null off the picture — the rail and the letterbox are not the device", () => {
    /* THE clamping mutant: treat everything around the picture as its nearest edge pixel. On a phone
       that edge is the status bar and the home indicator, so a miss becomes a press on something. */
    expect(normalizedPoint(rect, { clientX: 49, clientY: 400 }, false)).toBeNull();
    expect(normalizedPoint(rect, { clientX: 200, clientY: 99 }, false)).toBeNull();
    expect(normalizedPoint(rect, { clientX: 350, clientY: 400 }, false)).toBeNull(); // right edge is exclusive
    expect(normalizedPoint(rect, { clientX: 200, clientY: 700 }, false)).toBeNull();
  });

  it("clamps instead, for a drag that has left the picture with a touch still down", () => {
    // A drag that stopped reporting at the edge would leave the press DOWN on the device.
    expect(normalizedPoint(rect, { clientX: -400, clientY: 400 }, true)).toEqual({ x: 0, y: 0.5 });
    expect(normalizedPoint(rect, { clientX: 900, clientY: 9_000 }, true)).toEqual({ x: 1, y: 1 });
  });

  it("a picture with no box is no point at all, rather than a division by zero", () => {
    expect(normalizedPoint({ left: 0, top: 0, width: 0, height: 0 }, { clientX: 0, clientY: 0 }, false)).toBeNull();
    expect(normalizedPoint({ left: 0, top: 0, width: 0, height: 0 }, { clientX: 0, clientY: 0 }, true)).toBeNull();
  });
});
