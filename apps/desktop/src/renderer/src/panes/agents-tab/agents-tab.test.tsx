import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { findSidePane, sessionEvent, type DelegatedChild } from "@realm/contracts";
import { StoreContext, createAppStore, type DelegableModels } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "../session/transcript-model";
import { AgentsTab } from "./AgentsTab";
import { delegationBrief } from "./brief";

const LEAD = session("se1", "s1", { title: "Parent", agentKind: "claude", model: "claude-opus-5-5" });
const LUNA = session("se2", "s1", { title: "Agent: Write the tests", agentKind: "codex", model: "gpt-6-luna", status: "running", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const FABLE = session("se3", "s1", { title: "Agent: Write the migration", agentKind: "claude", model: "claude-fable-5-1", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const TAB = item("i20", "s1", { kind: "agents", title: "Agents", refId: "se1" });
const ITEMS = { s1: [
  item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" }),
  item("i8", "s1", { kind: "session", title: "Agent: Write the tests", refId: "se2" }),
  item("i7", "s1", { kind: "session", title: "Agent: Write the migration", refId: "se3" }),
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
] };

async function mount(over: { lead?: typeof LEAD; children?: DelegatedChild[]; status?: Record<string, "idle" | "running" | "waiting_permission"> } = {}) {
  const lead = over.lead ?? LEAD;
  const api = fakeApi({ items: ITEMS, sessions: [lead, LUNA, FABLE], delegatedChildren: { se1: over.children ?? CHILDREN }, delegableModels: CATALOG,
    delegatedRuns: { se1: [{ sessionId: "se2", startedAt: 0, detached: true, owned: true }] } });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({
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

  it("says plainly when there are none yet, and where to start", async () => {
    await mount({ children: [] });
    expect(await screen.findByText(/None yet\. Pick models below/)).toBeInTheDocument();
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
