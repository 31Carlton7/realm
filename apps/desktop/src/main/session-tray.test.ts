import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { SessionTray, TRAY_SESSION_LIMIT, trayHeader, trayMenu, trayTitle, trayTooltip, type SessionTrayHandle, type TraySession } from "./session-tray";

const actions = () => ({ reattach: vi.fn(), stopAllAgents: vi.fn(), quitAndStop: vi.fn() });
const labels = (t: MenuItemConstructorOptions[]) => t.map((i) => (i.type === "separator" ? "—" : String(i.label)));

describe("what the menu bar says", () => {
  it("says nothing when there is nothing to say", () => {
    expect(trayTitle({ working: 0, needsYou: 0 })).toBe("");
    expect(trayTooltip({ working: 0, needsYou: 0 })).toBe("Realm — nothing running");
    expect(trayHeader({ working: 0, needsYou: 0 })).toBe("Nothing running");
  });

  it("counts what is working, and prefers what is waiting on you", () => {
    expect(trayTitle({ working: 3, needsYou: 0 })).toBe("3");
    expect(trayTitle({ working: 3, needsYou: 1 })).toBe("1 waiting");
    expect(trayHeader({ working: 3, needsYou: 1 })).toBe("3 working, 1 waiting on you");
    expect(trayHeader({ working: 1, needsYou: 0 })).toBe("1 session working");
    expect(trayHeader({ working: 0, needsYou: 2 })).toBe("2 sessions need an answer");
  });
});

describe("the menu", () => {
  const sessions: TraySession[] = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, spaceId: "sp1", title: `Session ${i}`, spaceName: "Realm" }));

  it("lists a bounded number of sessions, each naming its space", () => {
    const t = trayMenu({ counts: { working: 7, needsYou: 0 }, sessions, actions: actions() });
    const named = labels(t).filter((l) => l.startsWith("Session "));
    expect(named).toHaveLength(TRAY_SESSION_LIMIT);
    // The window is closed at this point: a title alone does not say which space to open.
    expect(named[0]).toBe("Session 0 — Realm");
  });

  it("always offers the two ways back, and only offers to stop what is running", () => {
    const quiet = trayMenu({ counts: { working: 0, needsYou: 0 }, sessions: [], actions: actions() });
    expect(labels(quiet)).toEqual(["Nothing running", "—", "Open Realm", "Stop all agents", "—", "Quit Realm & stop agents"]);
    expect(quiet.find((i) => i.label === "Stop all agents")?.enabled).toBe(false);
    const busy = trayMenu({ counts: { working: 2, needsYou: 0 }, sessions: [], actions: actions() });
    expect(busy.find((i) => i.label === "Stop all agents")?.enabled).toBe(true);
  });

  it("wires each item to its action", () => {
    const a = actions();
    const t = trayMenu({ counts: { working: 1, needsYou: 0 }, sessions: sessions.slice(0, 1), actions: a });
    const click = (label: string) => t.find((i) => i.label === label)?.click?.(
      undefined as never, undefined as never, undefined as never);
    click("Session 0 — Realm");
    expect(a.reattach).toHaveBeenCalledWith({ sessionId: "s0", spaceId: "sp1" });
    click("Open Realm");
    expect(a.reattach).toHaveBeenLastCalledWith();
    click("Stop all agents");
    expect(a.stopAllAgents).toHaveBeenCalled();
    click("Quit Realm & stop agents");
    expect(a.quitAndStop).toHaveBeenCalled();
  });
});

describe("SessionTray", () => {
  const handle = (): SessionTrayHandle & { title: string[]; destroyed: number } => {
    const h = {
      title: [] as string[], destroyed: 0,
      setTitle(t: string) { h.title.push(t); },
      setToolTip() {}, setContextMenu() {},
      destroy() { h.destroyed++; },
    };
    return h;
  };

  it("comes up on show and renders immediately, without waiting for an event", () => {
    const h = handle();
    const tray = new SessionTray({ createTray: () => h, actions: actions() });
    expect(tray.showing).toBe(false);
    tray.show();
    expect(tray.showing).toBe(true);
    // The point: somebody who just quit with agents running sees the item, not an empty menu bar
    // until the next status event happens to arrive.
    expect(h.title).toEqual([""]);
  });

  it("ignores updates while hidden, and shows the latest when it comes back", () => {
    const h = handle();
    const tray = new SessionTray({ createTray: () => h, actions: actions() });
    tray.update({ working: 2, needsYou: 0 }, []);
    expect(h.title).toEqual([]);
    tray.show();
    expect(h.title).toEqual(["2"]);
  });

  it("takes itself down", () => {
    const h = handle();
    const tray = new SessionTray({ createTray: () => h, actions: actions() });
    tray.show();
    tray.hide();
    expect(h.destroyed).toBe(1);
    expect(tray.showing).toBe(false);
  });
});
