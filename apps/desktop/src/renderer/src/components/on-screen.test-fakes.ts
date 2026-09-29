import { vi } from "vitest";

/**
 * Put every observed element on screen, the moment it is observed.
 *
 * jsdom lays nothing out, so the observer test-setup.ts installs never answers — the right default
 * for a pager, and the wrong one for a file card, which holds its picture request until it has been
 * SEEN (`FileCard`). A case about which cards ask for a picture has to say that they are in view,
 * and this is that sentence. `vi.unstubAllGlobals()` puts the inert one back.
 *
 * One copy, because both grids' suites need it: the Library's and the session's file browser.
 */
export function allOnScreen(): void {
  vi.stubGlobal("IntersectionObserver", class {
    readonly cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
}
