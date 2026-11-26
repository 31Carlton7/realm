import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";

const switches: string[] = [];
const appEvents = new EventEmitter();
const dock = { hide: vi.fn(), show: vi.fn(), bounce: vi.fn(() => 1), downloadFinished: vi.fn() };
const app = Object.assign(appEvents, {
  commandLine: { appendSwitch: (s: string) => switches.push(s) },
  dock,
  whenReady: () => new Promise(() => {}),
  setActivationPolicy: vi.fn(),
  focus: vi.fn(),
  showAboutPanel: vi.fn(),
});
const { focus: realFocus, showAboutPanel: realAbout } = app;
const { show: realDockShow, bounce: realBounce } = dock;

/** Just enough of a window: what AppKit would do is recorded, never done. */
class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static getFocusedWindow(): FakeWindow | null { return null; }
  calls: string[] = [];
  visible = false;
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    setAudioMuted: vi.fn(), setBackgroundThrottling: vi.fn(),
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false, attach: vi.fn(), sendCommand: vi.fn(async () => ({})) }),
    isDestroyed: () => false,
  });
  constructor() { super(); FakeWindow.all.push(this); app.emit("browser-window-created", {}, this); }
  show() { this.calls.push("show"); this.visible = true; }
  showInactive() { this.calls.push("showInactive"); this.visible = true; }
  hide() { this.calls.push("hide"); this.visible = false; }
  focus() { this.calls.push("focus"); }
  blur() { this.calls.push("blur"); }
  isFocused() { return true; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  setOpacity(o: number) { this.calls.push(`opacity ${o * 255}`); }
  setHasShadow(s: boolean) { this.calls.push(`shadow ${s}`); }
  setFocusable(f: boolean) { this.calls.push(`focusable ${f}`); }
  setIgnoreMouseEvents(i: boolean) { this.calls.push(`ignore mouse ${i}`); }
  setAlwaysOnTop(on: boolean, level: string) { this.calls.push(`on top ${on} ${level}`); }
  setVisibleOnAllWorkspaces(on: boolean) { this.calls.push(`all spaces ${on}`); }
  setFullScreen(_on: boolean) { this.calls.push("full screen"); }
  setSimpleFullScreen(_on: boolean) { this.calls.push("simple full screen"); }
  flashFrame(_on: boolean) { this.calls.push("flash"); }
  close() { this.destroyed = true; this.emit("closed"); }
}

const shownNotifications: string[] = [];
class FakeNotification { title = "Done"; static isSupported = () => true; show() { shownNotifications.push(this.title); } }
const shell = { beep: vi.fn(), openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() };
const dialog = { showMessageBox: vi.fn(), showMessageBoxSync: vi.fn(), showOpenDialog: vi.fn(), showOpenDialogSync: vi.fn(), showSaveDialog: vi.fn(), showSaveDialogSync: vi.fn(), showErrorBox: vi.fn() };
const systemPreferences = { askForMediaAccess: vi.fn(async () => true) };
class FakeMenu { popup = vi.fn(); }
const webContents = { getFocusedWebContents: (): unknown => "the real one" };
const registered: string[] = [];
const globalShortcut = { register: (accelerator: string, _press?: () => void) => { registered.push(accelerator); return true; } };

vi.mock("electron", () => ({ app, BrowserWindow: FakeWindow, Notification: FakeNotification, shell, dialog, systemPreferences, Menu: FakeMenu, webContents, globalShortcut }));
const { agentUserData, installQuietWindows, quietKeyable, quietWindowsLog, quietWindowsOn } = await import("./quiet-windows");

describe("quietWindowsOn", () => {
  it("is on only for an unpackaged app asked for it", () => {
    expect(quietWindowsOn({ packaged: false, env: { REALM_QUIET_WINDOWS: "1" } })).toBe(true);
    expect(quietWindowsOn({ packaged: true, env: { REALM_QUIET_WINDOWS: "1" } })).toBe(false);
    expect(quietWindowsOn({ packaged: false, env: {} })).toBe(false);
    expect(quietWindowsOn({ packaged: false, env: { REALM_QUIET_WINDOWS: "true" } })).toBe(false);
  });

  it("is on for an unpackaged app an agent started, and never for a packaged one", () => {
    expect(quietWindowsOn({ packaged: false, env: { REALM_AGENT_SHELL: "1" } })).toBe(true);
    expect(quietWindowsOn({ packaged: true, env: { REALM_AGENT_SHELL: "1" } })).toBe(false);
    expect(quietWindowsOn({ packaged: true, env: { REALM_AGENT_SHELL: "1", REALM_QUIET_WINDOWS: "1" } })).toBe(false);
    expect(quietWindowsOn({ packaged: false, env: { REALM_AGENT_SHELL: "0" } })).toBe(false);
  });
});

describe("agentUserData", () => {
  const unpackaged = {
    packaged: false, env: { REALM_AGENT_SHELL: "1" }, appPath: "/src/realm-a/apps/desktop",
    userData: "/Library/Application Support/Realm", defaultUserData: "/Library/Application Support/Realm", tmpDir: "/tmp",
  };

  it("gives an unpackaged app an agent started a folder of its own under the temp folder, one per checkout", () => {
    const a = agentUserData(unpackaged)!;
    expect(a.startsWith("/tmp/realm-agent-shell/")).toBe(true);
    expect(agentUserData(unpackaged)).toBe(a);
    expect(agentUserData({ ...unpackaged, appPath: "/src/realm-b/apps/desktop" })).not.toBe(a);
  });

  it("leaves the folder alone for a packaged app, one no agent started, and one whose folder was already chosen", () => {
    expect(agentUserData({ ...unpackaged, packaged: true })).toBeNull();
    expect(agentUserData({ ...unpackaged, env: {} })).toBeNull();
    expect(agentUserData({ ...unpackaged, env: { REALM_QUIET_WINDOWS: "1" } })).toBeNull();
    expect(agentUserData({ ...unpackaged, userData: "/tmp/live-check/userData" })).toBeNull();
  });
});

describe("installQuietWindows", () => {
  beforeAll(() => installQuietWindows());

  it("seals secrets with the mock Keychain, which never asks for the login password", () => {
    expect(switches).toContain("use-mock-keychain");
  });

  it("keeps Chromium drawing a window nobody can see, and plays nothing", () => {
    expect(switches).toEqual(expect.arrayContaining(["mute-audio", "disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]));
  });

  it("puts nothing on the Dock and never activates the app", async () => {
    expect(dock.hide).toHaveBeenCalled();
    await app.dock.show();
    app.dock.bounce();
    app.focus();
    expect(realDockShow).not.toHaveBeenCalled();
    expect(realBounce).not.toHaveBeenCalled();
    expect(realFocus).not.toHaveBeenCalled();
  });

  it("shows every window inactive, transparent, unfocusable, click-through and never covered", () => {
    const w = new FakeWindow();
    w.show();
    expect(w.calls).not.toContain("show");
    expect(w.calls).toContain("showInactive");
    expect(w.calls).toEqual(expect.arrayContaining(["opacity 1", "shadow false", "focusable false", "ignore mouse true", "on top true screen-saver", "all spaces true"]));
    expect(w.calls.indexOf("opacity 1")).toBeLessThan(w.calls.indexOf("showInactive"));
    w.close();
  });

  it("takes no key from the system, except the one a check names", () => {
    expect(globalShortcut.register("Control+Alt+Space", () => {})).toBe(true);
    expect(registered).toEqual([]);
    expect(quietWindowsLog).toContainEqual({ what: "global shortcut", detail: "Control+Alt+Space" });
    vi.stubEnv("REALM_QUIET_GLOBAL_SHORTCUT", "Control+Alt+Shift+F19");
    globalShortcut.register("Control+Alt+Shift+F19", () => {});
    globalShortcut.register("Control+Alt+Space", () => {});
    vi.unstubAllEnvs();
    expect(registered).toEqual(["Control+Alt+Shift+F19"]);
  });

  it("lets a marked window really take the keyboard, only while the check asks", () => {
    const w = new FakeWindow();
    quietKeyable(w as never);
    w.show();
    w.focus();
    expect(w.calls).not.toContain("focus");
    expect(w.calls).not.toContain("focusable true");
    vi.stubEnv("REALM_QUIET_REAL_KEY", "1");
    const plain = new FakeWindow();
    plain.show();
    plain.focus();
    w.show();
    w.focus();
    vi.unstubAllEnvs();
    expect(plain.calls).not.toContain("focus");
    expect(w.calls).toEqual(expect.arrayContaining(["focusable true", "focus", "opacity 1", "ignore mouse true"]));
    w.close();
    plain.close();
  });

  it("makes the window shown or focused last the key one, as AppKit would", () => {
    const a = new FakeWindow();
    const b = new FakeWindow();
    const seen: string[] = [];
    a.on("focus", () => seen.push("a focus")); a.on("blur", () => seen.push("a blur"));
    b.on("focus", () => seen.push("b focus"));
    a.show();
    expect(a.isFocused()).toBe(true);
    b.show();
    expect([a.isFocused(), b.isFocused()]).toEqual([false, true]);
    expect((FakeWindow as unknown as { getFocusedWindow(): FakeWindow }).getFocusedWindow()).toBe(b);
    a.focus();
    expect(a.isFocused()).toBe(true);
    expect(seen).toEqual(["a focus", "a blur", "b focus", "a focus"]);
    expect(a.calls).not.toContain("focus");
    // Closing the key window hands key to the one left.
    a.close();
    expect(b.isFocused()).toBe(true);
    b.close();
    expect((FakeWindow as unknown as { getFocusedWindow(): FakeWindow | null }).getFocusedWindow()).toBeNull();
  });

  it("takes key from a window it hides, as AppKit does, so a panel shown inactive after is not key", () => {
    const main = new FakeWindow();
    const panel = new FakeWindow();
    main.show();
    panel.show();
    panel.hide();
    expect([main.isFocused(), panel.isFocused()]).toEqual([true, false]);
    panel.showInactive();
    expect(panel.isFocused()).toBe(false);
    main.close();
    panel.close();
  });

  it("never goes full screen or flashes the Dock", () => {
    const w = new FakeWindow();
    w.setFullScreen(true);
    w.setSimpleFullScreen(true);
    w.flashFrame(true);
    expect(w.calls).not.toContain("full screen");
    expect(w.calls).not.toContain("simple full screen");
    expect(w.calls).not.toContain("flash");
    w.close();
  });

  it("emulates focus in each window's page, and mutes every webContents", () => {
    const w = new FakeWindow();
    expect(w.webContents.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", { enabled: true });
    const wc = { setAudioMuted: vi.fn(), setBackgroundThrottling: vi.fn() };
    app.emit("web-contents-created", {}, wc);
    expect(wc.setAudioMuted).toHaveBeenCalledWith(true);
    expect(wc.setBackgroundThrottling).toHaveBeenCalledWith(false);
    w.close();
  });

  it("gives the keyboard to the webContents focused last, without the real focus that activates the app", () => {
    const contents = () => {
      const focus = vi.fn();
      const wc = { setAudioMuted: vi.fn(), setBackgroundThrottling: vi.fn(), isDestroyed: () => false, focus: focus as () => void, isFocused: () => true };
      app.emit("web-contents-created", {}, wc);
      return { wc, focus };
    };
    const page = contents();
    const pane = contents();
    expect(webContents.getFocusedWebContents()).toBeNull();
    pane.wc.focus();
    expect([page.wc.isFocused(), pane.wc.isFocused()]).toEqual([false, true]);
    page.wc.focus();
    expect(webContents.getFocusedWebContents()).toBe(page.wc);
    expect(pane.wc.isFocused()).toBe(false);
    expect(page.focus).not.toHaveBeenCalled();
    expect(pane.focus).not.toHaveBeenCalled();
  });

  it("records what would have reached the person instead of showing it", async () => {
    new FakeNotification().show();
    expect(shownNotifications).toEqual([]);
    expect(FakeNotification.isSupported()).toBe(false);
    await shell.openExternal("https://example.com");
    shell.showItemInFolder("/tmp/x");
    shell.beep();
    app.showAboutPanel();
    expect(realAbout).not.toHaveBeenCalled();
    expect(await systemPreferences.askForMediaAccess()).toBe(false);
    new FakeMenu().popup();
    expect(quietWindowsLog.map((e) => e.what)).toEqual(expect.arrayContaining(["notification", "open external", "show in folder", "beep", "about panel", "media access prompt"]));
  });

  it("answers every dialog with its Cancel", async () => {
    expect(await dialog.showMessageBox({ message: "Quit?", buttons: ["Quit", "Cancel"] })).toEqual({ response: 1, checkboxChecked: false });
    expect(await dialog.showMessageBox(new FakeWindow(), { message: "Quit?", buttons: ["Quit", "Stay"], cancelId: 1 })).toEqual({ response: 1, checkboxChecked: false });
    expect(dialog.showMessageBoxSync({ message: "Delete?", buttons: ["Delete"] })).toBe(0);
    expect(await dialog.showOpenDialog({})).toEqual({ canceled: true, filePaths: [] });
    expect(await dialog.showSaveDialog({})).toEqual({ canceled: true, filePath: "" });
  });
});
