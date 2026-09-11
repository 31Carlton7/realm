// Electron main launches this bundle under its own binary with ELECTRON_RUN_AS_NODE=1 (see
// apps/desktop/src/main/server-process.ts). Drop the variable immediately: everything spawned from
// here (terminal shells, agent CLI probes, the agent SDKs' subprocesses) inherits this env, and a
// stray ELECTRON_RUN_AS_NODE=1 breaks any Electron-based tool a child might launch.
delete process.env.ELECTRON_RUN_AS_NODE;

import { generateSessionSummary, generateSessionTitle } from "@realm/adapters";
import { createApp, PROTOCOL } from "./app";
import { realmHome } from "./paths";
import { acquireLock, clearState, currentBundleId, newBootId, newToken, readState, releaseLock, writeState } from "./daemon/state";

const envPort = Number(process.env.REALM_PORT);
const port = Number.isFinite(envPort) && envPort >= 0 ? envPort : 0;
const bootId = newBootId();
const token = newToken();
const entry = process.argv[1] ?? "";
let lockedHome: string | null = null;

try {
  const home = realmHome();
  // Mutual exclusion is on the HOME, not the port. What two servers would corrupt is one `realm.db`:
  // two live-session maps, two schedulers claiming the same rows, two processes racing the migration
  // runner. Taking the lock BEFORE createApp means the loser has not yet opened the database.
  const lock = acquireLock(home, { pid: process.pid, bootId });
  if (lock.kind === "held") {
    // Not a failure — it is the ordinary answer for a second launch. The launcher reads the code and
    // adopts the daemon already running instead of showing the user an error about a lock file.
    const running = readState(home);
    process.stdout.write(JSON.stringify({ type: "error", code: "ALREADY_RUNNING", message: `realm-server is already running on this home (pid ${lock.pid})`, pid: lock.pid, port: running?.port ?? null }) + "\n");
    process.exit(3);
  }
  lockedHome = home;

  const app = await createApp({
    home, port, token, titleGenerator: generateSessionTitle, summaryGenerator: generateSessionSummary,
    // Plan 22: where Plynn's meeting exports are read from. Unset in production (the app's own
    // Application Support folder); live checks point it at a fixture so no real recording is read.
    plynnMeetingsDir: process.env.REALM_PLYNN_MEETINGS_DIR || undefined,
  });

  // The state file is written only now, because `createApp` is what binds the port — a file
  // announcing a port nothing is listening on is worse than no file at all.
  writeState(home, {
    version: 1, pid: process.pid, bootId, port: app.port, token, home, protocol: PROTOCOL,
    bundleId: currentBundleId(entry), entry, startedAt: Date.now(), state: "running",
  });

  // Still announced on stdout, unchanged, for the child-process mode `pnpm dev` and the live checks
  // use. A detached daemon has no parent to read it and the write goes nowhere, which is harmless —
  // the state file above is what a launcher actually reads. The token deliberately does NOT travel
  // this way: stdout is a log file in daemon mode, and a secret that only ever lives in one 0600 file
  // is a secret with one place to go wrong.
  process.stdout.write(JSON.stringify({ type: "ready", port: app.port, home }) + "\n");

  const shutdown = async () => {
    // Clear before closing: between these two a launcher must not read a file pointing at a socket
    // that is already refusing connections.
    clearState(home);
    releaseLock(home, { pid: process.pid });
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
} catch (e) {
  if (lockedHome) releaseLock(lockedHome, { pid: process.pid });
  const message = e instanceof Error ? e.message : String(e);
  process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
  process.exit(1);
}
