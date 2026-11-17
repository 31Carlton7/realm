import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";

/** What a window's moving background stops for that Chromium does not tell its page. */
export type BackdropState = { lowPowerMode: boolean; covered: boolean };
export const BACKDROP_STATE_CHANNEL = "realm:backdrop-state";

function helperPath(): string | null {
  if (process.platform !== "darwin") return null;
  // Beside the source in a dev build or a live check (out/main → native/bin), whatever the app path.
  const dev = join(__dirname, "../../native/bin/backdropstate");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "backdropstate");
  return existsSync(packaged) ? packaged : null;
}

/** One line of the helper's output (native/BackdropState.swift), or null for one that is not. */
export function parseBackdropLine(line: string): { lowPower: boolean } | { covered: number[] } | null {
  try {
    const v = JSON.parse(line) as { lowPower?: unknown; covered?: unknown };
    if (typeof v.lowPower === "boolean") return { lowPower: v.lowPower };
    if (Array.isArray(v.covered) && v.covered.every((n) => Number.isInteger(n))) return { covered: v.covered as number[] };
    return null;
  } catch {
    return null;
  }
}

/** A window's number as macOS knows it, from Electron's media source id (`window:<number>:0`). */
export function windowNumber(win: BrowserWindow): number | null {
  const n = Number(/^window:(\d+):/.exec(win.getMediaSourceId())?.[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * macOS Low Power Mode, and whether each window playing a background loop can be seen, for the
 * renderer to stop the loop on (loop-player.ts). A window asks to be watched while it has a loop
 * (`backdrop:watch`), so the helper looks at the screen only while one plays. One helper for the app,
 * started with it and gone with it; where it is missing neither ever stops a loop.
 */
export function startBackdropState(): void {
  let lowPower = false;
  let covered = new Set<number>();
  const watched = new Set<BrowserWindow>();
  const hooked = new WeakSet<BrowserWindow>();
  const stateOf = (win: BrowserWindow): BackdropState => ({ lowPowerMode: lowPower, covered: covered.has(windowNumber(win) ?? -1) });
  const tell = (win: BrowserWindow) => { if (!win.isDestroyed()) win.webContents.send(BACKDROP_STATE_CHANNEL, stateOf(win)); };

  ipcMain.handle("backdrop:state", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? stateOf(win) : { lowPowerMode: lowPower, covered: false };
  });
  const bin = helperPath();
  if (!bin) { ipcMain.on("backdrop:watch", () => {}); return; }
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
  child.on("error", (e) => console.warn("[backdropstate] failed to spawn:", e.message));
  child.stdin.on("error", () => {});
  const sendWatched = () => {
    const ids = [...watched].filter((w) => !w.isDestroyed()).map(windowNumber).filter((n): n is number => n !== null);
    if (child.stdin.writable) child.stdin.write(`${ids.join(" ")}\n`);
  };
  ipcMain.on("backdrop:watch", (e, on: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (on === true) watched.add(win); else watched.delete(win);
    if (!hooked.has(win)) { hooked.add(win); win.once("closed", () => { watched.delete(win); sendWatched(); }); }
    sendWatched();
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const msg = parseBackdropLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (!msg) continue;
      if ("lowPower" in msg) {
        if (msg.lowPower === lowPower) continue;
        lowPower = msg.lowPower;
        for (const win of BrowserWindow.getAllWindows()) tell(win);
      } else {
        const was = covered;
        covered = new Set(msg.covered);
        for (const win of watched) { const n = windowNumber(win) ?? -1; if (was.has(n) !== covered.has(n)) tell(win); }
      }
    }
  });
  app.on("will-quit", () => child.stdin.end());
}
