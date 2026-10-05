import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent, type DelegatedChild } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

/** Real ULIDs: the line finds its child by the id the call's result names, and only an id of the
 *  session-id shape is read out of a result (`delegatedChildIds`). */
const LEAD = "01JC0000000000000000000001";
const CHILD = "01JC0000000000000000000002";

const start = (goal: string, result: { text: string; isError?: boolean } | null) => [
  sessionEvent("tool_call", { toolUseId: "t1", name: "mcp__realm__realm-agent__agent_start", input: { goal, constraints: { model: "GPT-6 Luna" } }, parentToolUseId: null }),
  ...(result ? [sessionEvent("tool_result", { toolUseId: "t1", content: result.text, isError: result.isError ?? false })] : []),
];

const child = (over: Partial<DelegatedChild> = {}): DelegatedChild => ({
  session: session(CHILD, "s1", { agentKind: "codex", model: "gpt-6-luna", dispatchedBy: { sessionId: LEAD, kind: "agent_run" } }),
  goal: "Write the tests\n\nFor the toggle.", startedAt: 1_000, settledAt: 101_000, outcome: "done", report: "All pass.", activity: null, ...over,
});

async function mount(events: ReturnType<typeof start>, children: DelegatedChild[], opts: { sessionId?: string | null } = {}) {
  const api = fakeApi({ items: { s1: [item("i1", "s1", { kind: "session", refId: LEAD })] }, sessions: [session(LEAD, "s1")], delegatedChildren: { [LEAD]: children } });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ agentProbe: [{ kind: "codex", available: true, version: "x", loggedIn: true, reason: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] }] });
  render(<StoreContext.Provider value={store}>
    <Transcript transcript={reduceAll(events)} sessionStatus="idle" onDecide={() => {}} sessionId={opts.sessionId === undefined ? LEAD : opts.sessionId} />
  </StoreContext.Provider>);
  return { api, store };
}

afterEach(() => cleanup());

describe("a sub-agent in its lead's transcript", () => {
  it("is one quiet line — Subagent finished · its task — with the model it ran on and how long", async () => {
    await mount(start("Write the tests\n\nFor the toggle.", { text: `Started delegated agent ${CHILD} ("Agent: Write the tests") on Codex · GPT-6 Luna.` }), [child()]);
    const line = await screen.findByRole("button", { name: "Subagent finished: Write the tests, on GPT-6 Luna" });
    expect(line).toHaveTextContent("Subagent finished");
    expect(line).toHaveTextContent("1m 40s");
    // Mutant: keep drawing the generic card — the raw tool name and its JSON in place of the line.
    expect(screen.queryByText("mcp__realm__realm-agent__agent_start")).toBeNull();
  });

  it("says what the sub-agent is doing now, not what the call did — a child working again says so", async () => {
    const { store } = await mount(start("Write the tests", { text: `Started delegated agent ${CHILD}.` }), [child()]);
    store.setState({ sessionStatus: { [CHILD]: "running" } });
    expect(await screen.findByRole("button", { name: /^Subagent working: Write the tests/ })).toBeInTheDocument();
  });

  it("links to its row in this session's Agents tab", async () => {
    const { api, store } = await mount(start("Write the tests", { text: `Started delegated agent ${CHILD}.` }), [child()]);
    fireEvent.click(await screen.findByRole("button", { name: /^Subagent finished/ }));
    await waitFor(() => expect(api.calls).toContain(`agentsTab:${LEAD}`));
    // The row it asks for waits for the tab to take it — no tab is mounted in this test to do so.
    // Mutant: open the tab without the child — the tab would open on its list and light nothing.
    expect(store.getState().agentsAsk[LEAD]).toMatchObject({ childId: CHILD });
  });

  it("an agent_run still blocking — no result yet — is found by its task", async () => {
    const { store } = await mount(start("Write the tests", null), [child({ goal: "Write the tests", outcome: null, settledAt: null, report: null })]);
    store.setState({ sessionStatus: { [CHILD]: "waiting_permission" } });
    // Mutant: find the child by the result's id alone — until agent_run returns, the line could only
    // say it is starting, about a sub-agent that is in fact waiting on the user.
    expect(await screen.findByRole("button", { name: /^Subagent waiting on you: Write the tests/ })).toBeInTheDocument();
  });

  it("a refused call keeps its card, so the refusal's words can be read", async () => {
    await mount(start("Write the tests", { text: 'refused: "GPT-6" could mean GPT-6 Astra or GPT-6 Luna.', isError: true }), []);
    expect(await screen.findByText("mcp__realm__realm-agent__agent_start")).toBeInTheDocument();
    expect(screen.queryByText(/^Subagent/)).toBeNull();
  });

  it("in a read-only mount it still reads, and links nowhere", async () => {
    await mount(start("Write the tests", { text: `Started delegated agent ${CHILD}.` }), [child()], { sessionId: null });
    expect(await screen.findByRole("button", { name: /Write the tests/ })).toBeDisabled();
  });
});
