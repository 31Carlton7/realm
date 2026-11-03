import { describe, expect, it } from "vitest";
import type { Environment, Session, SessionEvent } from "@realm/contracts";
import { moveInFlightKey, runMove, type MoveDeps, type MovePlan } from "./move";
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

function fakes(o: { busy?: (environmentId: string) => boolean; sourceChanged?: boolean; work?: string[] } = {}) {
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
      applyChanges: async (i: { cwd: string }) => { calls.push(`apply ${i.cwd}`); },
      extract: async (i: { cwd: string }) => { calls.push(`extract ${i.cwd}`); },
      restore: async (i: { cwd: string }) => { calls.push(`restore ${i.cwd}`); },
      hazard: async () => ({ filesChanged: o.sourceChanged ? 1 : 0, commitsRolledBack: 0, headMovable: true, headReason: null }),
      resetToHead: async (cwd: string) => { calls.push(`reset ${cwd}`); },
    } as never,
    environment: (id) => [SOURCE, TARGET].find((e) => e.id === id) ?? null,
    othersWorkingIn: (environmentId) => o.busy?.(environmentId) ?? false,
    capture: async (c) => ({ state: state(c.environmentId) }),
    createWorktree: async () => env("e-new", "/new"),
    discardWorktree: async () => { calls.push("discard"); },
    stop: async () => {},
    engineWork: async () => o.work ?? [],
    boot: async () => ({ providerSessionId: "p", resumeOutcome: "declined" }) as never,
    emit: (_id, ev) => { events.push(ev); },
    broadcastStatus: () => {},
    closeTerminal: () => false,
  };
  return { d, calls, settings, events };
}
const plan = (o: Partial<MovePlan> = {}): MovePlan => ({ moveId: "m1", to: { kind: "environment", environmentId: TARGET.id }, keepSourceChanges: true, stopping: false, signal: new AbortController().signal, ...o });
const moved = (events: SessionEvent[]) => events.find((e) => e.type === "moved")?.payload as { leftBehind: string[] } | undefined;

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
    const { d, calls, events } = fakes({ sourceChanged: true });
    await runMove(d, session, plan({ keepSourceChanges: false }));
    expect(calls).not.toContain("reset /src");
    expect(moved(events)?.leftBehind).toEqual(["its uncommitted changes (they changed during the move)"]);
  });

  it("resets the source once the changes are across and nothing has touched it", async () => {
    const { d, calls, events, settings } = fakes();
    await runMove(d, session, plan({ keepSourceChanges: false }));
    expect(calls).toEqual(["apply /dst", "reset /src"]);
    expect(moved(events)?.leftBehind).toEqual([]);
    expect(settings.get(moveInFlightKey(session.id))).toBeNull();
  });
});
