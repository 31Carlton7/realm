import { beforeEach, describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { createAppStore, FAN_OUT_MAX } from "./store";
import { fakeApi, item, session, type FakeApi } from "./store.test-fakes";

async function booted(api: FakeApi) {
  api.data.items.s1 = [item("i1", "s1", { title: "One" })];
  api.data.sessions = [session("se1", "s1", { title: "One" })];
  const store = createAppStore(api);
  await store.getState().boot();
  return store;
}

const created = (api: FakeApi) => api.calls.filter((c) => c.startsWith("createSession:"));
const worktrees = (api: FakeApi) => api.calls.filter((c) => c.startsWith("createWorktree:"));

describe("fanOutAgents", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  it("starts one session per agent, each in its own worktree, each sent the brief", async () => {
    const store = await booted(api);
    const started = await store.getState().fanOutAgents({ brief: "Fix the flake", count: 3, agentKind: "claude", worktrees: true });
    expect(started).toHaveLength(3);
    expect(created(api)).toEqual(["createSession:claude", "createSession:claude", "createSession:claude"]);
    expect(worktrees(api)).toHaveLength(3);
    expect(api.sent.map((s) => s.text)).toEqual(["Fix the flake", "Fix the flake", "Fix the flake"]);
    // Each session is pinned to its OWN environment. The mutant: hoist the worktree out of the loop
    // and reuse one — which is the collision the switch exists to prevent, wearing a green test.
    const envs = new Set(started.map((s) => s.environmentId));
    expect(envs.size).toBe(3);
  });

  it("opens no panes: a batch lands in the space, not in the layout", async () => {
    /* The mutant: route through `newSession`. Eight agents would become eight leaves, and the user
       would have to dismantle the layout before reading any of them. */
    const store = await booted(api);
    const before = store.getState().layout;
    await store.getState().fanOutAgents({ brief: "Survey the adapters", count: 4, agentKind: "claude", worktrees: true });
    expect(store.getState().layout).toEqual(before);
  });

  it("runs them all in the space folder when the worktree switch is off", async () => {
    const store = await booted(api);
    const started = await store.getState().fanOutAgents({ brief: "Read the docs", count: 2, agentKind: "claude", worktrees: false });
    expect(worktrees(api)).toEqual([]);
    expect(started).toHaveLength(2);
  });

  it("clamps the count to something a person can still read, and to at least one", async () => {
    const store = await booted(api);
    await store.getState().fanOutAgents({ brief: "b", count: 99, agentKind: "claude", worktrees: false });
    expect(created(api)).toHaveLength(FAN_OUT_MAX);
    api.calls.length = 0;
    await store.getState().fanOutAgents({ brief: "b", count: 0, agentKind: "claude", worktrees: false });
    expect(created(api)).toHaveLength(1);
  });

  it("starts nothing at all for a brief that is only whitespace", async () => {
    /* The mutant: check `brief` rather than its trim. A batch of agents handed "   " burns a
       worktree and a turn each to ask what the user meant. */
    const store = await booted(api);
    expect(await store.getState().fanOutAgents({ brief: "   ", count: 3, agentKind: "claude", worktrees: true })).toEqual([]);
    expect(created(api)).toEqual([]);
  });

  it("keeps the agents that did start when one fails part-way, and still publishes their items", async () => {
    /* The mutant: roll the batch back, or let the throw skip the item refetch. The first destroys
       work to tidy up a number; the second leaves the sidebar without the agents that ARE running,
       which is exactly when the user needs to see them. */
    const store = await booted(api);
    let made = 0;
    const realWorktree = api.createWorktree;
    api.createWorktree = async (sid, title) => {
      if (++made === 3) throw new Error("fatal: not a git repository");
      return realWorktree(sid, title);
    };
    await expect(store.getState().fanOutAgents({ brief: "Fix it", count: 5, agentKind: "claude", worktrees: true }))
      .rejects.toThrow("not a git repository");
    expect(created(api)).toHaveLength(2);
    expect(api.sent).toHaveLength(2);
    expect(api.calls.filter((c) => c === "listItems:s1").length).toBeGreaterThan(0);
  });
});

describe("the wall's live line", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  it("records what a session is doing even though nobody has opened its transcript", async () => {
    /* The mutant: fold the activity AFTER the `!transcripts[id]` guard. Every session on the wall is
       one nobody has opened — that is what a wall is for — so the line would be blank for all of
       them and appear only for the pane already on screen. */
    const store = await booted(api);
    expect(store.getState().transcripts["se9"]).toBeUndefined();
    store.getState().applySessionEvent({
      seq: 1, sessionId: "se9", ephemeral: false,
      event: sessionEvent("tool_call", { toolUseId: "t", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 5),
    });
    expect(store.getState().sessionActivity["se9"]).toEqual({ text: "pnpm build", icon: "terminal", ts: 5, tool: "Bash" });
  });

  it("costs no extra store write: the line rides along with the transcript's own", async () => {
    /* The mutant that shipped once: `set` the activity on its own line, before the transcript write.
       A store notification is a render of every subscribed pane, so a second one per event is one
       extra render per event per streaming session — with a wall of agents open, which is exactly
       when this code runs, that is the whole page re-rendering twice as often. store.test.ts pins
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
