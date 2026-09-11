// Electron main launches this bundle under its own binary with ELECTRON_RUN_AS_NODE=1 (see
// apps/desktop/src/main/server-process.ts). Drop the variable immediately: everything spawned from
// here (terminal shells, agent CLI probes, the agent SDKs' subprocesses) inherits this env, and a
// stray ELECTRON_RUN_AS_NODE=1 breaks any Electron-based tool a child might launch.
delete process.env.ELECTRON_RUN_AS_NODE;

import { generateSessionSummary, generateSessionTitle } from "@realm/adapters";
import { createApp } from "./app";
import { DAEMON_PROTOCOL } from "@realm/contracts";
import { realmHome } from "./paths";
import { BOOT_ID, acquireLock, clearState, currentBundleId, newToken, readState, releaseLock, writeState } from "./daemon/state";

const envPort = Number(process.env.REALM_PORT);
const port = Number.isFinite(envPort) && envPort >= 0 ? envPort : 0;
const token = newToken();
const entry = process.argv[1] ?? "";
let lockedHome: string | null = null;
/** Set once the app exists; called when `daemon.drain` is accepted. */
let markDraining: (() => void) | null = null;

try {
  const home = realmHome();
  // Mutual exclusion is on the HOME, not the port. What two servers would corrupt is one `realm.db`:
  // two live-session maps, two schedulers claiming the same rows, two processes racing the migration
  // runner. Taking the lock BEFORE createApp means the loser has not yet opened the database.
  const lock = acquireLock(home, { pid: process.pid, bootId: BOOT_ID });
  if (lock.kind === "held") {
    // Not a failure — it is the ordinary answer for a second launch. The launcher reads the code and
    // adopts the daemon already running instead of showing the user an error about a lock file.
    const running = readState(home);
    process.stdout.write(JSON.stringify({ type: "error", code: "ALREADY_RUNNING", message: `realm-server is already running on this home (pid ${lock.pid})`, pid: lock.pid, port: running?.port ?? null }) + "\n");
    process.exit(3);
  }
  lockedHome = home;

  const app = await createApp({
    home, port, token,
    // Announced in the state file, not just held in memory: the next launcher reads that file before
    // it reads anything else.
    onDraining: () => markDraining?.(),
    titleGenerator: generateSessionTitle, summaryGenerator: generateSessionRecap,
    // Plan 22: where Plynn's meeting exports are read from. Unset in production (the app's own
    // Application Support folder); live checks point it at a fixture so no real recording is read.
    plynnMeetingsDir: process.env.REALM_PLYNN_MEETINGS_DIR || undefined,
  });

  // The state file is written only now, because `createApp` is what binds the port — a file
  // announcing a port nothing is listening on is worse than no file at all.
  writeState(home, {
    version: 1, pid: process.pid, bootId: BOOT_ID, port: app.port, token, home, protocol: DAEMON_PROTOCOL,
    bundleId: currentBundleId(entry), entry, startedAt: Date.now(), state: "running",
  });

  // A drain rewrites the state file so a launcher that arrives mid-drain sees `draining` and WAITS
  // rather than adopting a daemon that is on its way out — `decideLaunch` checks that before it
  // checks anything about the port, because a draining daemon answers perfectly well.
  markDraining = () => {
    const current = readState(home);
    if (current) writeState(home, { ...current, state: "draining" });
  };

  // Still announced on stdout, unchanged, for the child-process mode `pnpm dev` and the live checks
  // use. A detached daemon has no parent to read it and the write goes nowhere, which is harmless —
  // the state file above is what a launcher actually reads. The token deliberately does NOT travel
  // this way: stdout is a log file in daemon mode, and a secret that only ever lives in one 0600 file
  // is a secret with one place to go wrong.
  process.stdout.write(JSON.stringify({ type: "ready", port: app.port, home }) + "\n");

  // A headless crash is silent: nobody is watching stderr, and the next thing the user notices is an
  // app that will not start. One timestamped line into the log is the difference between that and a
  // question somebody can answer.
  const fatal = (kind: string) => (e: unknown) => {
    process.stderr.write(`[realm-server] ${new Date().toISOString()} ${kind}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    if (kind !== "uncaughtException") return;
    // Tidy up on the way out. Not load-bearing — a launcher finding a state file whose pid is gone
    // decides to spawn, and a lock whose pid is gone is broken and retaken — but leaving them behind
    // means the next launch's log says "stale" about a crash it could have said nothing about.
    try { clearState(home); releaseLock(home, { pid: process.pid }); } catch { /* nothing left to do */ }
    process.exit(1);
  };
  process.on("unhandledRejection", fatal("unhandledRejection"));
  process.on("uncaughtException", fatal("uncaughtException"));

  const shutdown = async () => {
    // Clear before closing: between these two a launcher must not read a file pointing at a socket
    // that is already refusing connections.
    clearState(home);
    releaseLock(home, { pid: process.pid });
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  // SIGHUP's default action is termination, and a daemon started from a terminal gets one when that
  // terminal closes. `detached: true` already puts us in our own session, out of the way of the
  // controlling terminal — this is the belt to that's brace, and it costs one line.
  process.on("SIGHUP", () => process.stderr.write("[realm-server] ignoring SIGHUP\n"));
} catch (e) {
  if (lockedHome) releaseLock(lockedHome, { pid: process.pid });
  const message = e instanceof Error ? e.message : String(e);
  process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
  process.exit(1);
}
