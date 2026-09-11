import { describe, expect, it } from "vitest";
import { DAEMON_WAIT_MS, daemonModeEnabled, decideLaunch, ensureDaemon, type Probe } from "./daemon";
import type { DaemonState } from "@realm/contracts";

const OURS = { bundleId: "100:200" };
const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  version: 1, pid: 4242, bootId: "boot-a", port: 8790, token: "t", home: "/tmp/realm",
  protocol: 1, bundleId: OURS.bundleId, entry: "/Applications/Realm.app/…/main.js",
  startedAt: 1_757_000_000_000, state: "running", ...over,
});
const probe = (over: Partial<NonNullable<Probe>> = {}): Probe => ({ bootId: "boot-a", protocol: 1, ...over });

describe("decideLaunch", () => {
  it("spawns when there is nothing to adopt", () => {
    expect(decideLaunch({ state: null, pidAlive: false, probe: null, ours: OURS }))
      .toEqual({ kind: "spawn", reason: "none" });
    // A file naming a dead pid: every crash and hard shutdown leaves one.
    expect(decideLaunch({ state: state(), pidAlive: false, probe: null, ours: OURS }))
      .toEqual({ kind: "spawn", reason: "dead" });
  });

  it("adopts only a daemon that proves it is the one the file describes", () => {
    expect(decideLaunch({ state: state(), pidAlive: true, probe: probe(), ours: OURS }))
      .toEqual({ kind: "adopt", state: state() });
    // Pid alive AND port answering — and still not ours, because the bootId disagrees. This is pid
    // reuse plus an unrelated listener, and adopting it would hand the app to a stranger.
    expect(decideLaunch({ state: state(), pidAlive: true, probe: probe({ bootId: "somebody-else" }), ours: OURS }))
      .toEqual({ kind: "spawn", reason: "stale" });
  });

  it("waits rather than starting a second daemon when one is mid-flight", () => {
    expect(decideLaunch({ state: state(), pidAlive: true, probe: null, ours: OURS }))
      .toEqual({ kind: "wait", state: state(), why: "booting" });
    // Draining is judged before the probe: a draining daemon answers perfectly well, and adopting it
    // is exactly what the drain exists to prevent.
    const draining = state({ state: "draining" });
    expect(decideLaunch({ state: draining, pidAlive: true, probe: probe(), ours: OURS }))
      .toEqual({ kind: "wait", state: draining, why: "draining" });
  });

  it("hands off a daemon running code this app cannot drive", () => {
    const old = state({ bundleId: "99:1" });
    expect(decideLaunch({ state: old, pidAlive: true, probe: probe(), ours: OURS }))
      .toEqual({ kind: "handoff", state: old, why: "bundle" });
    // Protocol outranks bundle: an incompatible wire has no "Keep working" option to offer.
    const future = state({ bundleId: "99:1" });
    expect(decideLaunch({ state: future, pidAlive: true, probe: probe({ protocol: 7 }), ours: { ...OURS, protocolMax: 2 } }))
      .toEqual({ kind: "handoff", state: future, why: "protocol" });
    expect(decideLaunch({ state: state(), pidAlive: true, probe: probe({ protocol: 0 }), ours: { ...OURS, protocolMin: 1 } }))
      .toEqual({ kind: "handoff", state: state(), why: "protocol" });
  });

  it("a dead pid outranks everything, including a port that still answers", () => {
    // The port answering with our own bootId while the pid is gone cannot happen honestly; if it
    // does, the file is the thing we trust least and starting fresh is the safe answer.
    expect(decideLaunch({ state: state(), pidAlive: false, probe: probe(), ours: OURS }))
      .toEqual({ kind: "spawn", reason: "dead" });
  });
});

describe("ensureDaemon", () => {
  /** A world the test drives: what the state file says, and what the port answers. */
  const world = (initial: DaemonState | null) => {
    let file = initial;
    let clock = 0;
    const log: string[] = [];
    return {
      log,
      spawns: 0,
      handoffs: [] as string[],
      set: (s: DaemonState | null) => { file = s; },
      deps() {
        return {
          home: "/tmp/realm", ourBundleId: OURS.bundleId,
          readState: () => file,
          probe: async (_port: number, _token: string): Promise<Probe> => (file ? probe({ bootId: file.bootId, protocol: file.protocol }) : null),
          spawn: () => { this.spawns++; },
          onHandoff: async (_s: DaemonState, why: "bundle" | "protocol") => { this.handoffs.push(why); return { kind: "replaced" as const }; },
          pidAlive: () => true,
          now: () => clock,
          sleep: async (ms: number) => { clock += ms; },
          log: (l: string) => log.push(l),
        };
      },
    };
  };

  it("adopts a running daemon without spawning anything", async () => {
    const w = world(state());
    const handle = await ensureDaemon(w.deps());
    expect(handle).toMatchObject({ port: 8790, token: "t", adopted: true });
    expect(w.spawns).toBe(0);
  });

  it("spawns exactly once while the new daemon is coming up", async () => {
    const w = world(null);
    // The spawned daemon writes its state file three polls in. Until then the world reads as `none`,
    // which is the shape that would spawn again if the loop were not keeping count.
    let polls = 0;
    const deps = w.deps();
    const handle = await ensureDaemon({
      ...deps,
      readState: () => (++polls > 3 ? state() : null),
      probe: async () => (polls > 3 ? probe() : null),
    });
    expect(handle.port).toBe(8790);
    expect(handle.adopted).toBe(false);
    expect(w.spawns).toBe(1);
  });

  it("waits out a daemon that is still booting rather than starting a second one", async () => {
    const w = world(state());
    let polls = 0;
    const handle = await ensureDaemon({ ...w.deps(), probe: async () => (++polls > 4 ? probe() : null) });
    expect(handle.port).toBe(8790);
    expect(w.spawns).toBe(0);
    expect(w.log.filter((l) => l.includes("booting")).length).toBe(4);
  });

  it("gives up with the log path once the wait budget is spent", async () => {
    const w = world(state());
    await expect(ensureDaemon({ ...w.deps(), probe: async () => null }))
      .rejects.toThrow(/booting within 15s.*logs\/server\.log/s);
    expect(w.spawns).toBe(0);
  });

  it("hands off, then re-reads the world rather than assuming what the handoff did", async () => {
    const w = world(state({ bundleId: "an-older-build" }));
    const deps = w.deps();
    const handle = await ensureDaemon({
      ...deps,
      // The handoff stopped the old daemon and a new one came up on the current bundle.
      onHandoff: async (_s, why) => { w.handoffs.push(why); w.set(state()); return { kind: "replaced" as const }; },
      readState: () => deps.readState(),
    });
    expect(w.handoffs).toEqual(["bundle"]);
    expect(handle.state.bundleId).toBe(OURS.bundleId);
  });

  it("budgets the wait at the same 15s the ready line always used", () => {
    expect(DAEMON_WAIT_MS).toBe(15_000);
  });

  it("does not charge the replacement for the time it took to stop the old daemon", async () => {
    const w = world(state({ bundleId: "an-older-build" }));
    const deps = w.deps();
    let sinceSpawn = 0;
    const handle = await ensureDaemon({
      ...deps,
      // A real handoff SIGTERMs the old daemon and waits for its pid to go — seconds, on a machine
      // under load. MUTANT: keep one deadline for the whole orchestration and this throws, which is
      // exactly what a live check caught: "realm-server did not report ready within 15s", on every
      // update where the old server took a moment to exit.
      onHandoff: async (_s, why) => { w.handoffs.push(why); await deps.sleep(12_000); w.set(null); return { kind: "replaced" as const }; },
      // The replacement takes a few polls to write its state file, as a cold boot does.
      spawn: () => { deps.spawn(); sinceSpawn = 1; },
      readState: () => { if (sinceSpawn > 0 && sinceSpawn++ > 3) w.set(state()); return deps.readState(); },
    });
    expect(handle.state.bundleId).toBe(OURS.bundleId);
    expect(w.spawns).toBe(1);
    expect(w.handoffs).toEqual(["bundle"]);
  });

  it("adopts the old daemon when the user chooses to keep working, and says it is stale", async () => {
    const w = world(state({ bundleId: "an-older-build" }));
    const handle = await ensureDaemon({
      ...w.deps(),
      onHandoff: async () => ({ kind: "adopt" as const, stale: "bundle" as const }),
    });
    // MUTANT: loop back into decideLaunch after an adopt and the same dialog is asked again, forever,
    // until the wait budget runs out.
    expect(handle.stale).toBe("bundle");
    expect(handle.port).toBe(8790);
    expect(w.spawns).toBe(0);
  });

  it("leaves `stale` null on an ordinary adopt", async () => {
    const w = world(state());
    expect((await ensureDaemon(w.deps())).stale).toBeNull();
});

describe("daemonModeEnabled", () => {
  it("is packaged-only until asked otherwise", () => {
    expect(daemonModeEnabled({ packaged: true, env: undefined })).toBe(true);
    expect(daemonModeEnabled({ packaged: false, env: undefined })).toBe(false);
    // Both overrides matter: `1` is how a dev build gets a daemon, `0` is how packaged-smoke launches
    // the real app without leaving one behind.
    expect(daemonModeEnabled({ packaged: false, env: "1" })).toBe(true);
    expect(daemonModeEnabled({ packaged: true, env: "0" })).toBe(false);
    expect(daemonModeEnabled({ packaged: true, env: "" })).toBe(true);
  });
});
});