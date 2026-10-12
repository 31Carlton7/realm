import { describe, expect, it } from "vitest";
import { sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";
import { emptyTranscript, reduceTranscript, type Block } from "../panes/session/transcript-model";

/**
 * A long session opens on its end and reads further back as the reader goes there (P2 in the perf
 * audit: the biggest session was 48,000 events and 105 MB, every one fetched before the first row).
 *
 * The log here is 3,000 events: a prompt at every seq ending in 01 and an answer at every other —
 * thirty turns of a hundred events each. No turn reports a status, so each is closed by a derived
 * run line when the next prompt arrives — which is what makes the seam between two reads visible.
 */
const said = (blocks: readonly Block[]) => blocks.filter((b) => b.kind === "user" || b.kind === "assistant");
const N = 3000;
const ev = (seq: number): StoredSessionEvent => ({
  seq, sessionId: "se1",
  event: seq % 100 === 1 ? sessionEvent("user_message", { text: `q${seq}`, attachments: [] }, seq) : sessionEvent("assistant_text", { messageId: `m${seq}`, text: `a${seq}` }, seq),
});

function seed(extra: { seenSeq?: number; log?: StoredSessionEvent[] } = {}) {
  const api = fakeApi({
    items: { s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Long" })] },
    sessions: [session("se1", "s1", { seenSeq: extra.seenSeq ?? 0 })],
    sessionEvents: { se1: extra.log ?? Array.from({ length: N }, (_, i) => ev(i + 1)) },
  });
  return { api, store: createAppStore(api) };
}
const reads = (calls: string[]) => calls.filter((c) => c.startsWith("sessionEvents"));

describe("opening a long session", () => {
  it("reads one page from the end and starts at the latest prompt with enough after it", async () => {
    const { api, store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    const { t, lastSeq } = store.getState().transcripts.se1!;
    expect(lastSeq).toBe(N);
    // 2701..3000: three hundred events, the first of them a prompt.
    expect(t.earlierFrom).toBe(2701);
    expect(t.blocks[0]).toMatchObject({ kind: "user", text: "q2701", seq: 2701 });
    expect(said(t.blocks)).toHaveLength(300);
    expect(reads(api.calls)).toEqual(["sessionEventsBefore:se1:end", "sessionEventsBefore:se1:end:init,usage,summary,prompt_hint"]);
  });

  it("still knows what the log last said about the model, the meter and the summary, wherever it said it", async () => {
    const log = Array.from({ length: N }, (_, i) => ev(i + 1));
    log[49] = { seq: 50, sessionId: "se1", event: sessionEvent("init", { providerSessionId: "p1", model: "opus", tools: ["Bash"], cwd: "/w" }, 50) };
    log[59] = { seq: 60, sessionId: "se1", event: sessionEvent("usage", { costUsd: 4.2, inputTokens: 10, outputTokens: 20, numTurns: 7 }, 60) };
    log[69] = { seq: 70, sessionId: "se1", event: sessionEvent("summary", { text: "Built the thing.", throughSeq: 69 }, 70) };
    const { store } = seed({ log }); await store.getState().boot();
    await store.getState().openSession("se1");
    const { t } = store.getState().transcripts.se1!;
    expect(t.init?.model).toBe("opus");
    expect(t.usage.costUsd).toBe(4.2);
    expect(t.summary?.text).toBe("Built the thing.");
  });

  it("reads back to the reader's mark, so the rule lands where they stopped", async () => {
    const { store } = seed({ seenSeq: 1500 }); await store.getState().boot();
    await store.getState().openSession("se1");
    const { t } = store.getState().transcripts.se1!;
    expect(t.earlierFrom).toBe(1401);
    const rule = t.blocks.findIndex((b) => b.kind === "unseen-mark");
    // Before the answer at 1501, with the turn from 1401 (and its run line) above it.
    expect(t.blocks[rule - 1]).toMatchObject({ kind: "run" });
    expect(t.blocks[rule + 1]).toMatchObject({ kind: "user", seq: 1501 });
    expect(said(t.blocks.slice(0, rule))).toHaveLength(100);
    expect(store.getState().newSinceSeq.se1).toBe(1500);
  });
});

describe("reading further back", () => {
  it("puts the earlier stretch in front, numbered so the blocks on screen keep their keys", async () => {
    const { store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    const before = store.getState().transcripts.se1!.t;
    await store.getState().loadEarlierEvents("se1");
    const { t } = store.getState().transcripts.se1!;
    expect(t.earlierFrom).toBe(1701);
    expect(said(t.blocks)).toHaveLength(1300);
    const front = t.blocks.length - before.blocks.length;
    expect(t.base).toBe(-front);
    // The blocks already held are the same blocks, at the same place in the transcript's numbering.
    expect(t.blocks.slice(front)).toEqual(before.blocks);
    expect(t.blocks[front]).toBe(before.blocks[0]);
    // The earlier stretch's last turn is closed as the prompt after it would have closed it.
    expect(t.blocks[front - 1]).toMatchObject({ kind: "run", derived: true });
  });

  it("through the start, is the transcript a single read would have built", async () => {
    const { store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    await store.getState().loadEventsThrough("se1", 0);
    const { t } = store.getState().transcripts.se1!;
    expect(t.earlierFrom).toBeUndefined();
    const once = Array.from({ length: N }, (_, i) => ev(i + 1)).reduce((acc, e) => reduceTranscript(acc, e.event, false, e.seq), emptyTranscript());
    expect(t.blocks).toEqual(once.blocks);
  });

  it("keeps what arrived live while it read", async () => {
    const { api, store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    const read = store.getState().loadEarlierEvents("se1");
    store.getState().applySessionEvent({ seq: N + 1, sessionId: "se1", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "live", text: "live" }) });
    await read;
    const { t, lastSeq } = store.getState().transcripts.se1!;
    expect(lastSeq).toBe(N + 1);
    expect(t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "live" });
    expect(t.earlierFrom).toBe(1701);
    expect(reads(api.calls).filter((c) => c === "sessionEventsBefore:se1:2701")).toHaveLength(1);
  });

  it("is one read however many ask at once", async () => {
    const { api, store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    await Promise.all([store.getState().loadEarlierEvents("se1"), store.getState().loadEarlierEvents("se1")]);
    expect(reads(api.calls).filter((c) => c === "sessionEventsBefore:se1:2701")).toHaveLength(1);
    expect(store.getState().transcripts.se1!.t.earlierFrom).toBe(1701);
  });

  it("exports the whole conversation, not the stretch on screen", async () => {
    const { store } = seed(); await store.getState().boot();
    await store.getState().openSession("se1");
    await store.getState().exportSession("se1");
    expect(store.getState().transcripts.se1!.t.earlierFrom).toBeUndefined();
  });
});
