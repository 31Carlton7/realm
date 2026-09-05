import { describe, expect, it, afterEach } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions, type FakeScript } from "@realm/adapters";
import { RUN_BLOCK_SENTINEL } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { RunsStore } from "../store/runs";
import { waitFor } from "../test-utils";

/**
 * Durable runs, driven through the REAL app (`createApp` + FakeAdapter). The named mutants this
 * suite exists to kill:
 *
 *   - a settle that never lands                 → "the happy path"
 *   - NEEDS-HUMAN treated as a normal finish    → "the human gate"
 *   - approve resuming the wrong way (or not)   → "the human gate"
 *   - a failed attempt burning the whole budget → "attempts and the budget"
 *   - a restart SPENDING an attempt             → "surviving a restart" (default maxAttempts: 1)
 *   - a restart leaving a ghost `running` row   → "surviving a restart"
 *   - a poller's second tick opening a 2nd run  → "the dedupe key end to end"
 *   - an expired run still spending an attempt  → "deadlines"
 *   - a deleted session leaving a live run      → "a deleted session"
 */

let app: App;
afterEach(async () => { await app?.close(); });

class CaptureFake extends FakeAdapter {
  readonly seen: StartOptions[] = [];
  constructor(cfg: ConstructorParameters<typeof FakeAdapter>[0]) { super(cfg); }
  override start(o: StartOptions): AgentHandle { this.seen.push(o); return super.start(o); }
}

/** The worker's one message begins "You are an unattended run." — distinct from the delegation
 *  tools' openers, so a script here can never be answered by a delegated child's step. */
const WORKER_OPENER = "You are an unattended run.";
const DONE_SCRIPT: FakeScript = [{ on: WORKER_OPENER, emit: [
  { kind: "text", text: "partial: reading the assignment" },
  { kind: "text", text: "FINAL: drafted the essay" },
] }];

async function boot(opts: { script?: FakeScript; delayMs?: number; home?: string } = {}) {
  const home = opts.home ?? tempDir("realm-runs-");
  const fake = new CaptureFake({ script: opts.script ?? DONE_SCRIPT, delayMs: opts.delayMs ?? 2 });
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake },
    agentRun: { fallbackKind: "fake" },
  });
  const existing = new SpacesStore(app.db, home);
  const spaces = existing.listAll?.() ?? [];
  if (spaces.length > 0) return { home, fake, spaceId: spaces[0]!.id };
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = existing.create({ profileId: profile.id, name: "S", icon: "folder" });
  return { home, fake, spaceId: space.id };
}

const runOf = (id: string) => app.runs.get(id)!.run;
const attemptsOf = (id: string) => app.runs.get(id)!.attempts;
const settled = (id: string) => waitFor(() => ["succeeded", "failed", "cancelled", "expired"].includes(runOf(id).state));
const notifications = (category: string) =>
  app.db.prepare("SELECT * FROM notifications WHERE category = ?").all(category) as { ref_id: string; title: string; body: string | null; acted_at: number | null }[];

const create = (spaceId: string, over: Partial<Parameters<App["runs"]["create"]>[0]> = {}) =>
  app.runs.create({ spaceId, goal: "Draft the week 3 essay", constraints: null, dedupeKey: null, maxAttempts: 1, deadlineAt: null, ...over });

describe("durable runs — the happy path", () => {
  it("dispatches a real, visible session and stores its final report as the run's result", async () => {
    const { spaceId } = await boot();
    const { run, created } = create(spaceId);
    expect(created).toBe(true);
    expect(run.state).toBe("queued");

    await settled(run.id);
    const done = runOf(run.id);
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("FINAL: drafted the essay");
    expect(done.error).toBeNull();
    expect(done.settledAt).not.toBeNull();

    const session = app.sessions.list(spaceId).find((s) => s.id === done.sessionId)!;
    expect(session).toBeDefined();
    // The origin is recorded with no parent: a run is dispatched by the system, not by a session.
    expect(session.dispatchedBy).toEqual({ sessionId: null, kind: "run" });
    expect(attemptsOf(run.id).map((a) => [a.n, a.outcome])).toEqual([[1, "succeeded"]]);
  });

  it("gives the worker the unattended preamble — including how to stop and ask", async () => {
    const { spaceId, fake } = await boot();
    const { run } = create(spaceId, { goal: "Summarise chapter 4" });
    await settled(run.id);
    const ctx = fake.seen.at(-1)!.systemContext ?? "";
    expect(ctx).toContain("Unattended run");
    expect(ctx).toContain("Summarise chapter 4");
    expect(ctx).toContain(RUN_BLOCK_SENTINEL);
    // The anti-evasion line is part of the standing context, not advice the goal can drop.
    expect(ctx).toMatch(/CAPTCHA|bot check/);
  });

  it("writes one terminal run_done row naming the run", async () => {
    const { spaceId } = await boot();
    const { run } = create(spaceId);
    await settled(run.id);
    const rows = notifications("run_done");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref_id).toBe(run.id);
    expect(rows[0]!.title).toContain("finished");
    expect(rows[0]!.acted_at).not.toBeNull(); // terminal: born acted
  });
});

describe("durable runs — the human gate", () => {
  const BLOCKING: FakeScript = [
    // Ordered first: `find` takes the first match, and the approval message contains BOTH openers.
    { on: "supervising this run replied", emit: [{ kind: "text", text: "FINAL: used MLA as instructed" }] },
    { on: WORKER_OPENER, emit: [{ kind: "text", text: `${RUN_BLOCK_SENTINEL} which citation style should I use?` }] },
  ];

  it("parks the run at `blocked` instead of reporting the ask as a finished result", async () => {
    const { spaceId } = await boot({ script: BLOCKING });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "blocked");
    const blocked = runOf(run.id);
    expect(blocked.settledAt).toBeNull();      // not terminal — the work is not over
    expect(blocked.result).toContain("citation style");
    expect(attemptsOf(run.id).map((a) => [a.n, a.outcome])).toEqual([[1, "blocked"]]);
    // The attempt log keeps WHAT it asked for, so a person can answer without opening the transcript.
    expect(attemptsOf(run.id)[0]!.detail).toContain("citation style");

    const rows = notifications("run_blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acted_at).toBeNull();      // non-terminal: still open, awaiting an answer
    expect(rows[0]!.body).toContain("citation style");
  });

  it("approve(true) resumes the SAME session with the answer and finishes", async () => {
    const { spaceId } = await boot({ script: BLOCKING });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "blocked");
    const sessionBefore = runOf(run.id).sessionId;

    app.runs.approve(run.id, true, "Use MLA.");
    await settled(run.id);
    const done = runOf(run.id);
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("FINAL: used MLA as instructed");
    expect(done.sessionId).toBe(sessionBefore); // resumed, not restarted
    expect(attemptsOf(run.id).map((a) => a.outcome)).toEqual(["blocked", "succeeded"]);
    // The open run_blocked row is resolved once answered — it must stop reading "needs you".
    expect(notifications("run_blocked")[0]!.acted_at).not.toBeNull();
  });

  it("approve(false) cancels the run and keeps the reason", async () => {
    const { spaceId } = await boot({ script: BLOCKING });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "blocked");
    app.runs.approve(run.id, false, "not needed after all");
    const done = runOf(run.id);
    expect(done.state).toBe("cancelled");
    expect(done.error).toContain("not needed after all");
  });

  it("refuses to approve a run that is not blocked", async () => {
    const { spaceId } = await boot();
    const { run } = create(spaceId);
    await settled(run.id);
    expect(() => app.runs.approve(run.id, true, null)).toThrow(/not waiting/);
  });
});

describe("durable runs — attempts and the budget", () => {
  const CRASHING: FakeScript = [{ on: WORKER_OPENER, emit: [{ kind: "throw", message: "kaboom" }] }];

  it("retries a failed attempt while the budget allows, then goes terminal", async () => {
    const { spaceId } = await boot({ script: CRASHING });
    const { run } = create(spaceId, { maxAttempts: 2 });
    await settled(run.id);
    const done = runOf(run.id);
    expect(done.state).toBe("failed");
    expect(done.attempt).toBe(2);
    expect(attemptsOf(run.id).map((a) => [a.n, a.outcome])).toEqual([[1, "failed"], [2, "failed"]]);
    expect(done.error).toBeTruthy();
  });

  it("spends exactly one attempt when the budget is one", async () => {
    const { spaceId } = await boot({ script: CRASHING });
    const { run } = create(spaceId, { maxAttempts: 1 });
    await settled(run.id);
    expect(runOf(run.id).attempt).toBe(1);
    expect(attemptsOf(run.id)).toHaveLength(1);
  });

  it("retry() re-queues a terminal run and widens the budget to fit", async () => {
    const { spaceId } = await boot({ script: CRASHING });
    const { run } = create(spaceId, { maxAttempts: 1 });
    await settled(run.id);
    const again = app.runs.retry(run.id);
    expect(again.state).toBe("queued");
    expect(again.maxAttempts).toBe(2); // raised past the attempt about to happen
    await settled(run.id);
    expect(attemptsOf(run.id)).toHaveLength(2);
  });

  it("refuses to retry a run that is still live", async () => {
    const { spaceId } = await boot({ script: [{ on: WORKER_OPENER, emit: Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }], delayMs: 5 });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "running");
    expect(() => app.runs.retry(run.id)).toThrow(/still live/);
  });
});

describe("durable runs — cancelling", () => {
  it("cancels a live run and closes its attempt", async () => {
    const { spaceId } = await boot({ script: [{ on: WORKER_OPENER, emit: Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }], delayMs: 5 });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "running");
    const cancelled = app.runs.cancel(run.id);
    expect(cancelled.state).toBe("cancelled");
    expect(attemptsOf(run.id).map((a) => a.outcome)).toEqual(["cancelled"]);
  });

  it("cancelling an already-terminal run is a no-op, not an error or a relabelling", async () => {
    const { spaceId } = await boot();
    const { run } = create(spaceId);
    await settled(run.id);
    expect(app.runs.cancel(run.id).state).toBe("succeeded");
    expect(app.runs.cancel(run.id).state).toBe("succeeded");
  });
});

describe("durable runs — the dedupe key end to end", () => {
  it("a poller firing twice for one assignment gets ONE run", async () => {
    const { spaceId } = await boot();
    const first = create(spaceId, { dedupeKey: "cs101-week-3" });
    const second = create(spaceId, { dedupeKey: "cs101-week-3" });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    await settled(first.run.id);
    expect(app.runs.list({ spaceId, states: [], cursor: null, limit: 50 }).runs).toHaveLength(1);
  });

  it("but next week's run of the same recurring thing still gets created once this one is done", async () => {
    const { spaceId } = await boot();
    const first = create(spaceId, { dedupeKey: "cs101-weekly" });
    await settled(first.run.id);
    const next = create(spaceId, { dedupeKey: "cs101-weekly" });
    expect(next.created).toBe(true);
    expect(next.run.id).not.toBe(first.run.id);
  });
});

describe("durable runs — deadlines", () => {
  it("expires a run whose deadline passed before it started, without spending an attempt or a session", async () => {
    const { spaceId } = await boot();
    const before = app.sessions.list(spaceId).length;
    const { run } = create(spaceId, { deadlineAt: Date.now() - 1000 });
    await settled(run.id);
    const done = runOf(run.id);
    expect(done.state).toBe("expired");
    expect(done.attempt).toBe(0);
    expect(attemptsOf(run.id)).toEqual([]);
    expect(app.sessions.list(spaceId)).toHaveLength(before);
  });
});

describe("durable runs — a deleted session", () => {
  it("fails the run rather than leaving it live forever", async () => {
    const { spaceId } = await boot({ script: [{ on: WORKER_OPENER, emit: Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }], delayMs: 5 });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "running");
    await app.sessions.delete(runOf(run.id).sessionId!);
    const done = runOf(run.id);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("deleted");
    expect(attemptsOf(run.id).map((a) => a.outcome)).toEqual(["abandoned"]);
  });
});

describe("durable runs — surviving a restart", () => {
  it("resumes a run whose attempt the server died in the middle of, WITHOUT spending its budget", async () => {
    // Attempt 1: a script long enough that the run is still going when the server goes down.
    const slow: FakeScript = [{ on: WORKER_OPENER, emit: Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }];
    const { home, spaceId } = await boot({ script: slow, delayMs: 5 });
    // The default budget — one attempt. If a restart spends it, "durable" means nothing.
    const { run } = create(spaceId, { maxAttempts: 1 });
    await waitFor(() => runOf(run.id).state === "running");
    const runId = run.id;
    const sessionBefore = runOf(runId).sessionId;
    await app.close();

    // Reboot on the same home. `createApp` runs markStaleOnBoot and then recoverOnBoot.
    await boot({ home, script: DONE_SCRIPT });
    await settled(runId);
    const done = runOf(runId);
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("FINAL: drafted the essay");
    expect(done.sessionId).toBe(sessionBefore); // the SAME session, resumed
    // The abandoned attempt is logged honestly, and the budget was widened rather than spent.
    expect(attemptsOf(runId).map((a) => [a.n, a.outcome])).toEqual([[1, "abandoned"], [2, "succeeded"]]);
    expect(done.maxAttempts).toBe(2);
  });

  it("leaves a blocked run blocked across a restart — a restart is not an answer", async () => {
    const blocking: FakeScript = [{ on: WORKER_OPENER, emit: [{ kind: "text", text: `${RUN_BLOCK_SENTINEL} which style?` }] }];
    const { home, spaceId } = await boot({ script: blocking });
    const { run } = create(spaceId);
    await waitFor(() => runOf(run.id).state === "blocked");
    const runId = run.id;
    const attemptsBefore = attemptsOf(runId).length;
    await app.close();

    await boot({ home, script: blocking });
    expect(runOf(runId).state).toBe("blocked");
    expect(attemptsOf(runId)).toHaveLength(attemptsBefore); // recovery did not re-dispatch it
  });

  it("expires a run whose deadline passed while the server was down", async () => {
    const slow: FakeScript = [{ on: WORKER_OPENER, emit: Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }];
    const { home, spaceId } = await boot({ script: slow, delayMs: 5 });
    const { run } = create(spaceId, { deadlineAt: Date.now() + 250 });
    await waitFor(() => runOf(run.id).state === "running");
    const runId = run.id;
    await app.close();
    await waitFor(() => Date.now() > run.deadlineAt!);

    await boot({ home, script: DONE_SCRIPT });
    expect(runOf(runId).state).toBe("expired");
    expect(runOf(runId).error).toContain("deadline");
  });
});

describe("durable runs — constraints are validated where the caller is watching", () => {
  it("refuses a skills constraint the space never enabled, at create time", async () => {
    const { spaceId } = await boot();
    expect(() => create(spaceId, { constraints: { skills: ["not-a-real-skill"] } })).toThrow(/subset of this space's enabled skills/);
    expect(new RunsStore(app.db).list({ spaceId, states: [], cursor: null, limit: 10 }).runs).toEqual([]);
  });

  it("refuses environmentId and newWorktree together", async () => {
    const { spaceId } = await boot();
    expect(() => create(spaceId, { constraints: { environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", newWorktree: true } })).toThrow(/mutually exclusive/);
  });
});
