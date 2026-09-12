import { describe, expect, it } from "vitest";
import { SIM_WS_OPCODE } from "@realm/contracts";
import { buttonFrame, gestureFrame, keyFrame, keyUsage, keystrokeFrames, orientationFrame, SHIFT_USAGE, normalizedPoint } from "./sim-input";

/**
 * These frames are serve-sim's wire format, not ours.
 *
 * Every number and key name below was read out of the `serve-sim` CLI that speaks it — the opcode
 * byte, the `begin`/`move`/`end` vocabulary, the HID pairs on the hardware buttons. A frame with the
 * right shape and a wrong name is a tap that silently does nothing, which no amount of watching the
 * pane would explain, so this file pins them.
 */
const read = (f: Uint8Array): { opcode: number; body: unknown } =>
  ({ opcode: f[0]!, body: JSON.parse(new TextDecoder().decode(f.slice(1))) as unknown });

describe("the frames a device is driven with", () => {
  it("a touch is one opcode byte and normalized coordinates", () => {
    expect(read(gestureFrame("begin", 0.25, 0.5))).toEqual({ opcode: 3, body: { type: "begin", x: 0.25, y: 0.5 } });
    expect(SIM_WS_OPCODE.gesture).toBe(3);
  });

  it("clamps a coordinate into the screen rather than sending one off it", () => {
    // A drag that leaves the picture keeps reporting — that is what lifts the touch — so the numbers
    // arriving here can be outside 0..1, and the device's own input path rejects those outright.
    expect(read(gestureFrame("move", -0.4, 1.7)).body).toEqual({ type: "move", x: 0, y: 1 });
    expect(read(gestureFrame("end", Number.NaN, 0.5)).body).toEqual({ type: "end", x: 0, y: 0.5 });
  });

  it("the home button carries no HID pair, and the others carry their own", () => {
    // THE invented-usage mutant: give `home` a page/usage like its neighbours. The helper maps home
    // itself, and a pair made up for it presses some other button entirely.
    expect(read(buttonFrame("home"))).toEqual({ opcode: 4, body: { button: "home" } });
    expect(read(buttonFrame("volume-up"))).toEqual({ opcode: 4, body: { button: "volume-up", page: 12, usage: 233 } });
    expect(read(buttonFrame("power"))).toEqual({ opcode: 4, body: { button: "power", page: 12, usage: 48 } });
  });

  it("rotation and keys are their own opcodes", () => {
    expect(read(orientationFrame("landscape_left"))).toEqual({ opcode: 7, body: { orientation: "landscape_left" } });
    expect(read(keyFrame("down", 4))).toEqual({ opcode: 6, body: { type: "down", usage: 4 } });
  });
});

describe("a keystroke on the way to the device", () => {
  it("maps the US keyboard the way HID numbers it", () => {
    expect(keyUsage("a")).toEqual({ usage: 4, shift: false });
    expect(keyUsage("z")).toEqual({ usage: 29, shift: false });
    expect(keyUsage("1")).toEqual({ usage: 30, shift: false });
    expect(keyUsage("9")).toEqual({ usage: 38, shift: false });
    // The one place the table stops being arithmetic: zero sits AFTER nine, not before one.
    expect(keyUsage("0")).toEqual({ usage: 39, shift: false });
    expect(keyUsage(" ")).toEqual({ usage: 44, shift: false });
    expect(keyUsage("Enter")).toEqual({ usage: 40, shift: false });
    expect(keyUsage("Backspace")).toEqual({ usage: 42, shift: false });
    expect(keyUsage("ArrowUp")).toEqual({ usage: 82, shift: false });
  });

  it("a capital is the same key with shift, not a key of its own", () => {
    expect(keyUsage("A")).toEqual({ usage: 4, shift: true });
    expect(keyUsage("?")).toEqual({ usage: 56, shift: true });
    expect(keyUsage("/")).toEqual({ usage: 56, shift: false });
  });

  it("sends nothing at all for a key that is not on the layout", () => {
    // THE zero-usage mutant: fall through to 0. Usage 0 is "no event" in HID and some stacks read it
    // as an error — either way it is a keystroke the user typed and the device never saw, with no
    // sign that anything went wrong.
    for (const key of ["é", "Meta", "F5", "Dead", "🙂"]) expect(keyUsage(key), key).toBeNull();
    expect(keystrokeFrames("é")).toEqual([]);
  });

  it("wraps a shifted character in its shift, in the order a keyboard sends it", () => {
    const frames = keystrokeFrames("A").map(read);
    expect(frames).toEqual([
      { opcode: 6, body: { type: "down", usage: SHIFT_USAGE } },
      { opcode: 6, body: { type: "down", usage: 4 } },
      { opcode: 6, body: { type: "up", usage: 4 } },
      { opcode: 6, body: { type: "up", usage: SHIFT_USAGE } },
    ]);
    // …and an unshifted one is two frames, not four: a stray shift-up would clear a shift the user
    // is holding for the next character.
    expect(keystrokeFrames("a")).toHaveLength(2);
  });
});

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
