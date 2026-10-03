import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { CASCADE, WindowRegistry, cascadeFrom, readSavedWindows, writeSavedWindows, type WindowLike } from "./windows";

let next = 1;
const fakeWin = (bounds = { x: 0, y: 0, width: 1000, height: 700 }) => {
  const w = {
    id: next++, destroyed: false, focused: false, minimized: false, raised: 0,
    isDestroyed: () => w.destroyed, isFocused: () => w.focused, isMinimized: () => w.minimized,
    restore: () => { w.minimized = false; }, show: () => {}, focus: () => { w.raised++; },
    getNormalBounds: () => bounds, isMaximized: () => false, isFullScreen: () => false,
  };
  return w satisfies WindowLike;
};

describe("one space per window", () => {
  /* THE mutant: granting a space that another window already shows. Two windows on one space mirror
     each other's layout through the server — split in one, and the other splits. */
  it("grants a space to one window, refuses it to another and names the owner", () => {
    const reg = new WindowRegistry();
    const a = fakeWin(), b = fakeWin();
    reg.add(a); reg.add(b);
    expect(reg.claim(a.id, "s1")).toEqual({ ok: true });
    expect(reg.claim(b.id, "s1")).toEqual({ ok: false, ownerId: a.id });
    expect(reg.claim(a.id, "s1")).toEqual({ ok: true }); // asking again for your own space is fine
    expect(reg.claim(b.id, "s2")).toEqual({ ok: true });
    expect(reg.claimedBy(b.id)).toEqual(["s1"]);
    // Moving a window to another space frees the one it left.
    expect(reg.claim(a.id, "s3")).toEqual({ ok: true });
    expect(reg.claim(b.id, "s1")).toEqual({ ok: true });
  });

  it("brings the owner forward, out of the Dock if it was minimised", () => {
    const reg = new WindowRegistry();
    const a = fakeWin();
    const slot = reg.add(a);
    a.minimized = true;
    reg.raise(slot);
    expect(a.minimized).toBe(false);
    expect(a.raised).toBe(1);
  });

  it("knows which window is current: the focused one, else the one focused last", () => {
    const reg = new WindowRegistry();
    const a = fakeWin(), b = fakeWin();
    reg.add(a); reg.add(b);
    expect(reg.current()?.win).toBe(b);
    reg.touch(a.id);
    expect(reg.current()?.win).toBe(a);
    b.focused = true;
    expect(reg.current()?.win).toBe(b);
  });
});

describe("which windows come back", () => {
  /* THE mutants: forgetting windows that ⌘Q closed (the person asked to quit, not to lose them), and
     remembering one the person closed on purpose while others stayed open. */
  it("remembers every window a quit closes, forgets one closed alone, and keeps the last", () => {
    const reg = new WindowRegistry();
    const a = fakeWin({ x: 0, y: 0, width: 1000, height: 700 }), b = fakeWin({ x: 40, y: 40, width: 900, height: 600 }), c = fakeWin();
    reg.add(a); reg.add(b); reg.add(c);
    reg.claim(a.id, "s1"); reg.claim(b.id, "s2"); reg.claim(c.id, "s3");
    expect(reg.remove(c.id)).toBe(false);
    expect(reg.snapshot().windows.map((w) => w.spaceId).sort()).toEqual(["s1", "s2"]);
    reg.beginClosingAll();
    expect(reg.remove(a.id)).toBe(true);
    expect(reg.remove(b.id)).toBe(true);
    expect(reg.size).toBe(0);
    expect(reg.snapshot().windows.map((w) => w.spaceId).sort()).toEqual(["s1", "s2"]);
    // Windows are back: whatever closes next, closes on purpose.
    reg.endClosingAll();
    const d = fakeWin(), e = fakeWin();
    reg.add(d); reg.add(e); reg.claim(d.id, "s1");
    expect(reg.remove(e.id)).toBe(false);
    // The last window is kept, so reopening Realm lands where it was.
    expect(reg.remove(d.id)).toBe(true);
    expect(reg.snapshot().windows.map((w) => w.spaceId)).toEqual(["s1"]);
  });

  it("reads the window list back, and takes the old single-window file on the first launch", () => {
    const dir = tempDir("realm-windows-");
    const file = join(dir, "windows.json"), legacy = join(dir, "window-state.json");
    expect(readSavedWindows(file, legacy)).toEqual([]);
    writeFileSync(legacy, JSON.stringify({ x: 1, y: 2, width: 3, height: 4 }));
    expect(readSavedWindows(file, legacy)).toEqual([{ x: 1, y: 2, width: 3, height: 4, maximized: false, fullScreen: false }]);
    writeSavedWindows(file, { windows: [{ x: 5, y: 6, width: 700, height: 500, spaceId: "s9" }, { x: Number.NaN, y: 0, width: 1, height: 1 }] as never });
    expect(readSavedWindows(file, legacy)).toEqual([{ x: 5, y: 6, width: 700, height: 500, maximized: false, fullScreen: false, spaceId: "s9" }]);
  });

  it("cascades a new window down and right of the one it was asked from", () => {
    expect(cascadeFrom({ x: 100, y: 80, width: 1200, height: 800 }, { width: 0, height: 0 }))
      .toEqual({ x: 100 + CASCADE, y: 80 + CASCADE, width: 1200, height: 800 });
    expect(cascadeFrom(null, { width: 1, height: 1 })).toBeNull();
  });
});
