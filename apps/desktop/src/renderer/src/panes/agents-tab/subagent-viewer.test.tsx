import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type DelegatedChild, type SessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { reduceAll } from "../session/transcript-model";
import { AgentsTab } from "./AgentsTab";

const NOW = Date.now();
const LEAD = session("se1", "s1", { title: "Parent", agentKind: "claude", model: "claude-opus-5-5" });
const LUNA = session("se2", "s1", { title: "Write the tests", agentKind: "codex", model: "gpt-6-luna", status: "running",
  environmentId: "env-wt", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const FABLE = session("se3", "s1", { title: "Write the migration", agentKind: "claude", model: "claude-fable-5-1", dispatchedBy: { sessionId: "se1", kind: "agent_run" } });
const TAB = item("i20", "s1", { kind: "agents", title: "Agents", refId: "se1" });
const ITEMS = { s1: [item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" }), TAB] };
const CHILDREN: DelegatedChild[] = [
  { session: LUNA, goal: "Write the tests", startedAt: NOW - 65_000, settledAt: null, outcome: null, report: null, activity: null },
  { session: FABLE, goal: "Write the migration", startedAt: NOW - 300_000, settledAt: NOW - 120_000, outcome: "done",
    report: "Added the column. **All 12 pass.**", activity: null },
];

const launch = (id: string, description: string, prompt = "", ts = NOW - 40_000) =>
  sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description, ...(prompt ? { prompt } : {}), subagent_type: "Explore" }, parentToolUseId: null }, ts);
const under = (parent: string, id: string, name: string, input: Record<string, unknown>) =>
  sessionEvent("tool_call", { toolUseId: id, name, input, parentToolUseId: parent });
const result = (id: string, content: string, isError = false) => sessionEvent("tool_result", { toolUseId: id, content, isError });

async function mount(over: { shown?: string; settings?: Record<string, unknown>; transcripts?: Record<string, SessionEvent[]>;
  status?: Record<string, "idle" | "running" | "waiting_permission">; children?: DelegatedChild[] } = {}) {
  const api = fakeApi({ items: ITEMS, sessions: [LEAD, LUNA, FABLE], delegatedChildren: { se1: over.children ?? CHILDREN },
    delegatedRuns: { se1: [{ sessionId: "se2", startedAt: 0, detached: true, owned: true }] }, settings: over.settings });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({
    transcripts: Object.fromEntries(Object.entries({ se1: [], se2: [], se3: [], ...over.transcripts }).map(([id, evs]) => [id, { lastSeq: evs.length, t: reduceAll(evs) }])),
    sessionStatus: { se1: "idle", se2: "running", se3: "idle", ...over.status },
    environments: { "env-wt": { id: "env-wt", spaceId: "s1", path: "/r/wt/tests", branch: "realm/settings-tests", kind: "worktree", portBlockStart: null, createdAt: 0, updatedAt: 0 } },
  });
  await store.getState().openItem("i9");
  if (over.shown) await store.getState().openAgentsTab("se1", { childId: over.shown });
  const r = render(<StoreContext.Provider value={store}><AgentsTab item={TAB} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

const viewer = (name: string) => screen.findByRole("region", { name: `Sub-agent: ${name}` });

afterEach(() => cleanup());

describe("switching between a lead's sub-agents", () => {
  it("lists All and every sub-agent as tabs, each saying where it stands in words", async () => {
    await mount({ transcripts: { se1: [launch("t1", "Audit the mapper")] }, status: { se1: "running" } });
    const strip = await screen.findByRole("tablist", { name: "Sub-agents" });
    await waitFor(() => expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent))
      .toEqual(["All", "Write the migration, Done", "Write the tests, Working", "Audit the mapper, Working"]));
    expect(within(strip).getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  });

  it("→ moves to the next sibling and takes the keyboard with it; Escape in the viewer goes back to All", async () => {
    const { store } = await mount({ shown: "se3" });
    await viewer("Write the migration");
    const strip = screen.getByRole("tablist", { name: "Sub-agents" });
    const on = within(strip).getByRole("tab", { name: "Write the migration, Done" });
    on.focus();
    fireEvent.keyDown(on, { key: "ArrowRight" });
    // Mutant: change the selection and leave focus behind — the next → would step from the old tab.
    await viewer("Write the tests");
    await waitFor(() => expect(within(strip).getByRole("tab", { name: "Write the tests, Working" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("heading", { name: "Write the tests" }), { key: "Escape" });
    await waitFor(() => expect(store.getState().agentsShown.se1).toBeUndefined());
    expect(screen.queryByRole("region", { name: /^Sub-agent:/ })).toBeNull();
    await waitFor(() => expect(within(strip).getByRole("tab", { name: "All" })).toHaveFocus());
  });

  it("remembers which one was showing, across a relaunch", async () => {
    const first = await mount({ shown: "se3" });
    await viewer("Write the migration");
    // Persisted on a debounce, as every other remembered piece of window state is.
    await waitFor(() => expect(first.api.calls.some((c) => c.startsWith("setSetting:ui.agentsShown"))).toBe(true), { timeout: 2000 });
    const stored = await first.api.getSetting("ui.agentsShown");
    expect(stored).toEqual({ se1: "se3" });
    cleanup();
    // Mutant: keep it in memory only — the restored tab opens on the overview.
    await mount({ settings: { "ui.agentsShown": stored } });
    expect(await viewer("Write the migration")).toBeInTheDocument();
  });

  it("an id that names nothing any more is the overview, not an empty viewer", async () => {
    await mount({ settings: { "ui.agentsShown": { se1: "gone" } } });
    expect(await screen.findByRole("heading", { name: /^Sub-agents/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Sub-agent:/ })).toBeNull();
  });
});

describe("a delegated sub-agent's viewer", () => {
  it("heads it with its state in words, its clock, its model and harness, and its branch", async () => {
    await mount({ shown: "se2" });
    const head = (await viewer("Write the tests")).querySelector(".subagent-view-head");
    expect(head).toHaveTextContent(/Write the tests.*Working.*1m \d+s.*(GPT-6 Luna|gpt-6-luna) on Codex.*realm\/settings-tests/);
  });

  it("draws its own transcript, live — what it says lands as it says it", async () => {
    const { store } = await mount({ shown: "se2", transcripts: { se2: [sessionEvent("user_message", { text: "Write the tests", attachments: [] })] } });
    const view = await viewer("Write the tests");
    act(() => store.getState().applySessionEvent({ sessionId: "se2", seq: 2, ephemeral: false,
      event: sessionEvent("assistant_text", { messageId: "m1", text: "Reading the settings page first." }) }));
    // Mutant: read the child's transcript once — a viewer of a working agent that never moves.
    await waitFor(() => expect(within(view).getByText("Reading the settings page first.")).toBeInTheDocument());
  });

  it("answers its request on the CHILD's session, and Escape there leaves without denying", async () => {
    const ask = [sessionEvent("permission_request", { requestId: "r9", toolName: "Bash", input: { command: "pnpm vitest run settings" }, title: "Allow Bash?", suggestions: [] })];
    const { api, store } = await mount({ shown: "se2", transcripts: { se2: ask }, status: { se2: "waiting_permission" } });
    const view = await viewer("Write the tests");
    // THE MUTANT: let the card take Escape as Deny, as it does in a session's own pane.
    fireEvent.keyDown(within(view).getByRole("button", { name: "Allow" }), { key: "Escape" });
    await waitFor(() => expect(store.getState().agentsShown.se1).toBeUndefined());
    expect(api.calls.some((c) => c.startsWith("respondPermission:"))).toBe(false);
    await store.getState().openAgentsTab("se1", { childId: "se2" });
    fireEvent.click(within(await viewer("Write the tests")).getByRole("button", { name: "Allow" }));
    // And the answer goes to the child, which is the session blocked on it.
    await waitFor(() => expect(api.calls).toContain("respondPermission:se2:r9:allow"));
  });

  it("pins its report under the head once it has ended — and draws none while it works", async () => {
    await mount({ shown: "se3" });
    const done = await viewer("Write the migration");
    expect(within(done).getByRole("region", { name: "What it reported" })).toHaveTextContent("Added the column. All 12 pass.");
    // Outside the log's scroller: the report stays put while the transcript under it scrolls.
    expect(within(done).getByRole("region", { name: "What it reported" }).closest(".subagent-view-body")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Write the tests, Working" }));
    const working = await viewer("Write the tests");
    expect(within(working).queryByRole("region", { name: "What it reported" })).toBeNull();
  });
});

describe("a harness sub-agent's viewer", () => {
  it("shows the calls it made, and not a call the lead made itself", async () => {
    /* THE MUTANT: list every tool call in the transcript. The viewer would report the lead's own
       work as the agent's, which is the one thing it exists to tell apart. */
    await mount({ shown: "t1", status: { se1: "running" }, transcripts: { se1: [
      launch("t1", "Audit the mapper", "Audit every mapper and report anything that drops a field."),
      under("t1", "c1", "Read", { file_path: "/repo/mapper.ts" }),
      sessionEvent("tool_call", { toolUseId: "p1", name: "Read", input: { file_path: "/repo/parent-only.ts" }, parentToolUseId: null }),
    ] } });
    const view = await viewer("Audit the mapper");
    expect(within(view).getByTitle("/repo/mapper.ts")).toBeInTheDocument();
    expect(within(view).queryByTitle("/repo/parent-only.ts")).toBeNull();
    expect(within(view).getByText("1 call")).toBeInTheDocument();
    // The brief in full, which the line in the transcript could only name.
    expect(within(view).getByText(/drops a field/)).toBeInTheDocument();
    expect(view.querySelector(".subagent-view-head")).toHaveTextContent(/Working.*Explore inside Claude/);
  });

  it("pins a blocking call's result as its report, and a background agent's launch receipt as nothing", async () => {
    const bg = [sessionEvent("tool_call", { toolUseId: "b1", name: "Agent", input: { description: "Runner game", run_in_background: true }, parentToolUseId: null }, NOW - 30_000),
      result("b1", "Async agent launched successfully."), sessionEvent("background_task", { toolUseId: "b1", status: "running" }, NOW - 29_000),
      sessionEvent("background_task", { toolUseId: "b1", status: "stopped" }, NOW - 5_000)];
    const { store } = await mount({ shown: "t1", transcripts: { se1: [launch("t1", "Audit the mapper"), result("t1", "Two mappers drop `ts`."), ...bg] } });
    expect(within(await viewer("Audit the mapper")).getByRole("region", { name: "What it reported" })).toHaveTextContent("Two mappers drop ts.");
    await store.getState().openAgentsTab("se1", { childId: "b1" });
    // Mutant: pin any result — "Async agent launched successfully." would read as what it found.
    expect(within(await viewer("Runner game")).queryByRole("region", { name: "What it reported" })).toBeNull();
  });

  it("answers a request one of its calls is waiting on, on the lead's session that holds it", async () => {
    const { api } = await mount({ shown: "t1", status: { se1: "waiting_permission" }, transcripts: { se1: [
      launch("t1", "Audit the mapper"),
      under("t1", "c1", "Bash", { command: "pnpm vitest run mapper" }),
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "pnpm vitest run mapper" }, title: "Allow Bash?", suggestions: [] }),
    ] } });
    fireEvent.click(within(await viewer("Audit the mapper")).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.calls).toContain("respondPermission:se1:r1:allow"));
  });
});
