import { describe, expect, it } from "vitest";
import type { StoredSessionEvent, SessionEvent } from "@realm/contracts";
import { DelegationEngine, type ActiveRun } from "./engine";

/**
 * Direct unit tests for `awaitAnswer` (Plan 20), against a scripted transcript.
 *
 * These exist because the behaviour suite CANNOT pin the turn-boundary rule: through the real app the
 * peer's next turn starts microseconds after the interrupt, so whether a poll lands in the gap between
 * the old turn's `idle` and the new turn's `running` is a race. The integration test passed with the
 * rule removed — a surviving mutant, which is the only kind of evidence that counts. Here the
 * transcript is handed over one batch at a time, so the gap is exact and the rule is provable.
 */

const ev = (e: SessionEvent, seq: number): StoredSessionEvent => ({ seq, event: e } as StoredSessionEvent);
const status = (s: string, seq: number) => ev({ type: "status", ts: 0, payload: { status: s } } as SessionEvent, seq);
const said = (text: string, seq: number) => ev({ type: "assistant_text", ts: 0, payload: { messageId: "m", text } } as SessionEvent, seq);

/** Serves one scripted batch per `events()` call, so each poll of the wait sees exactly one slice.
 *  A batch of `[]` is a poll that found nothing new — the gap the rule turns on. */
function engineOver(batches: StoredSessionEvent[][]) {
  let i = 0;
  const interrupted: string[] = [];
  const engine = new DelegationEngine({
    sessions: {
      events: () => batches[Math.min(i++, batches.length - 1)] ?? [],
      interrupt: async (id: string) => { interrupted.push(id); },
    },
  });
  return { engine, interrupted };
}

const run = (): ActiveRun => ({ parentSessionId: "asker", childSessionId: "peer", cancelled: false, startedAt: 0, interruptOnCancel: false, detached: false, settled: null, done: null });
const wait = (engine: DelegationEngine, r = run(), answer: { text: string | null } = { text: null }, deadlineMs = 2000) =>
  engine.awaitAnswer({ targetId: "peer", fromSeq: 0, run: r, answer, deadline: Date.now() + deadlineMs, pollMs: 1 });

describe("awaitAnswer — the prose fallback only counts a turn that started AFTER the question", () => {
  it("ignores the interrupted turn's trailing text and waits for the real answer", async () => {
    // Exactly what an interrupted peer emits: the tail of the work it was already doing (text, then
    // idle), a gap, then the turn Realm's question started. THE MUTANT: drop `sawTurnStart` and the
    // first batch alone satisfies "idle with text", so the asker is handed "UNRELATED WORK" — a
    // fragment of the peer's own unrelated task — as its answer.
    const { engine } = engineOver([
      [said("UNRELATED WORK", 1), status("idle", 2)],
      [],
      [status("running", 3)],
      [said("THE REAL ANSWER", 4), status("idle", 5)],
    ]);
    const settled = await wait(engine);
    expect(settled.outcome).toBe("replied");
    expect(settled.answer).toBe("THE REAL ANSWER");
  });

  it("times out rather than answering, when the peer never starts a turn at all", async () => {
    // The same trailing tail, and then nothing. There is no answer here and the honest outcome is a
    // timeout — never the stale text.
    const { engine, interrupted } = engineOver([[said("UNRELATED WORK", 1), status("idle", 2)], []]);
    const settled = await wait(engine, run(), { text: null }, 60);
    expect(settled.outcome).toBe("timeout");
    expect(settled.answer).toBeNull();
    // And the peer is NOT interrupted on timeout — drain does that to its child; a peer is not a child.
    expect(interrupted).toEqual([]);
  });

  it("still accepts a whole turn delivered in ONE batch", async () => {
    // The reason the boundary is detected inside `scan` rather than by comparing last-status across
    // polls: a single batch can hold running → text → idle, and a caller watching only the batch's
    // final status would never see the `running`, so this would hang until the budget expired.
    const { engine } = engineOver([[status("running", 1), said("ANSWERED IN ONE BATCH", 2), status("idle", 3)]]);
    const settled = await wait(engine);
    expect(settled.outcome).toBe("replied");
    expect(settled.answer).toBe("ANSWERED IN ONE BATCH");
  });

  it("an explicit agent_answer beats the prose fallback even when both are available", async () => {
    const { engine } = engineOver([[status("running", 1), said("prose", 2), status("idle", 3)]]);
    const settled = await wait(engine, run(), { text: "the tool answer" });
    expect(settled.outcome).toBe("answered");
    expect(settled.answer).toBe("the tool answer");
  });

  it("cancelled wins over an answer that landed in the same poll window", async () => {
    const r = { ...run(), cancelled: true };
    const { engine } = engineOver([[status("running", 1), said("x", 2), status("idle", 3)]]);
    const settled = await wait(engine, r, { text: "answered too" });
    // Same ordering rule drain uses: once the asker is gone, nobody is listening, and reporting an
    // answer nobody received would be a lie about what happened.
    expect(settled.outcome).toBe("cancelled");
    expect(settled.answer).toBeNull();
  });

  it("reports a peer that errored or ended, rather than waiting out the budget", async () => {
    for (const bad of ["error", "ended"]) {
      const { engine } = engineOver([[status("running", 1), status(bad, 2)]]);
      const settled = await wait(engine);
      expect(settled.outcome, bad).toBe("failed");
      expect(settled.lastStatus, bad).toBe(bad);
    }
  });

  it("reports `gone` when the session's transcript can no longer be read", async () => {
    const engine = new DelegationEngine({
      sessions: { events: () => { throw new Error("deleted"); }, interrupt: async () => {} },
    });
    expect((await wait(engine)).outcome).toBe("gone");
  });
});

describe("parentInterrupted honours interruptOnCancel", () => {
  it("stops a delegated CHILD but never a peer", async () => {
    const { engine, interrupted } = engineOver([[]]);
    const child = engine.begin("parentA", "childA");                             // default: ours to stop
    const peer = engine.begin("parentB", "peerB", { interruptOnCancel: false }); // Plan 20's ask
    engine.parentInterrupted("parentA");
    engine.parentInterrupted("parentB");
    await new Promise((r) => setTimeout(r, 10));
    expect(child.cancelled).toBe(true);
    expect(peer.cancelled).toBe(true);
    // Both waits are cancelled; only the child is actually stopped. Kills the default leaking onto
    // the ask, which would make one session's stop destroy another session's unrelated work.
    expect(interrupted).toEqual(["childA"]);
  });
});

describe("drain — a turn a person stopped is not a finish", () => {
  const stoppedAt = (seq: number) => ev({ type: "status", ts: 0, payload: { status: "idle", interrupted: true } } as SessionEvent, seq);
  const settle = (engine: DelegationEngine, r = run(), deadlineMs = 2000) =>
    engine.drain("child", 0, r, Date.now() + deadlineMs, 1);

  it("reports a stopped turn as stopped, carrying what the child had said by then", async () => {
    // Stopping the child winds it down to idle WITH its partial text — exactly what a finish looks
    // like — and the parent was told "Delegated agent finished." THE MUTANT: drop the stop check,
    // or read it after the finish.
    const { engine } = engineOver([[status("running", 1), said("partial: read two files", 2), stoppedAt(3)]]);
    const settled = await settle(engine);
    expect(settled.outcome).toBe("stopped");
    expect(settled.finalText).toBe("partial: read two files");
  });

  it("settles a child stopped before its first word at once, rather than timing it out", async () => {
    // Nothing said, so the finish rule never fires. THE MUTANT: demand a report before settling as
    // stopped, and the wait runs out the whole budget and then reports a timeout — and interrupts a
    // child that had already been stopped.
    const { engine, interrupted } = engineOver([[status("running", 1), stoppedAt(2)], []]);
    const settled = await settle(engine, run(), 80);
    expect(settled.outcome).toBe("stopped");
    expect(settled.finalText).toBeNull();
    expect(interrupted).toEqual([]);
  });

  it("still reports the parent's own cancel as cancelled — it stops its child the same way", async () => {
    // `parentInterrupted` interrupts the child, which winds down to the same stopped idle. THE
    // MUTANT: read the stop before the cancel, and every cancelled run is misreported as the user
    // stopping its child.
    const { engine } = engineOver([[status("running", 1), said("partial", 2), stoppedAt(3)]]);
    const settled = await settle(engine, { ...run(), cancelled: true });
    expect(settled.outcome).toBe("interrupted");
  });

  it("judges a slice by how it ENDS — a finish is still a finish, whatever came before it", async () => {
    // A stop the child was then sent past — a steered message — followed by a turn that finished.
    // THE MUTANT: let the stop stick once seen, and a child that went on to finish is reported as
    // stopped. (And the plain finish, with no stop anywhere, must not be touched at all.)
    const steered = engineOver([[
      status("running", 1), said("first", 2), stoppedAt(3),
      status("running", 4), said("second, and final", 5), status("idle", 6),
    ]]);
    expect(await settle(steered.engine)).toMatchObject({ outcome: "done", finalText: "second, and final" });
    const plain = engineOver([[status("running", 1), said("all done", 2), status("idle", 3)]]);
    expect((await settle(plain.engine)).outcome).toBe("done");
  });
});

/**
 * A waiting tool is only audible on the wire if the wait says it is still waiting — and only useful
 * while someone is listening. These pin both halves of `awaitRuns`'s options.
 */
describe("awaitRuns — ticks while it waits, and stops for a caller that has gone", () => {
  it("reports a tick on every pass that is still waiting, and none once satisfied", async () => {
    // THE MUTANT: ticks never called — agent_wait goes silent and Claude aborts it at 300 s.
    const { engine } = engineOver([[]]);
    const r = run();
    let ticks = 0;
    setTimeout(() => { r.done = { outcome: "done", finalText: "ok", lastStatus: "idle" }; }, 30);
    const outcome = await engine.awaitRuns([r], "all", Date.now() + 2000, 5, { onTick: () => { ticks += 1; } });
    expect(outcome).toBe("settled");
    expect(ticks).toBeGreaterThanOrEqual(2);
    const after = ticks;
    await new Promise((res) => setTimeout(res, 30));
    expect(ticks).toBe(after);
  });

  it("returns aborted when the caller's signal fires, leaving the run untouched", async () => {
    // THE MUTANT: the signal ignored — the wait listens on to its deadline for a socket that is gone.
    const { engine, interrupted } = engineOver([[]]);
    const r = run();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const t0 = Date.now();
    const outcome = await engine.awaitRuns([r], "all", Date.now() + 5000, 5, { signal: controller.signal });
    expect(outcome).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.done).toBeNull();
    expect(r.cancelled).toBe(false);
    expect(interrupted).toEqual([]);
  });

  it("drain ticks while the child works", async () => {
    const { engine } = engineOver([[status("running", 1)], [], [said("done", 2), status("idle", 3)]]);
    let ticks = 0;
    const settled = await engine.drain("peer", 0, run(), Date.now() + 2000, 1, () => { ticks += 1; });
    expect(settled.outcome).toBe("done");
    expect(ticks).toBe(2);
  });
});
