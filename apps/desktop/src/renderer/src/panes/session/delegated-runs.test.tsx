import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { allItems, type DelegatedRun } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { sessionEvent } from "@realm/contracts";

const KID: DelegatedRun = { sessionId: "se2", startedAt: 0, detached: false, owned: true };
const PEER: DelegatedRun = { sessionId: "se3", startedAt: 0, detached: false, owned: false };

const ITEMS = { s1: [
  item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" }),
  item("i8", "s1", { kind: "session", title: "Agent: audit the mapper", refId: "se2" }),
  item("i7", "s1", { kind: "session", title: "A colleague", refId: "se3" }),
] };
const SESSIONS = [
  session("se1", "s1", { title: "Parent" }),
  session("se2", "s1", { title: "Agent: audit the mapper", status: "running", dispatchedBy: { sessionId: "se1", kind: "agent_run" } }),
  session("se3", "s1", { title: "A colleague" }),
];

async function mount(delegatedRuns: Record<string, DelegatedRun[]> = {}) {
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "running", se2: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  await store.getState().openItem("i9");
  const r = render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const dock = () => screen.queryByRole("button", { name: /agents? in flight for Parent/ });

afterEach(() => cleanup());

describe("the delegating session's dock", () => {
  it("draws nothing at all for a session that is waiting on no one", async () => {
    await mount();
    expect(dock()).toBeNull();
  });

  it("fetches on mount, so a pane opened mid-delegation still sees the run", async () => {
    const { api } = await mount({ se1: [KID] });
    // THE MUTANT: drop the fetch and rely on `delegation.changed` alone. The registry is in the
    // server's memory, so a reload — or a second window, or opening the pane ten minutes in — would
    // show nothing until the run ENDED, which is exactly when it stops being worth showing.
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(api.calls).toContain("listDelegatedRuns:se1");
    expect(screen.getByRole("button", { name: /Agent: audit the mapper/ })).toBeInTheDocument();
  });

  it("leaves when the last run settles rather than sitting there stale", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [] });
    // THE MUTANT: have `applyDelegationChanged` merge, or park the empty array under the key. The
    // pane then keeps announcing an agent that finished, with nothing left that will ever correct
    // it — the registry has already forgotten the run.
    await waitFor(() => expect(dock()).toBeNull());
    expect(store.getState().delegatedRuns).not.toHaveProperty("se1");
  });

  it("refetches when the socket comes back, because the registry may have died with the server", async () => {
    const scripted: Record<string, DelegatedRun[]> = { se1: [KID] };
    const { store } = await mount(scripted);
    await waitFor(() => expect(dock()).not.toBeNull());
    delete scripted["se1"]; // the server restarted while we were away: it is holding nothing now
    store.getState().applyConnectionState("reconnecting");
    store.getState().applyConnectionState("connected");
    // THE MUTANT: leave delegation out of the reconnect refetch. Every other kind of stale state
    // that gap covers is backed by a table the server can re-read; this one is not backed by
    // anything, so nothing will ever arrive to correct it and the dock names agents that are gone.
    await waitFor(() => expect(dock()).toBeNull());
  });

  it("replaces the set rather than accumulating: the payload is the whole truth", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [PEER] });
    expect(store.getState().delegatedRuns["se1"]).toEqual([PEER]);
  });

  it("opens a sub-agent BESIDE its parent, never over the top of it", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(dock()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Agent: audit the mapper/ }));
    // THE MUTANT: open in place. The pane the user pressed the button in is the parent whose work
    // they are trying to follow, and evicting it to show the child destroys the comparison.
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(expect.arrayContaining(["i9", "i8"])));
  });

  it("does not call a peer it merely asked a question a sub-agent", async () => {
    await mount({ se1: [PEER] });
    // THE MUTANT: read the origin off the session row for every run. A peer was doing its own work
    // before the question arrived and keeps doing it after — `agent_ask` neither spawned it nor owns
    // it, and its own row says nothing about this session at all.
    await waitFor(() => expect(screen.getByRole("button", { name: /A colleague/ })).toHaveAccessibleName(/Asked a question/));
  });
});

describe("sub-agents the HARNESS is running", () => {
  /* A different animal to a delegated run, and the difference is why these were invisible: an
     `agent_run` creates a real Realm session with a row, a pane and a place in the layout, and the
     dock listed those. Claude's own `Task` tool creates none of that — the subagent lives and dies
     inside the CLI process — so ten of them in flight showed nothing at all. */
  const task = (id: string, description: string, done = false) => [
    sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description }, parentToolUseId: null }),
    ...(done ? [sessionEvent("tool_result", { toolUseId: id, content: "ok", isError: false })] : []),
  ];

  /** The DOCK's own rows. The same text is also in the transcript's tool card for that call — which
   *  is right, and is why every assertion here is scoped rather than global. */
  const dockText = () => [...document.querySelectorAll(".delegation-item .delegation-title")].map((n) => n.textContent);

  async function mountWith(events: ReturnType<typeof sessionEvent>[], delegatedRuns: Record<string, DelegatedRun[]> = {}) {
    const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i9");
    return { store, ...render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>) };
  }

  it("shows a card for in-flight Task calls, which have no session behind them", async () => {
    await mountWith([...task("t1", "audit the mapper"), ...task("t2", "check the tests")]);
    await waitFor(() => expect(screen.getByText("2 agents running")).toBeInTheDocument());
    expect(dockText()).toEqual(["audit the mapper", "check the tests"]);
  });

  it("opens the sub-agent's panel — there is no pane to jump to, but there is work to watch", async () => {
    /* There is no session behind a harness sub-agent, so a jump to a pane would be a button that
       cannot work. There IS something to watch: every call it makes lands in this transcript under
       its launching call, and the drawer is where those are read. */
    const { store } = await mountWith(task("t1", "audit the mapper"));
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    expect(screen.getAllByText("in the agent")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Watch audit the mapper" }));
    expect(store.getState().sessionDock.se1).toEqual({ kind: "subagent", toolUseId: "t1" });
    expect(await screen.findByRole("dialog", { name: "Sub-agent: audit the mapper" })).toBeInTheDocument();
  });

  it("the row is the control that closes it too — a lit control says the state and undoes it", async () => {
    const { store } = await mountWith(task("t1", "audit the mapper"));
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    // Re-queried each time: opening the drawer re-parents the whole pane body into a split, so a
    // node held from before the click is a detached one.
    const row = () => screen.getByRole("button", { name: "Watch audit the mapper" });
    fireEvent.click(row());
    expect(row()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(row());
    expect(store.getState().sessionDock.se1).toBeUndefined();
    expect(screen.queryByRole("dialog", { name: /Sub-agent/ })).toBeNull();
  });

  it("names a Workflow by the name in its own script", async () => {
    /* The case that made this card look broken: a request for ten research agents produced one
       `Workflow` call, not ten `Task` ones, so a list that knew only about Task showed nothing at
       all. A Workflow names itself in its script's `meta`, which is the only place its name is. */
    await mountWith([sessionEvent("tool_call", { toolUseId: "w1", name: "Workflow",
      input: { script: "export const meta = { name: 'diamond-stuart-research', description: 'Parallel research' }" },
      parentToolUseId: null })]);
    await waitFor(() => expect(dockText()).toEqual(["diamond-stuart-research"]));
  });

  it("drops one the moment its result lands", async () => {
    await mountWith([...task("t1", "audit the mapper", true)]);
    expect(document.querySelector(".composer-agents")).toBeNull();
  });

  it("counts a Task alongside a real delegated run, in one card", async () => {
    await mountWith(task("t1", "audit the mapper"), { se1: [KID] });
    await waitFor(() => expect(screen.getByText("2 agents running")).toBeInTheDocument());
  });

  it("does not list a call made UNDER a Task — that is the Task's business, not a second row", async () => {
    await mountWith([
      ...task("t1", "audit the mapper"),
      sessionEvent("tool_call", { toolUseId: "t2", name: "Task", input: { description: "nested" }, parentToolUseId: "t1" }),
    ]);
    await waitFor(() => expect(screen.getByText("1 agent running")).toBeInTheDocument());
    expect(dockText()).toEqual(["audit the mapper"]);
  });
});

/**
 * BACKGROUND sub-agents — the mode that showed nothing at all.
 *
 * A background `Agent` call returns within a second and then runs for minutes, so "the result has
 * not landed" (which is what the blocking case above keys on) is false for the entire run. Ten of
 * them read as ten finished calls. The adapter now marks the launch and the harness's completion
 * notification as `background_task` events, and these are what the dock reads instead.
 */
describe("background sub-agents the harness is running", () => {
  const launch = (id: string, description: string) => [
    sessionEvent("tool_call", { toolUseId: id, name: "Agent", input: { description }, parentToolUseId: null }),
    // The launch result lands almost immediately — this is the whole difficulty.
    sessionEvent("tool_result", { toolUseId: id, content: "Async agent launched successfully.", isError: false }),
    sessionEvent("background_task", { toolUseId: id, status: "running" }),
  ];
  const stopped = (id: string) => sessionEvent("background_task", { toolUseId: id, status: "stopped", summary: "finished" });
  const dockText = () => [...document.querySelectorAll(".delegation-item .delegation-title")].map((n) => n.textContent);

  async function mountWith(events: ReturnType<typeof sessionEvent>[]) {
    const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns: {} });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i9");
    return render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  }

  it("lists agents whose launch call has ALREADY returned — the case that showed nothing", async () => {
    await mountWith([...launch("t1", "Agent 1: hold 10m"), ...launch("t2", "Agent 2: hold 10m")]);
    // THE MUTANT: keep the old `result === null` rule. Both calls have results, so the dock does not
    // render at all — which is exactly the bug this was reported as.
    await waitFor(() => expect(screen.getByText("2 agents running")).toBeInTheDocument());
    expect(dockText()).toEqual(["Agent 1: hold 10m", "Agent 2: hold 10m"]);
  });

  it("drops the row when the harness notifies that the agent stopped", async () => {
    await mountWith([...launch("t1", "Agent 1"), ...launch("t2", "Agent 2"), stopped("t1")]);
    await waitFor(() => expect(dockText()).toEqual(["Agent 2"]));
    expect(screen.getByText("1 agent running")).toBeInTheDocument();
  });

  it("leaves entirely once the last one stops", async () => {
    await mountWith([...launch("t1", "Agent 1"), stopped("t1")]);
    // THE MUTANT: fold the stop onto nothing (or read only the launch). A row for an agent that
    // finished ten minutes ago is worse than the blank the dock used to show.
    expect(document.querySelector(".delegation-dock")).toBeNull();
  });

  it("ignores a notification naming a call this transcript has never seen", async () => {
    await mountWith([...launch("t1", "Agent 1"), stopped("nonexistent")]);
    // A stray notification must not close somebody else's run, and must not invent a row of its own.
    await waitFor(() => expect(dockText()).toEqual(["Agent 1"]));
  });
});
