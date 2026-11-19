import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BACKGROUND_SETTING } from "@realm/contracts";
import { SessionBackdrop } from "../panes/session/HeroBackdrop";
import { setGlassDim } from "./glass-dim";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

vi.mock("./glass-dim", async (actual) => ({ ...(await actual<typeof import("./glass-dim")>()), setGlassDim: vi.fn() }));
vi.mock("../panes/session/chat-backdrop", async (actual) => {
  const canvas = () => Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
  return { ...(await actual<typeof import("../panes/session/chat-backdrop")>()), printed: vi.fn(async () => canvas()), soften: vi.fn(canvas), hush: vi.fn() };
});
vi.mock("../panes/session/hero-backdrop-color", async (actual) => ({
  ...(await actual<typeof import("../panes/session/hero-backdrop-color")>()),
  paintColorBackdrop: vi.fn(async (canvas: HTMLCanvasElement, w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
    return { screenMs: 0, composeMs: 0, cached: false, opacity: 0.7, hushes: [] };
  }),
}));

/* jsdom has no layout, no 2D context and no ResizeObserver (chat-backdrop-resize.test.tsx). */
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const ctx = { fillRect() {}, drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON() {} }) as DOMRect);
  vi.mocked(setGlassDim).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

async function drawn(hero: boolean) {
  const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: "van-gogh" } }));
  await store.getState().boot();
  vi.useFakeTimers();
  const { container } = render(<StoreContext.Provider value={store}><div className="session-pane"><SessionBackdrop sessionId="s1" hero={hero} /></div></StoreContext.Provider>);
  await act(() => vi.advanceTimersByTimeAsync(50));
  return container.querySelector(".session-pane")!;
}

describe("dark glass's dim is measured when the picture is drawn", () => {
  it("off the empty session's picture, at the opacity the guard drew it", async () => {
    // THE mutant: the hook dropped from the empty session's draw, which leaves its glass on the fallback.
    const pane = await drawn(true);
    expect(setGlassDim).toHaveBeenCalledTimes(1);
    const [onPane, source, , , opacity] = vi.mocked(setGlassDim).mock.calls[0]!;
    expect(onPane).toBe(pane);
    expect(source).toBe(pane.querySelector("canvas.hero-backdrop"));
    expect(opacity).toBe(0.7);
  });

  it("off the chat's picture, once it is drawn", async () => {
    // THE mutant: the hook dropped from the chat's draw, which leaves a chat on the empty session's number.
    const pane = await drawn(false);
    expect(setGlassDim).toHaveBeenCalledWith(pane, pane.querySelector("canvas[data-phase=chat]"), expect.anything(), expect.any(Function));
  });
});
