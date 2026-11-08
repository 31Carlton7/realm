import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { describe, expect, it } from "vitest";
import { CASCADE_OFFSET, WindowRegistry, cascadeFrom, readSavedWindows, spaceForNewWindow, windowTitle, windowsToRestore, writeSavedWindows } from "./window-registry";

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

describe("windows brought back on relaunch", () => {
  const spaces = [{ id: "sRealm", profileId: "pWork" }, { id: "sPersona", profileId: "pWork" }, { id: "sGeneral", profileId: "pHome" }];
  const quitWith = (reg: WindowRegistry<ReturnType<typeof win>>) => {
    const file = join(tempDir("realm-windows-"), "windows.json");
    writeSavedWindows(file, reg.saved());
    return readSavedWindows(file);
  };

  it("every window comes back on its space, opened for what it was opened for, the one used last in front", () => {
    /* THE mutants: save only the first window, and the Persona window is gone after ⌘Q; drop the space
       a window was opened for, and it comes back with the profile's view instead of its own panes;
       save in any other order, and the window behind is the one in front. */
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const first = win(1); const persona = win(2);
    reg.add(first, null); reg.setSpace(first, "sRealm");
    reg.add(persona, "pWork", "sPersona"); reg.setSpace(persona, "sPersona");
    reg.focused(first);
    expect(windowsToRestore(quitWith(reg), spaces)).toEqual([
      { profileId: "pWork", spaceId: "sPersona", land: "sPersona" },
      { profileId: null, spaceId: null, land: "sRealm" },
    ]);
  });

  it("a window that switched space lands on the one it showed, and keeps the space it was opened for", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const w = win(2);
    reg.add(w, "pWork", "sPersona"); reg.setSpace(w, "sGeneral");
    expect(windowsToRestore(quitWith(reg), spaces)).toEqual([{ profileId: "pHome", spaceId: "sPersona", land: "sGeneral" }]);
  });

  it("a window whose space was deleted is skipped; one whose new space went lands where it was opened", () => {
    /* THE mutant: restore without asking which spaces are left, and a deleted space's window opens on
       nothing. */
    expect(windowsToRestore([
      { profileId: null, spaceId: null, showing: "sRealm" },
      { profileId: "pWork", spaceId: "sGone", showing: "sGone" },
      { profileId: "pWork", spaceId: "sPersona", showing: "sAlsoGone" },
    ], spaces)).toEqual([
      { profileId: null, spaceId: null, land: "sRealm" },
      { profileId: "pWork", spaceId: "sPersona", land: "sPersona" },
    ]);
  });

  it("never opens two windows on one space", () => {
    /* THE mutant: no check, and a file that names a space twice — edited by hand, or a window that
       switched onto a space whose own window is still listed — opens it in two windows. */
    expect(windowsToRestore([
      { profileId: "pWork", spaceId: "sPersona", showing: "sPersona" },
      { profileId: "pWork", spaceId: "sRealm", showing: "sPersona" },
      { profileId: null, spaceId: null, showing: "sRealm" },
    ], spaces)).toEqual([
      { profileId: "pWork", spaceId: "sPersona", land: "sPersona" },
      { profileId: null, spaceId: null, land: "sRealm" },
    ]);
  });

  it("with nothing saved, or nothing left, one window opens and finds its own way", () => {
    const one = [{ profileId: null, spaceId: null, land: null }];
    expect(windowsToRestore([], spaces)).toEqual(one);
    expect(windowsToRestore([{ profileId: "pWork", spaceId: "sGone", showing: "sGone" }], spaces)).toEqual(one);
    expect(windowsToRestore([{ profileId: null, spaceId: null, showing: "sGone" }], spaces)).toEqual(one);
  });

  it("reads a missing or hand-edited file as nothing saved", () => {
    expect(readSavedWindows("/nonexistent/windows.json")).toEqual([]);
    expect(readSavedWindows("x", () => "{\"windows\":[3,{\"spaceId\":\"sRealm\",\"showing\":7}]}")).toEqual([
      { profileId: null, spaceId: "sRealm", showing: null },
    ]);
  });
});

describe("window titles", () => {
  const spaces = [
    { id: "s1", profileId: "pWork", name: "Realm" }, { id: "s2", profileId: "pWork", name: "Persona" },
    { id: "s3", profileId: "pHome", name: "Persona" }, { id: "s4", profileId: "pHome", name: "General" },
  ];
  const names: Record<string, string> = { pWork: "Work", pHome: "Home" };
  const profileName = (id: string) => names[id];

  it("a window is titled by its space, with the profile only when another profile has a space of that name", () => {
    /* THE mutants: title by profile, and two Work windows are both "Work" in the Window menu; always
       add the profile, and every title carries a word the person never needed. */
    expect(windowTitle("s1", "pWork", spaces, profileName)).toBe("Realm");
    expect(windowTitle("s4", "pHome", spaces, profileName)).toBe("General");
    expect(windowTitle("s2", "pWork", spaces, profileName)).toBe("Persona — Work");
    expect(windowTitle("s3", "pHome", spaces, profileName)).toBe("Persona — Home");
  });

  it("follows the window as it switches space, and the name as it is renamed", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const w = win(1);
    reg.add(w, null);
    const title = (list = spaces) => windowTitle(reg.spaceOf(w), reg.showing(w), list, profileName);
    expect(title()).toBe("Realm");
    reg.setShowing(w, "pHome");
    expect(title()).toBe("Home");
    reg.setSpace(w, "s4");
    expect(title()).toBe("General");
    reg.setSpace(w, "s1");
    expect(title()).toBe("Realm");
    expect(title(spaces.map((sp) => (sp.id === "s1" ? { ...sp, name: "Realm HQ" } : sp)))).toBe("Realm HQ");
  });
});

describe("where a toast opens", () => {
  it("in the window showing the session's space, even when another window was used last", () => {
    /* THE mutant: the window used last, as before, and a click on Persona's toast opens Persona's
       session in window 1 — the same space on screen twice — while window 2 sits behind. */
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const w1 = win(1); const w2 = win(2);
    reg.add(w1, null); reg.setSpace(w1, "sRealm");
    reg.add(w2, "pWork", "sPersona"); reg.setSpace(w2, "sPersona");
    reg.focused(w1);
    expect(reg.windowToOpen("sPersona")).toBe(w2);
    expect(reg.windowToOpen("sRealm")).toBe(w1);
  });

  it("a space no window shows goes to the window used last, which switches to it", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const w1 = win(1); const w2 = win(2);
    reg.add(w1, null); reg.setSpace(w1, "sRealm");
    reg.add(w2, "pWork", "sPersona"); reg.setSpace(w2, "sPersona");
    reg.focused(w1);
    expect(reg.windowToOpen("sGeneral")).toBe(w1);
    expect(reg.windowToOpen(null)).toBe(w1);
  });
});
