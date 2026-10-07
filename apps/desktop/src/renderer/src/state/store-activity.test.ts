import { beforeEach, describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session, type FakeApi } from "./store.test-fakes";

async function booted(api: FakeApi) {
  api.data.items.s1 = [item("i1", "s1", { title: "One" })];
  api.data.sessions = [session("se1", "s1", { title: "One" })];
  const store = createAppStore(api);
  await store.getState().boot();
  return store;
}

describe("a session's live line", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  it("records what a session is doing even though nobody has opened its transcript", async () => {
    /* The mutant: fold the activity AFTER the `!transcripts[id]` guard. A lead's sub-agents are
       sessions nobody has opened — that is what its Agents tab follows them for — so the line would
       be blank for all of them and appear only for the pane already on screen. */
    const store = await booted(api);
    expect(store.getState().transcripts["se9"]).toBeUndefined();
    store.getState().applySessionEvent({
      seq: 1, sessionId: "se9", ephemeral: false,
      event: sessionEvent("tool_call", { toolUseId: "t", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 5),
    });
    expect(store.getState().sessionActivity["se9"]).toEqual({ text: "pnpm build", icon: "terminal", ts: 5 });
  });

  it("costs no extra store write: the line rides along with the transcript's own", async () => {
    /* The mutant that shipped once: `set` the activity on its own line, before the transcript write.
       A store notification is a render of every subscribed pane, so a second one per event is one
       extra render per event per streaming session — with a fan of sub-agents working, which is
       exactly when this code runs, that is every pane re-rendering twice as often. store.test.ts pins
       the same number for the delta fold; this pins it for the activity fold. */
    const store = await booted(api);
    await store.getState().openSession("se1");
    let writes = 0; store.subscribe(() => writes++);
    store.getState().applySessionEvent({
      seq: 900, sessionId: "se1", ephemeral: false,
      event: sessionEvent("tool_call", { toolUseId: "t", name: "Read", input: { file_path: "design.md" }, parentToolUseId: null }, 1),
    });
    expect(writes).toBe(1);
    expect(store.getState().sessionActivity["se1"]!.text).toBe("design.md");
    expect(store.getState().transcripts["se1"]!.lastSeq).toBe(900);
  });

  it("keeps the last real line when an event says nothing about the work", async () => {
    const store = await booted(api);
    const tool = { seq: 1, sessionId: "se9", ephemeral: false,
      event: sessionEvent("tool_call", { toolUseId: "t", name: "Grep", input: { pattern: "TODO" }, parentToolUseId: null }, 1) } as const;
    store.getState().applySessionEvent(tool);
    store.getState().applySessionEvent({ seq: 2, sessionId: "se9", ephemeral: false, event: sessionEvent("status", { status: "running" }, 2) });
    expect(store.getState().sessionActivity["se9"]!.text).toBe("TODO");
  });
});
