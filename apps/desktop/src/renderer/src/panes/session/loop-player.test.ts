import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopMayPlay, loopStats, NO_WRAP, pickSource, refreshLoops, resetLoops, watchLoop, wrapTracker, type Gate, type Viewer, type Wrap } from "./loop-player";

describe("when a loop may play", () => {
  const open: Gate = { motion: true, reduce: false, quiet: null, lowPowerMode: false, hidden: false, covered: false, displayAsleep: false, screenLocked: false };

  it("plays with Motion on and nothing holding it still", () => {
    expect(loopMayPlay(open)).toBe(true);
    // An idle or unfocused window still shows its background moving: only Low power's "always" stops it.
    expect(loopMayPlay({ ...open, quiet: "idle" })).toBe(true);
    expect(loopMayPlay({ ...open, quiet: "unfocused" })).toBe(true);
  });

  it("stops for the Motion switch, Reduce motion, Low power, macOS Low Power Mode, a hidden or covered window, asleep displays and a locked screen", () => {
    for (const held of [{ motion: false }, { reduce: true }, { quiet: "always" }, { lowPowerMode: true }, { hidden: true }, { covered: true }, { displayAsleep: true }, { screenLocked: true }]) {
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

describe("the dissolve over a loop's wrap", () => {
  const FPS = 24, LAST = 239;
  const at = (i: number) => i / FPS;

  it("starts on the first frame whose media time goes back, a frame step in, and fades the held frame out over a third of a second", () => {
    const track = wrapTracker(() => 1 / 3);
    const before = Array.from({ length: LAST + 1 }, (_, i) => track(at(i)));
    expect(before.every((w) => w === NO_WRAP)).toBe(true);
    const after = Array.from({ length: 12 }, (_, i) => track(at(i)));
    expect(after.map((w) => w.wrapped)).toEqual([true, ...Array(11).fill(false)]);
    // Frame 0 is one step of eight in: the held frame never shows on its own, and is gone at frame 7.
    expect(after.map((w) => +w.held.toFixed(4))).toEqual([0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125, 0, 0, 0, 0, 0]);
    expect(after.slice(8)).toEqual(Array(4).fill(NO_WRAP));
  });

  it("goes by media time, so a dropped frame skips ahead and a repeated one holds where it is", () => {
    const track = wrapTracker(() => 1 / 3);
    // The last frame presented twice still leaves frame 0 a whole step in.
    for (const i of [...Array(LAST + 1).keys(), LAST]) track(at(i));
    const w = [0, 2, 2, 3].map((i) => track(at(i)).held);
    expect(w.map((v) => +v.toFixed(4))).toEqual([0.875, 0.625, 0.625, 0.5]);
  });

  it("dissolves again at every wrap, and not at all when its length is 0", () => {
    let len = 1 / 3;
    const track = wrapTracker(() => len);
    for (let loop = 0; loop < 3; loop++) for (let i = 0; i <= LAST; i++) {
      const w = track(at(i));
      if (loop > 0 && i === 0) expect([w.wrapped, +w.held.toFixed(4)]).toEqual([true, 0.875]);
    }
    len = 0;
    expect(track(at(0))).toEqual({ wrapped: true, held: 0 });
    expect(track(at(1))).toBe(NO_WRAP);
  });
});

/** jsdom has no media pipeline or IntersectionObserver: the video's methods and the observer are
 *  stood in for, and a frame is presented by hand. */
describe("the window's one loop", () => {
  let frames: ((now: number, meta: { mediaTime: number }) => void)[] = [];
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
    vproto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb: (now: number, meta: { mediaTime: number }) => void) {
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
    for (const a of ["data-window-covered", "data-display-asleep", "data-screen-locked"]) document.documentElement.removeAttribute(a);
    document.body.innerHTML = "";
  });

  let mediaTime = 0;
  const present = (t = (mediaTime += 1 / 24)) => { mediaTime = t; const due = frames; frames = []; for (const f of due) f(0, { mediaTime: t }); };
  let motion = true;
  function viewer(url: string, focusable = false) {
    const pane = document.createElement("div");
    const canvas = document.createElement("canvas");
    pane.appendChild(canvas);
    if (focusable) { const input = document.createElement("textarea"); pane.appendChild(input); }
    document.body.appendChild(pane);
    const v = { drawn: 0, showing: false, wraps: [] as Wrap[] };
    const spec: Viewer = {
      source: { kind: "video", url }, pane, canvas, motion: () => motion,
      frame: (_src, _w, _h, wrap) => { v.drawn++; v.wraps.push(wrap); }, showing: (on) => { v.showing = on; },
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

  it("tells every viewer of the loop where each frame stands against the wrap, from the frame's media time", () => {
    motion = true;
    const a = viewer("/sky.mp4"), b = viewer("/sky.mp4");
    for (const t of [9.875, 9.917, 9.958, 0, 0.042]) present(t);
    for (const v of [a, b]) {
      expect(v.state.wraps.map((w) => w.wrapped)).toEqual([false, false, false, true, false]);
      expect(v.state.wraps.map((w) => +w.held.toFixed(2))).toEqual([0, 0, 0, 0.88, 0.75]);
    }
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

  for (const [what, attr] of [["its displays are all asleep", "data-display-asleep"], ["the screen is locked", "data-screen-locked"]] as const) {
    it(`lets its decoder go while ${what}, and plays again after`, async () => {
      motion = true;
      const a = viewer("/a.mp4");
      present();
      expect([loopStats().decoders, a.state.showing]).toEqual([1, true]);
      document.documentElement.setAttribute(attr, "");
      await vi.advanceTimersByTimeAsync(0);
      expect([loopStats().decoders, a.state.showing]).toEqual([0, false]);
      document.documentElement.removeAttribute(attr);
      await vi.advanceTimersByTimeAsync(0);
      expect(loopStats().decoders).toBe(1);
    });
  }
});
