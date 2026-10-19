import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findLeafOfItem, findSidePane, type DelegatedChild, type DelegatedRun } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionMeta, SessionPane } from "./SessionPane";
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
/** The sub-agent behind KID, as `delegation.children` lists it. */
const KID_CHILD: DelegatedChild = { session: SESSIONS[1]!, goal: "Agent: audit the mapper", startedAt: 0, settledAt: null,
  outcome: null, report: null, activity: null };

/** Mounted as the window has it: the pane's bar over the pane, the prompter's row in the pane. */
async function mountWith(events: ReturnType<typeof sessionEvent>[] = [], delegatedRuns: Record<string, DelegatedRun[]> = {}) {
  const children = (delegatedRuns.se1 ?? []).some((r) => r.owned) ? [KID_CHILD] : [];
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns, delegatedChildren: { se1: children } });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "running", se2: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
  await store.getState().openItem("i9");
  const r = render(<StoreContext.Provider value={store}><SessionMeta item={ITEMS.s1[0]!} /><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}
const mount = (delegatedRuns: Record<string, DelegatedRun[]> = {}) => mountWith([], delegatedRuns);

/** The row of who is working, over the prompter — the one place a session's agents are named. */
const row = () => screen.queryByRole("group", { name: "Agents in this session" });
const names = () => [...(row()?.querySelectorAll(".active-agent .chip-label") ?? [])].map((n) => n.textContent);
const states = () => [...(row()?.querySelectorAll<HTMLElement>(".active-agent") ?? [])].map((c) => `${c.textContent} (${c.dataset.state})`);

afterEach(() => cleanup());

describe("the session's bar", () => {
  /* THE mutant: the count back in the bar — "2 working" at the top of the pane, naming the same agents
     as the row over the prompter a few hundred pixels below it. */
  it("names no agents: the row over the prompter is where they are said", async () => {
    await mount({ se1: [KID, PEER] });
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /agents? working for Parent/ })).toBeNull();
    expect(screen.queryByText(/\d+ working/)).toBeNull();
  });
});

describe("the runs in flight, on the row", () => {
  it("are fetched on mount, so a pane opened mid-delegation still sees the run", async () => {
    const { api } = await mount({ se1: [PEER] });
    // THE MUTANT: drop the fetch and rely on `delegation.changed` alone. The registry is in the
    // server's memory, so a reload — or a second window, or opening the pane ten minutes in — would
    // show nothing until the run ENDED, which is exactly when it stops being worth showing.
    await waitFor(() => expect(names()).toEqual(["A colleague"]));
    expect(api.calls).toContain("listDelegatedRuns:se1");
  });

  it("leave when the last run settles rather than sitting there stale", async () => {
    const { store } = await mount({ se1: [PEER] });
    await waitFor(() => expect(names()).toEqual(["A colleague"]));
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [] });
    // THE MUTANT: have `applyDelegationChanged` merge, or park the empty array under the key. The
    // pane then keeps announcing an agent that finished, with nothing left that will ever correct
    // it — the registry has already forgotten the run.
    await waitFor(() => expect(row()).toBeNull());
    expect(store.getState().delegatedRuns).not.toHaveProperty("se1");
  });

  it("are fetched again when the socket comes back, because the registry may have died with the server", async () => {
    const scripted: Record<string, DelegatedRun[]> = { se1: [PEER] };
    const { store } = await mount(scripted);
    await waitFor(() => expect(names()).toEqual(["A colleague"]));
    delete scripted["se1"]; // the server restarted while we were away: it is holding nothing now
    store.getState().applyConnectionState("reconnecting");
    store.getState().applyConnectionState("connected");
    // THE MUTANT: leave delegation out of the reconnect refetch. Every other kind of stale state
    // that gap covers is backed by a table the server can re-read; this one is not backed by
    // anything, so nothing will ever arrive to correct it and the row names agents that are gone.
    await waitFor(() => expect(row()).toBeNull());
  });

  it("are replaced rather than accumulated: the payload is the whole truth", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(store.getState().delegatedRuns.se1).toEqual([KID]));
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [PEER] });
    expect(store.getState().delegatedRuns.se1).toEqual([PEER]);
  });

  it("open a sub-agent in its parent's Agents tab, a tab of the side pane, never over the top of it", async () => {
    const { store } = await mount({ se1: [KID] });
    await waitFor(() => expect(names()).toEqual(["Agent: audit the mapper"]));
    const focused = store.getState().focusedLeafId;
    fireEvent.click(within(row()!).getByRole("button", { name: /^Agent: audit the mapper,/ }));
    // THE MUTANTS: open in place, which evicts the parent whose work the user is following; or open
    // beside the focused pane, a column per child — the layout the side pane exists to replace.
    await waitFor(() => expect(store.getState().agentsShown.se1).toBe("se2"));
    const tabs = findSidePane(store.getState().layout!, "i9")?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(store.getState().items.find((i) => i.id === tabs[0])).toMatchObject({ kind: "agents", refId: "se1" });
    // The keyboard stays in the parent's prompter.
    expect(store.getState().focusedLeafId).toBe(focused);
  });

  it("preview a peer it only asked as the session it is — it is no sub-agent of this one's", async () => {
    // THE MUTANT: open every chip in the Agents tab, where a peer has no card to open on.
    const { api, store } = await mount({ se1: [PEER] });
    await waitFor(() => expect(names()).toEqual(["A colleague"]));
    fireEvent.click(within(row()!).getByRole("button", { name: /^A colleague,/ }));
    await waitFor(() => expect(store.getState().layout && findLeafOfItem(store.getState().layout!, "i7")).toBeTruthy());
    expect(api.calls).not.toContain("agentsTab:se1");
    expect(store.getState().agentsShown.se1).toBeUndefined();
  });

  it("do not call a peer it merely asked a question a sub-agent, nor offer to stop it", async () => {
    await mount({ se1: [PEER] });
    await waitFor(() => expect(names()).toEqual(["A colleague"]));
    // THE MUTANT: read the origin off the session row for every run. A peer was doing its own work
    // before the question arrived and keeps doing it after — `agent_ask` neither spawned it nor owns
    // it, and its own row says nothing about this session at all.
    const chip = within(row()!).getByRole("button", { name: "A colleague, asked a question. Opens the session" });
    expect(chip).toHaveAttribute("title", expect.stringContaining("Asked a question (agent_ask)"));
    fireEvent.contextMenu(chip, { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menu", { name: "A colleague" })).toBeNull();
  });
});

describe("a sub-agent waiting on you", () => {
  it("leads the row, and goes to the Agents tab on its card; a peer it asked is not its to answer for", async () => {
    // THE MUTANT: a row that ignores waiting — the sub-agent sitting on a request among the rest, or
    // a peer's own request claimed as this session's.
    const { store } = await mount({ se1: [PEER, KID] });
    store.setState({ sessionStatus: { ...store.getState().sessionStatus, se2: "waiting_permission", se3: "waiting_permission" } });
    await waitFor(() => expect(states()).toEqual(["Agent: audit the mapper (waiting)", "A colleague (working)"]));
    fireEvent.click(within(row()!).getByRole("button", { name: /^Agent: audit the mapper, Needs you\./ }));
    await waitFor(() => expect(store.getState().agentsShown.se1).toBe("se2"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("sub-agents the HARNESS is running, on the row", () => {
  /* A different animal to a delegated run, and the difference is why these were invisible: an
     `agent_run` creates a real Realm session with a row, a pane and a place in the layout. Claude's
     own `Task` tool creates none of that — the subagent lives and dies inside the CLI process — so
     ten of them in flight showed nothing at all. */
  const task = (id: string, description: string, done = false) => [
    sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description }, parentToolUseId: null }),
    ...(done ? [sessionEvent("tool_result", { toolUseId: id, content: "ok", isError: false })] : []),
  ];

  it("shows the in-flight Task calls, which have no session behind them", async () => {
    await mountWith([...task("t1", "audit the mapper"), ...task("t2", "check the tests")]);
    await waitFor(() => expect(states()).toEqual(["audit the mapper (working)", "check the tests (working)"]));
  });

  it("opens one in the Agents tab's viewer — there is no pane to jump to, but there is work to watch", async () => {
    /* There is no session behind a harness sub-agent, so a jump to a pane would be a button that
       cannot work. There IS something to watch: every call it makes lands in this transcript under
       its launching call, and the viewer in the lead's Agents tab is where those are read. */
    const { store } = await mountWith(task("t1", "audit the mapper"));
    await waitFor(() => expect(names()).toEqual(["audit the mapper"]));
    fireEvent.click(within(row()!).getByRole("button", { name: /^audit the mapper,/ }));
    await waitFor(() => expect(store.getState().agentsShown.se1).toBe("t1"));
    // Nothing is laid over the session: the lead stays readable.
    expect(screen.queryByRole("dialog", { name: /Sub-agent/ })).toBeNull();
  });

  it("names a Workflow by the name in its own script", async () => {
    /* The case that made the old control look broken: a request for ten research agents produced one
       `Workflow` call, not ten `Task` ones, so a list that knew only about Task showed nothing at
       all. A Workflow names itself in its script's `meta`, which is the only place its name is. */
    await mountWith([sessionEvent("tool_call", { toolUseId: "w1", name: "Workflow",
      input: { script: "export const meta = { name: 'diamond-stuart-research', description: 'Parallel research' }" },
      parentToolUseId: null })]);
    await waitFor(() => expect(names()).toEqual(["diamond-stuart-research"]));
  });

  it("says one is done the moment its result lands", async () => {
    await mountWith(task("t1", "audit the mapper", true));
    await waitFor(() => expect(states()).toEqual(["audit the mapper (done)"]));
  });

  it("names a Task alongside a real delegated run", async () => {
    await mountWith(task("t1", "audit the mapper"), { se1: [KID] });
    await waitFor(() => expect(names()).toEqual(["Agent: audit the mapper", "audit the mapper"]));
  });

  it("does not list a call made UNDER a Task — that is the Task's business, not a second chip", async () => {
    await mountWith([
      ...task("t1", "audit the mapper"),
      sessionEvent("tool_call", { toolUseId: "t2", name: "Task", input: { description: "nested" }, parentToolUseId: "t1" }),
    ]);
    await waitFor(() => expect(names()).toEqual(["audit the mapper"]));
  });
});

/**
 * BACKGROUND sub-agents — the mode that showed nothing at all.
 *
 * A background `Agent` call returns within a second and then runs for minutes, so "the result has
 * not landed" (which is what the blocking case above keys on) is false for the entire run. Ten of
 * them read as ten finished calls. The adapter now marks the launch and the harness's completion
 * notification as `background_task` events, and these are what the row reads instead.
 */
describe("background sub-agents the harness is running, on the row", () => {
  const launch = (id: string, description: string) => [
    sessionEvent("tool_call", { toolUseId: id, name: "Agent", input: { description }, parentToolUseId: null }),
    // The launch result lands almost immediately — this is the whole difficulty.
    sessionEvent("tool_result", { toolUseId: id, content: "Async agent launched successfully.", isError: false }),
    sessionEvent("background_task", { toolUseId: id, status: "running" }),
  ];
  const stopped = (id: string) => sessionEvent("background_task", { toolUseId: id, status: "stopped", summary: "finished" });

  it("are working while their launch call has ALREADY returned — the case that showed nothing", async () => {
    await mountWith([...launch("t1", "Agent 1: hold 10m"), ...launch("t2", "Agent 2: hold 10m")]);
    // THE MUTANT: keep the old `result === null` rule. Both calls have results, so both read as done
    // while they run for ten minutes — which is exactly the bug this was reported as.
    await waitFor(() => expect(states()).toEqual(["Agent 1: hold 10m (working)", "Agent 2: hold 10m (working)"]));
  });

  it("are done when the harness notifies that the agent stopped, and not before", async () => {
    await mountWith([...launch("t1", "Agent 1"), ...launch("t2", "Agent 2"), stopped("t1")]);
    // THE MUTANT: fold the stop onto nothing (or read only the launch) — an agent that finished ten
    // minutes ago still working on the row.
    await waitFor(() => expect(states()).toEqual(["Agent 2 (working)", "Agent 1 (done)"]));
  });
});

/**
 * The way back to a child from the call that delegated to it. The running-agents control lists a
 * child only while it runs, and a child has no pane of its own — so once it has finished, the
 * delegation call in the lead's transcript is the one place left that names the child.
 */
describe("a delegation call links the sessions it started", () => {
  // ULID-shaped, as the server's ids are: the call's result is read for ids of exactly that shape.
  // (Crockford base32 has no I, L, O or U — hence the spellings.)
  const LEAD = "01HZHEAD".padEnd(26, "0"), KID_ID = "01HZK1D".padEnd(26, "0"), PEER_ID = "01HZPEER".padEnd(26, "0");
  const items = { s1: [
    item("i-lead", "s1", { kind: "session", title: "Lead", refId: LEAD }),
    item("i-kid", "s1", { kind: "session", title: "Agent: audit the mapper", refId: KID_ID }),
    item("i-peer", "s1", { kind: "session", title: "A colleague", refId: PEER_ID }),
  ] };
  const sessions = [
    session(LEAD, "s1", { title: "Lead" }),
    session(KID_ID, "s1", { title: "Agent: audit the mapper", dispatchedBy: { sessionId: LEAD, kind: "browser_agent_run" } }),
    session(PEER_ID, "s1", { title: "A colleague" }),
  ];
  /** One finished call, with the trail the server writes after `agent_run`'s report. */
  const call = (name: string, content: string) => [
    sessionEvent("tool_call", { toolUseId: "c1", name, input: { goal: "audit the mapper" }, parentToolUseId: null }),
    sessionEvent("tool_result", { toolUseId: "c1", content, isError: false }),
  ];
  const trail = (report: string) =>
    `Delegated agent finished.\n\nChild session: {"sessionId":"${KID_ID}","title":"Agent: audit the mapper","status":"done"} — its full trace is in that session's pane.\n\n${report}`;
  const links = () => [...document.querySelectorAll(".tool-card .delegation-item .delegation-title")].map((n) => n.textContent);

  async function mountWith(events: ReturnType<typeof sessionEvent>[]) {
    const api = fakeApi({ items, sessions });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ transcripts: { [LEAD]: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i-lead"); // a child has no pane of its own
    render(<StoreContext.Provider value={store}><SessionPane item={items.s1[0]!} visible /></StoreContext.Provider>);
    return store;
  }

  /* A browser agent's call keeps its list of the child it started. The `agent_run` family is drawn as
     each sub-agent's own line instead, linked to its row in the Agents tab (delegation-line.test.tsx). */
  it("names the child on the call, and opens it in the lead's Agents tab", async () => {
    const store = await mountWith(call("mcp__realm__realm-agent__browser_agent_run", trail("The mapper is fine.")));
    // THE MUTANT: compare the raw tool name. Every harness prefixes it — Claude's `mcp__realm__…`,
    // Codex's `realm.…` — so a set of bare names would never match one, and there is no way back.
    expect(links()).toEqual(["Agent: audit the mapper"]);
    fireEvent.click(screen.getByRole("button", { name: "Agent: audit the mapper — Browser agent" }));
    // The lead's Agents tab, on the child, like the control's row: the lead is the context it is read in.
    await waitFor(() => expect(store.getState().agentsShown[LEAD]).toBe(KID_ID));
    const tabs = findSidePane(store.getState().layout!, "i-lead")?.tabs ?? [];
    expect(store.getState().items.find((i) => i.id === tabs[0])).toMatchObject({ kind: "agents", refId: LEAD });
  });

  it("links only a delegated session, never another id a report happens to mention", async () => {
    // The child's report is the child's words, and it may name any session it likes. THE MUTANT:
    // link every id that resolves to a session, and a colleague the child merely mentioned becomes
    // a row on the lead's call, drawn as though the lead had delegated to it.
    await mountWith(call("mcp__realm__realm-agent__browser_agent_run", trail(`I compared notes with ${PEER_ID}.`)));
    expect(links()).toEqual(["Agent: audit the mapper"]);
  });

  it("reads delegation calls only — any other tool naming a child id draws nothing", async () => {
    // THE MUTANT: drop the name check, and a `cat` of a log that prints a child's id hangs a row off
    // a shell command.
    await mountWith(call("Bash", `grep found ${KID_ID} in the log`));
    expect(links()).toEqual([]);
  });
});
