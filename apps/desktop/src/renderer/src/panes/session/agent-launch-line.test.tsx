import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type DelegatedChild, type SessionEvent, type SessionStatus } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { stripHeadline } from "./session-subagents";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

const LEAD = "01JC0000000000000000000001";
const CHILD = "01JC0000000000000000000002";
const T0 = Date.now() - 120_000;

const ask = (text: string, ts: number) => sessionEvent("user_message", { text, attachments: [] }, ts);
/** Claude's own background agent: the launch returns at once, and the agent is marked running. */
const launch = (id: string, description: string, ts: number) => [
  sessionEvent("tool_call", { toolUseId: id, name: "Agent", input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose", run_in_background: true }, parentToolUseId: null }, ts),
  sessionEvent("tool_result", { toolUseId: id, content: "Async agent launched successfully.", isError: false }, ts + 500),
  sessionEvent("background_task", { toolUseId: id, status: "running" }, ts + 600),
];
const stop = (id: string, ts: number) => sessionEvent("background_task", { toolUseId: id, status: "stopped" }, ts);
/** A blocking one that came back an error. */
const failed = (id: string, description: string, ts: number) => [
  sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description }, parentToolUseId: null }, ts),
  sessionEvent("tool_result", { toolUseId: id, content: "It broke.", isError: true }, ts + 30_000),
];
const said = (text: string, ts: number) => sessionEvent("assistant_text", { messageId: `m${ts}`, text }, ts);

async function mount(events: SessionEvent[], opts: { status?: SessionStatus; children?: DelegatedChild[]; childStatus?: SessionStatus } = {}) {
  const api = fakeApi({ items: { s1: [item("i1", "s1", { kind: "session", refId: LEAD })] }, sessions: [session(LEAD, "s1")],
    delegatedChildren: { [LEAD]: opts.children ?? [] },
    delegatedRuns: opts.children ? { [LEAD]: opts.children.map((c) => ({ sessionId: c.session.id, startedAt: c.startedAt, detached: true, owned: true })) } : {} });
  const store = createAppStore(api); await store.getState().boot();
  const t = reduceAll(events);
  const status = opts.status ?? "idle";
  store.setState({ transcripts: { [LEAD]: { lastSeq: events.length, t } }, sessionStatus: { [LEAD]: status, ...(opts.childStatus ? { [CHILD]: opts.childStatus } : {}) } });
  if (opts.children) await store.getState().refreshSubagents(LEAD);
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

const strip = () => screen.queryByRole("region", { name: "Sub-agents" });
const fanOut = [ask("Restart both", T0), ...launch("a1", "Teams rule engine", T0 + 1_000), ...launch("a2", "Realmite runner game", T0 + 2_000),
  said("I've restarted both from where they stopped.", T0 + 3_000)];

afterEach(() => cleanup());

describe("the sub-agent strip under the last message", () => {
  it("lists the background agents a finished turn left working, each by its task and state", async () => {
    await mount(fanOut);
    const s = strip()!;
    // The turn is over (idle) — and the strip is still there, which is the whole point: the chip
    // in the corner was the only sign. Mutant: gate the strip on the session being busy.
    expect(within(s).getByRole("button", { name: /^2 sub-agents working/ })).toBeInTheDocument();
    const rows = within(s).getAllByRole("button", { name: /Open it beside the transcript$/ });
    expect(rows.map((r) => r.querySelector(".subagent-strip-title")!.textContent)).toEqual(["Teams rule engine", "Realmite runner game"]);
    for (const r of rows) expect(r).toHaveTextContent("Working");
  });

  it("says when one needs you, from the same live status the chip reads", async () => {
    const child: DelegatedChild = { session: session(CHILD, "s1", { title: "Write the migration", dispatchedBy: { sessionId: LEAD, kind: "agent_run" } }),
      goal: "Write the migration", startedAt: T0 + 2_500, settledAt: null, outcome: null, report: null, activity: null };
    await mount([...fanOut], { children: [child], childStatus: "waiting_permission" });
    const s = strip()!;
    await waitFor(() => expect(within(s).getByRole("button", { name: /^2 sub-agents working · 1 needs you/ })).toBeInTheDocument());
    expect(within(s).getByRole("button", { name: /^Write the migration\. Needs you,/ })).toBeInTheDocument();
  });

  it("opens the Agents tab on the row's own card — and on the list from its head", async () => {
    const { api, store } = await mount(fanOut);
    fireEvent.click(within(strip()!).getByRole("button", { name: /^Realmite runner game\./ }));
    await waitFor(() => expect(api.calls).toContain(`agentsTab:${LEAD}`));
    // Mutant: open the tab without saying which — the tab opens on its list and lights nothing.
    expect(store.getState().agentsShown[LEAD]).toBe("a2");
  });

  it("folds to one line once they have all ended, and that line still opens the tab", async () => {
    const { api, rerender } = await mount(fanOut);
    rerender([...fanOut, ...failed("a3", "Policies page", T0 + 4_000), stop("a1", T0 + 60_000), stop("a2", T0 + 90_000)]);
    const s = strip()!;
    // Mutant: keep listing the rows after the last one stops — a finished fan-out stays a wall.
    expect(within(s).queryAllByRole("listitem")).toHaveLength(0);
    const head = within(s).getByRole("button", { name: "3 sub-agents finished · 1 failed" });
    fireEvent.click(head);
    await waitFor(() => expect(api.calls).toContain(`agentsTab:${LEAD}`));
  });

  it("is about the latest turn: a new message that starts none leaves no strip behind", async () => {
    const done = [...fanOut, stop("a1", T0 + 60_000), stop("a2", T0 + 90_000)];
    const { rerender } = await mount(done);
    expect(strip()).not.toBeNull();
    rerender([...done, ask("Thanks — ship it", T0 + 100_000), said("Shipping.", T0 + 101_000)]);
    // Mutant: show every sub-agent the session ever had — a strip that never leaves.
    expect(strip()).toBeNull();
  });

  it("keeps a still-working agent from an earlier turn in the strip after a new message", async () => {
    const { rerender } = await mount(fanOut);
    rerender([...fanOut, stop("a1", T0 + 60_000), ask("How is the game going?", T0 + 100_000), said("Still on it.", T0 + 101_000)]);
    const s = strip()!;
    expect(within(s).getByRole("button", { name: /^1 sub-agent working/ })).toBeInTheDocument();
    expect(within(s).getByRole("button", { name: /^Realmite runner game\./ })).toBeInTheDocument();
  });

  it("draws nothing for a session with no sub-agents", async () => {
    await mount([ask("hi", T0), said("hello", T0 + 1)]);
    expect(strip()).toBeNull();
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

describe("stripHeadline", () => {
  it("leads with what is working, then what needs you, then how the rest ended", () => {
    expect(stripHeadline(["working", "working"])).toBe("2 sub-agents working");
    expect(stripHeadline(["working", "waiting", "done"])).toBe("1 sub-agent working · 1 needs you · 1 done");
    expect(stripHeadline(["waiting", "waiting"])).toBe("2 sub-agents need you");
    expect(stripHeadline(["done", "failed", "stopped"])).toBe("3 sub-agents finished · 1 failed · 1 stopped");
    expect(stripHeadline(["done"])).toBe("1 sub-agent finished");
  });
});
