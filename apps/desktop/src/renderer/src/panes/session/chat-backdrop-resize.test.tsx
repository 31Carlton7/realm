import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BACKGROUND_SETTING } from "@realm/contracts";
import { SessionBackdrop, RESIZE_QUIET_MS } from "./HeroBackdrop";
import { printed } from "./chat-backdrop";
import { paintColorBackdrop } from "./hero-backdrop-color";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

vi.mock("./chat-backdrop", async (actual) => {
  const canvas = () => Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
  return { ...(await actual<typeof import("./chat-backdrop")>()), printed: vi.fn(async () => canvas()), soften: vi.fn(canvas), hush: vi.fn() };
});

vi.mock("./hero-backdrop-color", async (actual) => ({
  ...(await actual<typeof import("./hero-backdrop-color")>()),
  paintColorBackdrop: vi.fn(async (canvas: HTMLCanvasElement, w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
    return { screenMs: 0, composeMs: 0, cached: false, opacity: 1, hushes: [] };
  }),
}));

/* jsdom has no layout, no 2D context and no ResizeObserver: the pane's width is the test's, every
   context is one that takes the calls a draw makes, and the observer is fired by hand. */
let width = 1200;
let observers: ResizeObserverCallback[] = [];
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() { observers.push(this.cb); }
  disconnect() {}
  unobserve() {}
}
const resizeTo = (w: number) => {
  width = w;
  for (const cb of observers) cb([], {} as ResizeObserver);
};

beforeEach(() => {
  width = 1200;
  observers = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  const ctx = { fillRect() {}, drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width, height: 800, right: width, bottom: 800, toJSON() {} }) as DOMRect);
  vi.mocked(printed).mockClear();
  vi.mocked(paintColorBackdrop).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("the chat's picture while the window is dragged", () => {
  it("holds its last frame through the drag and draws once when the size holds still", async () => {
    const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: "van-gogh" } }));
    await store.getState().boot();
    vi.useFakeTimers();
    const { container } = render(<StoreContext.Provider value={store}><SessionBackdrop sessionId="s1" hero={false} /></StoreContext.Provider>);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(container.querySelector("canvas[data-phase=chat]")?.hasAttribute("data-drawn")).toBe(true);
    expect(printed).toHaveBeenCalledTimes(1);

    // An edge drag: a new size every frame for a second.
    for (let i = 1; i <= 60; i++) {
      resizeTo(1200 - i * 5);
      await act(() => vi.advanceTimersByTimeAsync(16));
    }
    expect(printed).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(RESIZE_QUIET_MS + 50));
    expect(printed).toHaveBeenCalledTimes(2);
    expect(vi.mocked(printed).mock.calls[1]?.[3]).toBe(Math.round(900 * Math.min(window.devicePixelRatio || 1, 2)));
  });
});

describe("the empty session's picture while the window is dragged", () => {
  it("holds its last frame through the drag and paints once when the size holds still", async () => {
    const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: "van-gogh" } }));
    await store.getState().boot();
    vi.useFakeTimers();
    render(<StoreContext.Provider value={store}><SessionBackdrop sessionId="s1" hero /></StoreContext.Provider>);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(paintColorBackdrop).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 60; i++) {
      resizeTo(1200 - i * 5);
      await act(() => vi.advanceTimersByTimeAsync(16));
    }
    expect(paintColorBackdrop).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(RESIZE_QUIET_MS + 50));
    expect(paintColorBackdrop).toHaveBeenCalledTimes(2);
    expect(vi.mocked(paintColorBackdrop).mock.calls[1]?.[1]).toBe(Math.round(900 * Math.min(window.devicePixelRatio || 1, 2)));
  });
});
