import { describe, expect, it } from "vitest";
import { sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { createAppStore, TAIL_CACHE_SIZE } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";
import { TailCache } from "./tail-cache";

/**
 * A session's log end read ahead of the click on its row (the sidebar's neighbours, the row under the
 * pointer), so the click draws it without waiting on the server.
 */
const turn = (id: string, from: number, n: number): StoredSessionEvent[] => Array.from({ length: n }, (_, i) => ({
  seq: from + i, sessionId: id,
  event: i === 0 ? sessionEvent("user_message", { text: `q${from}`, attachments: [] }, from) : sessionEvent("assistant_text", { messageId: `m${from + i}`, text: `a${from + i}` }, from + i),
}));
const IDS = Array.from({ length: TAIL_CACHE_SIZE + 1 }, (_, i) => `se${i}`);

function seed() {
  const logs = Object.fromEntries(IDS.map((id, i) => [id, turn(id, i * 100 + 1, 20)]));
  const api = fakeApi({
    items: { s1: IDS.map((id) => item(`i-${id}`, "s1", { kind: "session", refId: id, title: id })) },
    sessions: IDS.map((id) => session(id, "s1", { lastEventSeq: logs[id]!.at(-1)!.seq })),
    sessionEvents: logs,
  });
  return { api, store: createAppStore(api) };
}
const tailReads = (calls: string[], id: string) => calls.filter((c) => c === `sessionEventsBefore:${id}:end`).length;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a log end read ahead of the click", () => {
  it("is drawn the moment the session opens, before anything is asked of the server", async () => {
    const { api, store } = seed(); await store.getState().boot();
    store.getState().prefetchSession("se0");
    await settle();
    const opening = store.getState().openSession("se0");
    expect(store.getState().transcripts.se0?.lastSeq).toBe(20);
    await opening;
    expect(tailReads(api.calls, "se0")).toBe(1);
  });

  it("reads on from where it stops, so what was said after it is there too", async () => {
    const { api, store } = seed(); await store.getState().boot();
    store.getState().prefetchSession("se0");
    await settle();
    api.data.sessionEvents.se0!.push(...turn("se0", 21, 5));
    await store.getState().openSession("se0");
    const { t, lastSeq } = store.getState().transcripts.se0!;
    expect(lastSeq).toBe(25);
    expect(t.blocks.filter((b) => b.kind === "user").map((b) => b.kind === "user" && b.text)).toEqual(["q1", "q21"]);
  });

  it("is joined by an open while it is still in flight, not read twice", async () => {
    const { api, store } = seed(); await store.getState().boot();
    store.getState().prefetchSession("se0");
    await store.getState().openSession("se0");
    expect(tailReads(api.calls, "se0")).toBe(1);
    expect(store.getState().transcripts.se0?.lastSeq).toBe(20);
  });

  it("is let go when the log moves on before the click", async () => {
    const { api, store } = seed(); await store.getState().boot();
    store.getState().prefetchSession("se0");
    await settle();
    store.getState().applySessionEvent({ seq: 21, sessionId: "se0", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "late", text: "late" }) });
    const opening = store.getState().openSession("se0");
    expect(store.getState().transcripts.se0).toBeUndefined();
    await opening;
    expect(tailReads(api.calls, "se0")).toBe(2);
  });

  it("keeps the last few only: the oldest read goes when one more comes", async () => {
    const { api, store } = seed(); await store.getState().boot();
    for (const id of IDS) { store.getState().prefetchSession(id); await settle(); }
    // se0 was read first, so it is the one that went.
    const first = store.getState().openSession("se0");
    expect(store.getState().transcripts.se0).toBeUndefined();
    await first;
    expect(tailReads(api.calls, "se0")).toBe(2);
    const last = store.getState().openSession(IDS.at(-1)!);
    expect(store.getState().transcripts[IDS.at(-1)!]).toBeDefined();
    await last;
  });

  it("is never made for a session already open", async () => {
    const { api, store } = seed(); await store.getState().boot();
    await store.getState().openSession("se0");
    store.getState().prefetchSession("se0");
    await settle();
    expect(tailReads(api.calls, "se0")).toBe(1);
  });
});

describe("TailCache", () => {
  const entry = (n: number) => ({ events: Array.from({ length: n }, (_, i) => i) });

  it("holds at most `size` entries, dropping the oldest put", () => {
    const c = new TailCache(2, 100);
    c.put("a", entry(1)); c.put("b", entry(1)); c.put("c", entry(1));
    expect([c.has("a"), c.has("b"), c.has("c"), c.count]).toEqual([false, true, true, 2]);
    // Putting one again makes it the newest.
    c.put("b", entry(1)); c.put("d", entry(1));
    expect([c.has("b"), c.has("c"), c.has("d")]).toEqual([true, false, true]);
  });

  it("keeps no entry longer than `maxEvents`, and lets a replaced one go", () => {
    const c = new TailCache(4, 10);
    c.put("a", entry(5));
    c.put("a", entry(11));
    expect(c.has("a")).toBe(false);
  });

  it("hands an entry over once", () => {
    const c = new TailCache(4, 10);
    c.put("a", entry(1));
    expect(c.take("a")).toEqual(entry(1));
    expect(c.take("a")).toBeUndefined();
  });
});
