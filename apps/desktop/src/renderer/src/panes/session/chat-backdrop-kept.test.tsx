import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BACKGROUND_SETTING } from "@realm/contracts";
import { HUSHED_KEPT, SessionBackdrop } from "./HeroBackdrop";
import { hushTrack } from "./chat-backdrop";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

vi.mock("./chat-backdrop", async (actual) => {
  const canvas = () => Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
  return { ...(await actual<typeof import("./chat-backdrop")>()), printed: vi.fn(async () => canvas()), soften: vi.fn(canvas), hushTrack: vi.fn() };
});

/* jsdom has no layout and no 2D context: the pane's width is the test's, and every context takes the
   calls a draw makes. */
let width = 1200;
beforeEach(() => {
  width = 1200;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const ctx = { fillRect() {}, drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 4, height: 4 }) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width, height: 800, right: width, bottom: 800, toJSON() {} }) as DOMRect);
  vi.mocked(hushTrack).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

async function open(sessionId: string) {
  const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: "van-gogh" } }));
  await store.getState().boot();
  vi.useFakeTimers();
  const view = render(<StoreContext.Provider value={store}><SessionBackdrop sessionId={sessionId} hero={false} /></StoreContext.Provider>);
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.container.querySelector("canvas[data-phase=chat]")?.hasAttribute("data-drawn")).toBe(true);
  view.unmount();
  vi.useRealTimers();
}

describe("the chat's picture on a switch to another session", () => {
  it("puts back the picture already hushed for that size and face, and hushes a new size afresh", async () => {
    width = 1100;
    await open("s1");
    expect(hushTrack).toHaveBeenCalledTimes(1);
    await open("s2");
    expect(hushTrack).toHaveBeenCalledTimes(1);
    width = 1000;
    await open("s2");
    expect(hushTrack).toHaveBeenCalledTimes(2);
  });

  it("keeps the last few pictures, not every one", async () => {
    for (let i = 0; i <= HUSHED_KEPT; i++) {
      width = 700 + i * 10;
      await open("s1");
    }
    expect(hushTrack).toHaveBeenCalledTimes(HUSHED_KEPT + 1);
    width = 700 + HUSHED_KEPT * 10;
    await open("s1");
    expect(hushTrack).toHaveBeenCalledTimes(HUSHED_KEPT + 1);
    width = 700;
    await open("s1");
    expect(hushTrack).toHaveBeenCalledTimes(HUSHED_KEPT + 2);
  });
});
