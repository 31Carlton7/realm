import { describe, expect, it } from "vitest";
import type { SessionEvent, StoredSessionEvent } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import { announceDelegation } from "./announce";
import { DelegationEngine } from "./engine";

/** A ULID-shaped id whose first characters spell the role — `IdSchema` rejects I, L, O and U. */
const id = (tag: string) => tag.padEnd(26, "0");
const PARENT = id("PARENT"), KID = id("KID"), PEER = id("PEER");

const ev = (e: SessionEvent, seq: number): StoredSessionEvent => ({ seq, event: e } as StoredSessionEvent);
const status = (s: string, seq: number) => ev({ type: "status", ts: 0, payload: { status: s } } as SessionEvent, seq);
const said = (text: string, seq: number) => ev({ type: "assistant_text", ts: 0, payload: { messageId: "m", text } } as SessionEvent, seq);

function recorder() {
  const sent: { event: string; payload: unknown }[] = [];
  const rpc: Pick<RpcServer, "broadcast"> = { broadcast: (event, payload) => { sent.push({ event, payload }); } };
  return { sent, rpc };
}

/** An engine wired to `announceDelegation`, serving one scripted batch per poll (see engine.test.ts). */
function wired(batches: StoredSessionEvent[][] = [[]]) {
  const { sent, rpc } = recorder();
  let i = 0;
  const engine: DelegationEngine = new DelegationEngine({
    sessions: { events: () => batches[Math.min(i++, batches.length - 1)] ?? [], interrupt: async () => { /* no child to stop */ } },
    onChange: (parentSessionId) => announceDelegation(rpc, engine, parentSessionId),
  });
  const running = (n: number) => (sent[n]!.payload as { running: unknown[] }).running;
  return { engine, sent, rpc, running };
}

describe("delegation.changed — the parent's live runs, straight off the registry", () => {
  it("announces the set when a run begins and again when it settles", async () => {
    const { engine, sent, running } = wired([[], [said("done", 1), status("idle", 2)]]);
    const run = engine.begin(PARENT, KID);
    // THE MUTANT: drop `begin`'s notify and a delegated agent starts with nothing on screen — which
    // is exactly the state this feature exists to end.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "delegation.changed", payload: { sessionId: PARENT, running: [{ sessionId: KID, detached: false, owned: true }] } });

    engine.watch(run, KID, 0, Date.now() + 2_000, 1);
    await run.settled;
    // THE MUTANT: drop the notify from `watch`'s settle and the strip keeps claiming a finished
    // agent is still working, with nothing that will ever correct it.
    expect(sent).toHaveLength(2);
    expect(running(1)).toEqual([]);
  });

  it("announces the empty set when the parent's last run is collected", () => {
    const { engine, sent, running } = wired();
    const run = engine.begin(PARENT, KID);
    engine.end(PARENT, run);
    // THE MUTANT: drop `end`'s notify. `agent_run` ends its run in a `finally` the instant the wait
    // returns, so without this the last thing the renderer ever hears is "one running".
    expect(sent).toHaveLength(2);
    expect(running(1)).toEqual([]);
  });

  it("announces the empty set when a parent's runs are all evicted at once", () => {
    const { engine, sent, running } = wired();
    engine.begin(PARENT, KID);
    engine.begin(PARENT, PEER, { interruptOnCancel: false });
    engine.end(PARENT);
    // `agent_ask`, `review` and `browser_agent_run` all end the no-arg way, as does deleting the
    // parent session. THE MUTANT: notify from the single-run branch only, and every one of those
    // paths leaves a pane insisting agents are still running that the registry has already dropped.
    expect(running(sent.length - 1)).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it("says nothing for a reviewer the user started from a diff pane", () => {
    const { engine, sent } = wired();
    // `review.ts` begins those under a synthetic key so they are still capped and cancellable.
    // THE MUTANT: drop the id guard and a field typed as a session id carries `review-env:…`,
    // a string no session in the renderer can ever match.
    engine.begin(`review-env:${id("ENV")}`, KID);
    expect(sent).toEqual([]);
  });

  it("drops a detached run that has settled: it is holding a report, not burning an agent", () => {
    const { engine } = wired();
    const run = engine.begin(PARENT, KID, { detached: true });
    expect(engine.liveRuns(PARENT)).toMatchObject([{ sessionId: KID, detached: true }]);
    run.done = { outcome: "done", finalText: "x", lastStatus: "idle" };
    // THE MUTANT: derive liveRuns from `runsOf` rather than `running`, and an `agent_start` nobody
    // has collected yet shows as a working agent until the parent gets round to `agent_wait`.
    expect(engine.liveRuns(PARENT)).toEqual([]);
    expect(engine.runsOf(PARENT)).toHaveLength(1);
  });

  it("marks a peer that was merely asked a question as not the parent's own", () => {
    const { engine } = wired();
    engine.begin(PARENT, PEER, { interruptOnCancel: false });
    // THE MUTANT: hardcode `owned: true` and the pane calls a session that was already doing its own
    // work a sub-agent the parent spawned.
    expect(engine.liveRuns(PARENT)).toMatchObject([{ sessionId: PEER, owned: false }]);
  });
});
