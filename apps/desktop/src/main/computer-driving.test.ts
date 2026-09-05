import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerDrivingIndicator } from "./computer-driving";

/**
 * The menu-bar indicator's counting and lingering, over a fake tray. Whether a menu-bar item can be
 * built from an empty image is Electron's business and is checked live; what must die here is the
 * indicator claiming the Mac is being driven when it is not, and — the worse direction — failing to
 * say so when it is.
 */
function indicator() {
  const calls: string[] = [];
  let live = 0;
  const inst = new ComputerDrivingIndicator({
    createTray: () => {
      live += 1;
      calls.push("create");
      return {
        setTitle: (t) => calls.push(`title:${t}`),
        setToolTip: (t) => calls.push(`tip:${t}`),
        destroy: () => { live -= 1; calls.push("destroy"); },
      };
    },
  });
  return { inst, calls, trays: () => live };
}

const titles = (calls: string[]): string[] =>
  calls.filter((c) => c.startsWith("title:")).map((c) => c.slice("title:".length));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ComputerDrivingIndicator", () => {
  it("puts an item in the menu bar naming the app being driven", () => {
    const { inst, calls } = indicator();
    inst.acquire("TextEdit");
    expect(inst.showing).toBe(true);
    expect(titles(calls)).toEqual(["Driving TextEdit"]);
    // The title has no room to say who is driving, so the tooltip must.
    expect(calls.find((c) => c.startsWith("tip:"))).toMatch(/Realm is driving TextEdit/);
  });

  it("shows nothing until something is actually driving", () => {
    const { inst, calls } = indicator();
    expect(inst.showing).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stays up until every act in flight has settled", () => {
    // Two sessions can be acting at once. Counted rather than flagged: with a boolean the first
    // settle takes the item down while the second session is still clicking.
    const { inst } = indicator();
    inst.acquire("TextEdit");
    inst.acquire("Calculator");
    inst.release();
    vi.advanceTimersByTime(60_000);
    expect(inst.showing).toBe(true);
    inst.release();
    vi.advanceTimersByTime(60_000);
    expect(inst.showing).toBe(false);
  });

  it("lingers after the last act rather than vanishing the instant it settles", () => {
    const { inst } = indicator();
    inst.acquire("TextEdit");
    inst.release();
    expect(inst.showing).toBe(true);
    vi.advanceTimersByTime(1499);
    expect(inst.showing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(inst.showing).toBe(false);
  });

  it("keeps one item across a run of acts instead of rebuilding it between them", () => {
    // Every appearance and disappearance shifts every menu-bar item to the left of it, so a burst
    // that tore the item down and rebuilt it would move other apps' icons under the cursor.
    const { inst, calls, trays } = indicator();
    for (let i = 0; i < 5; i += 1) {
      inst.acquire("TextEdit");
      inst.release();
      vi.advanceTimersByTime(100);
    }
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(calls.filter((c) => c === "destroy")).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    expect(trays()).toBe(0);
  });

  it("does not let a pending linger tear the item down under a new act", () => {
    // A run of acts spaced further apart than the linger: the second acquire has to cancel the
    // timer the first release armed, or that timer fires mid-act and takes the menu bar item away
    // while the Mac is still being driven — the one direction of this indicator that is a lie.
    const { inst } = indicator();
    inst.acquire("TextEdit");
    inst.release();
    vi.advanceTimersByTime(1000);
    inst.acquire("TextEdit");
    vi.advanceTimersByTime(1000);
    expect(inst.showing).toBe(true);
    inst.release();
    vi.advanceTimersByTime(1500);
    expect(inst.showing).toBe(false);
  });

  it("renames the item when the run moves to another app", () => {
    const { inst, calls } = indicator();
    inst.acquire("TextEdit");
    inst.release();
    inst.acquire("Calculator");
    expect(titles(calls)).toEqual(["Driving TextEdit", "Driving Calculator"]);
  });

  it("drops the item on quit, mid-linger, rather than leaving one behind", () => {
    const { inst, trays } = indicator();
    inst.acquire("TextEdit");
    inst.release();
    inst.dispose();
    expect(inst.showing).toBe(false);
    expect(trays()).toBe(0);
    // The linger is CANCELLED, not merely left harmless. Advancing the clock cannot tell those two
    // apart — `teardown` on an already-null tray is a no-op either way — so the pending count is
    // what actually reads whether quit let go of the timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the item on quit even with acts still in flight", () => {
    const { inst } = indicator();
    inst.acquire("TextEdit");
    inst.dispose();
    expect(inst.showing).toBe(false);
  });

  it("clips a long app name, which shares the menu bar with everything else", () => {
    const { inst, calls } = indicator();
    inst.acquire("Microsoft PowerPoint for Mac");
    expect(titles(calls)).toEqual(["Driving Microsoft PowerPoint…"]);
  });

  it("still names something when the app arrived unnamed", () => {
    const { inst, calls } = indicator();
    inst.acquire("   ");
    expect(titles(calls)).toEqual(["Driving an app"]);
  });

  it("survives more releases than acquires without going negative", () => {
    // A release is emitted from a `finally`, and a future caller pairing them wrongly must not leave
    // the count below zero — where a later act's settle would read as "nothing is running" and take
    // the item down while the OTHER act is still clicking. Two acquires after the deficit is what
    // makes that visible: with the clamp the first settle leaves one in flight, without it the count
    // is still under zero and the item goes.
    const { inst } = indicator();
    inst.release();
    inst.release();
    inst.acquire("TextEdit");
    inst.acquire("Calculator");
    inst.release();
    vi.advanceTimersByTime(1500);
    expect(inst.showing).toBe(true);
    inst.release();
    vi.advanceTimersByTime(1500);
    expect(inst.showing).toBe(false);
  });
});
