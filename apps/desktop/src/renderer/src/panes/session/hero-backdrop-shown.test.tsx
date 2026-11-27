import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BACKGROUND_SETTING } from "@realm/contracts";
import { SessionBackdrop } from "./HeroBackdrop";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/* A renderer per WebGL context: what each one drew, and whether it was let go. */
type Fake = { canvas: HTMLCanvasElement; draws: number; destroyed: boolean };
const shaders: Fake[] = [];
const loops: Fake[] = [];

vi.mock("./hero-backdrop", async (actual) => ({
  ...(await actual<typeof import("./hero-backdrop")>()),
  BackdropRenderer: class {
    me: Fake;
    constructor(canvas: HTMLCanvasElement) { this.me = { canvas, draws: 0, destroyed: false }; shaders.push(this.me); }
    async load() { return {} as HTMLImageElement; }
    use() {}
    draw() { this.me.draws++; }
    destroy() { this.me.destroyed = true; }
  },
}));

vi.mock("./loop-gl", async (actual) => ({
  ...(await actual<typeof import("./loop-gl")>()),
  LoopRenderer: class {
    me: Fake;
    constructor(canvas: HTMLCanvasElement) { this.me = { canvas, draws: 0, destroyed: false }; loops.push(this.me); }
    draw() { this.me.draws++; }
    destroy() { this.me.destroyed = true; }
  },
}));

vi.mock("./loop-player", async (actual) => ({ ...(await actual<typeof import("./loop-player")>()), watchLoop: () => () => {} }));

/* Frames come when the test says. */
let frames: FrameRequestCallback[] = [];
const runFrames = (n: number) => {
  for (let i = 0; i < n; i++) {
    const due = frames;
    frames = [];
    act(() => { for (const f of due) f(performance.now() + (i + 1) * 40); });
  }
};

beforeEach(() => {
  shaders.length = 0;
  loops.length = 0;
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((f) => { frames.push(f); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON() {} }) as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const mount = async (look: string, hero: boolean) => {
  const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: look } }));
  await store.getState().boot();
  const tree = (shown: boolean) => <StoreContext.Provider value={store}><div className="session-pane"><SessionBackdrop sessionId="s1" hero={hero} shown={shown} /></div></StoreContext.Provider>;
  const r = render(tree(true));
  await act(async () => {});
  return { ...r, show: (shown: boolean) => r.rerender(tree(shown)) };
};

describe("a backdrop in a pane kept hidden", () => {
  it("stops drawing and lets its WebGL context go, then draws again once shown", async () => {
    const { show } = await mount("haze", true);
    runFrames(5);
    expect(shaders).toHaveLength(1);
    const first = shaders[0]!;
    expect(first.draws).toBeGreaterThan(3);

    show(false);
    expect(first.destroyed).toBe(true);
    const at = first.draws;
    runFrames(10);
    expect(first.draws).toBe(at);
    expect(shaders).toHaveLength(1);

    // Shown again: a new renderer on a new canvas, drawn before the frame is painted, and moving.
    show(true);
    expect(shaders).toHaveLength(2);
    const again = shaders[1]!;
    expect(again.canvas).not.toBe(first.canvas);
    expect(again.draws).toBeGreaterThan(0);
    runFrames(5);
    expect(again.draws).toBeGreaterThan(3);
    expect(again.destroyed).toBe(false);
  });

  it("builds no renderer for a pane mounted hidden", async () => {
    const store = createAppStore(fakeApi({ settings: { [BACKGROUND_SETTING]: "silk" } }));
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><div className="session-pane"><SessionBackdrop sessionId="s1" hero shown={false} /></div></StoreContext.Provider>);
    await act(async () => {});
    runFrames(5);
    expect(shaders).toHaveLength(0);
  });

  it("lets a loop's context go while hidden and builds it again on show", async () => {
    const { show } = await mount("snow-cabin", false);
    expect(loops).toHaveLength(1);
    show(false);
    expect(loops[0]!.destroyed).toBe(true);
    show(true);
    expect(loops).toHaveLength(2);
    expect(loops[1]!.destroyed).toBe(false);
  });
});
