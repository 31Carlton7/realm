import { describe, expect, it } from "vitest";
import { moveFailedSentence, type Environment, type Session, type SessionEvent } from "@realm/contracts";
import { moveInFlightKey, runMove, undoInterruptedMove, type MoveDeps, type MoveInFlight, type MovePlan } from "./move";
import type { CapturedState } from "../workspace/checkpoints";

/**
 * `runMove` on fakes, for what the RPC tests cannot time: a turn starting in a checkout, or a
 * checkout changing, while the move is under way.
 */
const env = (id: string, path: string): Environment => ({ id, path, branch: "main", kind: "checkout", spaceId: "sp" }) as Environment;
const SOURCE = env("e-src", "/src");
const TARGET = env("e-dst", "/dst");
const state = (commitSha: string): CapturedState => ({ commitSha, worktreeTree: `${commitSha}-tree`, indexTree: `${commitSha}-index`, headSha: "head", headRef: "refs/heads/main" });
const session = { id: "s1", spaceId: "sp", environmentId: SOURCE.id, agentKind: "codex", providerSessionId: null, accountId: null, title: "t", status: "idle" } as unknown as Session;

/** `changed`: the checkouts that changed since the move last looked; `busy`: asked with the calls so far. */
function fakes(o: { busy?: (environmentId: string, calls: string[]) => boolean; changed?: string[]; work?: string[]; bootFails?: boolean; worktreeFails?: string } = {}) {
  const calls: string[] = [];
  const settings = new Map<string, unknown>();
  const events: SessionEvent[] = [];
  const d: MoveDeps = {
    db: { exec: () => {} } as never,
    sessions: { update: () => {}, setEnvironment: () => {} } as never,
    events: { transcript: () => [] } as never,
    settings: { get: (k: string) => settings.get(k) ?? null, set: (k: string, v: unknown) => { settings.set(k, v); } } as never,
    git: {
      isRepository: async () => true,
      changedFiles: async () => 2,
      secretLookingIgnored: async () => [],
      mergedTree: async () => "merged-tree",
      applyChanges: async (i: { cwd: string }) => {
        // The undo is on disk before there is anything to undo.
        const kept = settings.get(moveInFlightKey(session.id)) as MoveInFlight | undefined;
        calls.push(`apply ${i.cwd}${kept?.merged?.path === i.cwd ? "" : " (nothing kept)"}`);
      },
      extract: async (i: { cwd: string }) => { calls.push(`extract ${i.cwd}`); },
      restore: async (i: { cwd: string }) => { calls.push(`restore ${i.cwd}`); },
      hazard: async (i: { cwd: string; state: CapturedState }) => {
        calls.push(`hazard ${i.cwd} ${i.state.worktreeTree}`);
        return { filesChanged: o.changed?.includes(i.cwd) ? 1 : 0, commitsRolledBack: 0, headMovable: true, headReason: null };
      },
      resetToHead: async (cwd: string) => { calls.push(`reset ${cwd}`); },
    } as never,
    environment: (id) => [SOURCE, TARGET].find((e) => e.id === id) ?? null,
    othersWorkingIn: (environmentId) => o.busy?.(environmentId, calls) ?? false,
    capture: async (c) => ({ state: state(c.environmentId) }),
    createWorktree: async () => {
      if (o.worktreeFails) throw new Error(o.worktreeFails);
      return env("e-new", "/new");
    },
    discardWorktree: async () => { calls.push("discard"); },
    stop: async () => {},
    engineWork: async () => o.work ?? [],
    boot: async () => {
      if (o.bootFails) throw new Error("the boot timed out");
      return { providerSessionId: "p", resumeOutcome: "declined" } as never;
    },
    emit: (_id, ev) => { events.push(ev); },
    broadcastStatus: () => {},
    closeTerminal: () => false,
  };
  return { d, calls, settings, events };
}
const plan = (o: Partial<MovePlan> = {}): MovePlan => ({ moveId: "m1", to: { kind: "environment", environmentId: TARGET.id }, keepSourceChanges: true, stopping: false, signal: new AbortController().signal, ...o });
const moved = (events: SessionEvent[]) => events.find((e) => e.type === "moved")?.payload as { leftBehind: string[] } | undefined;
const failed = (events: SessionEvent[]) => events.find((e) => e.type === "move_failed")?.payload as { note: string; reason: string; from?: unknown } | undefined;
/** A session whose engine boots at the target, so the move waits there after the merge. */
const booting = { ...session, providerSessionId: "p" } as Session;

describe("runMove", () => {
  it("does not merge into a checkout a session started working in after the move was asked for", async () => {
    const { d, calls, events } = fakes({ busy: (id) => id === TARGET.id });
    await expect(runMove(d, session, plan())).rejects.toThrow("another session started working in that checkout");
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "move_failed", payload: { step: "place" } });
  });

  it("does not stop background work the agent started after the move was asked for, unless it is stopping", async () => {
    const { d, calls, events } = fakes({ work: ["a background command"] });
    await expect(runMove(d, session, plan())).rejects.toThrow("its agent is still running a background command, which moving would stop");
    expect(events.at(-1)).toMatchObject({ type: "move_failed", payload: { step: "preflight" } });
    expect(calls).toEqual([]);

    await runMove(d, session, plan({ stopping: true }));
    expect(moved(events)?.leftBehind).toEqual(["a background command (stopped)"]);
  });

  it("leaves the source's changes where they are when a session started working there during the move", async () => {
    const { d, calls, events } = fakes({ busy: (id) => id === SOURCE.id });
    await runMove(d, session, plan({ keepSourceChanges: false }));
    expect(calls).not.toContain("reset /src");
    expect(moved(events)?.leftBehind).toEqual(["its uncommitted changes (another session is working there)"]);
  });

  it("leaves the source's changes where they are when they changed after the checkpoint", async () => {
    const { d, calls, events } = fakes({ changed: ["/src"] });
    await runMove(d, session, plan({ keepSourceChanges: false }));
    expect(calls).not.toContain("reset /src");
    expect(moved(events)?.leftBehind).toEqual(["its uncommitted changes (they changed during the move)"]);
  });

  it("resets the source once the changes are across and nothing has touched it", async () => {
    const { d, calls, events, settings } = fakes();
    await runMove(d, session, plan({ keepSourceChanges: false }));
    expect(calls).toEqual(["apply /dst", "hazard /src e-src-tree", "reset /src"]);
    expect(moved(events)?.leftBehind).toEqual([]);
    expect(settings.get(moveInFlightKey(session.id))).toBeNull();
  });

  it("keeps the move on disk before it says its first step, so a server that stops after that can close it", async () => {
    const { d, settings } = fakes({ work: ["a background command"] });
    const told: (string | undefined)[] = [];
    d.emit = (_id, ev) => { if (ev.type === "moving") told.push((settings.get(moveInFlightKey(session.id)) as MoveInFlight | null)?.moveId); };
    await expect(runMove(d, session, plan())).rejects.toThrow("which moving would stop");
    expect(told).toEqual(["m1"]);
    expect(settings.get(moveInFlightKey(session.id))).toBeNull();
  });

  it("keeps what takes a merge back on disk before it merges, so a server that stops in between can", async () => {
    const { d, calls } = fakes();
    await runMove(d, session, plan());
    expect(calls).toEqual(["apply /dst"]);
  });

  it("takes back what it merged into a checkout when a later step fails and nothing has touched it since", async () => {
    const { d, calls, events } = fakes({ bootFails: true });
    await expect(runMove(d, booting, plan())).rejects.toThrow("the boot timed out");
    expect(calls).toEqual(["apply /dst", "hazard /dst merged-tree", "restore /dst"]);
    expect(failed(events)?.note).toBe("Couldn't move this session while starting the agent. It's still in src (main).");
  });

  it("leaves what it merged into a checkout that changed while the target booted, and says so", async () => {
    const { d, calls, events } = fakes({ bootFails: true, changed: ["/dst"] });
    await expect(runMove(d, booting, plan())).rejects.toThrow("the boot timed out");
    expect(calls).not.toContain("restore /dst");
    expect(failed(events)?.note).toBe("Couldn't move this session while starting the agent. It's still in src (main). " +
      "The changes it merged into /dst are still there, since that checkout changed after they went in.");
  });

  it("leaves what it merged into a checkout another session started working in while the target booted", async () => {
    const { d, calls, events } = fakes({ bootFails: true, busy: (id, done) => id === TARGET.id && done.includes("apply /dst") });
    await expect(runMove(d, booting, plan())).rejects.toThrow("the boot timed out");
    expect(calls).not.toContain("restore /dst");
    expect(failed(events)?.note).toContain("The changes it merged into /dst are still there, since another session is working there.");
  });

  it("says a failed move in the shared line and keeps git's own words in the reason", async () => {
    const git = "Command failed: git -c core.fsmonitor= worktree add -b realm/t /var/folders/xk/T/realm-wt/t HEAD\nfatal: a branch named 'realm/t' already exists";
    const { d, events } = fakes({ worktreeFails: git });
    await expect(runMove(d, session, plan({ to: { kind: "worktree" } }))).rejects.toThrow("a branch named 'realm/t' already exists");
    const f = failed(events)!;
    expect(f.note).toBe(moveFailedSentence({ step: "place", from: { cwd: "/src", branch: "main" } }));
    expect(f.note).not.toMatch(/git|fatal|\/var\/folders/);
    expect(f.reason).toBe(git);
    expect(f.from).toEqual({ machine: null, environmentId: SOURCE.id, cwd: "/src", branch: "main", kind: "checkout" });
  });
});

describe("undoInterruptedMove", () => {
  const kept: MoveInFlight = { moveId: "m1", sourcePath: "/src", merged: { path: "/dst", environmentId: TARGET.id, state: state("before"), after: { ...state("before"), worktreeTree: "merged-tree" } } };

  it("takes the merge back out of a checkout that is as the move left it", async () => {
    const { d, calls } = fakes();
    expect(await undoInterruptedMove(d, session.id, kept)).toEqual([]);
    expect(calls).toEqual(["hazard /dst merged-tree", "restore /dst"]);
  });

  it("leaves a checkout someone worked in after the server stopped, and says so", async () => {
    const { d, calls } = fakes({ changed: ["/dst"] });
    expect(await undoInterruptedMove(d, session.id, kept)).toEqual(["The changes it merged into /dst are still there, since that checkout changed after they went in."]);
    expect(calls).not.toContain("restore /dst");
  });
});
