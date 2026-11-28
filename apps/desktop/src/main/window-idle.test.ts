import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WindowIdle, busySpaces, canBeSeen, fullyCovered, pageLoaded, sharesRenderer, wakesWindows, type IdleKeep, type Sight } from "./window-idle";

const HOUR = 60 * 60_000;

function setup(o: { keep?: (id: number) => IdleKeep | null; refuse?: (id: number) => IdleKeep | null } = {}) {
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
    unload: async (w) => {
      const refused = o.refuse?.(w.id) ?? null;
      if (refused === null) unloaded.push(w.id);
      return refused;
    },
    load: async (w) => { loaded.push(w.id); },
  });
  /** A window opened after the others: the one used last, which no sweep unloads. */
  const front = () => { const f = win(100); idle.opened(f); return f; };
  return { idle, win, front, unloaded, loaded, wins, at: (ms: number) => { now = ms; } };
}

describe("a window nobody has focused for hours", () => {
  it("unloads once it has gone the idle window without focus, and not a moment before", async () => {
    const { idle, win, front, unloaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    front();
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
    const { idle, win, front, unloaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    const f = front();
    at(3 * HOUR);
    await idle.focused(a);
    await idle.focused(f);
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([]);
    at(7 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });

  it("counts from when it was last in front or had the keyboard, not from when it was focused", async () => {
    let reason: IdleKeep | null = "front";
    const { idle, win, front, unloaded, at } = setup({ keep: (id) => (id === 1 ? reason : null) });
    const a = win(1);
    idle.opened(a);
    const b = win(2);
    idle.opened(b);
    const f = front();
    // In front for five hours, then another window comes forward.
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    reason = null;
    at(5 * HOUR + 60_000);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([2]);
    // Left by a blur rather than seen in front by a sweep: the same.
    const c = win(3);
    idle.opened(c);
    await idle.focused(f);
    at(8 * HOUR);
    idle.blurred(c);
    at(9 * HOUR + 60_000);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([2, 1]);
  });

  it("comes back on focus, once, and counts afresh from there", async () => {
    const { idle, win, front, unloaded, loaded, at } = setup();
    const a = win(1);
    idle.opened(a);
    const f = front();
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    await idle.focused(a);
    await idle.focused(a);
    expect(loaded).toEqual([1]);
    expect(idle.isUnloaded(a)).toBe(false);
    await idle.focused(f);
    at(8 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
    at(10 * HOUR);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1, 1]);
  });

  it("comes back after an unload still under way has finished, never before it", async () => {
    let finish!: () => void;
    const order: string[] = [];
    let now = 0;
    const a = { id: 1, isDestroyed: () => false };
    const b = { id: 2, isDestroyed: () => false };
    const idle = new WindowIdle<typeof a>({
      now: () => now, keep: () => null,
      unload: () => new Promise<IdleKeep | null>((resolve) => { finish = () => { order.push("unloaded"); resolve(null); }; }),
      load: async () => { order.push("loaded"); },
    });
    idle.opened(a);
    idle.opened(b);
    now = 5 * HOUR;
    const sweep = idle.sweep(4 * HOUR);
    const back = idle.focused(a);
    finish();
    await Promise.all([sweep, back]);
    expect(order).toEqual(["unloaded", "loaded"]);
  });

  it("focused while it was still saving its view, keeps the page it has rather than loading a fresh one", async () => {
    // THE MUTANT: a focus during the save step reloading a page whose renderer never ended.
    let finish!: (kept: IdleKeep | null) => void;
    const loaded: number[] = [];
    let now = 0;
    const a = { id: 1, isDestroyed: () => false };
    const b = { id: 2, isDestroyed: () => false };
    const idle = new WindowIdle<typeof a>({
      now: () => now, keep: () => null,
      unload: () => new Promise<IdleKeep | null>((resolve) => { finish = resolve; }),
      load: async (w) => { loaded.push(w.id); },
    });
    idle.opened(a);
    idle.opened(b);
    now = 5 * HOUR;
    const sweep = idle.sweep(4 * HOUR);
    const back = idle.focused(a);
    finish("focused");
    const swept = await sweep;
    await back;
    expect(loaded).toEqual([]);
    expect(swept).toEqual({ unloaded: [], kept: [{ id: 1, reason: "focused" }, { id: 2, reason: "last" }] });
    expect(idle.isUnloaded(a)).toBe(false);
  });

  it("is never unloaded while focused, in front, seen on another display, driven by an agent, playing audio, listening or sharing its renderer", async () => {
    const reasons: Record<number, IdleKeep> = { 1: "focused", 2: "front", 3: "agent", 4: "working", 5: "audio", 6: "listening", 7: "visible", 8: "shared" };
    const { idle, win, unloaded, at } = setup({ keep: (id) => reasons[id] ?? null });
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) idle.opened(win(id));
    at(5 * HOUR);
    const swept = await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([9]);
    expect(swept.kept).toEqual([
      { id: 1, reason: "focused" }, { id: 2, reason: "front" }, { id: 3, reason: "agent" },
      { id: 4, reason: "working" }, { id: 5, reason: "audio" }, { id: 6, reason: "listening" },
      { id: 7, reason: "visible" }, { id: 8, reason: "shared" }, { id: 10, reason: "last" },
    ]);
  });

  it("stays loaded when its page says it holds work not saved anywhere, and asks again next sweep", async () => {
    // THE MUTANT: a page's refusal ignored, its unsent prompt lost with its renderer.
    let refusing = true;
    const { idle, win, front, unloaded, at } = setup({ refuse: (id) => (id === 1 && refusing ? "unsaved" : null) });
    const a = win(1);
    idle.opened(a);
    front();
    at(5 * HOUR);
    expect(await idle.sweep(4 * HOUR)).toEqual({ unloaded: [], kept: [{ id: 1, reason: "unsaved" }, { id: 100, reason: "last" }] });
    expect(idle.isUnloaded(a)).toBe(false);
    refusing = false;
    at(5 * HOUR + 60_000);
    expect((await idle.sweep(4 * HOUR)).unloaded).toEqual([1]);
  });

  it("never unloads the window used last, minimised or hidden, so a toast still has a page to ask for it", async () => {
    // THE MUTANT: the only window minimised past the idle window, unloaded, and every toast lost.
    const { idle, win, unloaded, at } = setup();
    const only = win(1);
    idle.opened(only);
    at(100 * HOUR);
    expect(await idle.sweep(4 * HOUR)).toEqual({ unloaded: [], kept: [{ id: 1, reason: "last" }] });
    // Another window used since: the first is no longer the one used last.
    const other = win(2);
    idle.opened(other);
    await idle.focused(other);
    at(105 * HOUR);
    expect((await idle.sweep(4 * HOUR)).unloaded).toEqual([1]);
    expect(unloaded).toEqual([1]);
    expect(idle.loadedCount([only, other])).toBe(1);
  });

  it("unloads nothing with no idle window (Never, or Unload idle windows off), and forgets a closed window", async () => {
    const { idle, win, front, unloaded, wins, at } = setup();
    const a = win(1);
    const b = win(2);
    idle.opened(a);
    idle.opened(b);
    front();
    at(100 * HOUR);
    await idle.sweep(null);
    expect(unloaded).toEqual([]);
    wins.get(2)!.destroyed = true;
    idle.closed(b);
    await idle.sweep(4 * HOUR);
    expect(unloaded).toEqual([1]);
  });
});

describe("an unloaded window whose space starts work", () => {
  it("loads at once, without waiting for a sweep or a focus", async () => {
    // THE MUTANT: nothing reloads it, and every browser_* call in that space answers "pane not open".
    const { idle, win, front, loaded, at } = setup();
    const a = win(1);
    const b = win(2);
    idle.opened(a);
    idle.opened(b);
    front();
    at(5 * HOUR);
    await idle.sweep(4 * HOUR);
    const space = new Map([[1, "sp-a"], [2, "sp-b"]]);
    await Promise.all(idle.wakeWhere((w) => space.get(w.id) === "sp-b"));
    expect(loaded).toEqual([2]);
    expect(idle.isUnloaded(a)).toBe(true);
    expect(idle.isUnloaded(b)).toBe(false);
  });

  it("is asked for when a session starts working or waits on you, and names the spaces with work", () => {
    expect(wakesWindows({ sessionId: "s", status: "running" })).toBe(true);
    expect(wakesWindows({ sessionId: "s", status: "waiting_permission" })).toBe(true);
    expect(wakesWindows({ sessionId: "s", status: "idle" })).toBe(false);
    expect(wakesWindows(null)).toBe(false);
    expect([...busySpaces([
      { spaceId: "sp-a", status: "running" }, { spaceId: "sp-b", status: "idle" }, { spaceId: "sp-c", status: "waiting_permission" }, { spaceId: "sp-a", status: "running" },
    ])]).toEqual(["sp-a", "sp-c"]);
  });
});

describe("waiting for a window's page to come back", () => {
  it("waits until the page loads, fails to, or goes, and no longer than its timeout", async () => {
    // THE MUTANT: only did-finish-load ends the wait, so a page that fails or dies holds it forever.
    const wc = new EventEmitter();
    const finished = pageLoaded(wc, 60_000);
    wc.emit("did-finish-load");
    expect(await finished).toBe("loaded");
    const failed = pageLoaded(wc, 60_000);
    wc.emit("did-fail-load", {}, -2, "x", "http://x/", false);
    wc.emit("did-fail-load", {}, -2, "x", "http://x/", true);
    expect(await failed).toBe("failed");
    const gone = pageLoaded(wc, 60_000);
    wc.emit("destroyed");
    expect(await gone).toBe("gone");
    expect(await pageLoaded(wc, 5)).toBe("timeout");
    expect(wc.eventNames()).toEqual([]);
  });

  it("is what a raise waits for, until the page has finished loading", async () => {
    // THE MUTANT: the session to open sent to a page still loading.
    let done!: () => void;
    const order: string[] = [];
    let now = 0;
    const a = { id: 1, isDestroyed: () => false };
    const b = { id: 2, isDestroyed: () => false };
    const idle = new WindowIdle<typeof a>({
      now: () => now, keep: () => null, unload: async () => null,
      load: () => new Promise<void>((resolve) => { done = () => { order.push("loaded"); resolve(); }; }),
    });
    idle.opened(a);
    idle.opened(b);
    now = 5 * HOUR;
    await idle.sweep(4 * HOUR);
    void idle.focused(a);
    expect(idle.isLoading(a)).toBe(true);
    const awake = idle.awake(a).then(() => order.push("awake"));
    await Promise.resolve();
    done();
    await awake;
    expect(order).toEqual(["loaded", "awake"]);
    expect(idle.isLoading(a)).toBe(false);
  });
});

describe("what main reads of a window before unloading it", () => {
  it("knows a renderer another page shares, which ending would end that page too", () => {
    const wc = (id: number, pid: number, destroyed = false) => ({ id, getOSProcessId: () => pid, isDestroyed: () => destroyed });
    const mine = wc(1, 500);
    expect(sharesRenderer(mine, [mine, wc(2, 600)])).toBe(false);
    expect(sharesRenderer(mine, [mine, wc(2, 500)])).toBe(true);
    expect(sharesRenderer(mine, [mine, wc(2, 500, true)])).toBe(false);
  });

  it("knows a window on another display from the one in front, which someone may be looking at", () => {
    const sight = (o: Partial<Sight>): Sight => ({ visible: true, minimized: false, display: 2, frame: null, ...o });
    expect(canBeSeen(sight({}), 1)).toBe(true);
    expect(canBeSeen(sight({ minimized: true }), 1)).toBe(false);
    expect(canBeSeen(sight({ visible: false }), 1)).toBe(false);
  });

  it("knows a window wholly under the windows above it, and one with any part showing", () => {
    const win = { x: 100, y: 100, width: 1200, height: 800 };
    expect(fullyCovered(win, [])).toBe(false);
    expect(fullyCovered(win, [{ x: 0, y: 0, width: 2000, height: 2000 }])).toBe(true);
    expect(fullyCovered(win, [{ x: 100, y: 100, width: 1200, height: 800 }])).toBe(true);
    // Two windows that tile it between them, neither alone.
    expect(fullyCovered(win, [{ x: 0, y: 0, width: 700, height: 2000 }, { x: 700, y: 0, width: 1000, height: 2000 }])).toBe(true);
    // A window cascaded 30 points down and right of it: its title bar and left edge still show.
    expect(fullyCovered(win, [{ x: 130, y: 130, width: 1200, height: 800 }])).toBe(false);
    // A strip one point wide, between two windows that cover the rest.
    expect(fullyCovered(win, [{ x: 0, y: 0, width: 700, height: 2000 }, { x: 701, y: 0, width: 1000, height: 2000 }])).toBe(false);
    // Covered top and bottom but not across its middle.
    expect(fullyCovered(win, [{ x: 0, y: 0, width: 2000, height: 450 }, { x: 0, y: 460, width: 2000, height: 1000 }])).toBe(false);
    expect(fullyCovered(win, [{ x: 1300, y: 100, width: 500, height: 800 }])).toBe(false);
  });
});

describe("a window that can be seen stays loaded past the idle window", () => {
  const front = { x: 200, y: 150, width: 1200, height: 800 };
  const back = { x: 100, y: 100, width: 1200, height: 800 };
  const run = async (sight: Sight) => {
    const s = setup({ keep: (id) => (id === 1 && canBeSeen(sight, 1) ? "visible" : null) });
    const w = s.win(1);
    s.idle.opened(w);
    s.front();
    s.at(5 * HOUR);
    const out = await s.idle.sweep(4 * HOUR);
    return { unloaded: s.unloaded.includes(1), kept: out.kept.find((k) => k.id === 1)?.reason ?? null };
  };
  const sight = (o: Partial<Sight>): Sight => ({ visible: true, minimized: false, display: 1, frame: { onScreen: true, bounds: back, above: [front] }, ...o });

  it("keeps a window partly covered by the one in front on the same display", async () => {
    expect(await run(sight({}))).toEqual({ unloaded: false, kept: "visible" });
  });

  it("unloads one wholly covered by the windows above it", async () => {
    expect(await run(sight({ frame: { onScreen: true, bounds: back, above: [front, { x: 0, y: 0, width: 400, height: 1200 }, { x: 0, y: 0, width: 1600, height: 200 }] } }))).toEqual({ unloaded: true, kept: null });
  });

  it("unloads one minimised", async () => {
    expect(await run(sight({ minimized: true, frame: { onScreen: false, bounds: back, above: [] } }))).toEqual({ unloaded: true, kept: null });
  });

  it("unloads one on another Space, which macOS lists off screen", async () => {
    expect(await run(sight({ frame: { onScreen: false, bounds: back, above: [] } }))).toEqual({ unloaded: true, kept: null });
  });

  it("keeps one on another display from the one in front, covered or not, as before", async () => {
    expect(await run(sight({ display: 2 }))).toEqual({ unloaded: false, kept: "visible" });
    expect(await run(sight({ display: 2, frame: { onScreen: true, bounds: back, above: [{ x: 0, y: 0, width: 2000, height: 2000 }] } }))).toEqual({ unloaded: false, kept: "visible" });
  });

  it("keeps one on screen when there is no look at what covers it", async () => {
    expect(await run(sight({ frame: null }))).toEqual({ unloaded: false, kept: "visible" });
  });
});
