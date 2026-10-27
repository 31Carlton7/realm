/**
 * Getting a realm-server process out of the way for certain.
 *
 * Every path that replaces a server — an update's hand-off, the launcher finding one that will not
 * answer, the banner's Restart, the tray's Quit Realm & stop agents — used to send SIGTERM and hope.
 * A server whose shutdown hangs (an agent that will not exit, a socket to another machine that went
 * away while the Mac slept) then lived on: running from a Realm.app that had been replaced under it,
 * holding the bundle so Finder would not let a fresh copy over it, and invisible to the next launch
 * once its own shutdown had cleared `daemon.json`. So the grace period ends in SIGKILL, and a pid is
 * only "gone" when it is.
 *
 * Nothing here is told to signal a pid it has not checked: `runsServer` reads the pid's command line
 * first, because a pid from a state file may belong to somebody else by now.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { performance } from "node:perf_hooks";

/** The few things this module does to processes, injected so the tests can drive a world of them. */
export type ProcessOps = {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** The pid's command line, or null when there is no such process. */
  commandOf: (pid: number) => string | null;
  /** Pids with `file` open. */
  holding: (file: string) => number[];
  /** A clock that does not jump when the Mac sleeps: a wait begun before the lid closed must not
   *  expire the moment it opens. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  self: number;
};

/** Their complaints go nowhere: a pid that is gone, or a file nobody has made yet, is an answer. */
const quietly: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };

export const realProcessOps: ProcessOps = {
  kill: (pid, signal) => { process.kill(pid, signal); },
  commandOf: (pid) => {
    try { return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], quietly).trim() || null; } catch { return null; }
  },
  holding: (file) => {
    // `lsof` exits 1 when nothing has the file open, which is an answer, not a failure.
    try { return execFileSync("lsof", ["-t", "--", file], quietly).split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0); } catch { return []; }
  },
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  self: process.pid,
};

/** How long a SIGTERM'd server is given to run its own shutdown: closing ptys, agents and the database. */
export const STOP_WAIT_MS = 10_000;
/** And how long SIGKILL is given to land. */
const KILL_WAIT_MS = 2_000;

export function isAlive(pid: number, ops: Pick<ProcessOps, "kill">): boolean {
  try { ops.kill(pid, 0); return true; } catch (e) {
    // EPERM means it exists and belongs to somebody else — alive for our purposes.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `pid` is a live process running the server bundle at `entry`. */
export function runsServer(pid: number, entry: string, ops: Pick<ProcessOps, "commandOf" | "self">): boolean {
  if (pid === ops.self || pid <= 0) return false;
  return ops.commandOf(pid)?.includes(entry) ?? false;
}

/** Wait for a pid to leave. True if it did. */
export async function waitForExit(pid: number, timeoutMs: number, ops: Pick<ProcessOps, "kill" | "now" | "sleep">): Promise<boolean> {
  const deadline = ops.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid, ops)) return true;
    if (ops.now() >= deadline) return false;
    await ops.sleep(100);
  }
}

/**
 * SIGTERM, then SIGKILL for a server too stuck to run its own shutdown. True once the pid is gone.
 *
 * The SIGKILL goes to the process group first: a daemon is spawned detached, so it leads a group of
 * its own, and the agent CLIs it started are in it — running from the same bundle, and with nobody
 * left to stop them once their server is killed. A server that is not a group leader (the app's own
 * child, off a Mac) has no group by its pid, and takes the SIGKILL alone.
 */
export async function stopServerProcess(pid: number, ops: ProcessOps = realProcessOps, graceMs = STOP_WAIT_MS): Promise<boolean> {
  try { ops.kill(pid, "SIGTERM"); } catch { return !isAlive(pid, ops); }
  if (await waitForExit(pid, graceMs, ops)) return true;
  try { ops.kill(-pid, "SIGKILL"); } catch {
    try { ops.kill(pid, "SIGKILL"); } catch { /* gone in between */ }
  }
  return waitForExit(pid, KILL_WAIT_MS, ops);
}

/** What every realm-server's command line ends in, packaged or not: `…/server/dist/main.js`. */
export const SERVER_ENTRY_SUFFIX = "/server/dist/main.js";

/**
 * realm-servers holding `home`'s database other than the ones in `keep`.
 *
 * Asked only where Realm is about to start the one server a home may have, or has just stopped it for
 * good — so anything still holding that database is left over: an older Realm's hand-off that sent
 * SIGTERM to a server whose shutdown then hung, and returned anyway. Its own shutdown had already
 * cleared `daemon.json` and released the lock, so nothing names it any more; the database is the one
 * thing it cannot have let go of. Only realm-server processes are returned — a `sqlite3` somebody has
 * open on the same file is not one.
 */
export function strayServers(home: string, keep: readonly number[], ops: Pick<ProcessOps, "holding" | "commandOf" | "self"> = realProcessOps): number[] {
  const db = `${home.replace(/\/+$/, "")}/realm.db`;
  const pids = new Set([...ops.holding(db), ...ops.holding(`${db}-wal`)]);
  return [...pids].filter((pid) => !keep.includes(pid) && runsServer(pid, SERVER_ENTRY_SUFFIX, ops)).sort((a, b) => a - b);
}

/** Stop every stray `strayServers` finds. Returns the pids it stopped. */
export async function stopStrayServers(home: string, keep: readonly number[], ops: ProcessOps = realProcessOps): Promise<number[]> {
  const strays = strayServers(home, keep, ops);
  await Promise.all(strays.map((pid) => stopServerProcess(pid, ops)));
  return strays;
}
