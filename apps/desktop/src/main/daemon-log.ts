/**
 * Where a detached daemon's output goes.
 *
 * A server child writes its stderr into Electron's, which a developer reads in the terminal and a
 * packaged app throws away. Neither works once the server outlives the app: after main exits there is
 * no terminal, and a crash at 3am with nothing written down is a crash nobody can explain. So the
 * daemon's stdout and stderr are an appended file under `~/Realm/logs`, at 0600 — the same posture as
 * every other file in that folder that might hold something private, and this one holds whatever an
 * agent printed.
 *
 * Rotation is one generation and no more. The alternative is a log that grows for as long as the
 * daemon runs, which for this feature is the point — and the alternative to *that* is a retention
 * policy nobody asked for. `server.log.1` is the previous run's; anything older is gone.
 *
 * This lives in the desktop app rather than beside the server because the server does not open its
 * own stdout: whoever spawns it hands it the file descriptor, and that is main.
 */
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOG_MAX_BYTES = 8 * 1024 * 1024;

export const daemonLogPath = (home: string): string => join(home, "logs", "server.log");

/** Rotate if the current log has grown past `maxBytes`. Every step is best-effort: a log we cannot
 *  rotate is not a reason to refuse to start the daemon it belongs to. */
export function rotateDaemonLog(home: string, maxBytes = LOG_MAX_BYTES): void {
  const path = daemonLogPath(home);
  mkdirSync(join(home, "logs"), { recursive: true });
  try {
    if (statSync(path).size < maxBytes) return;
  } catch {
    return; // no log yet: nothing to rotate
  }
  try {
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  } catch { /* rotation is a nicety; the append below still works */ }
}

/** An append-mode fd for the daemon's stdout and stderr, rotated first. The caller owns closing it —
 *  `spawn` dups it into the child, so the parent's copy is dead weight the moment the child is up. */
export function openDaemonLog(home: string): number {
  rotateDaemonLog(home);
  return openSync(daemonLogPath(home), "a", 0o600);
}

export const closeDaemonLog = (fd: number): void => { try { closeSync(fd); } catch { /* already gone */ } };
