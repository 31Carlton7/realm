import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findSidePane, sessionEvent, type DelegatedChild, type SessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore, type DelegableModels } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "../session/transcript-model";
import { AgentsTab } from "./AgentsTab";
import { delegationBrief } from "./brief";

const LEAD = session("se1", "s1", { title: "Parent", agentKind: "claude", model: "claude-opus-5-5" });
const LUNA = session("se2", "s1", { title: "Write the tests", agentKind: "codex", model: "gpt-6-luna", status: "running", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const FABLE = session("se3", "s1", { title: "Write the migration", agentKind: "claude", model: "claude-fable-5-1", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const TAB = item("i20", "s1", { kind: "agents", title: "Agents", refId: "se1" });
const ITEMS = { s1: [
  item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" }),
  item("i8", "s1", { kind: "session", title: "Write the tests", refId: "se2" }),
  item("i7", "s1", { kind: "session", title: "Write the migration", refId: "se3" }),
  TAB,
] };
const NOW = Date.now();
const CHILDREN: DelegatedChild[] = [
  { session: LUNA, goal: "Write the tests", startedAt: NOW - 65_000, settledAt: null, outcome: null, report: null,
    activity: sessionEvent("tool_call", { toolUseId: "t1", name: "Edit", input: { file_path: "apps/desktop/src/Settings.tsx" }, parentToolUseId: null }) },
  { session: FABLE, goal: "Write the migration", startedAt: NOW - 300_000, settledAt: NOW - 120_000, outcome: "done", report: "## Done\n\nAdded the column. **All 12 pass.**", activity: null },
];
const CATALOG: DelegableModels = { own: { kind: "claude", label: "Claude Opus 5.5" }, models: [
  { key: "6-gpt-luna", label: "GPT-6 Luna", kind: "codex", id: "gpt-6-luna", ready: true },
  { key: "5.1-claude-fable", label: "Claude Fable 5.1", kind: "claude", id: "claude-fable-5-1", ready: true },
  { key: "5.5-claude-opus", label: "Claude Opus 5.5", kind: "claude", id: "claude-opus-5-5", ready: true },
  { key: "2-composer", label: "Composer 2", kind: "acp:cursor", id: "composer-2", ready: false },
  { key: "5.4-gpt-nano-openai", label: "openai/gpt-5.4-nano", kind: "acp:fx", id: "openai/gpt-5.4-nano", ready: true },
] };

async function mount(over: { lead?: typeof LEAD; children?: DelegatedChild[]; status?: Record<string, "idle" | "running" | "waiting_permission">; idle?: boolean;
  runs?: string[]; transcripts?: Record<string, SessionEvent[]> } = {}) {
  const lead = over.lead ?? LEAD;
  const api = fakeApi({ items: ITEMS, sessions: [lead, LUNA, FABLE, ...(over.children ?? []).map((c) => c.session).filter((x) => ![lead.id, "se2", "se3"].includes(x.id))],
    delegatedChildren: { se1: over.children ?? CHILDREN }, delegableModels: CATALOG,
    delegatedRuns: over.idle ? {} : { se1: (over.runs ?? ["se2"]).map((id) => ({ sessionId: id, startedAt: 0, detached: true, owned: true })) } });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({
    transcripts: Object.fromEntries(Object.entries(over.transcripts ?? {}).map(([id, evs]) => [id, { lastSeq: evs.length, t: reduceAll(evs) }])),
    sessionStatus: { se2: "running", se3: "idle", ...over.status },
    agentProbe: [{ kind: "codex", available: true, version: "x", loggedIn: true, reason: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] }],
  });
  await store.getState().openItem("i9");
  const r = render(<StoreContext.Provider value={store}><AgentsTab item={TAB} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const card = (name: RegExp) => screen.findByRole("button", { name });
const chip = (name: RegExp) => screen.findByRole("button", { name, pressed: false });
const send = () => screen.getByRole("button", { name: "Send to this session's agent" });

afterEach(() => cleanup());

describe("the list of a session's sub-agents", () => {
  it("says, per sub-agent, what model it is on, what it was asked, where it stands and what it is doing", async () => {
    await mount();
    const luna = await card(/^Write the tests\. GPT-6 Luna on Codex\. Working, 1m \d+s\.$/);
    expect(luna).toHaveTextContent("apps/desktop/src/Settings.tsx");
  });

  it("a finished one says how it ended and what it reported, in plain prose", async () => {
    await mount();
    const fable = await card(/^Write the migration\. Claude Fable 5\.1 on Claude\. Done, 3m 0s\.$/);
    expect(fable).toHaveTextContent("Done Added the column. All 12 pass.");
  });

  it("opens a sub-agent's transcript as a tab of its lead's side pane", async () => {
    const { store } = await mount();
    fireEvent.click(await card(/^Write the tests\./));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    // The same route as the running-agents control's preview: beside the lead, never instead of it.
    await waitFor(() => expect(findSidePane(store.getState().layout!, "i9")?.tabs).toContain("i8"));
  });

  it("re-reads the list whenever the lead's delegation changes", async () => {
    const { api, store } = await mount();
    await card(/^Write the tests\./);
    const before = api.calls.filter((c) => c === "listDelegatedChildren:se1").length;
    store.getState().applyDelegationChanged({ sessionId: "se1", running: [] });
    // Mutant: refresh only on mount — a child that starts, settles or is collected later would never
    // show, and a list that only moves when you reopen it is a list you stop trusting.
    await waitFor(() => expect(api.calls.filter((c) => c === "listDelegatedChildren:se1").length).toBeGreaterThan(before));
  });

  it("re-reads after the socket comes back — what changed while it was down went unannounced", async () => {
    // A lead with nothing in flight and no transcript loaded: the delegated-runs refetch never names
    // it, so only the list's own refetch can. Mutant: drop it from the reconnect.
    const { api, store } = await mount({ idle: true });
    await card(/^Write the tests\./);
    const before = api.calls.filter((c) => c === "listDelegatedChildren:se1").length;
    store.getState().applyConnectionState("reconnecting");
    store.getState().applyConnectionState("connected");
    await waitFor(() => expect(api.calls.filter((c) => c === "listDelegatedChildren:se1").length).toBeGreaterThan(before));
  });

  it("says plainly when there are none yet, and where to start — one composition, not a header over nothing", async () => {
    await mount({ children: [] });
    expect(await screen.findByRole("heading", { name: "Hand work to sub-agents" })).toBeInTheDocument();
    expect(screen.getByText(/Pick models below and say what to build/)).toBeInTheDocument();
    // The list's own head is the populated state's; over an empty list it was the top-left label the
    // owner asked to have gone.
    expect(screen.queryByRole("heading", { name: /^Sub-agents/ })).toBeNull();
  });

  it("lights the row a transcript line asked for", async () => {
    const { store, container } = await mount();
    await card(/^Write the migration\./);
    await store.getState().openAgentsTab("se1", { childId: "se3" });
    await waitFor(() => expect(container.querySelector('li.subagent[data-flash]')).toHaveTextContent("Write the migration"));
    // Taken once: a remount after a space switch must not light it again.
    expect(store.getState().agentsAsk["se1"]).toBeUndefined();
  });
});

describe("Build with", () => {
  it("sends the lead a brief naming the chosen model — and not the prompter's draft with it", async () => {
    const { api, store } = await mount();
    // A half-written message in the lead's own prompter, with a file on it.
    store.setState({ pendingAttachments: { se1: [{ path: "/tmp/shot.png", mime: "image/png", name: "shot.png", size: 1 }] } });
    fireEvent.click(await chip(/GPT-6 Luna/));
    fireEvent.change(screen.getByRole("textbox", { name: "What to build" }), { target: { value: "Add the dark-mode toggle." } });
    fireEvent.click(send());
    await waitFor(() => expect(api.sent).toHaveLength(1));
    // Mutant: send through `sendMessage` — the prompter's attachment would ride along with a message
    // that never asked for it.
    expect(api.sent[0]).toEqual({ id: "se1", attachments: [], text: delegationBrief({
      work: "Add the dark-mode toggle.", split: false, picks: [{ label: "GPT-6 Luna", own: false, task: "" }] }) });
  });

  it("suggests the vendors' own models, never the first entry of a proxy's long catalog", async () => {
    await mount();
    await chip(/GPT-6 Luna/);
    const chips = [...document.querySelectorAll(".subagents-pick .subagents-pick-label")].map((n) => n.textContent);
    // Mutant: suggest the first ready model of every harness — fx's first of 165 becomes a chip.
    expect(chips).toEqual(["Claude Opus 5.5", "Claude Fable 5.1", "GPT-6 Luna", "More models"]);
  });

  it("the session's own model is offered first, and picking it names no model", async () => {
    const { api } = await mount();
    fireEvent.click(await chip(/Claude Opus 5\.5.*this session/));
    fireEvent.change(screen.getByRole("textbox", { name: "What to build" }), { target: { value: "Refactor it." } });
    fireEvent.click(send());
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toContain("leave constraints.model out");
  });

  it("split by model gives each model its own part", async () => {
    const { api } = await mount();
    fireEvent.click(await chip(/GPT-6 Luna/));
    fireEvent.click(await chip(/Claude Opus 5\.5.*this session/));
    fireEvent.click(screen.getByRole("button", { name: "Split by model" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What GPT-6 Luna should do" }), { target: { value: "Write the toggle" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What Claude Opus 5.5 should do" }), { target: { value: "Review it" } });
    fireEvent.click(send());
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- GPT-6 Luna: Write the toggle",
      "- Your own model (Claude Opus 5.5), with constraints.model left out: Review it",
    ]);
  });

  it("More models lists every model by harness; one picked there joins the chips, one not ready cannot be picked", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "More models" }));
    const list = await screen.findByRole("listbox", { name: "Models" });
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["This session", "Codex", "Claude", "Cursor", "fx"]);
    fireEvent.click(within(list).getByRole("option", { name: /Claude Fable 5\.1/ }));
    expect(within(list).getByRole("option", { name: /Claude Fable 5\.1/ })).toHaveAttribute("aria-selected", "true");
    // Mutant: let an unready harness's row toggle — a sub-agent the server would refuse to start.
    const composer = within(list).getByRole("option", { name: /Composer 2/ });
    expect(composer).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(composer);
    expect(composer).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: /Claude Fable 5\.1/, pressed: true })).toBeInTheDocument();
  });

  it("the chooser's search narrows by model or by harness", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "More models" }));
    const search = await screen.findByRole("textbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "luna" } });
    expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["GPT-6 Luna"]);
    fireEvent.change(search, { target: { value: "claude" } });
    expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Claude Opus 5.5Claude", "Claude Fable 5.1"]);
  });

  it("will not send without a model, or without anything to build", async () => {
    await mount();
    fireEvent.change(await screen.findByRole("textbox", { name: "What to build" }), { target: { value: "Something" } });
    expect(send()).toBeDisabled();
    fireEvent.click(await chip(/GPT-6 Luna/));
    expect(send()).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "What to build" }), { target: { value: "" } });
    expect(send()).toBeDisabled();
  });

  it("Implement with… starts the composer from the plan, and calls it the plan", async () => {
    const { api, store } = await mount();
    await store.getState().openAgentsTab("se1", { plan: "1. Carry the plan.\n2. Draw it." });
    const field = await screen.findByRole("textbox", { name: "What to build" });
    await waitFor(() => expect(field).toHaveValue("1. Carry the plan.\n2. Draw it."));
    fireEvent.click(await chip(/GPT-6 Luna/));
    fireEvent.click(send());
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toContain("The plan:\n\n1. Carry the plan.\n2. Draw it.");
  });

  it("a lead waiting on its plan: answered Keep planning, switched to Build, and only then sent the brief", async () => {
    const lead = session("se1", "s1", { title: "Parent", agentKind: "claude", model: "claude-opus-5-5", permissionMode: "plan", status: "waiting_permission" });
    const { api, store } = await mount({ lead, status: { se1: "waiting_permission" } });
    store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([sessionEvent("permission_request", {
      requestId: "r1", toolName: "ExitPlanMode", input: { plan: "x" }, title: "Exit plan mode?", suggestions: [] })]) } } });
    expect(await screen.findByText("Sending answers the open plan with Keep planning and switches to Build.")).toBeInTheDocument();
    fireEvent.click(await chip(/GPT-6 Luna/));
    fireEvent.change(screen.getByRole("textbox", { name: "What to build" }), { target: { value: "Build it." } });
    fireEvent.click(send());
    await waitFor(() => expect(api.sent).toHaveLength(1));
    // Mutant: send first — a lead still in Plan can only start sub-agents that read.
    const deny = api.calls.indexOf("respondPermission:se1:r1:deny");
    const leave = api.calls.lastIndexOf("setSessionOptions:se1");
    const brief = api.calls.findIndex((c) => c.startsWith("sendMessage:se1="));
    expect(deny).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(deny);
    expect(brief).toBeGreaterThan(leave);
    expect(store.getState().sessions["se1"]!.permissionMode).toBe("default");
  });
});

/** A sub-agent waiting on a Bash permission, as its own transcript holds it. */
const ASKING = session("se4", "s1", { title: "Dark-mode toggle", agentKind: "codex", model: "gpt-6-luna", status: "waiting_permission", permissionMode: "bypassPermissions",
  dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const ASK_EVENTS: SessionEvent[] = [sessionEvent("permission_request", { requestId: "r9", toolName: "Bash", input: { command: "pnpm vitest run settings" }, title: "Allow Bash?", suggestions: [] })];
const asking = (over: Partial<DelegatedChild> = {}): DelegatedChild => ({ session: ASKING, goal: "You are a builder.\nAdd the dark-mode toggle.", startedAt: NOW - 30_000,
  settledAt: null, outcome: null, report: null, activity: null, ...over });

describe("the orchestrator", () => {
  it("a waiting card is open, says who asks, and Allow answers the CHILD's request", async () => {
    // THE MUTANT: answer with the lead's id — the request sits on the child's session, not the lead's.
    const { api } = await mount({ children: [...CHILDREN, asking()], runs: ["se2", "se4"], status: { se4: "waiting_permission" }, transcripts: { se4: ASK_EVENTS } });
    const head = await card(/^Dark-mode toggle\./);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Waiting in Dark-mode toggle" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.calls).toContain("respondPermission:se4:r9:allow"));
  });

  it("Escape folds the card and answers nothing", async () => {
    // THE MUTANT: let the card take Escape as Deny, as it does in the transcript.
    const { api } = await mount({ children: [asking()], runs: ["se4"], status: { se4: "waiting_permission" }, transcripts: { se4: ASK_EVENTS } });
    const head = await card(/^Dark-mode toggle\./);
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), { key: "Escape" });
    await waitFor(() => expect(head).toHaveAttribute("aria-expanded", "false"));
    expect(api.calls.some((c) => c.startsWith("respondPermission:"))).toBe(false);
  });

  it("orders what needs you first, then what is working, then what has ended", async () => {
    // THE MUTANT: start order only — the waiting card, started last, sits at the bottom.
    await mount({ children: [...CHILDREN, asking()], runs: ["se2", "se4"], status: { se4: "waiting_permission" }, transcripts: { se4: ASK_EVENTS } });
    await card(/^Dark-mode toggle\./);
    const order = [...document.querySelectorAll(".subagents-list > li.subagent .subagent-task")].map((n) => n.textContent);
    expect(order).toEqual(["Dark-mode toggle", "Write the tests", "Write the migration"]);
    expect(screen.getByRole("heading", { name: /Sub-agents/ })).toHaveTextContent("1 needs you · 1 working · 1 done");
  });

  it("Stop interrupts the child, and is not offered once it has ended", async () => {
    // THE MUTANT: offer Stop on a settled child — a button whose only effect is nothing.
    const { api } = await mount();
    fireEvent.click(await card(/^Write the tests\./));
    fireEvent.click(screen.getByRole("button", { name: "Stop Write the tests" }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se2"));
    fireEvent.click(await card(/^Write the migration\./));
    expect(screen.queryByRole("button", { name: "Stop Write the migration" })).toBeNull();
  });

  it("Message goes to the child; the placeholder warns that the lead may not see it only once the run has ended", async () => {
    // THE MUTANTS: send to the lead; say the warning always, or never.
    const { api } = await mount();
    fireEvent.click(await card(/^Write the tests\./));
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    const field = screen.getByRole("textbox", { name: "Message Write the tests" });
    expect(field.getAttribute("placeholder")).toBe("Goes to this agent only.");
    fireEvent.change(field, { target: { value: "Use the existing toggle." } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.sent).toContainEqual(expect.objectContaining({ id: "se2", text: "Use the existing toggle." })));
    fireEvent.click(await card(/^Write the migration\./));
    fireEvent.click(within(document.getElementById("subagent-detail-se3")!).getByRole("button", { name: "Message" }));
    expect(screen.getByRole("textbox", { name: "Message Write the migration" }).getAttribute("placeholder"))
      .toBe("Goes to this agent only. If its run was already collected, Parent will not see the reply.");
  });

  it("says the budget as working time spent of the whole, only where there is a budget", async () => {
    // THE MUTANT: "of —" on a child whose record kept no budget.
    const { container } = await mount({ children: [
      { ...CHILDREN[0]!, budgetMs: 660_000, working: { ms: 161_000, at: Date.now() } },
      CHILDREN[1]!,
    ] });
    await card(/^Write the tests\./);
    const budgets = [...container.querySelectorAll(".subagent-budget")].map((n) => n.textContent);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatch(/^2m 4\ds of 11m 0s$/);
  });

  it("says where each child works and in which mode — an inherited Full access is visible", async () => {
    const { store, container } = await mount({ children: [asking()], runs: ["se4"], status: { se4: "waiting_permission" }, transcripts: { se4: ASK_EVENTS } });
    store.setState({ environments: { "01ARZ3NDEKTSV4RRFFQ69G5FAV": { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId: "s1", path: "/r/wt/dark", branch: "realm/dark-mode-toggle",
      kind: "worktree", portBlockStart: null, createdAt: 0, updatedAt: 0 } } });
    await card(/^Dark-mode toggle\./);
    await waitFor(() => expect(container.querySelector(".subagent-where")).toHaveTextContent("realm/dark-mode-toggle"));
    expect(container.querySelector(".subagent-mode")).toHaveTextContent("Full access");
  });

  it("nests the agents a child runs inside its harness under that child, not beside it", async () => {
    // THE MUTANT: list them at the top level, as if the lead had started them.
    const task = sessionEvent("tool_call", { toolUseId: "tk1", name: "Task", input: { description: "Survey fixtures" }, parentToolUseId: null });
    const { container } = await mount({ transcripts: { se2: [task] } });
    await card(/^Write the tests\./);
    const nested = await screen.findByRole("button", { name: "Watch Survey fixtures, in the agent" });
    expect(nested.closest("li.subagent")).toHaveAttribute("data-state", "working");
    expect(within(nested.closest("li.subagent") as HTMLElement).getByText("Write the tests")).toBeInTheDocument();
    expect(container.querySelectorAll(".subagents-list > li.subagent")).toHaveLength(2);
  });

  it("nests a sub-agent's own sub-agents, from before a sub-agent could no longer start any", async () => {
    const grand = session("se5", "s1", { title: "Agent: Check the copy", dispatchedBy: { sessionId: "se3", kind: "agent_run" } });
    await mount({ children: [CHILDREN[0]!, { ...CHILDREN[1]!, children: [{ session: grand, goal: "Check the copy", startedAt: NOW - 200_000, settledAt: NOW - 150_000,
      outcome: "done", report: "Fine.", activity: null }] }] });
    const g = await card(/^Check the copy\./);
    expect(g.closest("li.subagent")).toHaveAttribute("data-nested");
    expect(g.closest("li.subagent")!.parentElement!.closest("li.subagent")).toHaveTextContent("Write the migration");
  });

  it("titles a card by the child's session title, and not by an old 'Agent: …' clip of its goal", async () => {
    await mount({ children: [asking()], runs: ["se4"], status: { se4: "waiting_permission" }, transcripts: { se4: ASK_EVENTS } });
    // The goal opens with boilerplate; the session's own title is the task's name.
    expect(await card(/^Dark-mode toggle\./)).toBeInTheDocument();
  });

  it("says why Realm stopped a child itself", async () => {
    await mount({ children: [{ ...CHILDREN[1]!, outcome: "stopped", report: null,
      note: "Stopped when the session that started it went to Plan: Realm cannot hold Cursor to a read-only mode." }] });
    expect(await card(/^Write the migration\. .*Stopped/)).toHaveTextContent("Realm cannot hold Cursor to a read-only mode.");
  });
});
