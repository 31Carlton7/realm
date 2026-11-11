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

vi.mock("electron", () => ({ app, BrowserWindow: FakeWindow, Notification: FakeNotification, shell, dialog, systemPreferences, Menu: FakeMenu, webContents }));
const { installQuietWindows, quietWindowsLog, quietWindowsOn } = await import("./quiet-windows");

describe("quietWindowsOn", () => {
  it("is on only for an unpackaged app asked for it", () => {
    expect(quietWindowsOn({ packaged: false, env: { REALM_QUIET_WINDOWS: "1" } })).toBe(true);
    expect(quietWindowsOn({ packaged: true, env: { REALM_QUIET_WINDOWS: "1" } })).toBe(false);
    expect(quietWindowsOn({ packaged: false, env: {} })).toBe(false);
    expect(quietWindowsOn({ packaged: false, env: { REALM_QUIET_WINDOWS: "true" } })).toBe(false);
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
