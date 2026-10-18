import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type DelegatedChild, type GitInfo, type Session, type SessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { SessionPane } from "./SessionPane";
import { ROW_MAX } from "./ActiveAgents";

/**
 * The prompter's teammates: "+ → Add teammate…", and the row of who is working on the over-strip.
 * The mutants this suite exists to kill:
 *
 *   - the menu row missing, or offered on a sub-agent          → "the + offers Add teammate…"
 *   - the picker sending something other than what was picked   → "adds one with…"
 *   - a worktree offered where there is no git checkout         → "…only where there is a checkout"
 *   - the row's states drawn without the sidebar's marks        → "each agent wears its state"
 *   - no fold, or a fold that hides the one that needs you      → "crowded"
 *   - an empty strip with nothing on it                         → "quiet when there are none"
 *   - dismiss / stop / message not doing what they say          → "its menu"
 */

const NOW = Date.now();
const LEAD = session("se1", "s1", { title: "Parent", agentKind: "claude", model: "claude-opus-5-5", status: "idle" });
const kid = (id: string, title: string, extra: Partial<Session>, child: Partial<DelegatedChild> = {}): DelegatedChild => ({
  session: session(id, "s1", { title, agentKind: "codex", model: "gpt-6-luna", status: "idle", dispatchedBy: { sessionId: "se1", kind: "agent_run" }, ...extra }),
  goal: title, startedAt: NOW - 65_000, settledAt: null, outcome: null, report: null, activity: null, ...child,
});
const WORKING = kid("se2", "Write the tests", { status: "running" }, { goal: "Write the tests\n\n# Joining as a teammate…" });
const WAITING = kid("se4", "Check the schema", { status: "waiting_permission" });
const DONE = kid("se3", "Draft the changelog", {}, { settledAt: NOW - 5_000, outcome: "done", report: "Done." });
const FAILED = kid("se5", "Run the e2e suite", {}, { settledAt: NOW - 4_000, outcome: "failed" });
const DONE_TOO = kid("se6", "Rename the flag", {}, { settledAt: NOW - 3_000, outcome: "done", report: "Done." });
const PROBE: AgentProbe[] = [{ kind: "codex", available: true, version: "x", loggedIn: true, reason: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] }];
const gi = (branch: string): GitInfo => ({ branch, additions: 0, deletions: 0, dirty: 0 } as GitInfo);

async function mount(over: { lead?: Session; children?: DelegatedChild[]; events?: SessionEvent[]; git?: GitInfo | null; dismissed?: string[] } = {}) {
  const lead = over.lead ?? LEAD;
  const children = over.children ?? [];
  const api = fakeApi({ sessions: [lead, ...children.map((c) => c.session)], delegatedChildren: { se1: children },
    gitInfo: { "/tmp": over.git ?? null }, agentProbe: PROBE,
    dismissedSubagents: { se1: over.dismissed ?? [] },
    delegatedRuns: { se1: children.filter((c) => c.outcome === null).map((c) => ({ sessionId: c.session.id, startedAt: c.startedAt, detached: true, owned: true })) } });
  const store = createAppStore(api); await store.getState().boot();
  const events = over.events ?? [];
  store.setState({
    sessionStatus: Object.fromEntries([lead, ...children.map((c) => c.session)].map((s) => [s.id, s.status])),
    transcripts: { se1: { lastSeq: events.length, t: reduceAll(events) } },
    gitInfo: { "/tmp": over.git === undefined ? null : over.git },
    agentProbe: PROBE,
  });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: lead.id, title: "Parent" })} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const row = () => screen.findByRole("group", { name: "Agents in this session" });
const chips = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>(".active-agent")];
const openPlus = () => fireEvent.click(screen.getByRole("button", { name: "Add" }));

afterEach(() => cleanup());

describe("the + offers Add teammate…", () => {
  it("adds one with the session's own model, the brief and the checkout picked — through delegation.addTeammate", async () => {
    const { api } = await mount({ git: gi("main") });
    openPlus();
    fireEvent.click(within(await screen.findByRole("menu", { name: "Add" })).getByRole("menuitem", { name: /^Add teammate…/ }));
    const pop = await screen.findByRole("dialog", { name: "Add a teammate" });
    // The prompter's own picker, opening on the session's model.
    expect(within(pop).getByRole("button", { name: "Model" })).toHaveTextContent("Opus 5.5");
    fireEvent.click(within(pop).getByRole("radio", { name: "Its own worktree" }));
    const brief = within(pop).getByRole("textbox", { name: "What it should help with" });
    fireEvent.change(brief, { target: { value: "  Write the tests " } });
    fireEvent.keyDown(brief, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain(`addTeammate:${JSON.stringify({ sessionId: "se1", agentKind: "claude", model: "claude-opus-5-5", brief: "Write the tests", newWorktree: true })}`));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a teammate" })).toBeNull());
  });

  it("offers a worktree only where there is a git checkout, and works in this folder otherwise", async () => {
    const { api } = await mount({ git: null });
    openPlus();
    fireEvent.click(within(await screen.findByRole("menu", { name: "Add" })).getByRole("menuitem", { name: /^Add teammate…/ }));
    const pop = await screen.findByRole("dialog", { name: "Add a teammate" });
    expect(within(pop).queryByRole("radio")).toBeNull();
    fireEvent.click(within(pop).getByRole("button", { name: "Add teammate" }));
    await waitFor(() => expect(api.calls).toContain(`addTeammate:${JSON.stringify({ sessionId: "se1", agentKind: "claude", model: "claude-opus-5-5", newWorktree: false })}`));
  });

  it("is not offered to a sub-agent, which may not start agents of its own", async () => {
    await mount({ lead: { ...LEAD, dispatchedBy: { sessionId: "se0", kind: "agent_run" } } });
    openPlus();
    const menu = await screen.findByRole("menu", { name: "Add" });
    expect(within(menu).getByRole("menuitem", { name: /^Files…/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /^Add teammate…/ })).toBeNull();
  });
});

describe("the row of who is working", () => {
  it("each agent wears its state — the sidebar's dot and ring while it works or needs you — and says the rest on hover", async () => {
    const { store } = await mount({ children: [WORKING, WAITING, DONE] });
    const g = await row();
    // Needs you first, then working, then what has ended.
    expect(chips(g).map((c) => [c.textContent, c.dataset.state])).toEqual([
      ["Check the schema", "waiting"], ["Write the tests", "working"], ["Draft the changelog", "done"]]);
    expect(chips(g)[0]!.querySelector('.status-dot[data-status="waiting_permission"]')).not.toBeNull();
    expect(chips(g)[1]!.querySelector('.status-dot[data-status="running"]')).not.toBeNull();
    expect(chips(g)[2]!.querySelector(".status-dot")).toBeNull();
    // The name, what runs it, where it stands and for how long — and the task, where it says more.
    expect(chips(g)[1]).toHaveAttribute("title", expect.stringMatching(/^Write the tests · Codex · GPT-6 Luna · Working, 1m \d+s\. Right-click for more\.$/));
    // A click opens it in the Agents tab, on that agent.
    fireEvent.click(chips(g)[1]!);
    await waitFor(() => expect(store.getState().agentsShown.se1).toBe("se2"));
  });

  it("is quiet when there are none — no strip at all without a checkout — and draws one for agents alone", async () => {
    await mount({ git: null });
    expect(document.querySelector(".composer-overstrip")).toBeNull();
    cleanup();
    await mount({ git: null, children: [WORKING] });
    expect(chips(await row())).toHaveLength(1);
    expect(document.querySelector(".composer-overstrip .composer-git")).toBeNull();
  });

  it("sits after the branch on the same strip when there is one", async () => {
    await mount({ git: gi("feat/x"), children: [WORKING] });
    await row();
    const strip = document.querySelector(".composer-overstrip")!;
    expect([...strip.children].map((c) => c.className)).toEqual(["composer-git", "active-agents"]);
  });

  it(`folds past ${ROW_MAX} into +N, never folding away the one that needs you`, async () => {
    await mount({ children: [DONE, FAILED, DONE_TOO, WORKING, WAITING] });
    const g = await row();
    expect(chips(g).map((c) => c.textContent)).toEqual(["Check the schema", "Write the tests"]);
    const more = within(g).getByRole("button", { name: "3 more agents" });
    expect(more).toHaveTextContent("+3");
    fireEvent.click(more);
    const menu = await screen.findByRole("menu", { name: "More agents" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.querySelector(".menu-label")!.textContent))
      .toEqual(["Draft the changelog", "Run the e2e suite", "Rename the flag"]);
  });

  it("keeps a finished agent until the next message, and an agent still working whenever it began", async () => {
    const said: SessionEvent = { ...sessionEvent("user_message", { text: "next", attachments: [] }), ts: NOW - 10_000 };
    await mount({ children: [WORKING, { ...DONE, startedAt: NOW - 20_000 }, { ...DONE_TOO, startedAt: NOW - 2_000 }], events: [said] });
    expect(chips(await row()).map((c) => c.textContent)).toEqual(["Write the tests", "Rename the flag"]);
  });

  it("leaves out what the person dismissed", async () => {
    await mount({ children: [WORKING, DONE], dismissed: ["se3"] });
    expect(chips(await row()).map((c) => c.textContent)).toEqual(["Write the tests"]);
  });
});

describe("its menu", () => {
  const menuOf = async (name: string) => {
    fireEvent.contextMenu(within(await row()).getByRole("button", { name: new RegExp(`^${name},`) }), { clientX: 10, clientY: 10 });
    return screen.findByRole("menu", { name });
  };

  it("stops a working sub-agent and dismisses one, which leaves the row at once", async () => {
    const { api } = await mount({ children: [WORKING, DONE] });
    fireEvent.click(within(await menuOf("Write the tests")).getByRole("menuitem", { name: "Stop" }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se2"));
    const done = await menuOf("Draft the changelog");
    // Nothing to stop once it has ended.
    expect(within(done).queryByRole("menuitem", { name: "Stop" })).toBeNull();
    fireEvent.click(within(done).getByRole("menuitem", { name: /^Dismiss/ }));
    await waitFor(() => expect(api.calls).toContain("dismissSubagent:se1:se3"));
    await waitFor(async () => expect(chips(await row()).map((c) => c.textContent)).toEqual(["Write the tests"]));
  });

  it("Message puts its name in the prompter, as the @ list would, to pass it the next message", async () => {
    const { store } = await mount({ children: [WORKING] });
    fireEvent.click(within(await menuOf("Write the tests")).getByRole("menuitem", { name: /^Message/ }));
    await waitFor(() => expect(store.getState().drafts.se1).toBe("@[Write the tests] "));
    expect(store.getState().draftRefs.se1).toEqual([{ kind: "agent", sessionId: "se2", label: "Write the tests" }]);
  });

  it("offers neither Stop nor Message for one the harness runs inside the session's agent", async () => {
    const launch: SessionEvent = sessionEvent("tool_call", { toolUseId: "toolu_h1", name: "Task", input: { description: "Survey the docs", prompt: "Survey" }, parentToolUseId: null });
    const lead = { ...LEAD, status: "running" as const };
    await mount({ lead, events: [launch] });
    const menu = await menuOf("Survey the docs");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.querySelector(".menu-label")!.textContent)).toEqual(["Open in Agents tab", "Dismiss"]);
  });
});

describe("the @ list", () => {
  it("names the session's own sub-agents, under their own head", async () => {
    await mount({ children: [WORKING, DONE] });
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "@" } });
    fireEvent.select(box, { target: { selectionStart: 1, selectionEnd: 1 } });
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("In this session")).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /Write the tests/ })).toBeInTheDocument();
  });
});
