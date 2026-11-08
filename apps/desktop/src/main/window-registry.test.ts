import { describe, expect, it } from "vitest";
import { CASCADE_OFFSET, WindowRegistry, cascadeFrom, spaceForNewWindow } from "./window-registry";

const win = (id: number) => {
  const w = { id, destroyed: false, isDestroyed: () => w.destroyed };
  return w;
};

describe("WindowRegistry", () => {
  it("finds the window showing a profile — what opening that profile again brings forward", () => {
    /* THE mutant: no lookup, so "Open in new window" makes a second Work window beside the first —
       two windows holding one profile's panes, each thinking the views are its own. */
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const first = win(1); const work = win(2);
    reg.add(first, null);
    reg.add(work, "pWork");
    expect(reg.windowFor("pWork")).toBe(work);
    expect(reg.windowFor("pSchool")).toBeNull();
  });

  it("follows the profile a window SHOWS, which its renderer reports as the person switches", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const first = win(1);
    reg.add(first, null);
    expect(reg.windowFor("pPersonal")).toBeNull();
    reg.setShowing(first, "pPersonal");
    expect(reg.windowFor("pPersonal")).toBe(first);
    reg.setShowing(first, "pWork");
    expect(reg.windowFor("pPersonal")).toBeNull();
    expect(reg.boundTo(first)).toBeNull();
  });

  it("asked from the window that shows it, there is no OTHER window for that profile", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const work = win(2);
    reg.add(work, "pWork");
    expect(reg.windowFor("pWork", work)).toBeNull();
  });

  it("the primary window is the one used last; a closed or destroyed window is never it", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const a = win(1); const b = win(2); const c = win(3);
    reg.add(a, null); reg.add(b, "pWork"); reg.add(c, "pSchool");
    expect(reg.primary()).toBe(c); // the newest window is in front
    reg.focused(a);
    expect(reg.primary()).toBe(a);
    reg.remove(a);
    expect(reg.primary()).toBe(c);
    c.destroyed = true;
    expect(reg.primary()).toBe(b);
    expect(reg.all()).toEqual([b]);
    expect(reg.size).toBe(1);
    expect(reg.windowFor("pSchool")).toBeNull();
  });
});

describe("cascadeFrom", () => {
  it("opens a new window just down and to the right of the one it came from, the same size", () => {
    expect(cascadeFrom({ x: 100, y: 80, width: 1400, height: 900 })).toEqual({ x: 100 + CASCADE_OFFSET, y: 80 + CASCADE_OFFSET, width: 1400, height: 900 });
    expect(cascadeFrom(null)).toBeNull();
  });
});

describe("one space per window", () => {
  it("finds the window showing a space — what asking for it from another window brings forward", () => {
    /* THE mutant: no lookup, so a click on a space open in another window shows it twice, and a split
       in one window splits the other. */
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const first = win(1); const second = win(2);
    reg.add(first, null); reg.add(second, "pWork");
    reg.setSpace(first, "s1"); reg.setSpace(second, "s2");
    expect(reg.windowForSpace("s2", first)).toBe(second);
    expect(reg.windowForSpace("s2", second)).toBeNull();
    expect(reg.windowForSpace("s3")).toBeNull();
    reg.setSpace(second, "s3");
    expect(reg.windowForSpace("s2")).toBeNull();
    expect(reg.openSpaces()).toEqual(new Set(["s1", "s3"]));
  });
});

describe("spaceForNewWindow", () => {
  const spaces = [
    { id: "a", profileId: "work" }, { id: "b", profileId: "work" }, { id: "c", profileId: "work" },
    { id: "x", profileId: "home" },
  ];
  it("opens the space after the front window's, skipping any already open, and wraps round", () => {
    expect(spaceForNewWindow(spaces, { profileId: "work", spaceId: "a" }, new Set(["a"]))?.id).toBe("b");
    expect(spaceForNewWindow(spaces, { profileId: "work", spaceId: "b" }, new Set(["b", "c"]))?.id).toBe("a");
  });
  it("goes to another profile's spaces once the front profile's are all open, and to none after that", () => {
    expect(spaceForNewWindow(spaces, { profileId: "work", spaceId: "a" }, new Set(["a", "b", "c"]))?.id).toBe("x");
    expect(spaceForNewWindow(spaces, { profileId: "work", spaceId: "a" }, new Set(["a", "b", "c", "x"]))).toBeNull();
    expect(spaceForNewWindow(spaces, null, new Set())?.id).toBe("a");
  });
});
