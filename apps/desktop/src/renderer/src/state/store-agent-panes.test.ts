import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeLayout, allItems, CLOSE_FINISHED_AGENT_PANES_KEY, findLeafOfItem, sessionEvent, type DelegationOutcome, type StoredSessionEvent } from "@realm/contracts";
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

/** One turn of the child's, as its event log holds it — a finish, or a turn a person stopped. */
const turn = (stopped: boolean): StoredSessionEvent[] => [
  { seq: 1, sessionId: "kid", event: sessionEvent("user_message", { text: "You are a delegated agent. Accomplish this goal: fix the parser", attachments: [] }) },
  { seq: 2, sessionId: "kid", event: sessionEvent("status", { status: "running" }) },
  { seq: 3, sessionId: "kid", event: sessionEvent("assistant_text", { messageId: "m1", text: "Fixed the parser; tests pass." }) },
  { seq: 4, sessionId: "kid", event: sessionEvent("status", { status: "idle", ...(stopped ? { interrupted: true } : {}) }) },
];

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

/** The child's turn ends — its transcript loaded, as it is once its pane has mounted — and the
 *  server announces the settle. The timers go fake here and not earlier: boot and the fake Api ride
 *  real ones. */
async function finish(store: Store, api: FakeApi, opts: { outcome?: DelegationOutcome; stopped?: boolean } = {}) {
  api.data.sessionEvents.kid = turn(opts.stopped ?? false);
  await store.getState().openSession("kid");
  store.getState().applySessionStatus("kid", "idle");
  vi.useFakeTimers();
  store.getState().applyAgentSettled({ spaceId: "s1", sessionId: "kid", itemId: "i-kid", outcome: opts.outcome ?? "done" });
}

/** The user goes back to the lead — where they type, and where the child's report lands. */
const backToLead = (store: Store) => store.getState().focusLeaf(leafOf(store, "i-lead"));

describe("a delegated agent's pane — Realm takes back what it opened, once it finished, and nothing else", () => {
  let api: FakeApi;
  beforeEach(() => { api = fakeApi(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens the child beside the lead, and closes that pane after a beat once the child finishes", async () => {
    const store = await delegate(api);
    expect(open(store)).toEqual(["i-lead", "i-kid"]); // beside, never in place of, the pane the user is in
    backToLead(store);
    await finish(store, api);
    await vi.advanceTimersByTimeAsync(AGENT_PANE_CLOSE_BEAT_MS - 1);
    // THE MUTANT: close on arrival. The pane goes on the frame its status settles, which reads as the
    // agent crashing or as something else closing it — the finish is never seen.
    expect(open(store)).toContain("i-kid");
    await vi.advanceTimersByTimeAsync(1);
    expect(open(store)).toEqual(["i-lead"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-lead")); // the user is where they were
  });

  it("closes the pane and nothing behind it — the item and the session stay", async () => {
    const store = await delegate(api);
    backToLead(store);
    await finish(store, api);
    await pastTheBeat();
    expect(open(store)).not.toContain("i-kid");
    // THE MUTANT: `deleteItem` for `closeFromLayout`. design.md — closing a pane never implies
    // deleting the object behind it — and this object is a whole transcript the lead's report came from.
    expect(api.calls.filter((c) => c.startsWith("deleteItem"))).toEqual([]);
    expect(store.getState().items.map((i) => i.id)).toContain("i-kid");
    expect(store.getState().sessions["kid"]).toBeDefined();
  });

  it.each(["failed", "timeout", "interrupted", "gone"] as const)("keeps the pane of a run that ended %s", async (outcome) => {
    // THE MUTANT: take back on any settle. Each of these leaves something a person has to read in the
    // pane — the error, the partial report, where it was cut off.
    const store = await delegate(api);
    backToLead(store);
    await finish(store, api, { outcome });
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it.each(["waiting_permission", "running"] as const)("keeps a child that is %s again by the end of the beat", async (status) => {
    // `done` meant idle when the engine looked. A permission prompt — or a question, which rides the
    // same channel — or a message from another window can land inside the beat. THE MUTANT: trust
    // the settle's word and skip the re-read, and a pane closes on a child that is asking for the user.
    const store = await delegate(api);
    backToLead(store);
    await finish(store, api);
    store.getState().applySessionStatus("kid", status);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("keeps the pane the user is in", async () => {
    // openItemBeside hands a new pane the keyboard, and the user never left it: by the one measure of
    // attention the renderer has, they are watching this child. THE MUTANT: drop the focus test.
    const store = await delegate(api);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-kid"));
    await finish(store, api);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("decides once per run — a repeated settle cannot close a pane the first one kept", async () => {
    // The server announces once (agent-run.test.ts pins it); this is the renderer not depending on
    // that. THE MUTANT: keep the entry after the decision, and a second announcement arriving once
    // the user has looked away re-decides a pane that was kept because they were in it.
    const store = await delegate(api);
    await finish(store, api); // the user is in the child's pane, so it stays
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
    backToLead(store);
    await finish(store, api);
    await vi.advanceTimersByTimeAsync(AGENT_PANE_CLOSE_BEAT_MS / 2);
    store.getState().focusLeaf(leafOf(store, "i-kid"));
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("a glance is not an adoption — a pane the user looked at and left still closes", async () => {
    // Focus is asked at the moment of the close, not remembered. Answering the child's permission
    // prompt, checking on it — every child in a fan-out gets one of those, and if a glance kept a pane
    // for good, the feature would keep nearly all of them.
    const store = await delegate(api);
    store.getState().focusLeaf(leafOf(store, "i-kid"));
    backToLead(store);
    await finish(store, api);
    await pastTheBeat();
    expect(open(store)).toEqual(["i-lead"]);
  });

  it("keeps a child the user has written to, for good", async () => {
    // A steered message the child answers inside its own turn leaves it idle with a report — nothing
    // on the row says a person was ever there. THE MUTANT: drop the claim in `sendMessage`, and a
    // conversation the user joined is closed on them the moment it finishes.
    const store = await delegate(api);
    await store.getState().sendMessage("kid", "also update the changelog");
    backToLead(store);
    await finish(store, api);
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it("keeps a child whose turn a person stopped, which the engine reports as done", async () => {
    // A stopped turn settles idle with whatever the child had said, and the engine reads the status,
    // not why it changed. THE MUTANT: drop the transcript's `stopped` check, and a child the user
    // stopped — to look at it, or to redirect it — is closed as though it had finished.
    const store = await delegate(api);
    backToLead(store);
    await finish(store, api, { stopped: true });
    await pastTheBeat();
    expect(open(store)).toContain("i-kid");
  });

  it.each(["draft", "attachment"] as const)("keeps a child with an unsent %s in its prompter", async (what) => {
    // THE MUTANT: forget the prompter. The words would survive the close — drafts are kept by
    // session — but out of sight, in a pane the user did not close.
    const store = await delegate(api);
    if (what === "draft") store.getState().setDraft("kid", "one more thing:");
    else store.setState({ pendingAttachments: { kid: [{ path: "/tmp/trace.png", mime: "image/png", name: "trace.png", size: 1 }] } });
    backToLead(store);
    await finish(store, api);
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
    await finish(store, api);
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
    await finish(store, api);
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
    await finish(store, api);
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
    await finish(store, api);
    await pastTheBeat();
    expect(open(store)).toEqual(["i-kid"]);
    expect(api.calls.filter((c) => c.startsWith("createSession")).length).toBe(before);
  });

  it("does nothing when the switch is off", async () => {
    const store = await delegate(api);
    await store.getState().setCloseFinishedAgentPanes(false);
    expect(api.calls).toContain(`setSetting:${CLOSE_FINISHED_AGENT_PANES_KEY}=false`);
    backToLead(store);
    // THE MUTANT: forget to ask the preference, and the switch in Settings does nothing.
    await finish(store, api);
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
