import { describe, expect, it } from "vitest";
import { CARET_DEFAULT, type CaretPrefs } from "@realm/contracts";
import { atSoftWrap, caretBox, drawnCaret, intersect, nativeCaret, snap, spotBetween, type CaretSpot, type CharBox } from "./caret-geometry";

/** A caret standing before an "m" 9px wide, on a line whose font box is 18px tall. */
const spot: CaretSpot = { x: 100, top: 40, height: 18, glyph: "m", glyphWidth: 9 };

describe("caretBox", () => {
  it("draws a thin line AT the insertion point, the platform's own pixel, and a wider bar centred on it", () => {
    // THE centred-thin-line mutant: half a pixel left of the native caret, which the measuring live
    // check reads as a one-pixel miss on every field in the app.
    expect(caretBox(spot, "line-thin")).toEqual({ left: 100, top: 40, width: 1, height: 18 });
    expect(caretBox(spot, "line")).toEqual({ left: 99, top: 40, width: 2, height: 18 });
    // An odd width can only centre on a retina pixel grid; on a 1x one it leans a pixel right.
    expect(caretBox(spot, "pill", 2)).toEqual({ left: 98.5, top: 40, width: 3, height: 18 });
    expect(caretBox(spot, "beam", 2)).toEqual({ left: 98.5, top: 40, width: 3, height: 18 });
    expect(caretBox(spot, "pill", 1).left).toBe(99);
  });

  it("covers the next character with a block, and runs an underline under it at the foot of the line", () => {
    for (const shape of ["block", "block-soft", "block-outline"] as const) {
      expect(caretBox(spot, shape)).toEqual({ left: 100, top: 40, width: 9, height: 18 });
    }
    expect(caretBox(spot, "underline")).toEqual({ left: 100, top: 56, width: 9, height: 2 });
    expect(caretBox(spot, "underline-thin")).toEqual({ left: 100, top: 57, width: 9, height: 1 });
  });

  it("stands on the device pixel grid, so a one-pixel caret is one pixel and not a smear of two", () => {
    const odd: CaretSpot = { ...spot, x: 100.3, top: 40.4 };
    expect(caretBox(odd, "line-thin", 2)).toEqual({ left: 100.5, top: 40.5, width: 1, height: 18 });
    expect(caretBox(odd, "line-thin", 1)).toEqual({ left: 100, top: 40, width: 1, height: 18 });
    expect(snap(10.26, 2)).toBe(10.5);
  });
});

/** "ab" on one line; the wrap case moves `after` to the next line, 20px down at the left edge. */
const a: CharBox = { left: 50, top: 10, width: 8, height: 18, char: "a" };
const b: CharBox = { left: 58, top: 10, width: 8, height: 18, char: "b" };
const wrapped: CharBox = { left: 0, top: 30, width: 8, height: 18, char: "b" };
const opts = { upstream: false, typicalWidth: 7 };

describe("spotBetween", () => {
  it("is the next character's left edge on a line, and the glyph a block covers", () => {
    expect(spotBetween(a, b, opts)).toEqual({ x: 58, top: 10, height: 18, glyph: "b", glyphWidth: 8 });
  });

  it("follows the last character at the end of a field, with a typical width for a block's body", () => {
    expect(spotBetween(a, null, opts)).toEqual({ x: 58, top: 10, height: 18, glyph: "", glyphWidth: 7 });
  });

  it("stands at the start of the next line after a soft wrap — unless the gesture asked for the end of this one", () => {
    /* THE single-answer mutant either way round. Typing past the edge leaves the caret on the new line;
       End, ⌘→ or a click past the last word leaves it at the end of the old one. A layer that only
       knew one of them would draw the caret a line away from the platform's for the other. */
    expect(atSoftWrap(a, wrapped)).toBe(true);
    expect(atSoftWrap(a, b)).toBe(false);
    expect(spotBetween(a, wrapped, opts)).toMatchObject({ x: 0, top: 30, glyph: "b" });
    expect(spotBetween(a, wrapped, { ...opts, upstream: true })).toMatchObject({ x: 58, top: 10, glyph: "" });
    // On one line the gesture changes nothing: there is only one place to be.
    expect(spotBetween(a, b, { ...opts, upstream: true })).toMatchObject({ x: 58, top: 10, glyph: "b" });
  });

  it("treats a newline and a zero-width space as places, not characters a block could cover", () => {
    const newline: CharBox = { left: 58, top: 10, width: 0, height: 18, char: "\n" };
    const zwsp: CharBox = { left: 58, top: 10, width: 0, height: 18, char: "​" };
    expect(spotBetween(a, newline, opts)).toEqual({ x: 58, top: 10, height: 18, glyph: "", glyphWidth: 7 });
    expect(spotBetween(null, zwsp, opts)).toEqual({ x: 58, top: 10, height: 18, glyph: "", glyphWidth: 7 });
    expect(spotBetween(null, null, opts)).toBeNull();
  });
});

describe("intersect", () => {
  it("is the overlap, or nothing", () => {
    expect(intersect({ left: 0, top: 0, width: 100, height: 50 }, { left: 80, top: 40, width: 40, height: 40 }))
      .toEqual({ left: 80, top: 40, width: 20, height: 10 });
    expect(intersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBeNull();
  });
});

const prefs = (over: Partial<CaretPrefs>): CaretPrefs => ({ ...CARET_DEFAULT, ...over });

describe("drawnCaret", () => {
  it("holds a caret still under reduced motion or low power, and keeps its shape and colour", () => {
    // THE motion-leak mutant: honour the preference for the blink and forget the glide, which is
    // motion too.
    const fancy = prefs({ shape: "pill", animation: "pulse", glide: true, colour: "text" });
    expect(drawnCaret(fancy, true)).toEqual({ shape: "pill", animation: "solid", glide: false, colour: "text" });
    expect(drawnCaret(fancy, false)).toBe(fancy);
  });
});

describe("nativeCaret", () => {
  const none = { shape: false, animation: false };
  const all = { shape: true, animation: true };

  it("leaves a thin blinking line to the platform, which already draws exactly that", () => {
    expect(nativeCaret(prefs({ shape: "line-thin" }), none)).toEqual({ shape: "auto", animation: "auto" });
  });

  it("draws everything else itself on an engine with no caret-shape or caret-animation", () => {
    for (const shape of ["line", "pill", "beam", "block", "block-soft", "block-outline", "underline", "underline-thin"] as const) {
      expect(nativeCaret(prefs({ shape }), none), shape).toBeNull();
    }
    expect(nativeCaret(prefs({ shape: "line-thin", animation: "solid" }), none)).toBeNull();
    expect(nativeCaret(prefs({ shape: "line-thin", animation: "smooth" }), all)).toBeNull();
  });

  it("hands the platform a block, an underline and a still caret where the engine can draw them", () => {
    expect(nativeCaret(prefs({ shape: "block", animation: "solid" }), all)).toEqual({ shape: "block", animation: "manual" });
    expect(nativeCaret(prefs({ shape: "underline" }), all)).toEqual({ shape: "underline", animation: "auto" });
    // A shape it has no word for is still drawn, however capable the engine.
    expect(nativeCaret(prefs({ shape: "block-outline" }), all)).toBeNull();
  });

  it("never lets the platform take a glide, which it cannot do", () => {
    expect(nativeCaret(prefs({ shape: "line-thin", glide: true }), all)).toBeNull();
  });
});
