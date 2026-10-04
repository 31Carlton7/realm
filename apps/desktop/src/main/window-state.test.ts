import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVE_DEBOUNCE_MS, readWindowState, restoredBounds, trackWindowState, windowStateFileName, type SavedWindow } from "./window-state";

const DEFAULTS = { width: 1400, height: 900, minWidth: 900, minHeight: 600 };
const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 };
const MONITOR = { x: 1512, y: -200, width: 2560, height: 1415 };

describe("where the window opens", () => {
  it("opens where it was left", () => {
    const saved: SavedWindow = { x: 1700, y: 0, width: 1800, height: 1100 };
    expect(restoredBounds(saved, [LAPTOP, MONITOR], DEFAULTS)).toEqual({ x: 1700, y: 0, width: 1800, height: 1100, center: false });
  });

  /* THE mutant: trusting the saved place blindly. A window left on a monitor that has since been
     unplugged would open somewhere no pointer can reach. */
  it("brings a window left on a display that is gone back to the main one, keeping its size", () => {
    const saved: SavedWindow = { x: 1700, y: 0, width: 1300, height: 800 };
    expect(restoredBounds(saved, [LAPTOP], DEFAULTS)).toEqual({ x: 0, y: 0, width: 1300, height: 800, center: true });
    // A size the remaining display cannot hold is clamped to it.
    const big: SavedWindow = { x: 1700, y: 0, width: 2400, height: 1300 };
    expect(restoredBounds(big, [LAPTOP], DEFAULTS)).toMatchObject({ width: LAPTOP.width, height: LAPTOP.height, center: true });
  });

  it("keeps a window that is mostly on screen even if an edge hangs off it", () => {
    const saved: SavedWindow = { x: 400, y: 25, width: 1400, height: 900 };
    expect(restoredBounds(saved, [LAPTOP], DEFAULTS).center).toBe(false);
  });

  it("falls back to the defaults on a first launch, and never opens below the minimum size", () => {
    expect(restoredBounds(null, [LAPTOP], DEFAULTS)).toEqual({ x: 0, y: 0, width: 1400, height: 900, center: true });
    expect(restoredBounds({ x: 10, y: 30, width: 200, height: 100 }, [LAPTOP], DEFAULTS)).toMatchObject({ width: 900, height: 600 });
    expect(restoredBounds({ x: Number.NaN, y: 0, width: 1, height: 1 }, [LAPTOP], DEFAULTS).center).toBe(true);
  });
});

describe("remembering it", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reads what it wrote, and treats a missing or garbled file as a first launch", () => {
    const file = join(tempDir("realm-window-state-"), "window-state.json");
    expect(readWindowState(file)).toBeNull();
    writeFileSync(file, "{not json");
    expect(readWindowState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ x: 1, y: 2, width: 3, height: 4, maximized: true }));
    expect(readWindowState(file)).toEqual({ x: 1, y: 2, width: 3, height: 4, maximized: true, fullScreen: false });
  });

  it("writes once a drag settles, and again on close, with the size it returns to from maximised", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    let maximized = false;
    const win = {
      getNormalBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
      isMaximized: () => maximized, isFullScreen: () => false, isDestroyed: () => false,
      on: (ev: string, fn: () => void) => listeners.set(ev, fn),
    };
    const write = vi.fn();
    trackWindowState(win, "/state.json", write);
    for (let i = 0; i < 20; i++) listeners.get("move")!();
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);
    maximized = true;
    listeners.get("maximize")!();
    listeners.get("close")!();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(write.mock.calls[1]![1] as string)).toEqual({ x: 10, y: 20, width: 1200, height: 800, maximized: true, fullScreen: false });
  });
});

describe("windowStateFileName", () => {
  it("keeps the first window's place where it always was, and each profile window's apart", () => {
    /* THE mutant: one file for every window — Work's window opens exactly over the first, and closing
       either moves the other's saved place. */
    expect(windowStateFileName(null)).toBe("window-state.json");
    expect(windowStateFileName("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("window-state-01ARZ3NDEKTSV4RRFFQ69G5FAV.json");
    expect(windowStateFileName("../../etc")).toBe("window-state-etc.json");
    expect(windowStateFileName("/")).toBe("window-state-profile.json");
  });
});
