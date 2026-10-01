import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeLayout, allItems, findLeafOfItem, findSidePane, sessionEvent, type DelegationOutcome } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, notification, session, type FakeApi } from "./store.test-fakes";

/**
 * A delegated agent, from `session.agentOpened` to `session.agentSettled`: no pane of its own — it is
 * listed under the lead's running-agents control and previewed as a tab on request — and a clean
 * finish reads its "Finished a turn" row, since its report is already in the lead's transcript.
 * Every test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const open = (store: Store) => allItems(store.getState().layout!);
const leafOf = (store: Store, itemId: string) => findLeafOfItem(store.getState().layout!, itemId)!.id;

/** The lead session's pane open and focused, then a child delegated the way the server does it: the
 *  child's row and item exist first (`items.changed`), then `session.agentOpened` arrives. */
async function delegate(api: FakeApi): Promise<Store> {
  api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" })];
  api.data.sessions = [session("lead", "s1", { title: "Lead" })];
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  api.data.items.s1.push(item("i-kid", "s1", { kind: "session", refId: "kid", title: "Agent: fix the parser" }));
  api.data.sessions.push(session("kid", "s1", { title: "Agent: fix the parser", status: "running", dispatchedBy: { sessionId: "lead", kind: "agent_run" } }));
  await store.getState().refreshSessions();
  await store.getState().applyAgentOpened({ spaceId: "s1", sessionId: "kid", itemId: "i-kid" });
  return store;
}

/** The child's turn ends — its status stream says idle — and the server announces the settle. */
function finish(store: Store, opts: { outcome?: DelegationOutcome } = {}) {
  store.getState().applySessionStatus("kid", "idle");
  store.getState().applyAgentSettled({ spaceId: "s1", sessionId: "kid", itemId: "i-kid", outcome: opts.outcome ?? "done" });
}

describe("a delegated agent gets no pane of its own", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  it("leaves the layout and the keyboard exactly as they were", async () => {
    // THE MUTANT: open the child beside the lead, as before — a fan-out of eight is eight columns.
    const store = await delegate(api);
    expect(open(store)).toEqual(["i-lead"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-lead"));
  });

  it("a durable run's worker still arrives with the keyboard, as it always has", async () => {
    // Runs are not a sub-agent. THE MUTANT: treat every agentOpened as a child, and a scheduled
    // run's worker never appears at all.
    api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead" }), item("i-worker", "s1", { kind: "session", refId: "worker" })];
    api.data.sessions = [session("lead", "s1"), session("worker", "s1", { dispatchedBy: { sessionId: null, kind: "run" } })];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    await store.getState().applyAgentOpened({ spaceId: "s1", sessionId: "worker", itemId: "i-worker" });
    expect(open(store)).toEqual(["i-lead", "i-worker"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-worker"));
  });

  it("tells a run's worker apart even when its row has not reached the store yet", async () => {
    // `agentOpened` can beat `items.changed`'s refetch of the session list. THE MUTANT: read the row
    // from the store alone, and a worker whose row is still in flight is taken for a sub-agent.
    api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead" })];
    api.data.sessions = [session("lead", "s1")];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    api.data.items.s1.push(item("i-worker", "s1", { kind: "session", refId: "worker" }));
    api.data.sessions.push(session("worker", "s1", { dispatchedBy: { sessionId: null, kind: "run" } }));
    expect(store.getState().sessions["worker"]).toBeUndefined();
    await store.getState().applyAgentOpened({ spaceId: "s1", sessionId: "worker", itemId: "i-worker" });
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-worker"));
  });

  it("does not open a worker into another space's layout when the user switches mid-open", async () => {
    // THE MUTANT: drop the second space check, and the pane lands in the space the user switched TO.
    api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead" }), item("i-worker", "s1", { kind: "session", refId: "worker" })];
    api.data.sessions = [session("lead", "s1"), session("worker", "s1", { dispatchedBy: { sessionId: null, kind: "run" } })];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    api.delays["listItems:s1"] = 40;
    const opening = store.getState().applyAgentOpened({ spaceId: "s1", sessionId: "worker", itemId: "i-worker" });
    await store.getState().selectSpace("s2");
    await opening;
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(allItems(activeLayout(store.getState().groups!))).not.toContain("i-worker");
  });

  it("a click on the child previews it as a tab of the lead's side pane, keyboard left with the lead", async () => {
    const store = await delegate(api);
    expect(await store.getState().openInSidePane("lead", "i-kid")).toBe(true);
    expect(findSidePane(store.getState().layout!, "i-lead")).toMatchObject({ itemId: "i-kid", tabs: ["i-kid"] });
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-lead"));
  });
});

/**
 * Reading a finished child. The two halves of the focused pane's auto-read: the seen mark behind the
 * sidebar's dot (`markSessionSeen`), and the child's "Finished a turn" row in the feed
 * (`markNotificationsRead`), which is what the unread count counts. Every ending that is not a clean
 * finish keeps both, for the person who has to come back to it.
 */
describe("reading a child that finished cleanly", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });
  afterEach(() => { api.calls.length = 0; });

  /** The child's transcript held, as a preview tab holds it: four events, so its newest is seq 4. */
  async function childHeld(store: Store) {
    api.data.sessionEvents.kid = [
      { seq: 1, sessionId: "kid", event: sessionEvent("user_message", { text: "You are a delegated agent. Accomplish this goal: fix the parser", attachments: [] }) },
      { seq: 2, sessionId: "kid", event: sessionEvent("status", { status: "running" }) },
      { seq: 3, sessionId: "kid", event: sessionEvent("assistant_text", { messageId: "m1", text: "Fixed the parser; tests pass." }) },
      { seq: 4, sessionId: "kid", event: sessionEvent("status", { status: "idle" }) },
    ];
    await store.getState().openSession("kid");
  }
  const finishedRow = (store: Store) => store.getState().applyNotificationsChanged({
    notification: notification("n-kid", { sessionId: "kid", refId: "kid", title: "Agent: fix the parser" }), unread: 1,
  });
  const reads = () => api.calls.filter((c) => c.startsWith("markSessionSeen:kid") || c.startsWith("markNotificationsRead:"));
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it("reads its seen mark and its row — a fan-out of ten does not leave ten", async () => {
    const store = await delegate(api);
    await childHeld(store);
    finishedRow(store);
    finish(store);
    await settled();
    // THE MUTANTS: drop either call, or forget to note the row as it arrives.
    expect(reads()).toEqual(["markSessionSeen:kid@4", "markNotificationsRead:n-kid"]);
  });

  it("moves only the seen mark when no row arrived — Sessions finishing switched off in the feed", async () => {
    // THE MUTANT: drop the guard, and the server is asked to read `[undefined]`, which fails
    // validation and puts an error banner over a finish that went fine.
    const store = await delegate(api);
    await childHeld(store);
    finish(store);
    await settled();
    expect(reads()).toEqual(["markSessionSeen:kid@4"]);
    expect(store.getState().error).toBeNull();
  });

  it.each([
    ["it failed", { outcome: "failed" as const }],
    ["someone stopped it", { outcome: "stopped" as const }],
    ["it timed out", { outcome: "timeout" as const }],
    ["it is waiting on a permission again", { waiting: true }],
    ["the user has written to it", { wrote: true }],
  ])("reads nothing when %s", async (_why, how) => {
    // THE MUTANT: read on every settle, and the row that says "come back to this" is read by the
    // very ending that needs a person.
    const store = await delegate(api);
    await childHeld(store);
    if ("wrote" in how) await store.getState().sendMessage("kid", "also update the changelog");
    finishedRow(store);
    store.getState().applySessionStatus("kid", "idle");
    if ("waiting" in how) store.getState().applySessionStatus("kid", "waiting_permission");
    store.getState().applyAgentSettled({ spaceId: "s1", sessionId: "kid", itemId: "i-kid", outcome: "outcome" in how ? how.outcome : "done" });
    await settled();
    expect(reads()).toEqual([]);
  });
});

describe("what agents open goes into the side pane of the session that asked", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });

  /** Two sessions side by side, the user typing in the RIGHT one (s-b), and a child of the left. */
  async function twoLeads(): Promise<Store> {
    api.data.items.s1 = [
      item("i-a", "s1", { kind: "session", refId: "a" }), item("i-b", "s1", { kind: "session", refId: "b" }),
      item("i-kid", "s1", { kind: "session", refId: "kid" }),
    ];
    api.data.sessions = [session("a", "s1"), session("b", "s1"), session("kid", "s1", { dispatchedBy: { sessionId: "a", kind: "agent_run" } })];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-a");
    await store.getState().openItemBeside("i-b");
    return store;
  }
  const browser = (id: string) => api.data.items.s1!.push(item(id, "s1", { kind: "browser", refId: `ref-${id}` }));

  it("puts a browser beside the session that opened it, not the one with focus, and leaves focus there", async () => {
    // THE MUTANT: the old `openItemBeside(itemId)` — the browser lands beside s-b, the pane being typed in.
    const store = await twoLeads();
    const typing = store.getState().focusedLeafId;
    browser("i-br1");
    await store.getState().applyAgentPaneOpened({ spaceId: "s1", itemId: "i-br1", openedBy: "a" });
    expect(findSidePane(store.getState().layout!, "i-a")).toMatchObject({ itemId: "i-br1", tabs: ["i-br1"] });
    expect(open(store)).toEqual(["i-a", "i-br1", "i-b"]);
    expect(store.getState().focusedLeafId).toBe(typing);
  });

  it("every later browser is a tab of that one pane, not a column", async () => {
    const store = await twoLeads();
    for (const id of ["i-br1", "i-br2", "i-br3"]) {
      browser(id);
      await store.getState().applyAgentPaneOpened({ spaceId: "s1", itemId: id, openedBy: "a" });
    }
    expect(findSidePane(store.getState().layout!, "i-a")).toMatchObject({ itemId: "i-br3", tabs: ["i-br1", "i-br2", "i-br3"] });
    expect(open(store)).toHaveLength(5);
  });

  it("a sub-agent's browser goes beside its lead — the child has no pane to be beside", async () => {
    // THE MUTANT: look only for the asking session's own pane, and a child's browser opens nowhere.
    const store = await twoLeads();
    browser("i-br1");
    await store.getState().applyAgentPaneOpened({ spaceId: "s1", itemId: "i-br1", openedBy: "kid" });
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toEqual(["i-br1"]);
  });

  it("falls back to beside the focused pane when no session in the chain is on screen — the page must be live", async () => {
    // THE MUTANT: open nothing. A browser that never had a pane has no view, and the agent that just
    // opened it is refused with "the pane is not open in the app".
    api.data.items.s1 = [item("i-a", "s1", { kind: "session", refId: "a" }), item("i-z", "s1", { kind: "session", refId: "z" })];
    api.data.sessions = [session("a", "s1"), session("z", "s1")];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-a");
    browser("i-br1");
    await store.getState().applyAgentPaneOpened({ spaceId: "s1", itemId: "i-br1", openedBy: "z" });
    expect(open(store)).toEqual(["i-a", "i-br1"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-a"));
  });

  it("an agent's document goes to the same side pane; one a person opened still arrives beside", async () => {
    const store = await twoLeads();
    api.data.items.s1!.push(item("i-docs", "s1", { kind: "documents", refId: "ws1" }));
    await store.getState().applyDocumentOpenRequested({ spaceId: "s1", environmentId: "e1", documentsId: "ws1", itemId: "i-docs", path: "a.md", openedBy: "a" });
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toEqual(["i-docs"]);
  });

  it("brings a document tab behind a browser to the front when the agent opens another file", async () => {
    const store = await twoLeads();
    api.data.items.s1!.push(item("i-docs", "s1", { kind: "documents", refId: "ws1" }));
    const req = { spaceId: "s1", environmentId: "e1", documentsId: "ws1", itemId: "i-docs", path: "a.md", openedBy: "a" };
    await store.getState().applyDocumentOpenRequested(req);
    browser("i-br1");
    await store.getState().applyAgentPaneOpened({ spaceId: "s1", itemId: "i-br1", openedBy: "a" });
    await store.getState().applyDocumentOpenRequested({ ...req, path: "b.md" });
    expect(findSidePane(store.getState().layout!, "i-a")).toMatchObject({ itemId: "i-docs", tabs: ["i-docs", "i-br1"] });
  });
});
