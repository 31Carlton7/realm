import { describe, expect, it } from "vitest";
import { STATUS_W, TOOLBAR_BUTTON, TOOLBAR_CHROME, toolbarFit } from "./toolbar-fit";

/**
 * A narrow pane takes the device's toolbar apart in a stated order: the resolution, then the state's
 * word, then the presses from the end. Arithmetic, tested as arithmetic — jsdom lays nothing out — and
 * the rendering half (what leaves arrives in the overflow) is simulator-pane.test.tsx's.
 */
const LIVE = STATUS_W.Live;
const full = (buttons: number) => TOOLBAR_CHROME + LIVE.full + buttons * TOOLBAR_BUTTON;

describe("the device toolbar's ladder", () => {
  it("draws everything where everything fits", () => {
    expect(toolbarFit(full(4), 4)).toEqual({ status: "full", keep: 4 });
    expect(toolbarFit(800, 4)).toEqual({ status: "full", keep: 4 });
  });

  it("gives up the resolution first, then the state's word, before any press", () => {
    // THE MUTANT: buttons first. A press is something a person does; a resolution is only read.
    expect(toolbarFit(full(4) - 1, 4)).toEqual({ status: "word", keep: 4 });
    expect(toolbarFit(TOOLBAR_CHROME + LIVE.word + 4 * TOOLBAR_BUTTON - 1, 4)).toEqual({ status: "dot", keep: 4 });
  });

  it("then the presses, one at a time from the end, and never the dot", () => {
    const dot = (n: number) => TOOLBAR_CHROME + LIVE.dot + n * TOOLBAR_BUTTON;
    expect(toolbarFit(dot(4) - 1, 4)).toEqual({ status: "dot", keep: 3 });
    expect(toolbarFit(dot(1), 4)).toEqual({ status: "dot", keep: 1 });
    expect(toolbarFit(dot(0), 4)).toEqual({ status: "dot", keep: 0 });
    expect(toolbarFit(10, 4)).toEqual({ status: "dot", keep: 0 });
  });

  it("reads 0 as not measured yet, not as a toolbar with no room", () => {
    // Every press into the overflow for the first frame of every mount would read as a flicker.
    expect(toolbarFit(0, 3)).toEqual({ status: "full", keep: 3 });
  });

  it("budgets the word it is showing, so a toolbar still connecting does not clip", () => {
    // THE MUTANT: one width for every word. "Connecting" is a button wider than "Live", and a toolbar
    // budgeted for "Live" ran its overflow off the pill's end for as long as the touch took to come up.
    expect(toolbarFit(full(4), 4, "Connecting")).toEqual({ status: "word", keep: 4 });
    expect(toolbarFit(full(4), 4, "Live")).toEqual({ status: "full", keep: 4 });
  });

  it("orders its rungs, so no two fire together", () => {
    for (const w of Object.values(STATUS_W)) {
      expect(w.full).toBeGreaterThan(w.word);
      expect(w.word).toBeGreaterThan(w.dot);
    }
  });
});
