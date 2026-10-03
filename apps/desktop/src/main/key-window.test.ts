import { expect, it, vi } from "vitest";

const handlers = new Map<string, (e: unknown) => unknown>();
let focused = true;
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { fromWebContents: () => ({ isFocused: () => focused }) },
}));
const { registerKeyWindowQuery, wireKeyWindow } = await import("./key-window");

/* THE mutants: reporting the event rather than the window's real state, and a window that opened
   behind another app having no way to learn it is not key. */
it("reports the window's own key state on every focus change, and answers when asked", () => {
  const listeners = new Map<string, () => void>();
  const sent: unknown[][] = [];
  let isFocused = false;
  const win = {
    on: (ev: string, fn: () => void) => listeners.set(ev, fn),
    isFocused: () => isFocused, isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  };
  wireKeyWindow(win as never);
  listeners.get("blur")!();
  isFocused = true;
  listeners.get("focus")!();
  expect(sent).toEqual([["window:key", false], ["window:key", true]]);

  registerKeyWindowQuery();
  focused = false;
  expect(handlers.get("window:is-key")!({ sender: {} })).toBe(false);
});
