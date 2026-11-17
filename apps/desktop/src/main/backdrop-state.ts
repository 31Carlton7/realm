import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";

/** What a window's moving background stops for that Chromium does not tell its page. */
export type BackdropState = { lowPowerMode: boolean; covered: boolean; displayAsleep: boolean; screenLocked: boolean };
export const BACKDROP_STATE_CHANNEL = "realm:backdrop-state";

function helperPath(): string | null {
  if (process.platform !== "darwin") return null;
  // Beside the source in a dev build or a live check (out/main → native/bin), whatever the app path.
  const dev = join(__dirname, "../../native/bin/backdropstate");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "backdropstate");
  return existsSync(packaged) ? packaged : null;
}

type WindowsLine = { covered: number[]; asleep: number[]; locked: boolean };
const windowNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));

/** One line of the helper's output (native/BackdropState.swift), or null for one that is not. */
export function parseBackdropLine(line: string): { lowPower: boolean } | WindowsLine | null {
  try {
    const v = JSON.parse(line) as { lowPower?: unknown; covered?: unknown; asleep?: unknown; locked?: unknown };
    if (typeof v.lowPower === "boolean") return { lowPower: v.lowPower };
    if (windowNumbers(v.covered) && windowNumbers(v.asleep) && typeof v.locked === "boolean") return { covered: v.covered, asleep: v.asleep, locked: v.locked };
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
 * macOS Low Power Mode, and whether each window playing a background loop can be seen (covered, on
 * displays all asleep, or behind a locked screen), for the renderer to stop the loop on
 * (loop-player.ts). A window asks to be watched while it has a loop (`backdrop:watch`), so the helper
 * looks at the screen only while one plays. One helper for the app, started with it and gone with it;
 * where it is missing, none of these ever stops a loop.
 */
export function startBackdropState(): void {
  let lowPower = false;
  let covered = new Set<number>();
  let asleep = new Set<number>();
  let locked = false;
  const watched = new Set<BrowserWindow>();
  const hooked = new WeakSet<BrowserWindow>();
  const stateOf = (win: BrowserWindow): BackdropState => {
    const n = windowNumber(win) ?? -1;
    return { lowPowerMode: lowPower, covered: covered.has(n), displayAsleep: asleep.has(n), screenLocked: locked };
  };
  const tell = (win: BrowserWindow) => { if (!win.isDestroyed()) win.webContents.send(BACKDROP_STATE_CHANNEL, stateOf(win)); };

  ipcMain.handle("backdrop:state", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? stateOf(win) : { lowPowerMode: lowPower, covered: false, displayAsleep: false, screenLocked: locked };
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
      } else {
        covered = new Set(msg.covered);
        asleep = new Set(msg.asleep);
        locked = msg.locked;
      }
      // Every window, watched or not: one that stopped watching while covered is told it no longer is,
      // so its loop is free to play when it watches again. The helper prints only on a change.
      for (const win of BrowserWindow.getAllWindows()) tell(win);
    }
  });
  app.on("will-quit", () => child.stdin.end());
}
