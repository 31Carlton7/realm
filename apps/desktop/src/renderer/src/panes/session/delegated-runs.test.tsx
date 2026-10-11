import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { findSidePane, type DelegatedRun } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { labelOf } from "./DelegatedRuns";
import { SessionMeta, SessionPane } from "./SessionPane";
import { toolSummary } from "./tool-summary";
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
  const r = render(<StoreContext.Provider value={store}><SessionMeta item={ITEMS.s1[0]!} /><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

/** The running-agents control in the session's bar. */
const dock = () => screen.queryByRole("button", { name: /agents? working for Parent/ });
/** Open its list — every row lives in the popover. */
const openAgents = async () => fireEvent.click(await screen.findByRole("button", { name: /agents? working for Parent/ }));

afterEach(() => cleanup());

describe("the delegating session's running-agents control", () => {
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
    await openAgents();
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

  it("previews a sub-agent as a tab of its parent's side pane, never over the top of it", async () => {
    const { store } = await mount({ se1: [KID] });
    await openAgents();
    const focused = store.getState().focusedLeafId;
    fireEvent.click(screen.getByRole("button", { name: /Agent: audit the mapper/ }));
    // THE MUTANTS: open in place, which evicts the parent whose work the user is following; or open
    // beside the focused pane, a column per child — the layout this control exists to replace.
    await waitFor(() => expect(findSidePane(store.getState().layout!, "i9")?.tabs).toEqual(["i8"]));
    // The keyboard stays in the parent's prompter.
    expect(store.getState().focusedLeafId).toBe(focused);
  });

  it("does not call a peer it merely asked a question a sub-agent", async () => {
    await mount({ se1: [PEER] });
    await openAgents();
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
  const dockText = () => [...document.querySelectorAll(".agents-pop .delegation-item .delegation-title")].map((n) => n.textContent);

  async function mountWith(events: ReturnType<typeof sessionEvent>[], delegatedRuns: Record<string, DelegatedRun[]> = {}) {
    const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i9");
    return { store, ...render(<StoreContext.Provider value={store}><SessionMeta item={ITEMS.s1[0]!} /><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>) };
  }

  it("shows a card for in-flight Task calls, which have no session behind them", async () => {
    await mountWith([...task("t1", "audit the mapper"), ...task("t2", "check the tests")]);
    await waitFor(() => expect(screen.getByText("2 working")).toBeInTheDocument());
    await openAgents();
    expect(dockText()).toEqual(["audit the mapper", "check the tests"]);
  });

  it("opens the sub-agent's panel — there is no pane to jump to, but there is work to watch", async () => {
    /* There is no session behind a harness sub-agent, so a jump to a pane would be a button that
       cannot work. There IS something to watch: every call it makes lands in this transcript under
       its launching call, and the drawer is where those are read. */
    const { store } = await mountWith(task("t1", "audit the mapper"));
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    expect(screen.getAllByText("in the agent")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Watch audit the mapper" }));
    expect(store.getState().sessionDock.se1).toEqual({ kind: "subagent", toolUseId: "t1" });
    expect(await screen.findByRole("dialog", { name: "Sub-agent: audit the mapper" })).toBeInTheDocument();
  });

  it("the row is the control that closes it too — a lit row says the state and undoes it", async () => {
    const { store } = await mountWith(task("t1", "audit the mapper"));
    await openAgents();
    const row = () => screen.getByRole("button", { name: "Watch audit the mapper" });
    fireEvent.click(row());
    // Opening the panel puts the list away: two overlays both answering Escape answer it in mount
    // order, and the list would swallow the Escape meant for the panel.
    await waitFor(() => expect(document.querySelector(".agents-pop")).toBeNull());
    await openAgents();
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
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["diamond-stuart-research"]));
  });

  it("drops one the moment its result lands", async () => {
    await mountWith([...task("t1", "audit the mapper", true)]);
    expect(dock()).toBeNull();
  });

  it("counts a Task alongside a real delegated run, in one card", async () => {
    await mountWith(task("t1", "audit the mapper"), { se1: [KID] });
    await waitFor(() => expect(screen.getByText("2 working")).toBeInTheDocument());
  });

  it("does not list a call made UNDER a Task — that is the Task's business, not a second row", async () => {
    await mountWith([
      ...task("t1", "audit the mapper"),
      sessionEvent("tool_call", { toolUseId: "t2", name: "Task", input: { description: "nested" }, parentToolUseId: "t1" }),
    ]);
    await waitFor(() => expect(screen.getByText("1 working")).toBeInTheDocument());
    await openAgents();
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
  const dockText = () => [...document.querySelectorAll(".agents-pop .delegation-item .delegation-title")].map((n) => n.textContent);

  async function mountWith(events: ReturnType<typeof sessionEvent>[]) {
    const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns: {} });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i9");
    return render(<StoreContext.Provider value={store}><SessionMeta item={ITEMS.s1[0]!} /><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  }

  it("lists agents whose launch call has ALREADY returned — the case that showed nothing", async () => {
    await mountWith([...launch("t1", "Agent 1: hold 10m"), ...launch("t2", "Agent 2: hold 10m")]);
    // THE MUTANT: keep the old `result === null` rule. Both calls have results, so the dock does not
    // render at all — which is exactly the bug this was reported as.
    await waitFor(() => expect(screen.getByText("2 working")).toBeInTheDocument());
    await openAgents();
    expect(dockText()).toEqual(["Agent 1: hold 10m", "Agent 2: hold 10m"]);
  });

  it("drops the row when the harness notifies that the agent stopped", async () => {
    await mountWith([...launch("t1", "Agent 1"), ...launch("t2", "Agent 2"), stopped("t1")]);
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["Agent 2"]));
    expect(screen.getByText("1 working")).toBeInTheDocument();
  });

  it("leaves entirely once the last one stops", async () => {
    await mountWith([...launch("t1", "Agent 1"), stopped("t1")]);
    // THE MUTANT: fold the stop onto nothing (or read only the launch). A row for an agent that
    // finished ten minutes ago is worse than the blank the dock used to show.
    expect(dock()).toBeNull();
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
  it("names the child on the call, and previews it in the lead's side pane", async () => {
    const store = await mountWith(call("mcp__realm__realm-agent__browser_agent_run", trail("The mapper is fine.")));
    // THE MUTANT: compare the raw tool name. Every harness prefixes it — Claude's `mcp__realm__…`,
    // Codex's `realm.…` — so a set of bare names would never match one, and there is no way back.
    expect(links()).toEqual(["Agent: audit the mapper"]);
    fireEvent.click(screen.getByRole("button", { name: "Agent: audit the mapper — Browser agent" }));
    // A tab beside the lead, like the control's row: the lead is the context the child is read in.
    await waitFor(() => expect(findSidePane(store.getState().layout!, "i-lead")?.tabs).toEqual(["i-kid"]));
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

/** A workflow's script, naming itself the way the harness requires. */
const SCRIPT = "export const meta = { name: 'probe-run', description: 'Probe run with two agents' }\nreturn await agent('PROBE-AGENT-A say alpha')";

/**
 * One name for a `Workflow` call. The running-agents list and the call's own row used to work it out
 * separately. The list took the input's `description` and the row took the first string in the
 * input, so the list could offer to stop a run under a name its card did not use.
 */
describe("a Workflow call", () => {
  const both = (input: Record<string, unknown>) => [labelOf("Workflow", input), toolSummary("Workflow", input)];

  it("is called by its script's own name, in the list and on its row alike", () => {
    expect(both({ script: SCRIPT })).toEqual(["probe-run", "probe-run"]);
  });

  it("never takes its name from the input's description or title, which the harness ignores", () => {
    expect(both({ script: SCRIPT, description: "Tidy the README", title: "Tidy" })).toEqual(["probe-run", "probe-run"]);
    expect(both({ description: "Tidy the README", title: "Tidy" })).toEqual(["Workflow", "Workflow"]);
  });

  it("is called by the saved workflow it asks for when it carries no script", () => {
    expect(both({ name: "deploy-all", args: { target: "staging" } })).toEqual(["deploy-all", "deploy-all"]);
  });

  it("is called by its file's name when a script path is all it carries", () => {
    const input = { scriptPath: "/tmp/capture/workflows/scripts/probe-run-wf_e7f5f79f-cf9.js", resumeFromRunId: "wf_e7f5f79f-cf9" };
    expect(both(input)).toEqual(["probe-run-wf_e7f5f79f-cf9.js", "probe-run-wf_e7f5f79f-cf9.js"]);
  });

  it("is called by its file when it carries a script path, whatever script the model sent with it", () => {
    expect(both({ script: SCRIPT, scriptPath: "/x/deploy-prod.js" })).toEqual(["deploy-prod.js", "deploy-prod.js"]);
  });

  it("is called by the saved workflow it names, whatever script the model sent with it", () => {
    expect(both({ script: SCRIPT, name: "deploy-all" })).toEqual(["deploy-all", "deploy-all"]);
  });

  it("is called the same on its permission card and on its row for a saved-script launch", () => {
    const file = "export const meta = { name: 'what-the-file-says', description: 'The script on disk' }\nreturn await agent('go')";
    const card = toolSummary("Workflow", { script: file, scriptPath: "/x/deploy-prod.js" });
    const row = labelOf("Workflow", { scriptPath: "/x/deploy-prod.js" });
    expect([card, row]).toEqual(["deploy-prod.js", "deploy-prod.js"]);
  });

  it("is called by its file when it carries a script path and a name, since the harness takes the path first", () => {
    expect(both({ name: "deploy-all", scriptPath: "/x/deploy-prod.js" })).toEqual(["deploy-prod.js", "deploy-prod.js"]);
  });

  it("is called Workflow when nothing names it, and never Sub-agent", () => {
    expect(both({})).toEqual(["Workflow", "Workflow"]);
    expect(both({ script: "return await agent('go')" })).toEqual(["Workflow", "Workflow"]);
    expect(both({ scriptPath: "/tmp/capture/workflows/scripts/" })).toEqual(["Workflow", "Workflow"]);
  });

  it("takes no name from text further down its script", () => {
    expect(both({ script: "await agent('go', { name: 'decoy' })\nexport const meta = { name: 'late', description: 'x' }" })).toEqual(["Workflow", "Workflow"]);
  });

  it("leaves every other tool's label as it was", () => {
    expect(labelOf("Task", { description: "audit the mapper", prompt: "Audit every mapper." })).toBe("audit the mapper");
    expect(labelOf("Agent", { prompt: "  Audit every mapper.  " })).toBe("Audit every mapper.");
    expect(labelOf("Agent", {})).toBe("Sub-agent");
    expect(toolSummary("Task", { description: "audit the mapper", prompt: "Audit every mapper." })).toBe("audit the mapper");
  });
});

/** A stop the test answers by hand, so the time the call is out can be looked at. */
function held(api: ReturnType<typeof fakeApi>): { allow: () => void; refuse: (why: string) => void } {
  const answer = { allow: () => {}, refuse: (_why: string) => {} };
  api.stopBackgroundRun = () => new Promise<void>((resolve, reject) => {
    answer.allow = resolve;
    answer.refuse = (why) => reject(new Error(why));
  });
  return answer;
}

/**
 * The stop control on a background run's row, which ends one run and leaves the session alone.
 *
 * Mounted inside a `.panel`, as the app mounts a session's bar and its pane, because where the
 * keyboard goes when the list empties is found from the panel the control stands in.
 */
describe("the stop control on a background run's row", () => {
  const launch = (id: string, name: string, input: Record<string, unknown>) => [
    sessionEvent("tool_call", { toolUseId: id, name, input, parentToolUseId: null }),
    sessionEvent("background_task", { toolUseId: id, status: "running" }),
    sessionEvent("tool_result", { toolUseId: id, content: "Workflow launched in background. Task ID: w1m36gxx5", isError: false }),
  ];
  const workflow = (id: string, input: Record<string, unknown> = { script: SCRIPT }) => launch(id, "Workflow", input);
  const blocking = (id: string, description: string) => sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description }, parentToolUseId: null });
  const ended = (id: string, outcome: "completed" | "failed" | "stopped") => sessionEvent("background_task", { toolUseId: id, status: "stopped", outcome });
  const dockText = () => [...document.querySelectorAll(".agents-pop .delegation-item .delegation-title")].map((n) => n.textContent);
  const stops = () => screen.queryAllByRole("button", { name: /^Stop / });
  const stopOf = (label: string) => screen.findByRole("button", { name: `Stop ${label}` });
  const rows = () => [...document.querySelectorAll<HTMLElement>(".agents-pop .delegation-list > li")];

  async function mountWith(events: ReturnType<typeof sessionEvent>[], delegatedRuns: Record<string, DelegatedRun[]> = {}) {
    const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
    const store = createAppStore(api); await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
    await store.getState().openItem("i9");
    const tree = (bar: (typeof ITEMS.s1)[number]) =>
      <StoreContext.Provider value={store}><div className="panel"><SessionMeta item={bar} /><SessionPane item={ITEMS.s1[0]!} visible /></div></StoreContext.Provider>;
    const view = render(tree(ITEMS.s1[0]!));
    const show = (next: ReturnType<typeof sessionEvent>[]) => act(() => store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll(next) } } }));
    return { api, store, show, turnBarTo: (bar: (typeof ITEMS.s1)[number]) => view.rerender(tree(bar)) };
  }

  it("is drawn on a top-level row whose call is running in the background, and on no other row", async () => {
    await mountWith([
      blocking("t1", "audit the mapper"),
      ...launch("a1", "Agent", { description: "Agent 1: hold 10m" }),
      sessionEvent("tool_call", { toolUseId: "n1", name: "Agent", input: { description: "nested under the Task" }, parentToolUseId: "t1" }),
      sessionEvent("background_task", { toolUseId: "n1", status: "running" }),
    ], { se1: [KID] });
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["Agent: audit the mapper", "audit the mapper", "Agent 1: hold 10m"]));
    expect(stops().map((b) => b.getAttribute("aria-label"))).toEqual(["Stop Agent 1: hold 10m"]);
  });

  it("is not drawn on a call that has only been made, before the harness says its run is working", async () => {
    await mountWith([sessionEvent("tool_call", { toolUseId: "w1", name: "Workflow", input: { script: SCRIPT }, parentToolUseId: null })]);
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["probe-run"]));
    expect(stops()).toEqual([]);
  });

  it("is named, like the watch control beside it, by the workflow's own name, whatever description the call carries", async () => {
    await mountWith(workflow("w1", { script: SCRIPT, description: "Tidy the README" }));
    await openAgents();
    expect(await stopOf("probe-run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Watch probe-run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tidy the README|Sub-agent/ })).toBeNull();
  });

  it("is a native button whose tooltip says what it stops and what goes on", async () => {
    await mountWith(workflow("w1"));
    await openAgents();
    const stop = await stopOf("probe-run");
    expect(stop).toHaveAttribute("title", "Stop this run. The session goes on.");
    expect(stop.tagName).toBe("BUTTON");
  });

  it("takes the room of the words in the agent, which the watch button's tooltip says as a sentence on its row and which stay on a row without it", async () => {
    await mountWith([blocking("t1", "audit the mapper"), ...workflow("w1")]);
    await openAgents();
    await stopOf("probe-run");
    expect(screen.getByRole("button", { name: "Watch probe-run" })).toHaveAttribute("title", "Runs in the agent.");
    expect(screen.getByRole("button", { name: "Watch probe-run" })).not.toHaveTextContent("in the agent");
    expect(screen.getByRole("button", { name: "Watch audit the mapper" })).toHaveTextContent("in the agent");
    expect(screen.getByRole("button", { name: "Watch audit the mapper" })).not.toHaveAttribute("title");
  });

  it("leaves an empty slot of its own width on the rows with nothing to stop, so every time ends on one edge", async () => {
    await mountWith([blocking("t1", "audit the mapper"), ...workflow("w1")], { se1: [KID] });
    await openAgents();
    await stopOf("probe-run");
    expect(rows().map((li) => li.className)).toEqual(["agents-row", "agents-row", "agents-row"]);
    expect(rows().map((li) => li.lastElementChild!.className)).toEqual(["delegation-stop-slot", "delegation-stop-slot", "icon-btn delegation-stop"]);
  });

  it("leaves a list with nothing to stop exactly as it was: no row class, no slot, one button a row", async () => {
    await mountWith([blocking("t1", "audit the mapper")], { se1: [KID] });
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["Agent: audit the mapper", "audit the mapper"]));
    expect(rows().map((li) => li.className)).toEqual(["", ""]);
    expect(rows().map((li) => [...li.children].map((c) => c.tagName))).toEqual([["BUTTON"], ["BUTTON"]]);
    expect(document.querySelector(".delegation-stop-slot")).toBeNull();
  });

  it("keeps the row class and the empty slot on the rows that remain when the only run that could be stopped has left", async () => {
    const { show } = await mountWith([blocking("t1", "audit the mapper"), ...workflow("w1")]);
    await openAgents();
    await stopOf("probe-run");
    show([blocking("t1", "audit the mapper"), ...workflow("w1"), ended("w1", "stopped")]);
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    expect(rows().map((li) => li.className)).toEqual(["agents-row"]);
    expect(rows().map((li) => li.lastElementChild!.className)).toEqual(["delegation-stop-slot"]);
  });

  it("draws a list opened after that run has left with no row class and no slot, as a list that never had one", async () => {
    const { show } = await mountWith([blocking("t1", "audit the mapper"), ...workflow("w1")]);
    await openAgents();
    await stopOf("probe-run");
    show([blocking("t1", "audit the mapper"), ...workflow("w1"), ended("w1", "stopped")]);
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".agents-pop")).toBeNull());
    await openAgents();
    await waitFor(() => expect(dockText()).toEqual(["audit the mapper"]));
    expect(rows().map((li) => li.className)).toEqual([""]);
    expect(document.querySelector(".delegation-stop-slot")).toBeNull();
  });

  it("draws the rows of a session the bar has turned to with no row class and no slot when that session has nothing to stop", async () => {
    const { store, turnBarTo } = await mountWith(workflow("w1"));
    await openAgents();
    await stopOf("probe-run");
    act(() => store.setState({ transcripts: { ...store.getState().transcripts, se3: { lastSeq: 0, t: reduceAll([blocking("t9", "check the tests")]) } } }));
    turnBarTo(ITEMS.s1[2]!);
    await waitFor(() => expect(dockText()).toEqual(["check the tests"]));
    expect(rows().map((li) => li.className)).toEqual([""]);
    expect(document.querySelector(".delegation-stop-slot")).toBeNull();
  });

  it("leaves the keyboard where it was when the bar turns to another session with the list open", async () => {
    const { store, turnBarTo } = await mountWith(workflow("w1"));
    await openAgents();
    await stopOf("probe-run");
    act(() => store.setState({ transcripts: { ...store.getState().transcripts, se3: { lastSeq: 0, t: reduceAll([blocking("t9", "check the tests")]) } } }));
    document.querySelector<HTMLElement>(".composer-input")!.focus();
    turnBarTo(ITEMS.s1[2]!);
    await waitFor(() => expect(dockText()).toEqual(["check the tests"]));
    expect(document.activeElement).toHaveClass("composer-input");
  });

  it("stops its run alone on one press, by the id of the call that launched it, and leaves the list open", async () => {
    const { api, store } = await mountWith([...workflow("w1"), ...workflow("w2", { script: SCRIPT.replace("probe-run", "other-run") })]);
    await openAgents();
    fireEvent.click(await stopOf("other-run"));
    await waitFor(() => expect(api.calls).toContain("stopBackgroundRun:se1:w2"));
    expect(api.calls.filter((c) => c.startsWith("stopBackgroundRun") || c.startsWith("interrupt"))).toEqual(["stopBackgroundRun:se1:w2"]);
    expect(document.querySelector(".agents-pop")).not.toBeNull();
    expect(store.getState().sessionDock.se1).toBeUndefined();
  });

  it("ignores the second click of a double-click, so the run that moved up under the pointer is not stopped", async () => {
    const other = workflow("w2", { script: SCRIPT.replace("probe-run", "other-run") });
    const { api, show } = await mountWith([...workflow("w1"), ...other]);
    await openAgents();
    fireEvent.click(await stopOf("probe-run"), { detail: 1 });
    await waitFor(() => expect(api.calls).toContain("stopBackgroundRun:se1:w1"));
    show([...workflow("w1"), ended("w1", "stopped"), ...other]);
    await waitFor(() => expect(dockText()).toEqual(["other-run"]));
    fireEvent.click(await stopOf("other-run"), { detail: 2 });
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    expect(api.calls.filter((c) => c.startsWith("stopBackgroundRun"))).toEqual(["stopBackgroundRun:se1:w1"]);
    expect(await stopOf("other-run")).toBeEnabled();
  });

  it("still stops on a first click, which the platform counts as one", async () => {
    const { api } = await mountWith(workflow("w1"));
    await openAgents();
    fireEvent.click(await stopOf("probe-run"), { detail: 1 });
    await waitFor(() => expect(api.calls).toContain("stopBackgroundRun:se1:w1"));
  });

  it("still stops on a key press, which carries no click count", async () => {
    const { api } = await mountWith(workflow("w1"));
    await openAgents();
    fireEvent.click(await stopOf("probe-run"), { detail: 0 });
    await waitFor(() => expect(api.calls).toContain("stopBackgroundRun:se1:w1"));
  });

  it("is disabled while the call is out, keeping its shape, its words and the list", async () => {
    const { api } = await mountWith(workflow("w1"));
    const answer = held(api);
    await openAgents();
    const stop = await stopOf("probe-run");
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(stop).toBeDisabled());
    expect(stop).toHaveClass("icon-btn", "delegation-stop");
    expect(stop).toHaveAttribute("title", "Stop this run. The session goes on.");
    expect(document.querySelector(".agents-pop")).not.toBeNull();
    await act(async () => { answer.allow(); });
  });

  it("is enabled again when the server refuses, with the server's sentence in a toast and the list still open", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { api, store } = await mountWith(workflow("w1"));
      const answer = held(api);
      await openAgents();
      const stop = await stopOf("probe-run");
      fireEvent.click(stop);
      await waitFor(() => expect(stop).toBeDisabled());
      await act(async () => { answer.refuse("Claude Code did not stop this run."); });
      await waitFor(() => expect(stop).toBeEnabled());
      expect(store.getState().toasts.map((t) => t.text)).toContain("Claude Code did not stop this run.");
      expect(document.querySelector(".agents-pop")).not.toBeNull();
    } finally { quiet.mockRestore(); }
  });

  it("takes the list with it when its row was the last, and hands the keyboard to the session's prompter", async () => {
    const { api, show } = await mountWith(workflow("w1"));
    await openAgents();
    const stop = await stopOf("probe-run");
    stop.focus();
    fireEvent.click(stop);
    await waitFor(() => expect(api.calls).toContain("stopBackgroundRun:se1:w1"));
    show([...workflow("w1"), ended("w1", "stopped")]);
    await waitFor(() => expect(document.querySelector(".agents-pop")).toBeNull());
    expect(dock()).toBeNull();
    expect(document.activeElement).toHaveClass("composer-input");
  });

  it("moves the keyboard nowhere when the last run ends by itself", async () => {
    const { show } = await mountWith(workflow("w1"));
    await openAgents();
    (await screen.findByRole("button", { name: "Watch probe-run" })).focus();
    show([...workflow("w1"), ended("w1", "completed")]);
    await waitFor(() => expect(dock()).toBeNull());
    expect(document.activeElement).not.toHaveClass("composer-input");
  });

  it("moves the keyboard nowhere for a stop the server refused, when that run later ends by itself", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { api, show } = await mountWith(workflow("w1"));
      const answer = held(api);
      await openAgents();
      const stop = await stopOf("probe-run");
      fireEvent.click(stop);
      await waitFor(() => expect(stop).toBeDisabled());
      await act(async () => { answer.refuse("Claude Code did not stop this run."); });
      await waitFor(() => expect(stop).toBeEnabled());
      show([...workflow("w1"), ended("w1", "completed")]);
      await waitFor(() => expect(dock()).toBeNull());
      expect(document.activeElement).not.toHaveClass("composer-input");
    } finally { quiet.mockRestore(); }
  });

  it("moves the keyboard nowhere when the bar turns to another session while a stop is out", async () => {
    const { api, turnBarTo } = await mountWith(workflow("w1"));
    const answer = held(api);
    await openAgents();
    const stop = await stopOf("probe-run");
    stop.focus();
    fireEvent.click(stop);
    await waitFor(() => expect(stop).toBeDisabled());
    turnBarTo(ITEMS.s1[2]!);
    await waitFor(() => expect(document.querySelector(".agents-pop")).toBeNull());
    expect(document.activeElement).not.toHaveClass("composer-input");
    await act(async () => { answer.allow(); });
  });

  it("carries no mark that keeps an agent out, because it grants nothing and starts nothing", async () => {
    await mountWith(workflow("w1"));
    await openAgents();
    expect((await stopOf("probe-run")).closest("[data-no-agent]")).toBeNull();
  });
});
