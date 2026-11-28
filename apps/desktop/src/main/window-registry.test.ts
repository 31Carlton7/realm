import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { describe, expect, it } from "vitest";
import { WINDOWS_OPENED_AT_LAUNCH } from "@realm/contracts";
import { CASCADE_OFFSET, PaneWindows, WindowRegistry, cascadeFrom, readSavedWindows, splitLaunch, spaceForNewWindow, windowTitle, windowsToRestore, writeSavedWindows } from "./window-registry";

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

describe("only the windows used last open at launch", () => {
  const spaces = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => ({ id, profileId: "pWork" }));
  const six = windowsToRestore(spaces.map((sp) => ({ profileId: "pWork", spaceId: sp.id, showing: sp.id })), spaces);

  it("opens the three used last, the one used last still in front, and holds the rest", () => {
    expect(WINDOWS_OPENED_AT_LAUNCH).toBe(3);
    const { open, held } = splitLaunch(six, WINDOWS_OPENED_AT_LAUNCH);
    expect(open.map((w) => w.land)).toEqual(["s4", "s5", "s6"]);
    expect(held.map((w) => w.land)).toEqual(["s1", "s2", "s3"]);
    expect(splitLaunch(six, Number.POSITIVE_INFINITY).open).toHaveLength(6);
  });

  it("keeps a held window in what is saved, so the next launch still knows it", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const { open, held } = splitLaunch(six, 3);
    reg.hold(held);
    open.forEach((w, i) => { const opened = win(i + 1); reg.add(opened, w.profileId, w.spaceId); reg.setSpace(opened, w.land); });
    expect(reg.saved().map((w) => w.showing)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(windowsToRestore(reg.saved(), spaces)).toEqual(six);
  });

  it("opens a held window exactly as it was when its space is asked for, and holds it no longer", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    reg.hold(splitLaunch(six, 3).held);
    expect(reg.heldFor("s2")).toEqual({ profileId: "pWork", spaceId: "s2", land: "s2" });
    expect(reg.heldFor("s6")).toBeNull();
    reg.release(reg.heldFor("s2")!);
    expect(reg.heldFor("s2")).toBeNull();
    expect(reg.saved().map((w) => w.showing)).toEqual(["s1", "s3"]);
  });

  it("opens a held window once, however many ask for its space while it is opening", async () => {
    // THE MUTANT: the entry released and the window not yet known by its space, so a second ask opens
    // a second window on the same space.
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    reg.hold(splitLaunch(six, 3).held);
    const opened: string[] = [];
    let finish!: () => void;
    const open = (held: { land: string | null }) => new Promise<ReturnType<typeof win>>((resolve) => {
      opened.push(held.land!);
      finish = () => { const w = win(7); reg.add(w, "pWork", "s2"); reg.setSpace(w, held.land); resolve(w); };
    });
    const first = reg.openHeld("s2", open);
    const second = reg.openHeld("s2", open);
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(opened).toEqual(["s2"]);
    expect(a).toBe(b);
    expect(await reg.openHeld("s2", open)).toBeNull();
    expect(await reg.openHeld("s6", open)).toBeNull();
  });

  it("saves no held window that has no space to land on", () => {
    // THE MUTANT: a held window whose space is gone saved again at every quit, forever.
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    reg.hold([{ profileId: "pWork", spaceId: null, land: null }, ...splitLaunch(six, 5).held]);
    expect(reg.saved().map((w) => w.showing)).toEqual(["s1"]);
  });

  it("drops a held window once an open window has moved onto its space", () => {
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    reg.hold(splitLaunch(six, 3).held);
    const w = win(9);
    reg.add(w, "pWork", "s6"); reg.setSpace(w, "s1");
    expect(reg.heldFor("s1")).toBeNull();
    expect(reg.saved().map((x) => x.showing)).toEqual(["s2", "s3", "s1"]);
  });

  it("forgets a held window an open window moved onto, after that window moves on or closes", () => {
    // THE MUTANT: still held while hidden from what is saved, so it comes back in windows.json once
    // the other window leaves its space: a window the person never saw.
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    reg.hold(splitLaunch(six, 3).held);
    const w = win(9);
    reg.add(w, "pWork", "s6"); reg.setSpace(w, "s1");
    reg.setSpace(w, "s4");
    expect(reg.saved().map((x) => x.showing)).toEqual(["s2", "s3", "s4"]);
    expect(reg.heldFor("s1")).toBeNull();
    reg.remove(w);
    expect(reg.saved().map((x) => x.showing)).toEqual(["s2", "s3"]);
  });

  it("a window opened behind the person's is not the one used last, and saves as used longest ago", () => {
    // THE MUTANT: a held window an agent's work opened becomes where toasts and the menu bar go.
    const reg = new WindowRegistry<ReturnType<typeof win>>();
    const mine = win(1);
    reg.add(mine, "pWork", "s6");
    const held = win(2);
    reg.add(held, "pWork", "s2", { behind: true });
    reg.setSpace(mine, "s6"); reg.setSpace(held, "s2");
    expect(reg.primary()).toBe(mine);
    expect(reg.saved().map((x) => x.showing)).toEqual(["s2", "s6"]);
  });
});

describe("a window held at launch, opened for an agent's pane", () => {
  type W = ReturnType<typeof win>;
  /** Space s1 held, s5 open; `finish` is openHeld finishing, left to the test. */
  const setup = () => {
    const reg = new WindowRegistry<W>();
    reg.hold([{ profileId: "pWork", spaceId: "s1", land: "s1" }]);
    const front = win(5);
    reg.add(front, "pWork", "s5"); reg.setSpace(front, "s5");
    const opens: string[] = [];
    const closers: (() => void)[] = [];
    let finish!: (w: W | null) => void;
    const panes = new PaneWindows<W>({
      windows: reg,
      openHeld: (spaceId) => reg.openHeld(spaceId, () => { opens.push(spaceId); return new Promise<W | null>((r) => { finish = r; }); }),
      onClosed: (_w, fn) => { closers.push(fn); },
    });
    /** createWindow's part, and then the page's first word: it shows no space until its store has one. */
    const made = () => { const w = win(1); reg.add(w, "pWork", "s1", { behind: true, land: "s1" }); reg.setSpace(w, "s1"); reg.setSpace(w, null); return w; };
    return { reg, front, panes, opens, closers, made, finish: (w: W | null) => finish(w) };
  };
  const pane = (browserId: string) => ({ spaceId: "s1", browserId, itemId: `i-${browserId}`, openedBy: "sess" });

  it("hands its page the pane events, even when the page asks before the window has finished opening", async () => {
    // THE MUTANT: the events kept only once the window has opened, so a page quicker than that asks,
    // gets nothing, and the agent's pane never mounts in its space's window.
    const { panes, opens, made, finish } = setup();
    const opening = panes.needed("s1", pane("a"));
    void panes.needed("s1", pane("b"));
    const w = made();
    expect(panes.unheardBy(w)).toEqual([pane("a"), pane("b")]);
    finish(w);
    await opening;
    expect(opens).toEqual(["s1"]);
  });

  it("hands them over once, and to no window on another space", async () => {
    // THE MUTANT: the events kept after the page took them, so a reload applies them again.
    const { panes, front, made, finish } = setup();
    const opening = panes.needed("s1", pane("a"));
    const w = made();
    finish(w);
    await opening;
    expect(panes.unheardBy(front)).toEqual([]);
    expect(panes.unheardBy(w)).toEqual([pane("a")]);
    expect(panes.unheardBy(w)).toEqual([]);
  });

  it("makes the pane's browser view in that space's own window only, while it opens and once open", async () => {
    // THE MUTANT: the window in front makes the view first, the agent drives it, and the space's own
    // window then takes it, loading the page again under the agent.
    const { reg, panes, front, made, finish } = setup();
    expect(panes.makesView(front, "s1")).toBe(true);
    const opening = panes.needed("s1", pane("a"));
    expect(panes.makesView(front, "s1")).toBe(false);
    const w = made();
    expect(panes.makesView(w, "s1")).toBe(true);
    finish(w);
    await opening;
    panes.unheardBy(w);
    reg.setSpace(w, "s1");
    expect(panes.makesView(front, "s1")).toBe(false);
    expect(panes.makesView(front, "s5")).toBe(true);
  });

  it("holds an agent's op on its browser until the view is made there, and no other browser's", async () => {
    // THE MUTANT: no wait, so browser_snapshot straight after browser_open finds the pane not open,
    // its window still booting.
    const { panes } = setup();
    void panes.needed("s1", pane("a"));
    let done = false;
    const waiting = panes.mounted("a", 60_000).then(() => { done = true; });
    expect(await panes.mounted("other", 60_000)).toBe(false);
    await Promise.resolve();
    expect(done).toBe(false);
    panes.made("a");
    await waiting;
    expect(done).toBe(true);
    expect(await panes.mounted("a", 60_000)).toBe(false);
  });

  it("waits for a view that is never made only as long as it is told, and only once", async () => {
    const { panes } = setup();
    void panes.needed("s1", pane("a"));
    const t0 = Date.now();
    await panes.mounted("a", 30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const t1 = Date.now();
    await panes.mounted("a", 5_000);
    expect(Date.now() - t1).toBeLessThan(1_000);
  });

  it("keeps nothing for a space with no window held, nor once its window closes or fails to open", async () => {
    // THE MUTANT: what was kept outlives its window, so no window ever makes that space's views again.
    const { reg, panes, front, opens, closers, made, finish } = setup();
    await panes.needed("s3", { ...pane("c"), spaceId: "s3" });
    expect(opens).toEqual([]);
    expect(panes.makesView(front, "s3")).toBe(true);
    const opening = panes.needed("s1", pane("a"));
    const w = made();
    finish(w);
    await opening;
    w.destroyed = true; reg.remove(w);
    for (const fn of closers) fn();
    expect(panes.makesView(front, "s1")).toBe(true);
    await panes.mounted("a", 60_000);

    const failed = setup();
    const gone = failed.panes.needed("s1", pane("b"));
    failed.finish(null);
    await gone;
    expect(failed.panes.makesView(failed.front, "s1")).toBe(true);
    await failed.panes.mounted("b", 60_000);
  });
});
