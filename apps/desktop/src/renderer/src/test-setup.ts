import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(cleanup);

// jsdom has no ResizeObserver, and every anchored surface (`useAnchoredPopover`) now constructs one
// to re-place itself when its content changes height. An inert default: jsdom reports no layout, so
// a real implementation would have nothing to report anyway. Suites that assert on observer traffic
// still stubGlobal their own over this one.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}
