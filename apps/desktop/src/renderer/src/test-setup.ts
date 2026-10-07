import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { forgetAllScroll } from "./panes/scroll-memory";
afterEach(cleanup);

// The scroll marks are module-level by design — they have to outlive the unmount a space switch
// causes (panes/scroll-memory.ts) — which means they also outlive a test. Cleared here so that one
// test's reading position can never decide the next one's first paint.
afterEach(forgetAllScroll);

// jsdom has no ResizeObserver, and every anchored surface (`useAnchoredPopover`) now constructs one
// to re-place itself when its content changes height. An inert default: jsdom reports no layout, so
// a real implementation would have nothing to report anyway. Suites that assert on observer traffic
// still stubGlobal their own over this one.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

// Same story for IntersectionObserver, which the Library's pager uses to ask for its next page when
// the end of the list comes into view. Inert by default and, unlike ResizeObserver, that inertness
// is the USEFUL default here: jsdom lays nothing out, so a faithful implementation would have to
// decide whether an unlaid-out sentinel is on screen, and "never intersects" is the answer that
// keeps a test's assertions about the first page honest. A suite that wants a second page fires the
// callback itself.
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
    root = null; rootMargin = ""; thresholds = [];
  } as unknown as typeof IntersectionObserver;
}

// jsdom implements Range but not its geometry: `getBoundingClientRect` is simply absent, so code
// that measures a selection throws here rather than reading a zero. The zero rect is the honest
// stand-in — jsdom lays nothing out, so there is no rect to report — and it is what makes the
// selection bar mountable in a suite at all. Nothing asserts on placement from it: that arithmetic
// is tested as pure numbers in `selection-bar.test.ts`, and against the real window in
// `selection-bar-live.mjs`.
// Guarded on `Range` existing at all, not only on the method: this setup file also runs for the
// main-process suites, which declare the `node` environment and have no DOM globals whatsoever.
if ("Range" in globalThis && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = (() => Object.assign([], { item: () => null })) as unknown as Range["getClientRects"];
}
