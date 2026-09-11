/**
 * How a Realm app finds the realm-server that is already running.
 *
 * Until now the server announced its port on stdout and Electron main read it off a pipe. A pipe is
 * a parent-child channel: it works exactly once, for the process that spawned this one. A daemon
 * outlives the app that started it, so the app that launches NEXT has no pipe to read — and the
 * daemon's own next `stdout.write` after that parent exits takes EPIPE. So the port, and everything
 * else a second launch needs to decide what to do, is written to a file instead.
 *
 * The file is mode 0600 because it carries the RPC token. It is written by rename so a reader never
 * sees half of it, and every read is validated — a truncated or hand-edited file reads as "no daemon"
 * rather than throwing on a path where throwing would stop the app from starting at all.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_LOCK_FILE, DAEMON_STATE_FILE, DaemonStateSchema, bundleIdOf, type DaemonState } from "@realm/contracts";

export type { DaemonState };
export const stateFile = (home: string): string => join(home, DAEMON_STATE_FILE);
export const lockFile = (home: string): string => join(home, DAEMON_LOCK_FILE);

/** The bundle this process is running. A vanished entry — `install-local.mjs` swapped it out from
 *  under a daemon that is still up — reads as "missing", which no live bundle can equal, so a
 *  launcher comparing the two always decides it is looking at different code. */
export function currentBundleId(entry: string): string {
  try { return bundleIdOf(statSync(entry)); } catch { return "missing"; }
}

export const newBootId = (): string => randomUUID();
export const newToken = (): string => randomBytes(32).toString("base64url");

/** Write the state file atomically at 0600. The temp file is a sibling so the rename stays on one
 *  volume, and it carries the pid so two launches racing cannot scribble on each other's temp. */
export function writeState(home: string, state: DaemonState): void {
  mkdirSync(home, { recursive: true });
  const target = stateFile(home);
  const tmp = `${target}.${state.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** The state file, or null for every kind of absence: no file, unreadable, not JSON, wrong shape. */
export function readState(home: string): DaemonState | null {
  let raw: string;
  try { raw = readFileSync(stateFile(home), "utf8"); } catch { return null; }
  try {
    const parsed = DaemonStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function clearState(home: string): void {
  rmSync(stateFile(home), { force: true });
}

export type LockOutcome = { kind: "acquired" } | { kind: "held"; pid: number };

/**
 * Take the per-home daemon lock.
 *
 * The lock is on the HOME, not on the port, because what two daemons would actually corrupt is one
 * `realm.db` — two live-session maps, two sets of gateway tokens, two processes racing the migration
 * runner. A home is also the unit a test or a live-check script already varies, so a scratch
 * REALM_HOME gets its own daemon for free.
 *
 * `wx` makes creation the mutual exclusion. A lock whose pid is gone is broken and retaken, because
 * the alternative is that one SIGKILL locks the user out of their own app until they find the file.
 */
export function acquireLock(
  home: string,
  owner: { pid: number; bootId: string },
  d: { kill: (pid: number, signal: 0) => void } = { kill: process.kill },
): LockOutcome {
  mkdirSync(home, { recursive: true });
  const path = lockFile(home);
  const write = (): void => {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
  };
  try {
    write();
    return { kind: "acquired" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const held = readLock(path);
  if (held && held.pid !== owner.pid && alive(held.pid, d.kill)) return { kind: "held", pid: held.pid };
  // Stale (or ours from a previous run in this same process): drop it and retake. A second launcher
  // can win the race here, which is why the retake goes through `wx` again rather than truncating.
  rmSync(path, { force: true });
  try {
    write();
    return { kind: "acquired" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const winner = readLock(path);
    return winner ? { kind: "held", pid: winner.pid } : { kind: "held", pid: 0 };
  }
}

export function releaseLock(home: string, owner: { pid: number }): void {
  const held = readLock(lockFile(home));
  // Only our own lock. A daemon that was stale-broken while it was still shutting down must not
  // delete the lock its replacement now holds.
  if (held && held.pid !== owner.pid) return;
  rmSync(lockFile(home), { force: true });
}

function readLock(path: string): { pid: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
  } catch {
    // Unreadable or half-written: treat as stale. A lock nobody can identify cannot be honoured.
    return null;
  }
}

function alive(pid: number, kill: (pid: number, signal: 0) => void): boolean {
  try { kill(pid, 0); return true; } catch (e) {
    // EPERM means it exists and belongs to somebody else — alive for our purposes.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
