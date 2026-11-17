import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopMayPlay, loopStats, pickSource, refreshLoops, resetLoops, watchLoop, type Gate, type Viewer } from "./loop-player";

describe("when a loop may play", () => {
  const open: Gate = { motion: true, reduce: false, quiet: null, lowPowerMode: false, hidden: false, covered: false };

  it("plays with Motion on and nothing holding it still", () => {
    expect(loopMayPlay(open)).toBe(true);
    // An idle or unfocused window still shows its background moving: only Low power's "always" stops it.
    expect(loopMayPlay({ ...open, quiet: "idle" })).toBe(true);
    expect(loopMayPlay({ ...open, quiet: "unfocused" })).toBe(true);
  });

  it("stops for the Motion switch, Reduce motion, Low power, macOS Low Power Mode, and a hidden or covered window", () => {
    for (const held of [{ motion: false }, { reduce: true }, { quiet: "always" }, { lowPowerMode: true }, { hidden: true }, { covered: true }]) {
      expect(loopMayPlay({ ...open, ...held })).toBe(false);
    }
  });
});

describe("which loop a window decodes", () => {
  it("is the focused pane's, else the first on screen, and none when nothing is on screen", () => {
    expect(pickSource([{ key: "a", onScreen: true, focused: false }, { key: "b", onScreen: true, focused: true }])).toBe("b");
    expect(pickSource([{ key: "a", onScreen: false, focused: true }, { key: "b", onScreen: true, focused: false }, { key: "c", onScreen: true, focused: false }])).toBe("b");
    expect(pickSource([{ key: "a", onScreen: false, focused: true }])).toBeNull();
    expect(pickSource([])).toBeNull();
  });
});

/** jsdom has no media pipeline or IntersectionObserver: the video's methods and the observer are
 *  stood in for, and a frame is presented by hand. */
describe("the window's one loop", () => {
  let frames: (() => void)[] = [];
  let observed: ((on: boolean, el: Element) => void) | null = null;
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
    proto.play = function (this: HTMLVideoElement) { Object.defineProperty(this, "paused", { value: false, configurable: true }); return Promise.resolve(); };
    proto.pause = function (this: HTMLVideoElement) { Object.defineProperty(this, "paused", { value: true, configurable: true }); };
    proto.load = () => {};
    const vproto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    vproto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb: () => void) {
      Object.defineProperty(this, "videoWidth", { value: 1920, configurable: true });
      Object.defineProperty(this, "videoHeight", { value: 1080, configurable: true });
      frames.push(cb);
      return frames.length;
    };
    vproto.cancelVideoFrameCallback = () => {};
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (e: { target: Element; isIntersecting: boolean }[]) => void) { observed = (on, el) => cb([{ target: el, isIntersecting: on }]); }
      observe() {}
      unobserve() {}
    });
  });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    resetLoops();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-quiet");
    document.documentElement.removeAttribute("data-window-covered");
    document.body.innerHTML = "";
  });

  const present = () => { const due = frames; frames = []; for (const f of due) f(); };
  let motion = true;
  function viewer(url: string, focusable = false) {
    const pane = document.createElement("div");
    const canvas = document.createElement("canvas");
    pane.appendChild(canvas);
    if (focusable) { const input = document.createElement("textarea"); pane.appendChild(input); }
    document.body.appendChild(pane);
    const v = { drawn: 0, showing: false };
    const spec: Viewer = {
      source: { kind: "video", url }, pane, canvas, motion: () => motion,
      frame: () => { v.drawn++; }, showing: (on) => { v.showing = on; },
    };
    cleanups.push(watchLoop(spec));
    observed?.(true, canvas);
    return { ...v, get state() { return v; }, pane, canvas };
  }

  it("decodes one loop for two viewers of it, and draws each frame into both", () => {
    motion = true;
    const a = viewer("/sky.mp4"), b = viewer("/sky.mp4");
    expect(loopStats()).toMatchObject({ decoders: 1, key: "/sky.mp4", viewers: 2 });
    present();
    present();
    expect([a.state.drawn, b.state.drawn]).toEqual([2, 2]);
    expect([a.state.showing, b.state.showing]).toEqual([true, true]);
  });

  it("decodes only the focused pane's loop when two panes ask for different ones; the other shows its still", () => {
    motion = true;
    const a = viewer("/a.mp4");
    const b = viewer("/b.mp4", true);
    expect(loopStats()).toMatchObject({ decoders: 1, key: "/a.mp4" });
    b.pane.querySelector("textarea")!.focus();
    expect(loopStats()).toMatchObject({ decoders: 1, key: "/b.mp4" });
    present();
    expect([a.state.drawn, a.state.showing, b.state.drawn, b.state.showing]).toEqual([0, false, 1, true]);
  });

  it("releases the decoder when its viewers go off screen, and when Motion goes off", () => {
    motion = true;
    const a = viewer("/a.mp4");
    present();
    observed?.(false, a.canvas);
    expect(loopStats()).toMatchObject({ decoders: 0, key: null });
    expect(a.state.showing).toBe(false);
    observed?.(true, a.canvas);
    expect(loopStats().decoders).toBe(1);
    motion = false;
    refreshLoops();
    expect(loopStats().decoders).toBe(0);
  });

  it("stops under Realm's Low power, and plays again after", async () => {
    motion = true;
    const a = viewer("/a.mp4");
    present();
    document.documentElement.setAttribute("data-quiet", "always");
    await vi.advanceTimersByTimeAsync(0);
    expect([loopStats().decoders, a.state.showing]).toEqual([0, false]);
    document.documentElement.setAttribute("data-quiet", "idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(loopStats().decoders).toBe(1);
  });

  it("lets its decoder go while macOS says the window is covered, and asks main to look only while it has a loop", async () => {
    const watch = vi.fn();
    vi.stubGlobal("realm", { watchBackdrop: watch });
    motion = true;
    const a = viewer("/a.mp4");
    present();
    expect(watch.mock.calls).toEqual([[true]]);
    document.documentElement.setAttribute("data-window-covered", "");
    await vi.advanceTimersByTimeAsync(0);
    expect([loopStats().decoders, a.state.showing]).toEqual([0, false]);
    document.documentElement.removeAttribute("data-window-covered");
    await vi.advanceTimersByTimeAsync(0);
    expect(loopStats().decoders).toBe(1);
    cleanups.pop()!();
    expect(watch.mock.calls).toEqual([[true], [false]]);
  });
});
