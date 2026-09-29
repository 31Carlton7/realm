import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeLayout, allItems, CLOSE_FINISHED_AGENT_PANES_KEY, findLeafOfItem, type DelegationOutcome } from "@realm/contracts";
import { AGENT_PANE_CLOSE_BEAT_MS, createAppStore } from "./store";
import { fakeApi, item, session, type FakeApi } from "./store.test-fakes";

/**
 * A delegated agent's pane, from `session.agentOpened` to `session.agentSettled`: Realm takes back
 * the pane it opened for a child that finished cleanly, after a beat, and nothing else. Every test
 * below names the one-line change that would make it fail — the mutant it exists to kill.
 */

type Store = ReturnType<typeof createAppStore>;
const open = (store: Store) => allItems(store.getState().layout!);
const leafOf = (store: Store, itemId: string) => findLeafOfItem(store.getState().layout!, itemId)!.id;
/** Long enough for any close the beat was going to make to have been made. */
const pastTheBeat = () => vi.advanceTimersByTimeAsync(AGENT_PANE_CLOSE_BEAT_MS * 2);

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

/** The child's turn ends — its status stream says idle — and the server announces the settle. The
 *  timers go fake here and not earlier: boot and the fake Api ride real ones. */
function finish(store: Store, opts: { outcome?: DelegationOutcome } = {}) {
  store.getState().applySessionStatus("kid", "idle");
  vi.useFakeTimers();
  store.getState().applyAgentSettled({ spaceId: "s1", sessionId: "kid", itemId: "i-kid", outcome: opts.outcome ?? "done" });
}

/** The user clicks into the child's pane, and back to the lead — where they type, and where the
 *  child's report lands. */
const intoChild = (store: Store) => store.getState().focusLeaf(leafOf(store, "i-kid"));
const backToLead = (store: Store) => store.getState().focusLeaf(leafOf(store, "i-lead"));

describe("a delegated agent's pane — Realm takes back what it opened, once it finished, and nothing else", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });
  afterEach(() => { vi.useRealTimers(); });

  it("brings the child in beside the lead without taking the keyboard", async () => {
    // THE MUTANT: the focusing open (`openItemBeside`). The child's pane takes the keyboard, so its
    // permission and question cards grab focus as they appear — the Enter the user was typing to the
    // lead answers the child's prompt — and the pane is then "the one they are in", which keeps it
    // open however cleanly the child finishes.
    const store = await delegate(api);
    expect(open(store)).toEqual(["i-lead", "i-kid"]); // beside, never in place of, the pane the user is in
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-lead"));
  });

  it("closes a watched child's pane after a beat once it finishes — nobody has to click away first", async () => {
    // The case that kept every single agent_run's pane open while the open took the keyboard: the user
    // watches the child work, touches nothing, and it finishes.
    const store = await delegate(api);
    finish(store);
    await vi.advanceTimersByTimeAsync(AGENT_PANE_CLOSE_BEAT_MS - 1);
    // THE MUTANT: close on arrival. The pane goes on the frame its status settles, which reads as the
    // agent crashing or as something else closing it — the finish is never seen.
    expect(open(store)).toContain("i-kid");
    await vi.advanceTimersByTimeAsync(1);
    expect(open(store)).toEqual(["i-lead"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-lead")); // the user is where they were
  });

  it("a durable run's worker still arrives with the keyboard, as it always has", async () => {
    // Runs are not this change's to decide. THE MUTANT: open every agentOpened quietly, and a run's
    // worker stops arriving the way it did before anyone asked for that.
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
    // from the store alone, and a worker whose row is still in flight is opened as a sub-agent.
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

  it("closes the pane and nothing behind it — the item and the session stay", async () => {
    const store = await delegate(api);
    finish(store);
    await pastTheBeat();
    expect(open(store)).not.toContain("i-kid");
    // THE MUTANT: `deleteItem` for `closeFromLayout`. design.md — closing a pane never implies
    // deleting the object behind it — and this object is a whole transcript the lead's report came from.
    expect(api.calls.filter((c) => c.startsWith("deleteItem"))).toEqual([]);
    expect(store.getState().items.map((i) => i.id)).toContain("i-kid");
    expect(store.getState().sessions["kid"]).toBeDefined();
  });

  it.each(["stopped", "failed", "timeout", "interrupted", "gone"] as const)("keeps the pane of a run that ended %s", async (outcome) => {
    // THE MUTANT: take back on any settle. Each of these leaves something a person has to read in the
    // pane — the error, the partial report, where it was cut off — and `stopped` is a child someone
    // halted on purpose, to look at it or to redirect it.
    const store = await delegate(api);
    finish(store, { outcome });
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it.each(["waiting_permission", "running"] as const)("keeps a child that is %s again by the end of the beat", async (status) => {
    // `done` meant idle when the engine looked. A permission prompt — or a question, which rides the
    // same channel — or a message from another window can land inside the beat. THE MUTANT: trust
    // the settle's word and skip the re-read, and a pane closes on a child that is asking for the user.
    const store = await delegate(api);
    finish(store);
    store.getState().applySessionStatus("kid", status);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("keeps the pane the user is in", async () => {
    // The user clicked into the child and stayed: by the one measure of attention the renderer has,
    // they are reading it. THE MUTANT: drop the focus test.
    const store = await delegate(api);
    intoChild(store);
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("decides once per run — a repeated settle cannot close a pane the first one kept", async () => {
    // The server announces once (agent-run.test.ts pins it); this is the renderer not depending on
    // that. THE MUTANT: keep the entry after the decision, and a second announcement arriving once
    // the user has looked away re-decides a pane that was kept because they were in it.
    const store = await delegate(api);
    intoChild(store);
    finish(store); // the user is in the child's pane, so it stays
    await pastTheBeat();
    backToLead(store);
    store.getState().applyAgentSettled({ spaceId: "s1", sessionId: "kid", itemId: "i-kid", outcome: "done" });
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("keeps a pane the user clicks into during the beat", async () => {
    // The beat is also the chance to say no. THE MUTANT: decide once, on arrival, and close on the
    // timer regardless — the click lands, and the pane leaves from under it anyway.
    const store = await delegate(api);
    finish(store);
    await vi.advanceTimersByTimeAsync(AGENT_PANE_CLOSE_BEAT_MS / 2);
    intoChild(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("a glance is not an adoption — a pane the user looked at and left still closes", async () => {
    // Focus is asked at the moment of the close, not remembered. Answering the child's permission
    // prompt, checking on it — every child in a fan-out gets one of those, and if a glance kept a pane
    // for good, the feature would keep nearly all of them.
    const store = await delegate(api);
    intoChild(store);
    backToLead(store);
    finish(store);
    await pastTheBeat();
    expect(open(store)).toEqual(["i-lead"]);
  });

  it("keeps a child the user has written to, for good", async () => {
    // A steered message the child answers inside its own turn leaves it idle with a report — nothing
    // on the row says a person was ever there. THE MUTANT: drop the claim in `sendMessage`, and a
    // conversation the user joined is closed on them the moment it finishes.
    const store = await delegate(api);
    intoChild(store);
    await store.getState().sendMessage("kid", "also update the changelog");
    backToLead(store);
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it.each(["draft", "attachment"] as const)("keeps a child with an unsent %s in its prompter", async (what) => {
    // THE MUTANT: forget the prompter. The words would survive the close — drafts are kept by
    // session — but out of sight, in a pane the user did not close.
    const store = await delegate(api);
    if (what === "draft") store.getState().setDraft("kid", "one more thing:");
    else store.setState({ pendingAttachments: { kid: [{ path: "/tmp/trace.png", mime: "image/png", name: "trace.png", size: 1 }] } });
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("never touches a pane the user opened", async () => {
    // The same child and the same settle, but the pane is one the user put there — no agentOpened in
    // this window (another window's, or a reload since). THE MUTANT: take back any pane showing the
    // settled child, and Realm closes something it never opened.
    api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead" }), item("i-kid", "s1", { kind: "session", refId: "kid" })];
    api.data.sessions = [session("lead", "s1"), session("kid", "s1", { dispatchedBy: { sessionId: "lead", kind: "agent_run" } })];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    await store.getState().openItemAt("i-kid", leafOf(store, "i-lead"), "right");
    backToLead(store);
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("never touches a pane the user closed and opened again", async () => {
    // The item is the same, the pane is not: it sits in a leaf the user chose. THE MUTANT: match on
    // the item alone, and the pane the user deliberately brought back is taken away again.
    const store = await delegate(api);
    await store.getState().closeFromLayout("i-kid");
    await store.getState().openItemAt("i-kid", leafOf(store, "i-lead"), "right");
    backToLead(store);
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("leaves the arrangement alone when the user has moved on to another group", async () => {
    // THE MUTANT: look the pane up in every group. `closeFromLayout` would happily detach it from an
    // arrangement the user is not looking at, and they would come back to find it rearranged.
    const store = await delegate(api);
    const main = store.getState().groups!.activeGroupId;
    // A group with something in it, so this is the group rule and not the last-pane guard at work.
    api.data.items.s1!.push(item("i-notes", "s1", { title: "Notes" }));
    await store.getState().refreshItems();
    await store.getState().newPaneGroup();
    await store.getState().openItem("i-notes");
    finish(store);
    await pastTheBeat();
    await store.getState().activatePaneGroup(main);
    expect(open(store)).toContain("i-kid");
  });

  it("never closes the last pane standing — that would conjure a fresh session", async () => {
    // The user closed the lead and split an empty box beside the child, so the child is the only
    // pane holding anything and not the one focused. THE MUTANT: drop the guard, and the close
    // empties the layout and `closeFromLayout` makes a brand-new session to fill it.
    const store = await delegate(api);
    await store.getState().closeFromLayout("i-lead");
    await store.getState().splitFocused("row");
    const before = api.calls.filter((c) => c.startsWith("createSession")).length;
    finish(store);
    await pastTheBeat();
    expect(open(store)).toEqual(["i-kid"]);
    expect(api.calls.filter((c) => c.startsWith("createSession")).length).toBe(before);
  });

  it("does nothing when the switch is off", async () => {
    const store = await delegate(api);
    await store.getState().setCloseFinishedAgentPanes(false);
    expect(api.calls).toContain(`setSetting:${CLOSE_FINISHED_AGENT_PANES_KEY}=false`);
    // THE MUTANT: forget to ask the preference, and the switch in Settings does nothing.
    finish(store);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("is on unless the stored value is exactly false", async () => {
    // THE MUTANT: `=== true`. Every home from before the switch existed has no key, and would find
    // the feature off without anyone having turned it off.
    for (const [stored, on] of [[undefined, true], [null, true], ["false", true], [0, true], [false, false]] as const) {
      const store = createAppStore(fakeApi(stored === undefined ? {} : { settings: { [CLOSE_FINISHED_AGENT_PANES_KEY]: stored } }));
      await store.getState().boot();
      expect(store.getState().closeFinishedAgentPanes, String(stored)).toBe(on);
    }
  });

  it("opens nothing, and so takes back nothing, for a child in a space the user is not in", async () => {
    const store = await delegate(api);
    const before = open(store);
    await store.getState().applyAgentOpened({ spaceId: "s2", sessionId: "other", itemId: "i-other" });
    expect(open(store)).toEqual(before);
  });

  it("does not open a child into another space's layout when the user switches mid-open", async () => {
    // The item fetch is in flight when the user changes space. THE MUTANT: drop the second space
    // check, and the child's pane lands in the space the user switched TO — a pane in the wrong room.
    api.data.items.s1 = [item("i-lead", "s1", { kind: "session", refId: "lead" }), item("i-kid", "s1", { kind: "session", refId: "kid" })];
    api.data.sessions = [session("lead", "s1"), session("kid", "s1")];
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    api.delays["listItems:s1"] = 40;
    const opening = store.getState().applyAgentOpened({ spaceId: "s1", sessionId: "kid", itemId: "i-kid" });
    await store.getState().selectSpace("s2");
    await opening;
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(open(store)).not.toContain("i-kid");
    expect(allItems(activeLayout(store.getState().groups!))).not.toContain("i-kid");
  });
});
