import { describe, expect, it } from "vitest";
import { WindowIdle, backgroundThrottled, type IdleKeep } from "./window-idle";

const HOUR = 60 * 60_000;

function setup(o: { keep?: (id: number) => IdleKeep | null } = {}) {
  let now = 0;
  const unloaded: number[] = [];
  const loaded: number[] = [];
  const wins = new Map<number, { id: number; destroyed: boolean; isDestroyed(): boolean }>();
  const win = (id: number) => {
    const w = { id, destroyed: false, isDestroyed: () => w.destroyed };
    wins.set(id, w);
    return w;
  };
  const idle = new WindowIdle<ReturnType<typeof win>>({
    now: () => now,
    keep: (w) => o.keep?.(w.id) ?? null,
    unload: async (w) => { unloaded.push(w.id); },
    load: (w) => { loaded.push(w.id); },
  });
  return { idle, win, unloaded, loaded, wins, at: (ms: number) => { now = ms; } };
}

describe("a window nobody has focused for hours", () => {
  it("unloads once it has gone the idle window without focus, and not a moment before", async () => {
    const { idle, win, unloaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    at(4 * HOUR - 1);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([]);
    at(4 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
    expect(idle.isUnloaded(a)).toBe(true);
    // Already unloaded: the next sweep leaves it be.
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });

  it("counts from the last focus, not from when it opened", async () => {
    const { idle, win, unloaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    at(3 * HOUR);
    await idle.focused(a);
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([]);
    at(7 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });

  it("comes back on focus, once, and counts afresh from there", async () => {
    const { idle, win, unloaded, loaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    await idle.focused(a);
    await idle.focused(a);
    expect(loaded).toEqual([1]);
    expect(idle.isUnloaded(a)).toBe(false);
    at(8 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });

  it("comes back after an unload still under way has finished, never before it", async () => {
    let finish!: () => void;
    const order: string[] = [];
    let now = 0;
    const a = { id: 1, isDestroyed: () => false };
    const idle = new WindowIdle<typeof a>({
      now: () => now, keep: () => null,
      unload: () => new Promise<void>((resolve) => { finish = () => { order.push("unloaded"); resolve(); }; }),
      load: () => { order.push("loaded"); },
    });
    idle.opened(a);
    now = 5 * HOUR;
    const sweep = idle.sweep(4 * HOUR);
    const back = idle.focused(a);
    finish();
    await Promise.all([sweep, back]);
    expect(order).toEqual(["unloaded", "loaded"]);
  });

  it("is never unloaded while focused, in front, driven by an agent, playing audio or listening", async () => {
    const reasons: Record<number, IdleKeep> = { 1: "focused", 2: "front", 3: "agent", 4: "working", 5: "audio", 6: "listening" };
    const { idle, win, unloaded, at } = setup({ keep: (id) => reasons[id] ?? null });
    for (const id of [1, 2, 3, 4, 5, 6, 7]) idle.opened(win(id));
    at(5 * HOUR);
    const swept = await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([7]);
    expect(swept.kept).toEqual([
      { id: 1, reason: "focused" }, { id: 2, reason: "front" }, { id: 3, reason: "agent" },
      { id: 4, reason: "working" }, { id: 5, reason: "audio" }, { id: 6, reason: "listening" },
    ]);
  });

  it("unloads nothing with no idle window (Never, or Unload idle windows off), and forgets a closed window", async () => {
    const { idle, win, unloaded, wins, at } = setup();
    const a = win(1);
    const b = win(2);
    idle.opened(a);
    idle.opened(b);
    at(100 * HOUR);
    await idle.sweep(null);
    expect(unloaded).toEqual([]);
    wins.get(2)!.destroyed = true;
    idle.closed(b);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });
});

describe("background throttling, window by window", () => {
  it("is on unless an agent is driving the window or it has live audio", () => {
    const quiet = { unloadIdle: true, agent: false, audio: false, listening: false };
    expect(backgroundThrottled(quiet)).toBe(true);
    expect(backgroundThrottled({ ...quiet, agent: true })).toBe(false);
    expect(backgroundThrottled({ ...quiet, audio: true })).toBe(false);
    expect(backgroundThrottled({ ...quiet, listening: true })).toBe(false);
  });

  it("is off for every window with Unload idle windows switched off, as Realm ran before", () => {
    expect(backgroundThrottled({ unloadIdle: false, agent: false, audio: false, listening: false })).toBe(false);
  });
});
