import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";

/** One line from the native ScrollPhase helper (see apps/desktop/native/ScrollPhase.swift). */
export type ScrollPhaseMessage = { phase: string; momentum: string; dx: number; dy: number; ts: number };

export const SCROLL_PHASE_CHANNEL = "realm:scroll-phase";

function helperPath(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.REALM_SCROLLPHASE_BIN) return process.env.REALM_SCROLLPHASE_BIN;
  const dev = join(app.getAppPath(), "native", "bin", "scrollphase");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "scrollphase");
  return existsSync(packaged) ? packaged : null;
}

/** Streams native trackpad scroll phases (began/changed/ended + momentum) to the renderer so the
 *  space swiper can hold/settle/commit exactly on finger lift, like macOS Spaces. Optional: when the
 *  helper is missing (non-mac, or not built) the renderer falls back to timer heuristics. */
export function startScrollPhaseStream(win: BrowserWindow): { stop(): void } {
  const bin = helperPath();
  if (!bin) return { stop() {} };
  let child: ChildProcess | null = null;
  try {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    console.warn("[scrollphase] failed to spawn:", (e as Error).message);
    return { stop() {} };
  }
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as ScrollPhaseMessage | { ready: true };
        if ("ready" in msg) { console.log("[scrollphase] native trackpad phases: ON"); continue; }
        if (!win.isDestroyed()) win.webContents.send(SCROLL_PHASE_CHANNEL, msg);
      } catch { /* ignore malformed line */ }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) console.warn("[scrollphase]", s); });
  child.on("exit", (code) => {
    if (code === 2) console.warn("[scrollphase] native trackpad phases: OFF — event tap unavailable (grant Input Monitoring to the app that launched Realm), using timer fallback");
    else if (code && code !== 0) console.warn(`[scrollphase] exited with ${code}; using timer fallback`);
    child = null;
  });
  return {
    stop() { try { child?.stdin?.end(); child?.kill(); } catch { /* ignore */ } child = null; },
  };
}
