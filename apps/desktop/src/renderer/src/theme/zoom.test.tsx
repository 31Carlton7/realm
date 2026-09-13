import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ZOOM_VAR, applyZoom, currentZoom, useZoom } from "./zoom";

const root = () => document.documentElement;
const zoomVar = () => root().style.getPropertyValue(ZOOM_VAR);

/** A renderer with a preload bridge that answers `factor`. */
const bridge = (factor: unknown) => vi.stubGlobal("realm", { zoomFactor: () => factor });

function Probe() {
  useZoom();
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  root().style.removeProperty(ZOOM_VAR);
});

describe("currentZoom", () => {
  it("reads the factor the window is actually at", () => {
    bridge(0.8);
    expect(currentZoom()).toBe(0.8);
  });

  it("is 1 wherever nothing can say", () => {
    /* A browser, a test, a renderer whose preload did not load. 1 is not a guess — it is the
       behaviour every length had before anything asked, so the app reads exactly as it did. */
    vi.stubGlobal("realm", {});
    expect(currentZoom()).toBe(1);
  });

  it("refuses an answer that would collapse everything derived from it", () => {
    /* THE MUTANT: trust the bridge. `--prompter-w` multiplies by this, and a 0, a negative or a NaN
       is a prompter with no width — a pane with no prompter in it, from one bad reading. */
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.8", null, undefined]) {
      bridge(bad);
      expect(currentZoom(), String(bad)).toBe(1);
    }
  });
});

describe("applyZoom", () => {
  it("writes the factor where the stylesheet reads it, rounded", () => {
    applyZoom(0.6666666666);
    expect(zoomVar()).toBe("0.667");
  });

  it("does not rewrite the property when the factor has not moved", () => {
    // It is written on every resize, and a resize is a stream of events. Re-setting an inherited,
    // registered property invalidates style for the whole document — on every frame of a drag.
    expect(applyZoom(0.8)).toBe(true);
    expect(applyZoom(0.8)).toBe(false);
    expect(applyZoom(0.9)).toBe(true);
  });
});

describe("useZoom", () => {
  it("puts the zoom on the root at mount and keeps it there as the window changes", () => {
    let factor = 1;
    vi.stubGlobal("realm", { zoomFactor: () => factor });
    render(<Probe />);
    expect(zoomVar()).toBe("1");

    /* Chromium fires no zoom event, so `resize` is the signal — a zoom change always changes the
       viewport. THE MUTANT is reading the factor once at mount: ⌘− then does nothing until the next
       reload, which is the same as not shipping this. */
    factor = 0.75;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(zoomVar()).toBe("0.75");
  });

  it("stops listening when the app unmounts", () => {
    let factor = 1;
    vi.stubGlobal("realm", { zoomFactor: () => factor });
    const { unmount } = render(<Probe />);
    unmount();
    factor = 0.5;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(zoomVar()).toBe("1");
  });
});
