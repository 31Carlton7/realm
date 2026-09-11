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
import { DAEMON_PROTOCOL_MAX, DAEMON_PROTOCOL_MIN, type DaemonState } from "@realm/contracts";

/** What `system.info` said, or null for a port that did not answer in time. */
export type Probe = { bootId: string; protocol: number } | null;

export type LaunchDecision =
  | { kind: "adopt"; state: DaemonState }
  /** Nothing usable is running. `none` — no state file at all; `dead` — the file names a pid that is
   *  gone; `stale` — the pid is alive and the port answers, but as somebody other than our daemon. */
  | { kind: "spawn"; reason: "none" | "dead" | "stale" }
  /** A daemon of ours is up, but it is not running code this app can drive. */
  | { kind: "handoff"; state: DaemonState; why: "bundle" | "protocol" }
  /** Something is there and not answering yet: mid-boot, or draining for a handoff already underway.
   *  The caller waits and asks again rather than starting a second one. */
  | { kind: "wait"; state: DaemonState; why: "booting" | "draining" };

export function decideLaunch(d: {
  state: DaemonState | null;
  pidAlive: boolean;
  probe: Probe;
  /** What THIS app ships: the bundle it would spawn, and the range of wire versions it can drive. */
  ours: { bundleId: string; protocolMin?: number; protocolMax?: number };
}): LaunchDecision {
  const { state, pidAlive, probe, ours } = d;
  if (!state) return { kind: "spawn", reason: "none" };
  // The pid first, because it is the one fact we can check without a round trip, and a file naming a
  // dead process is by far the commonest case — every crash and every hard shutdown leaves one.
  if (!pidAlive) return { kind: "spawn", reason: "dead" };
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
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), d.timeoutMs ?? 2_000);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${d.port}`, [`realm.${d.token}`]);
    } catch {
      clearTimeout(timer);
      return resolve(null);
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: "probe", method: "system.info", params: {} })));
    ws.addEventListener("error", () => done(null));
    ws.addEventListener("close", () => done(null));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "") as
          { id?: string; ok?: boolean; result?: { bootId?: unknown; protocol?: unknown } };
        if (m.id !== "probe") return;
        if (!m.ok || typeof m.result?.bootId !== "string" || typeof m.result.protocol !== "number") return done(null);
        done({ bootId: m.result.bootId, protocol: m.result.protocol });
      } catch { done(null); }
    });
  });
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM means the process exists and belongs to somebody else — alive for our purposes.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** How long a `wait` decision is honoured before we stop believing in the daemon it named. Matches
 *  the ready-line timeout the child-process path has always used. */
export const DAEMON_WAIT_MS = 15_000;

export type DaemonHandle = { port: number; home: string; token: string; adopted: boolean; state: DaemonState };

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
  onHandoff: (state: DaemonState, why: "bundle" | "protocol") => Promise<void>;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<DaemonHandle> {
  const pidAlive = d.pidAlive ?? isAlive;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + DAEMON_WAIT_MS;
  let spawned = false;

  for (;;) {
    const state = d.readState(d.home);
    const decision = decideLaunch({
      state,
      pidAlive: state ? pidAlive(state.pid) : false,
      probe: state ? await d.probe(state.port, state.token) : null,
      ours: { bundleId: d.ourBundleId },
    });

    if (decision.kind === "adopt") {
      d.log?.(`[daemon] adopted pid ${decision.state.pid} on port ${decision.state.port}`);
      return { port: decision.state.port, home: d.home, token: decision.state.token, adopted: !spawned, state: decision.state };
    }
    if (decision.kind === "handoff") {
      d.log?.(`[daemon] running daemon is a different ${decision.why}; handing off`);
      await d.onHandoff(decision.state, decision.why);
      // Whatever the handoff did — stopped the old daemon, or left it running because the user chose
      // to keep working — the next pass reads the world again rather than assuming an outcome.
    } else if (decision.kind === "spawn") {
      // Once. A spawn that has not produced a readable state file yet reads as `none` on the next
      // pass, and spawning again on that would be exactly the two-daemons bug.
      if (!spawned) {
        d.log?.(`[daemon] starting realm-server (${decision.reason})`);
        d.spawn(d.home);
        spawned = true;
      }
    } else {
      d.log?.(`[daemon] waiting for realm-server (${decision.why})`);
    }

    if (now() >= deadline) {
      const what = decision.kind === "spawn" ? "did not report ready" : `is ${decision.kind === "wait" ? decision.why : "not usable"}`;
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
 */
export function daemonModeEnabled(d: { packaged: boolean; env: string | undefined }): boolean {
  if (d.env === "1" || d.env === "true") return true;
  if (d.env === "0" || d.env === "false") return false;
  return d.packaged;
}
