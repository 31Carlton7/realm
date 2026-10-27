import { expect, it, vi } from "vitest";

const handlers = new Map<string, (e: unknown) => unknown>();
let fullScreen = false;
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { fromWebContents: () => ({ isFullScreen: () => fullScreen }) },
}));
const { registerFullScreenQuery, wireFullScreen } = await import("./full-screen");

/* THE mutants: an event left unwired (the regions never come off, or never come back), reporting
   the event rather than the window's real state, and a window restored into full screen having no
   way to learn it is in one. */
it("reports the window's own full-screen state on entering and leaving, and answers when asked", () => {
  const listeners = new Map<string, () => void>();
  const sent: unknown[][] = [];
  let isFullScreen = true;
  const win = {
    on: (ev: string, fn: () => void) => listeners.set(ev, fn),
    isFullScreen: () => isFullScreen, isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  };
  wireFullScreen(win as never);
  listeners.get("enter-full-screen")!();
  isFullScreen = false;
  listeners.get("leave-full-screen")!();
  // What is sent is the window's state, not the event's name.
  isFullScreen = true;
  listeners.get("leave-full-screen")!();
  expect(sent).toEqual([["window:full-screen", true], ["window:full-screen", false], ["window:full-screen", true]]);

  registerFullScreenQuery();
  fullScreen = true;
  expect(handlers.get("window:is-full-screen")!({ sender: {} })).toBe(true);
});

it("says nothing to a window that has gone", () => {
  const listeners = new Map<string, () => void>();
  const send = vi.fn();
  wireFullScreen({ on: (ev: string, fn: () => void) => listeners.set(ev, fn), isFullScreen: () => true, isDestroyed: () => true, webContents: { send } } as never);
  listeners.get("leave-full-screen")!();
  expect(send).not.toHaveBeenCalled();
});
