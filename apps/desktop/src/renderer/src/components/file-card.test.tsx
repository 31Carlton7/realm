import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { FileCard } from "./FileCard";
import { resetThumbnailCache } from "./use-thumbnail";
import { allOnScreen } from "./on-screen.test-fakes";

beforeEach(() => { resetThumbnailCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The bridge, holding one picture for anything asked of it. */
function bridge() {
  const attachmentThumbnail = vi.fn(async (_path: string, _size?: string) => "data:image/png;base64,AAAA");
  vi.stubGlobal("realm", { attachmentThumbnail });
  return attachmentThumbnail;
}

/** An observer the case answers by hand: `show()` is the card scrolling into view. */
function observerByHand() {
  let show: (() => void) | null = null;
  vi.stubGlobal("IntersectionObserver", class {
    readonly cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
    observe(el: Element) {
      show = () => this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  return () => act(() => { show?.(); });
}

const card = (path: string) => (
  <FileCard path={path} name={path.split("/").pop()!} type="image" title={path} onOpen={() => {}} />
);

describe("a file card's picture", () => {
  it("is not asked for until the card has been on screen", async () => {
    /* A folder listing mounts every card the folder holds — up to four hundred — and a card that asked
       on mount queued a decode in main for each of them, or a QuickLook child process for each phone
       photo, the moment the grid opened. THE MUTANT: pass `ask` as true (or drop the observer), and
       the request goes out before anything has been seen. */
    const asked = bridge();
    const show = observerByHand();
    const { container } = render(card("/space/shot.png"));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).not.toHaveBeenCalled();
    expect(container.querySelector(".library-tile-mark")).not.toBeNull();

    await show();
    await waitFor(() => expect(asked).toHaveBeenCalledWith("/space/shot.png", "card"));
    await waitFor(() => expect(container.querySelector(".library-tile-art[data-thumb] img.library-tile-thumb")).not.toBeNull());
  });

  it("draws a picture it already has on the first frame, without waiting to be seen again", async () => {
    /* Closing the panel and opening it again remounts every card. The picture is in the cache by
       then, and costs nothing to draw — so a card that held it back until the observer answered
       flashed through its glyph on every reopen. THE MUTANT: gate the PATH on having been seen
       (`useThumbnail(seen ? path : null, …)`) instead of gating only the fetch. */
    const asked = bridge();
    allOnScreen();
    render(card("/space/shot.png"));
    await waitFor(() => expect(document.querySelector("img.library-tile-thumb")).not.toBeNull());
    cleanup();
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

    const { container } = render(card("/space/shot.png"));
    expect(container.querySelector("img.library-tile-thumb"), "on the very first render").not.toBeNull();
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
