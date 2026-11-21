import { describe, expect, it } from "vitest";
import { QUICK_CHAT_PANEL_OPTIONS, QUICK_CHAT_PANEL_SIZE, QuickChatPanel, QuickChatShortcut, quickChatPanelPlace, quickChatPanelStep, type PanelWindow } from "./quick-chat-panel";

const DISPLAY = { x: 0, y: 25, width: 1440, height: 875 };

function fakeWindow() {
  const calls: string[] = [];
  let visible = false;
  let destroyed = false;
  const win: PanelWindow = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    showInactive: () => { visible = true; calls.push("showInactive"); },
    focus: () => { calls.push("focus"); },
    hide: () => { visible = false; calls.push("hide"); },
    destroy: () => { destroyed = true; visible = false; calls.push("destroy"); },
    setContentProtection: (on) => { calls.push(`protect ${on}`); },
    webContents: { focus: () => { calls.push("page focus"); }, send: (channel) => { calls.push(`send ${channel}`); } },
  };
  return { win, calls, destroy: () => { destroyed = true; visible = false; } };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the panel window's options", () => {
  it("keeps the title empty, since a protected window is still listed by name", () => {
    expect(QUICK_CHAT_PANEL_OPTIONS.title).toBe("");
  });

  it("is a frameless window that starts hidden and can take the keyboard", () => {
    expect(QUICK_CHAT_PANEL_OPTIONS).toMatchObject({ frame: false, show: false, focusable: true, skipTaskbar: true });
  });
});

describe("quickChatPanelPlace", () => {
  it("opens centred near the top of the display the pointer is on", () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(quickChatPanelPlace(null, [DISPLAY, second], second)).toEqual({ x: 1440 + (1920 - 380) / 2, y: 112 });
  });

  it("opens where it was dragged to", () => {
    const saved = { x: 900, y: 300, ...QUICK_CHAT_PANEL_SIZE, maximized: false, fullScreen: false };
    expect(quickChatPanelPlace(saved, [DISPLAY], DISPLAY)).toEqual({ x: 900, y: 300 });
  });

  it("forgets a place on a display that has gone", () => {
    const saved = { x: 4000, y: 300, ...QUICK_CHAT_PANEL_SIZE, maximized: false, fullScreen: false };
    expect(quickChatPanelPlace(saved, [DISPLAY], DISPLAY)).toEqual({ x: 530, y: 96 });
  });
});

describe("QuickChatPanel", () => {
  it("opens without activating: shown inactive, then given the keyboard, then told", async () => {
    const w = fakeWindow();
    const panel = new QuickChatPanel(() => ({ win: w.win, ready: Promise.resolve() }));
    panel.toggle();
    expect(panel.isOpen()).toBe(true);
    await settled();
    expect(w.calls).toEqual(["protect true", "showInactive", "focus", "page focus", "send quick-chat-panel:shown"]);
  });

  it("can be made ahead of the first open, hidden, and that open shows the window already made", async () => {
    const w = fakeWindow();
    let made = 0;
    const panel = new QuickChatPanel(() => { made++; return { win: w.win, ready: Promise.resolve() }; });
    panel.prepare();
    await settled();
    expect(made).toBe(1);
    expect(panel.isOpen()).toBe(false);
    expect(w.calls).toEqual([]);
    panel.prepare();
    panel.open(); await settled();
    expect(made).toBe(1);
    expect(w.calls).toEqual(["protect true", "showInactive", "focus", "page focus", "send quick-chat-panel:shown"]);
  });

  it("is made ahead for the chord, and for a double-tap of Command with no chord", async () => {
    for (const keys of [{ chord: true, doubleTap: false }, { chord: false, doubleTap: true }, { chord: true, doubleTap: true }]) {
      let made = 0;
      const panel = new QuickChatPanel(() => { made++; return { win: fakeWindow().win, ready: Promise.resolve() }; });
      panel.prepareFor(keys); await settled();
      expect(made, JSON.stringify(keys)).toBe(1);
      expect(panel.isOpen()).toBe(false);
    }
  });

  it("makes nothing ahead while no key opens it from another app", async () => {
    let made = 0;
    const panel = new QuickChatPanel(() => { made++; return { win: fakeWindow().win, ready: Promise.resolve() }; });
    panel.prepareFor({ chord: false, doubleTap: false }); await settled();
    expect(made).toBe(0);
    expect(panel.window()).toBeNull();
  });

  it("destroys the window made ahead once neither key opens it, and makes a new one when one does again", async () => {
    const first = fakeWindow(), second = fakeWindow();
    const windows = [first, second];
    const panel = new QuickChatPanel(() => ({ win: windows.shift()!.win, ready: Promise.resolve() }));
    panel.prepareFor({ chord: false, doubleTap: true }); await settled();
    panel.prepareFor({ chord: false, doubleTap: false });
    expect(first.calls).toEqual(["destroy"]);
    expect(panel.window()).toBeNull();
    panel.prepareFor({ chord: true, doubleTap: false }); await settled();
    expect(panel.window()).toBe(second.win);
  });

  it("leaves an open panel on screen when the last key is switched off", async () => {
    const w = fakeWindow();
    const panel = new QuickChatPanel(() => ({ win: w.win, ready: Promise.resolve() }));
    panel.open(); await settled();
    panel.prepareFor({ chord: false, doubleTap: false });
    expect(w.calls).not.toContain("destroy");
    expect(panel.isOpen()).toBe(true);
  });

  it("makes nothing ahead of time off macOS", () => {
    let made = 0;
    new QuickChatPanel(() => { made++; return { win: fakeWindow().win, ready: Promise.resolve() }; }, "linux").prepare();
    expect(made).toBe(0);
  });

  it("lets go of a window made ahead whose page failed, so the first open makes a new one", async () => {
    const first = fakeWindow(), second = fakeWindow();
    const windows = [first, second];
    const panel = new QuickChatPanel(() => ({ win: windows.shift()!.win, ready: windows.length === 1 ? Promise.reject(new Error("load")) : Promise.resolve() }));
    panel.prepare(); await settled();
    expect(first.calls).toEqual(["destroy"]);
    panel.open(); await settled();
    expect(second.calls).toContain("showInactive");
  });

  it("is put away by the same call that opened it", async () => {
    const w = fakeWindow();
    const panel = new QuickChatPanel(() => ({ win: w.win, ready: Promise.resolve() }));
    panel.toggle();
    await settled();
    panel.toggle();
    expect(panel.isOpen()).toBe(false);
    expect(w.calls.at(-1)).toBe("hide");
  });

  it("makes the window once and shows the same one again", async () => {
    const w = fakeWindow();
    let made = 0;
    const panel = new QuickChatPanel(() => { made++; return { win: w.win, ready: Promise.resolve() }; });
    panel.open(); await settled();
    panel.close();
    panel.open(); await settled();
    expect(made).toBe(1);
    expect(w.calls.filter((c) => c === "showInactive")).toHaveLength(2);
  });

  it("does not show a panel that was put away while its page was loading", async () => {
    const w = fakeWindow();
    let loaded = () => {};
    const panel = new QuickChatPanel(() => ({ win: w.win, ready: new Promise<void>((resolve) => { loaded = resolve; }) }));
    panel.toggle();
    panel.toggle();
    loaded();
    await settled();
    expect(w.calls).toEqual([]);
  });

  it("makes a new window after the old one was destroyed", async () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const windows = [first, second];
    const panel = new QuickChatPanel(() => ({ win: windows.shift()!.win, ready: Promise.resolve() }));
    panel.open(); await settled();
    first.destroy();
    expect(panel.isOpen()).toBe(false);
    panel.toggle(); await settled();
    expect(second.calls).toContain("showInactive");
  });

  it("stays closed while there is nothing to make it from", () => {
    const panel = new QuickChatPanel(() => null);
    panel.toggle();
    expect(panel.isOpen()).toBe(false);
  });

  it("lets go of a window whose page failed to load, so the next press makes a new one", async () => {
    const failed = fakeWindow();
    const loaded = fakeWindow();
    const windows = [{ win: failed.win, ready: Promise.reject(new Error("ERR_FILE_NOT_FOUND")) }, { win: loaded.win, ready: Promise.resolve() }];
    const panel = new QuickChatPanel(() => windows.shift()!);
    panel.toggle(); await settled();
    expect(panel.isOpen()).toBe(false);
    expect(failed.calls).toEqual(["destroy"]);
    panel.toggle(); await settled();
    expect(panel.isOpen()).toBe(true);
    expect(loaded.calls).toContain("showInactive");
  });

  it.each(["linux", "win32"])("makes no window on %s, where the panel was never measured", async (platform) => {
    let made = 0;
    const w = fakeWindow();
    const panel = new QuickChatPanel(() => { made++; return { win: w.win, ready: Promise.resolve() }; }, platform);
    panel.toggle(); await settled();
    expect(made).toBe(0);
    expect(panel.isOpen()).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it("is hidden from screen sharing until that is switched off, and follows the switch while open", async () => {
    const w = fakeWindow();
    const panel = new QuickChatPanel(() => ({ win: w.win, ready: Promise.resolve() }));
    panel.setHiddenFromSharing(false);
    panel.open(); await settled();
    expect(w.calls[0]).toBe("protect false");
    panel.setHiddenFromSharing(true);
    expect(w.calls.at(-1)).toBe("protect true");
  });
});

describe("QuickChatShortcut", () => {
  function system(taken: string[] = [], platform?: string) {
    const held = new Map<string, () => void>();
    const shortcut = new QuickChatShortcut({
      register: (accelerator, press) => { if (taken.includes(accelerator)) return false; held.set(accelerator, press); return true; },
      unregister: (accelerator) => { held.delete(accelerator); },
      press: () => { presses++; },
      platform,
    });
    let presses = 0;
    return { shortcut, held, presses: () => presses };
  }

  it("registers the chord, and a press of it toggles", () => {
    const s = system();
    expect(s.shortcut.set("ctrl+alt+space")).toEqual({ chord: "ctrl+alt+space", registered: true });
    s.held.get("Control+Alt+Space")!();
    expect(s.presses()).toBe(1);
  });

  it("says so when the system refuses the chord", () => {
    const s = system(["Control+Alt+Space"]);
    expect(s.shortcut.set("ctrl+alt+space")).toEqual({ chord: "ctrl+alt+space", registered: false });
    expect(s.held.size).toBe(0);
  });

  it("lets go of the old chord when it is replaced, and of the last one when cleared", () => {
    const s = system();
    s.shortcut.set("ctrl+alt+space");
    s.shortcut.set("mod+shift+j");
    expect([...s.held.keys()]).toEqual(["Command+Shift+J"]);
    expect(s.shortcut.set(null)).toEqual({ chord: null, registered: false });
    expect(s.held.size).toBe(0);
  });

  it("registers nothing for a chord that cannot be a system-wide key", () => {
    const s = system();
    expect(s.shortcut.set("shift+a")).toEqual({ chord: null, registered: false });
    expect(s.held.size).toBe(0);
  });

  it.each(["linux", "win32"])("registers no system-wide key on %s, whatever chord is stored", (platform) => {
    const s = system([], platform);
    expect(s.shortcut.set("ctrl+alt+space")).toEqual({ chord: null, registered: false });
    expect(s.held.size).toBe(0);
  });

  it("does not unregister a chord it never held", () => {
    const unregistered: string[] = [];
    const shortcut = new QuickChatShortcut({ register: () => false, unregister: (a) => { unregistered.push(a); }, press: () => {} });
    shortcut.set("ctrl+alt+space");
    shortcut.set("mod+shift+j");
    shortcut.release();
    expect(unregistered).toEqual([]);
  });
});

describe("quickChatPanelStep", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const middle = (1440 - QUICK_CHAT_PANEL_SIZE.width) / 2;
  const right = 1440 - QUICK_CHAT_PANEL_SIZE.width;

  it("moves from the right edge to the middle, then to the left edge, and stays there", () => {
    expect(quickChatPanelStep(right, area, -1)).toBe(middle);
    expect(quickChatPanelStep(middle, area, -1)).toBe(0);
    expect(quickChatPanelStep(0, area, -1)).toBe(0);
  });

  it("moves from the left edge to the middle, then to the right edge, and stays there", () => {
    expect(quickChatPanelStep(0, area, 1)).toBe(middle);
    expect(quickChatPanelStep(middle, area, 1)).toBe(right);
    expect(quickChatPanelStep(right, area, 1)).toBe(right);
  });

  it("goes to the next place in that direction from where it was dragged", () => {
    expect(quickChatPanelStep(middle + 40, area, -1)).toBe(middle);
    expect(quickChatPanelStep(middle + 40, area, 1)).toBe(right);
    expect(quickChatPanelStep(20, area, -1)).toBe(0);
  });

  it("keeps to the display it is on", () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(quickChatPanelStep(1440, second, 1)).toBe(1440 + Math.round((1920 - QUICK_CHAT_PANEL_SIZE.width) / 2));
    expect(quickChatPanelStep(3000, second, 1)).toBe(1440 + 1920 - QUICK_CHAT_PANEL_SIZE.width);
  });
});
