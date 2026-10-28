import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_DISCARD_HIDDEN_KEY, BROWSER_KEEP_HIDDEN_KEY, MCP_IDLE_STOP_KEY } from "@realm/contracts";
import { POLICY_TICK_MS, ResourcePolicies, minutesSetting } from "./policies";

afterEach(() => { vi.useRealTimers(); });

function setup(o: { settings?: Record<string, unknown>; attached?: boolean; slow?: Promise<void> } = {}) {
  const asked: { hiddenMs: number | null; keepHidden: number; policy?: boolean }[] = [];
  const settings = new Map(Object.entries(o.settings ?? {}));
  let attached = o.attached ?? true;
  const p = new ResourcePolicies({
    settings: { get: (k) => settings.get(k) },
    app: () => (attached ? { call: async (_op, params) => { asked.push(params); await o.slow; return { discarded: [], kept: [] }; } } : null),
  });
  return { p, asked, settings, attach: (v: boolean) => { attached = v; } };
}

describe("the browser pane policy", () => {
  it("asks the app every minute to discard panes hidden twenty minutes, keeping the three most recent", async () => {
    vi.useFakeTimers();
    const { p, asked } = setup();
    p.start();
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLICY_TICK_MS);
    expect(asked).toEqual([{ hiddenMs: 20 * 60_000, keepHidden: 3, policy: true }]);
    await vi.advanceTimersByTimeAsync(POLICY_TICK_MS);
    expect(asked).toHaveLength(2);
    p.close();
    await vi.advanceTimersByTimeAsync(POLICY_TICK_MS * 3);
    expect(asked).toHaveLength(2);
  });

  it("follows its settings — Never sent as no window, so main's budget for unmounted panes keeps to it too — and asks nothing with no app attached", async () => {
    const { p, asked, settings, attach } = setup({ settings: { [BROWSER_DISCARD_HIDDEN_KEY]: 45, [BROWSER_KEEP_HIDDEN_KEY]: 1 } });
    await p.tick();
    expect(asked).toEqual([{ hiddenMs: 45 * 60_000, keepHidden: 1, policy: true }]);
    settings.set(BROWSER_DISCARD_HIDDEN_KEY, 0);
    await p.tick();
    expect(asked[1]).toEqual({ hiddenMs: null, keepHidden: 1, policy: true });
    attach(false);
    settings.set(BROWSER_DISCARD_HIDDEN_KEY, 5);
    await p.tick();
    expect(asked).toHaveLength(2);
  });

  it("never runs two sweeps at once while pages are slow to answer", async () => {
    let release!: () => void;
    const { p, asked } = setup({ slow: new Promise<void>((r) => { release = r; }) });
    const first = p.tick();
    await p.tick();
    expect(asked).toHaveLength(1);
    release();
    await first;
  });

  it("reads a setting that is not a whole, non-negative number as the default", () => {
    expect(minutesSetting(12.7, 20)).toBe(12);
    expect(minutesSetting(-1, 20)).toBe(20);
    expect(minutesSetting("10", 20)).toBe(20);
    expect(minutesSetting(0, 20)).toBe(0);
  });
});

describe("the MCP policy", () => {
  it("stops stdio servers idle thirty minutes each tick, sooner when memory is short, never at 0", async () => {
    const asked: number[] = [];
    let adapt = (m: number) => m;
    const settings = new Map<string, unknown>();
    const p = new ResourcePolicies({ settings: { get: (k) => settings.get(k) }, app: () => null, mcp: { sleepIdle: (ms) => { asked.push(ms); return []; } }, adapt: (m) => adapt(m) });
    await p.tick();
    adapt = (m) => Math.min(m, 10);
    await p.tick();
    settings.set(MCP_IDLE_STOP_KEY, 0);
    await p.tick();
    expect(asked).toEqual([30 * 60_000, 10 * 60_000]);
  });

  it("shortens the browser window under pressure too", async () => {
    const { asked } = setup();
    const p = new ResourcePolicies({ settings: { get: () => undefined }, adapt: (m) => Math.min(m, 5), app: () => ({ call: async (_op, params) => { asked.push(params); } }) });
    await p.tick();
    expect(asked).toEqual([{ hiddenMs: 5 * 60_000, keepHidden: 3, policy: true }]);
  });
});
