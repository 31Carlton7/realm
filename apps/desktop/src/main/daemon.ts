/**
 * What to do about the realm-server that may or may not already be running.
 *
 * Before this, launching Realm meant spawning a server child and reading its port off a pipe. A
 * daemon outlives the app, so the first question at launch is no longer "which port did my child
 * pick" but "is one of mine already up, and is it the one I want to talk to". `decideLaunch` is that
 * question as a pure function, because it is the heart of the feature and every branch of it is a way
 * the app can fail to start.
 *
 * Liveness takes all three facts, because any one of them lies on its own:
 *
 *   - the pid is alive — but pids are reused, so this alone can point at somebody else's process;
 *   - the port answers — but anything can be listening on a port a dead daemon used to hold;
 *   - `system.info` returns the SAME bootId as the file — the only test that says "this is the daemon
 *     that wrote this file", and the only reason the other two are worth asking.
 */
import { performance } from "node:perf_hooks";
import { DAEMON_PROTOCOL_MAX, DAEMON_PROTOCOL_MIN, type DaemonState } from "@realm/contracts";

/** What `system.info` said, or null for a port that did not answer in time. */
export type Probe = { bootId: string; protocol: number } | null;

export type LaunchDecision =
  | { kind: "adopt"; state: DaemonState }
  /** Nothing usable is running. `none` — no state file at all; `dead` — the file names a pid that is
   *  gone; `stale` — the pid is alive and the port answers, but as somebody other than our daemon. */
  | { kind: "spawn"; reason: "none" | "dead" | "stale" }
  /** A daemon of ours is up, but it is not running code this app can drive. `replaced` — the
   *  Realm.app it was started from has been replaced on disk since (an update, a reinstall): it is
   *  running files that are gone, and loads the new bundle's in their place for anything it has not
   *  loaded yet. */
  | { kind: "handoff"; state: DaemonState; why: HandoffWhy }
  /** Something is there and not answering yet: mid-boot, or draining for a handoff already underway.
   *  The caller waits and asks again rather than starting a second one. */
  | { kind: "wait"; state: DaemonState; why: "booting" | "draining" };

export type HandoffWhy = "bundle" | "protocol" | "replaced";

export function decideLaunch(d: {
  state: DaemonState | null;
  pidAlive: boolean;
  probe: Probe;
  /** What THIS app ships: the bundle it would spawn, and the range of wire versions it can drive. */
  ours: { bundleId: string; protocolMin?: number; protocolMax?: number };
  /** The bundle id of whatever is at the daemon's own `entry` now (`currentBundleId`'s "missing" for
   *  nothing). Unknown — undefined — is never read as replaced. */
  onDisk?: string;
}): LaunchDecision {
  const { state, pidAlive, probe, ours } = d;
  if (!state) return { kind: "spawn", reason: "none" };
  // The pid first, because it is the one fact we can check without a round trip, and a file naming a
  // dead process is by far the commonest case — every crash and every hard shutdown leaves one.
  if (!pidAlive) return { kind: "spawn", reason: "dead" };
  // Before the drain and the probe: a daemon whose own files were replaced under it is what an update
  // leaves behind (ShipIt renames the old Realm.app away and deletes it), and nothing it says changes
  // what happens to it. It cannot be kept working — the next chunk it loads is the new bundle's — so
  // there is nothing to ask it, and nothing to wait for if it will not answer.
  if (d.onDisk !== undefined && d.onDisk !== state.bundleId) return { kind: "handoff", state, why: "replaced" };
  // Draining is checked before the port, because a draining daemon still answers perfectly well and
  // would otherwise be adopted — which is precisely the thing a drain exists to stop.
  if (state.state === "draining") return { kind: "wait", state, why: "draining" };
  if (!probe) return { kind: "wait", state, why: "booting" };
  // A different bootId on the recorded port is not our daemon, whatever the pid says. Spawning is
  // safe even if we are wrong about that, because realm-server's own home lock is the backstop.
  if (probe.bootId !== state.bootId) return { kind: "spawn", reason: "stale" };
  const min = ours.protocolMin ?? DAEMON_PROTOCOL_MIN;
  const max = ours.protocolMax ?? DAEMON_PROTOCOL_MAX;
  if (probe.protocol < min || probe.protocol > max) return { kind: "handoff", state, why: "protocol" };
  // Bundle last: a daemon on a compatible wire running older code is still usable for the moments it
  // takes to hand off, which is why this is the branch with a "Keep working" option and the one above
  // is not.
  if (state.bundleId !== ours.bundleId) return { kind: "handoff", state, why: "bundle" };
  return { kind: "adopt", state };
}

/**
 * Ask a port whether it is a realm-server, and which one.
 *
 * A short timeout on purpose: this runs on the path that decides whether Realm can start at all, and
 * "did not answer" is a perfectly good answer — the caller waits and asks again. Any failure at all,
 * including a refused handshake because the token in the file is stale, reads as null.
 */
export function probeDaemon(d: { port: number; token: string; timeoutMs?: number }): Promise<Probe> {
  return callDaemon(d, "system.info", {}, d.timeoutMs).then((result) => {
    const r = result as { bootId?: unknown; protocol?: unknown } | null;
    if (typeof r?.bootId !== "string" || typeof r.protocol !== "number") return null;
    return { bootId: r.bootId, protocol: r.protocol };
  }).catch(() => null);
}

/**
 * One RPC call on a daemon we are not attached to.
 *
 * A socket per call, deliberately: this is used before the bridge exists (the probe) and against a
 * daemon we are about to replace (`daemon.info`, `daemon.stop`), neither of which is a connection
 * worth keeping. Every failure — refused handshake because the token in the file is stale, a port
 * answered by something else, silence — rejects, and every caller reads that as "no answer".
 */
export function callDaemon(d: { port: number; token: string }, method: string, params: unknown, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`${method} timed out`))), timeoutMs);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${d.port}`, [`realm.${d.token}`]);
    } catch (e) {
      clearTimeout(timer);
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: "one", method, params })));
    ws.addEventListener("error", () => done(() => reject(new Error(`${method} failed`))));
    ws.addEventListener("close", () => done(() => reject(new Error(`${method}: socket closed`))));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { id?: string; ok?: boolean; result?: unknown; error?: { message?: string } };
        if (m.id !== "one") return;
        done(() => (m.ok ? resolve(m.result) : reject(new Error(m.error?.message ?? method))));
      } catch { done(() => reject(new Error(`${method}: unreadable answer`))); }
    });
  });
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM means the process exists and belongs to somebody else — alive for our purposes.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The two facts a client needs to get onto realm-server's socket. */
export type DaemonEndpoint = { port: number; token: string };

/**
 * Where realm-server is now: the endpoint `daemon.json` records, when that is a different one and the
 * pid that wrote it is alive; otherwise `known`.
 *
 * A server mints its port and token at every boot, so the one the supervisor started after a crash
 * is somewhere nothing attached to the old one knows about. The file is the only place that says
 * where. A file still naming the dead server — a crash does not clear it — names a pid that is gone,
 * and is not followed; neither is a server on its way out.
 */
export function followDaemon(known: DaemonEndpoint, recorded: DaemonState | null, pidAlive: (pid: number) => boolean = isAlive): DaemonEndpoint {
  if (!recorded || recorded.state !== "running") return known;
  if (recorded.port === known.port && recorded.token === known.token) return known;
  if (!pidAlive(recorded.pid)) return known;
  return { port: recorded.port, token: recorded.token };
}

/** How long a `wait` decision is honoured before we stop believing in the daemon it named. Matches
 *  the ready-line timeout the child-process path has always used. */
export const DAEMON_WAIT_MS = 15_000;
/** How long a daemon this launch did not start may go without answering before it is replaced. It
 *  wrote its state file, so it finished booting long ago: one that will not answer `system.info` for
 *  this long is stuck, and waiting on it is how every launch after an update failed to start. */
export const DAEMON_UNRESPONSIVE_MS = 10_000;

export type DaemonHandle = {
  port: number; home: string; token: string; adopted: boolean; state: DaemonState;
  /** Set when we are attached to a daemon this app did not ship, because the user chose to keep it
   *  working. The UI says so and refuses to start new sessions against it; null is the ordinary case. */
  stale: "bundle" | "protocol" | null;
};

/** What a handoff did. `replaced` means the old daemon is gone and the loop should look again;
 *  `adopt` means the user chose to carry on with it. */
export type HandoffResult = { kind: "replaced" } | { kind: "adopt"; stale: "bundle" | "protocol" };

/**
 * Get a realm-server we can talk to, starting one only if there isn't one.
 *
 * The loop exists for the `wait` case, and only for it: a daemon that is mid-boot or mid-drain will
 * shortly become a decision this function can act on, and starting a second one in the meantime is
 * the failure this whole file is arranged to prevent. Every other decision is terminal on the first
 * pass.
 */
export async function ensureDaemon(d: {
  home: string;
  ourBundleId: string;
  readState: (home: string) => DaemonState | null;
  probe: (port: number, token: string) => Promise<Probe>;
  spawn: (home: string) => void;
  onHandoff: (state: DaemonState, why: HandoffWhy) => Promise<HandoffResult>;
  /** Stop a daemon this launch did not start that will not answer, or will not finish a drain nobody
   *  is waiting on any more. Resolves once it is gone, or is known not to be a realm-server at all. */
  replace: (state: DaemonState, why: "unresponsive" | "draining") => Promise<void>;
  /** The bundle id now at a daemon's `entry` (see `decideLaunch`'s `onDisk`). */
  bundleOnDisk?: (entry: string) => string;
  /** Stop any realm-server still holding this home that no state file names — called right before
   *  this launch starts the one a home may have. */
  clearStrays?: () => Promise<void>;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<DaemonHandle> {
  const pidAlive = d.pidAlive ?? isAlive;
  // Monotonic: a launch the Mac slept through (the lid closed on an update's relaunch) must not wake
  // to find every deadline it set already in the past.
  const now = d.now ?? (() => performance.now());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The budget bounds ONE wait for a daemon to come up — not the whole orchestration. Stopping a
  // daemon we are replacing legitimately takes seconds, and charging that to the replacement's clock
  // is how a handoff on a slow machine fails to start anything at all. So every ACTION restarts it.
  let deadline = now() + DAEMON_WAIT_MS;
  let spawned = false;
  /** When each daemon we have waited on, by boot id, was first found not answering. */
  const waitingSince = new Map<string, number>();
  /** Daemons already handed off or replaced, by boot id. One still there afterwards is not going. */
  const replaced = new Set<string>();

  for (;;) {
    const state = d.readState(d.home);
    const alive = state ? pidAlive(state.pid) : false;
    const onDisk = state && alive ? d.bundleOnDisk?.(state.entry) : undefined;
    // Not asked of a server running a replaced bundle: nothing it answers changes what happens to it,
    // and one that cannot answer would cost the probe's whole timeout.
    const replacedOnDisk = state !== null && onDisk !== undefined && onDisk !== state.bundleId;
    const decision = decideLaunch({
      state,
      pidAlive: alive,
      probe: state && alive && !replacedOnDisk ? await d.probe(state.port, state.token) : null,
      ours: { bundleId: d.ourBundleId },
      onDisk,
    });

    if (decision.kind === "adopt") {
      d.log?.(`[daemon] adopted pid ${decision.state.pid} on port ${decision.state.port}`);
      return { port: decision.state.port, home: d.home, token: decision.state.token, adopted: !spawned, state: decision.state, stale: null };
    }
    if (decision.kind === "handoff") {
      // A hand-off that said `replaced` and left the daemon where it was would otherwise be asked again
      // on every pass, each one restarting the clock that is meant to end this.
      if (replaced.has(decision.state.bootId)) {
        throw new Error(`the previous realm-server (pid ${decision.state.pid}) could not be stopped — see the log under ${d.home}/logs/server.log`);
      }
      replaced.add(decision.state.bootId);
      d.log?.(`[daemon] running daemon ${decision.why === "replaced" ? "is running a Realm.app that has been replaced" : `is a different ${decision.why}`}; handing off`);
      const outcome = await d.onHandoff(decision.state, decision.why);
      // `adopt` is the user choosing to carry on with the old server. Returned from here rather than
      // looped back into `decideLaunch`, which would decide `handoff` again and ask a second time.
      if (outcome.kind === "adopt") {
        return { port: decision.state.port, home: d.home, token: decision.state.token, adopted: true, state: decision.state, stale: outcome.stale };
      }
      // `replaced`: the old daemon is going away, and however long that took is not time the
      // replacement should be charged for. The next pass reads the world again rather than assuming
      // how far along it is.
      deadline = now() + DAEMON_WAIT_MS;
    } else if (decision.kind === "spawn") {
      // Once. A spawn that has not produced a readable state file yet reads as `none` on the next
      // pass, and spawning again on that would be exactly the two-daemons bug.
      if (!spawned) {
        // Whatever still holds this home now is left over from a hand-off that did not finish, and its
        // home lock is released, so it would not even stop ours from starting — only run beside it.
        await d.clearStrays?.();
        d.log?.(`[daemon] starting realm-server (${decision.reason})`);
        d.spawn(d.home);
        spawned = true;
        deadline = now() + DAEMON_WAIT_MS;
      }
    } else if (!spawned) {
      // A daemon that was here before this launch, and has had its chance: it wrote its state file, so
      // it finished booting long ago, and one that will not answer is stuck. A drain that has not
      // finished in the budget is waiting on agents that may never stop, and the launcher that asked
      // for it is not here to stop it. Either way it is in the way, and waiting longer is how every
      // launch after an update ended in "Realm failed to start".
      d.log?.(`[daemon] waiting for realm-server (${decision.why})`);
      const { state: stuck } = decision;
      if (replaced.has(stuck.bootId)) {
        throw new Error(`realm-server (pid ${stuck.pid}) is not answering and could not be stopped — see the log under ${d.home}/logs/server.log`);
      }
      if (!waitingSince.has(stuck.bootId)) waitingSince.set(stuck.bootId, now());
      if (now() - waitingSince.get(stuck.bootId)! >= (decision.why === "draining" ? DAEMON_WAIT_MS : DAEMON_UNRESPONSIVE_MS)) {
        d.log?.(`[daemon] pid ${stuck.pid} is ${decision.why === "draining" ? "still draining" : "not answering"}; replacing it`);
        replaced.add(stuck.bootId);
        await d.replace(stuck, decision.why === "draining" ? "draining" : "unresponsive");
        deadline = now() + DAEMON_WAIT_MS;
        continue;
      }
      await sleep(200);
      continue;
    } else {
      d.log?.(`[daemon] waiting for realm-server (${decision.why})`);
    }

    if (now() >= deadline) {
      const what = decision.kind === "spawn" || spawned ? "did not report ready" : "could not be replaced";
      throw new Error(`realm-server ${what} within ${DAEMON_WAIT_MS / 1000}s — see the log under ${d.home}/logs/server.log`);
    }
    await sleep(200);
  }
}

/**
 * Whether this launch runs realm-server as a daemon at all.
 *
 * Packaged builds only, by default. Under `pnpm dev` the server is rebuilt constantly and a daemon
 * that survives the app is a daemon running yesterday's code until somebody notices — and every one
 * of the live-check scripts drives a server child on a scratch home and expects it to die with the
 * app it started. Orphaned daemons in development are the likeliest daily annoyance this feature has;
 * defaulting it off is most of the fix. `REALM_DAEMON=1` opts a dev build in, `REALM_DAEMON=0` opts a
 * packaged build out — which is how `packaged-smoke.cjs` launches the real app without leaking one.
 *
 * And a Mac only, by default. An AppImage runs from a mount that goes away when the app that mounted
 * it exits, taking a daemon's own executable with it; on Windows a daemon still running from the
 * install folder holds it open, so the installer can neither update nor remove Realm. There the
 * server is the app's child and stops with it.
 */
export function daemonModeEnabled(d: { packaged: boolean; env: string | undefined; platform?: string }): boolean {
  if (d.env === "1" || d.env === "true") return true;
  if (d.env === "0" || d.env === "false") return false;
  return d.packaged && (d.platform ?? "darwin") === "darwin";
}
