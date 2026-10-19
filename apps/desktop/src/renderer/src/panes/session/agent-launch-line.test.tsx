import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent, type SessionEvent, type SessionStatus } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

const LEAD = "01JC0000000000000000000001";
const T0 = Date.now() - 120_000;

const ask = (text: string, ts: number) => sessionEvent("user_message", { text, attachments: [] }, ts);
/** Claude's own background agent: the launch returns at once, and the agent is marked running. */
const launch = (id: string, description: string, ts: number) => [
  sessionEvent("tool_call", { toolUseId: id, name: "Agent", input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose", run_in_background: true }, parentToolUseId: null }, ts),
  sessionEvent("tool_result", { toolUseId: id, content: "Async agent launched successfully.", isError: false }, ts + 500),
  sessionEvent("background_task", { toolUseId: id, status: "running" }, ts + 600),
];
const stop = (id: string, ts: number) => sessionEvent("background_task", { toolUseId: id, status: "stopped" }, ts);
const said = (text: string, ts: number) => sessionEvent("assistant_text", { messageId: `m${ts}`, text }, ts);

async function mount(events: SessionEvent[], opts: { status?: SessionStatus } = {}) {
  const api = fakeApi({ items: { s1: [item("i1", "s1", { kind: "session", refId: LEAD })] }, sessions: [session(LEAD, "s1")] });
  const store = createAppStore(api); await store.getState().boot();
  const t = reduceAll(events);
  const status = opts.status ?? "idle";
  store.setState({ transcripts: { [LEAD]: { lastSeq: events.length, t } }, sessionStatus: { [LEAD]: status } });
  const r = render(<StoreContext.Provider value={store}>
    <Transcript transcript={t} sessionStatus={status} onDecide={() => {}} sessionId={LEAD} />
  </StoreContext.Provider>);
  const rerender = (next: SessionEvent[]) => {
    const t2 = reduceAll(next);
    act(() => store.setState({ transcripts: { [LEAD]: { lastSeq: next.length, t: t2 } } }));
    r.rerender(<StoreContext.Provider value={store}>
      <Transcript transcript={t2} sessionStatus={status} onDecide={() => {}} sessionId={LEAD} />
    </StoreContext.Provider>);
  };
  return { api, store, rerender };
}

const fanOut = [ask("Restart both", T0), ...launch("a1", "Teams rule engine", T0 + 1_000), ...launch("a2", "Realmite runner game", T0 + 2_000),
  said("I've restarted both from where they stopped.", T0 + 3_000)];

afterEach(() => cleanup());

describe("the transcript after a fan-out", () => {
  /* THE mutant: the strip back under the last message — a third place naming the agents that the
     prompter's row and their own launch lines already name. */
  it("ends on its last message: who is working is said on the prompter's row, not under the log", async () => {
    await mount(fanOut);
    expect(screen.getByRole("button", { name: "Sub-agent working: Teams rule engine, general-purpose" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sub-agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^2 sub-agents working/ })).toBeNull();
  });
});

describe("the launch of the session's own sub-agent, in the transcript", () => {
  it("is a sub-agent line, not a generic tool card, and says how it stands", async () => {
    const { rerender } = await mount(fanOut);
    expect(screen.getByRole("button", { name: "Sub-agent working: Teams rule engine, general-purpose" })).toBeInTheDocument();
    // Mutant: draw it as the ordinary card — "Agent tool call" with its JSON a click away.
    expect(screen.queryByRole("button", { name: "Agent tool call" })).toBeNull();
    rerender([...fanOut, stop("a1", T0 + 61_000)]);
    // Elapsed to the STOP, not to the launch's one-second result. Mutant: measure to the result.
    const line = screen.getByRole("button", { name: "Sub-agent finished: Teams rule engine, general-purpose" });
    expect(line).toHaveTextContent("1m 0s");
  });

  it("stands apart from the calls around it, rather than folding into Worked for", async () => {
    const read = (id: string, ts: number) => [
      sessionEvent("tool_call", { toolUseId: id, name: "Read", input: { file_path: `/${id}.ts` }, parentToolUseId: null }, ts),
      sessionEvent("tool_result", { toolUseId: id, content: "x", isError: false }, ts + 1),
    ];
    await mount([ask("go", T0), ...read("r1", T0 + 10), ...launch("a1", "Audit", T0 + 20), ...read("r2", T0 + 30), said("ok", T0 + 40)]);
    // Mutant: drop the launch from `standsAlone` — the three fold into one run and the line is hidden.
    expect(screen.getByRole("button", { name: /^Sub-agent working: Audit/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "3 tool calls" })).toBeNull();
  });

  it("opens the Agents tab on its card", async () => {
    const { api, store } = await mount(fanOut);
    fireEvent.click(screen.getByRole("button", { name: /^Sub-agent working: Teams rule engine/ }));
    await waitFor(() => expect(api.calls).toContain(`agentsTab:${LEAD}`));
    expect(store.getState().agentsShown[LEAD]).toBe("a1");
  });

  it("a blocking one whose turn was cut off is stopped, not working forever", async () => {
    await mount([ask("go", T0), sessionEvent("tool_call", { toolUseId: "b1", name: "Task", input: { description: "Dig" }, parentToolUseId: null }, T0 + 10)]);
    expect(screen.getByRole("button", { name: "Sub-agent stopped: Dig" })).toBeInTheDocument();
  });
});
