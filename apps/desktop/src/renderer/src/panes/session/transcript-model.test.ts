import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { blockKey, emptyTranscript, markArrivalAtRest, reduceAll, reduceTranscript, type Transcript } from "./transcript-model";

describe("a plan the agent proposed", () => {
  const plan = (planId: string, payload: { text?: string; steps?: { text: string; status: "pending" | "in_progress" | "completed" }[] }, ts: number) =>
    sessionEvent("plan", { planId, ...payload }, ts);

  it("carries prose and checklist independently — neither is derived from the other", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, plan("p1", { text: "# Do it" }, 10));
    expect(t.blocks.at(-1)).toEqual({ kind: "plan", planId: "p1", text: "# Do it", ts: 10 });
    // A checklist-only plan must not grow an empty `text`: Claude sends no steps and Codex's
    // turn/plan/updated sends no prose, and inventing the missing half is the whole failure mode.
    t = reduceTranscript(t, plan("p2", { steps: [{ text: "Read the spec", status: "completed" }] }, 20));
    expect(t.blocks.at(-1)).toEqual({ kind: "plan", planId: "p2", steps: [{ text: "Read the spec", status: "completed" }], ts: 20 });
    expect(t.blocks.at(-1)).not.toHaveProperty("text");
  });

  it("replaces a revised plan in place instead of stacking a second card", () => {
    // The mutant: `blocks.push(block)` unconditionally. Codex re-sends the whole plan on every
    // turn/plan/updated and ACP's plan is explicitly "not incremental", so an agent that revises
    // three times would leave four cards saying almost the same thing.
    let t = emptyTranscript();
    t = reduceTranscript(t, plan("p1", { steps: [{ text: "A", status: "pending" }] }, 10));
    t = reduceTranscript(t, sessionEvent("assistant_text", { messageId: "m1", text: "working" }, 15));
    t = reduceTranscript(t, plan("p1", { steps: [{ text: "A", status: "completed" }, { text: "B", status: "in_progress" }] }, 30));
    expect(t.blocks.filter((b) => b.kind === "plan")).toHaveLength(1);
    expect(t.blocks[0]).toMatchObject({ kind: "plan", steps: [{ text: "A", status: "completed" }, { text: "B", status: "in_progress" }] });
    // In its original place, and dated from when it first appeared: the card the reader has been
    // watching must not jump ahead of the message that was written after it.
    expect(t.blocks.map((b) => b.kind)).toEqual(["plan", "assistant"]);
    expect(t.blocks[0]).toMatchObject({ ts: 10 });
  });

  it("keeps a different plan id as its own card", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, plan("p1", { text: "first" }, 10));
    t = reduceTranscript(t, plan("p2", { text: "second" }, 20));
    expect(t.blocks.filter((b) => b.kind === "plan")).toHaveLength(2);
  });

  it("keys the block on its plan id, so a revision never replays the entrance animation", () => {
    // The mutant: letting plan fall through to the positional `${kind}:${i}` key. A plan whose index
    // shifts (an interjected message landing before it) would then remount and animate in again.
    const block = { kind: "plan" as const, planId: "p1", text: "x", ts: 1 };
    expect(blockKey(block, 3)).toBe("plan:p1");
    expect(blockKey(block, 7)).toBe("plan:p1");
  });

});

describe("an ACP call's own account of itself", () => {
  it("carries the kind and the files it named onto the block, and nothing for a call that stated neither", () => {
    const t = reduceAll([
      sessionEvent("tool_call", { toolUseId: "c1", name: "Editing orgs.ts", input: {}, parentToolUseId: null, kind: "edit", paths: ["/w/orgs.ts"] }),
      sessionEvent("tool_call", { toolUseId: "c2", name: "Edit", input: { file_path: "/w/a.ts" }, parentToolUseId: null }),
    ]);
    expect(t.blocks[0]).toMatchObject({ toolKind: "edit", paths: ["/w/orgs.ts"] });
    expect(t.blocks[1]).not.toHaveProperty("toolKind");
    expect(t.blocks[1]).not.toHaveProperty("paths");
  });
});

describe("a tool call a sub-agent made", () => {
  it("carries `parentToolUseId` onto the block, and leaves it absent for a call the agent made itself", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("tool_call", { toolUseId: "t1", name: "Task", input: {}, parentToolUseId: null }));
    // Absence is the ordinary case, and the adapters that report no hierarchy send null forever.
    expect(t.blocks.at(-1)).not.toHaveProperty("parentToolUseId");
    t = reduceTranscript(t, sessionEvent("tool_call", { toolUseId: "t2", name: "Read", input: {}, parentToolUseId: "t1" }));
    // Kills the reducer dropping the field: the pane then has nothing to nest by and renders the
    // sub-agent's calls flat among the agent's own, which is what it did before.
    expect(t.blocks.at(-1)).toMatchObject({ kind: "tool", toolUseId: "t2", parentToolUseId: "t1" });
  });
});

describe("transcript model", () => {
  it("builds blocks: user, assistant (deltas then final), tool with result, permission pending→resolved", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("user_message", { text: "hi", attachments: [] }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m1", delta: "He" }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m1", delta: "llo" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    t = reduceTranscript(t, sessionEvent("assistant_text", { messageId: "m1", text: "Hello" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: false });
    expect(t.blocks).toHaveLength(2);
    t = reduceTranscript(t, sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls" }, parentToolUseId: null }));
    t = reduceTranscript(t, sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }));
    expect(t.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    const same = reduceTranscript(t, sessionEvent("permission_response", { requestId: "other", decision: "allow" }));
    expect(same).toBe(t);
    t = reduceTranscript(t, sessionEvent("permission_response", { requestId: "r1", decision: "allow" }));
    expect(t.pendingPermissions).toEqual([]);
    t = reduceTranscript(t, sessionEvent("tool_result", { toolUseId: "t1", content: "a b", isError: false }));
    const tool = t.blocks.find((b) => b.kind === "tool")!;
    expect(tool.kind === "tool" && tool.result?.content).toBe("a b");
    t = reduceTranscript(t, sessionEvent("usage", { costUsd: 0.5, inputTokens: 1, outputTokens: 2, numTurns: 1 }));
    expect(t.usage.costUsd).toBe(0.5);
    t = reduceTranscript(t, sessionEvent("init", { providerSessionId: "p", model: "m", tools: ["Bash"], cwd: "/x" }));
    expect(t.init).toEqual({ providerSessionId: "p", model: "m", tools: ["Bash"] });
    // No `running` ever opened a clock here, so the settle closes the turn from the outside (see
    // "still closes a turn that failed before its agent ever reported running") — once.
    t = reduceTranscript(t, sessionEvent("status", { status: "idle" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "run", derived: true });
    const settled = t;
    expect(reduceTranscript(t, sessionEvent("status", { status: "idle" }))).toBe(settled);
  });
  it("tracks concurrent permission requests and resolves them in either order", () => {
    const req = (id: string) => sessionEvent("permission_request", { requestId: id, toolName: "Bash", input: { command: id }, title: `Run ${id}?`, suggestions: [] });
    const res = (id: string) => sessionEvent("permission_response", { requestId: id, decision: "allow" });
    let t = reduceAll([req("r1"), req("r2")]);
    expect(t.pendingPermissions.map((p) => p.requestId)).toEqual(["r1", "r2"]);
    const a = reduceAll([res("r2"), res("r1")], t);
    expect(a.pendingPermissions).toEqual([]);
    const b = reduceTranscript(t, res("r1"));
    expect(b.pendingPermissions.map((p) => p.requestId)).toEqual(["r2"]);
    t = reduceTranscript(b, req("r2")); // duplicate request id replaces, doesn't double
    expect(t.pendingPermissions.map((p) => p.requestId)).toEqual(["r2"]);
  });
  it("assistant_delta after final text starts a new block", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("assistant_text", { messageId: "m1", text: "A" }));
    t = reduceTranscript(t, sessionEvent("assistant_delta", { messageId: "m2", delta: "B" }));
    expect(t.blocks.filter((b) => b.kind === "assistant")).toHaveLength(2);
  });
  it("assistant_text without prior deltas appends; thinking and error blocks; tool_result for unknown tool is ignored", () => {
    const t = reduceAll([
      sessionEvent("thinking", { messageId: "m1", text: "hmm" }),
      sessionEvent("assistant_text", { messageId: "m1", text: "A" }),
      sessionEvent("tool_result", { toolUseId: "nope", content: "x", isError: true }),
      sessionEvent("error", { message: "bad" }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["thinking", "assistant", "error"]);
  });
  it("does not mutate the input transcript", () => {
    const a = emptyTranscript();
    const b = reduceTranscript(a, sessionEvent("user_message", { text: "x", attachments: [] }));
    expect(a.blocks).toHaveLength(0); expect(b.blocks).toHaveLength(1);
  });
});

describe("how long the run worked", () => {
  const status = (s: "idle" | "running" | "waiting_permission" | "error" | "ended", ts: number) => sessionEvent("status", { status: s }, ts);
  const runBlocks = (t: ReturnType<typeof emptyTranscript>) => t.blocks.filter((b) => b.kind === "run");

  it("banks a run block when the run settles, spanning running→idle", () => {
    const t = reduceAll([status("running", 1_000), status("idle", 13_500)]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 12_500, startedAt: 1_000, ts: 13_500 }]);
    expect(t.run).toBeNull();
  });

  it("subtracts the time the run sat on a permission prompt", () => {
    // Wall clock says 100s. The user was away for 90 of them with an Allow button on screen, and
    // "Cooked for 1m 40s" would be crediting the agent with the user's coffee break.
    const t = reduceAll([
      status("running", 0), status("waiting_permission", 5_000), status("running", 95_000), status("idle", 100_000),
    ]);
    expect(runBlocks(t)).toMatchObject([{ ms: 10_000 }]);
  });

  it("does not restart the clock when a second `running` lands inside an open run", () => {
    // The adapter re-announces `running` when the last pending permission clears, and again when the
    // user queues another message mid-run. Either one restarting the span would report only the tail.
    const t = reduceAll([status("running", 0), status("running", 30_000), status("idle", 40_000)]);
    expect(runBlocks(t)).toMatchObject([{ ms: 40_000, startedAt: 0 }]);
  });

  it("reports nothing for a status that closes no run", () => {
    // An adapter says `idle` when it boots and `ended` after the idle that closed the last turn.
    // Both would otherwise bank a run dated from the epoch.
    const boot = reduceAll([status("idle", 500), status("ended", 900)]);
    expect(boot.blocks).toEqual([]);
    const after = reduceAll([status("running", 0), status("idle", 1_000), status("ended", 2_000)]);
    expect(runBlocks(after)).toHaveLength(1);
  });

  it("settles on error and on ended, not only on idle", () => {
    expect(runBlocks(reduceAll([status("running", 0), status("error", 3_000)]))).toMatchObject([{ ms: 3_000 }]);
    expect(runBlocks(reduceAll([status("running", 0), status("ended", 3_000)]))).toMatchObject([{ ms: 3_000 }]);
  });

  it("counts a run the crash left open only from its own start, once the log terminates it", () => {
    // markStaleOnBoot backdates a synthetic idle to the last event the log has. Without it the next
    // turn's settle would report a span reaching back across however long the app was shut down.
    const t = reduceAll([status("running", 1_000), status("idle", 2_000), status("running", 9_000_000), status("idle", 9_004_000)]);
    expect(runBlocks(t)).toMatchObject([{ ms: 1_000 }, { ms: 4_000 }]);
  });

  it("marks a run that ended on a failure as failed, whichever way the harness settled it", () => {
    // Claude settles a failed turn with `status: error`; the scripted agent says `error` and then
    // `idle`. Both are a turn that did not finish, and "Simmered for 4s" under either would say it did.
    expect(runBlocks(reduceAll([status("running", 0), status("error", 3_000)]))).toEqual([
      { kind: "run", ms: 3_000, startedAt: 0, ts: 3_000, failed: true }]);
    const t = reduceAll([status("running", 0), sessionEvent("error", { message: "boom" }, 2_000), status("idle", 2_100)]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 2_100, startedAt: 0, ts: 2_100, failed: true }]);
    // An ordinary settle is not a failure.
    expect(runBlocks(reduceAll([status("running", 0), status("idle", 3_000)]))[0]).not.toHaveProperty("failed");
  });

  it("calls a turn the user stopped stopped, even when the harness reported the abort as an error", () => {
    const t = reduceAll([status("running", 0), sessionEvent("error", { message: "aborted" }, 900),
      sessionEvent("status", { status: "idle", interrupted: true }, 1_000)]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 1_000, startedAt: 0, ts: 1_000, stopped: true }]);
  });

  it("still closes a turn that failed before its agent ever reported running", () => {
    // A CLI that will not start says so and settles without a `running` ever opening a clock. The
    // turn still has two real moments — the message and the failure — and they are what it says.
    const t = reduceAll([
      sessionEvent("user_message", { text: "go", attachments: [] }, 1_000),
      status("idle", 1_100),
      sessionEvent("error", { message: "claude: command not found" }, 1_500),
      status("error", 1_600),
      status("ended", 60_000),
    ]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 500, startedAt: 1_000, ts: 1_500, derived: true, failed: true }]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "error", "run"]);
  });

  it("closes an unsettled turn when the next message arrives, at the last thing it produced", () => {
    const t = reduceAll([
      sessionEvent("user_message", { text: "go", attachments: [] }, 1_000),
      sessionEvent("error", { message: "session ended" }, 2_000),
      sessionEvent("user_message", { text: "again", attachments: [] }, 9_000),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "error", "run", "user"]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 1_000, startedAt: 1_000, ts: 2_000, derived: true, failed: true }]);
  });

  it("invents no line for a turn that produced nothing, or that already has one", () => {
    // The boot `idle` lands after the message that started the adapter, with nothing said yet.
    const quiet = reduceAll([sessionEvent("user_message", { text: "go", attachments: [] }, 1_000), status("idle", 1_100),
      sessionEvent("user_message", { text: "again", attachments: [] }, 2_000)]);
    expect(runBlocks(quiet)).toEqual([]);
    const settled = reduceAll([sessionEvent("user_message", { text: "go", attachments: [] }, 1_000), status("running", 1_100),
      sessionEvent("assistant_text", { messageId: "m", text: "done" }, 1_500), status("idle", 1_600), status("ended", 5_000),
      sessionEvent("user_message", { text: "again", attachments: [] }, 9_000)]);
    expect(runBlocks(settled)).toHaveLength(1);
  });
});

/**
 * The wait the adapter says while a card is open and no turn is in flight: a background run's agent
 * asked for a tool between turns. A turn can then begin under that card, when the harness starts a
 * report turn by itself or the person types a message. For the whole of such a turn the adapter
 * says the wait again without the mark. It says `running` only if the card is answered before the
 * turn ends.
 */
const atRest = (ts: number) => sessionEvent("status", { status: "waiting_permission", betweenTurns: true }, ts);

describe("a turn that starts under a card open between turns", () => {
  const status = (s: "idle" | "running" | "waiting_permission" | "error" | "ended", ts: number) => sessionEvent("status", { status: s }, ts);
  const said = (text: string, ts: number) => sessionEvent("assistant_text", { messageId: text, text }, ts);
  const call = (id: string, ts: number, parentToolUseId: string | null = null) =>
    sessionEvent("tool_call", { toolUseId: id, name: "Bash", input: { command: id }, parentToolUseId }, ts);
  const runBlocks = (t: ReturnType<typeof emptyTranscript>) => t.blocks.filter((b) => b.kind === "run");
  const before = [sessionEvent("user_message", { text: "launch it", attachments: [] }, 1_000), status("running", 1_100), said("launched", 1_500), status("idle", 2_000)];

  it("gives a turn that opened under a card between turns its own run line", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("the report", 5_000), status("idle", 9_000)]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "run", "assistant", "run"]);
    expect(runBlocks(t)[1]).toMatchObject({ startedAt: 4_000 });
    expect(t.run).toBeNull();
  });

  it("measures a turn that ended under the card to its last output, not to the card's answer", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("the report", 5_000), call("b1", 6_000), status("idle", 3_600_000)]);
    expect(runBlocks(t)[1]).toMatchObject({ ms: 2_000, startedAt: 4_000 });
  });

  it("dates that turn's line at the settle, the time the server files the turn's changes under", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("the report", 5_000), status("idle", 3_600_000)]);
    expect(runBlocks(t)[1]).toMatchObject({ ts: 3_600_000 });
    expect(runBlocks(t)[1]).not.toHaveProperty("derived");
  });

  it("measures a turn whose card was answered first to the settle, from where the turn opened", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("half", 5_000), status("running", 6_000), said("done", 7_000), status("idle", 9_000)]);
    expect(runBlocks(t)[1]).toEqual({ kind: "run", ms: 5_000, startedAt: 4_000, ts: 9_000 });
  });

  it("takes off a wait of the turn's own that began after the card it opened under was answered", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), status("running", 6_000),
      status("waiting_permission", 7_000), status("running", 8_500), said("done", 8_800), status("idle", 9_000)]);
    expect(runBlocks(t)[1]).toMatchObject({ ms: 3_500, startedAt: 4_000 });
  });

  it("banks no line for an unmarked wait that no output followed", () => {
    const settled = reduceAll(before);
    const t = reduceAll([status("waiting_permission", 3_000), status("idle", 4_000)], settled);
    expect(t.blocks).toEqual(settled.blocks);
    expect(t.run).toBeNull();
  });

  it("takes a background sub-agent's own call for no output of the turn, since it arrives with no turn in flight", () => {
    const t = reduceAll([...before, status("waiting_permission", 3_000), call("n1", 3_500, "a1"), status("idle", 4_000)]);
    expect(runBlocks(t)).toHaveLength(1);
  });

  it("counts nothing the agent said before the wait as output that followed it", () => {
    const t = reduceAll([sessionEvent("user_message", { text: "go", attachments: [] }, 1_000), said("an answer that never settled", 1_500),
      status("waiting_permission", 3_000), status("idle", 4_000)]);
    expect(runBlocks(t)).toEqual([{ kind: "run", ms: 500, startedAt: 1_000, ts: 1_500, derived: true }]);
  });

  it("opens no run on a wait marked between turns", () => {
    const t = reduceAll([...before, atRest(3_000), said("stray", 3_500), sessionEvent("status", { status: "idle", betweenTurns: true }, 4_000)]);
    expect(runBlocks(t)).toHaveLength(1);
    expect(t.run).toBeNull();
  });

  it("calls a turn stopped under the card stopped, measured to its last output", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("half", 5_000),
      sessionEvent("status", { status: "idle", interrupted: true }, 9_000)]);
    expect(runBlocks(t)[1]).toEqual({ kind: "run", ms: 1_000, startedAt: 4_000, ts: 9_000, stopped: true });
  });

  it("ignores a wait raised under the card when the turn ends under it", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("half", 5_000),
      status("waiting_permission", 6_000), said("done", 8_000), status("idle", 3_600_000)]);
    expect(runBlocks(t)[1]).toEqual({ kind: "run", ms: 4_000, startedAt: 4_000, ts: 3_600_000 });
  });

  it("gives a turn that ends under the card with its process its line", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("the report", 5_000), status("ended", 9_000)]);
    expect(runBlocks(t)[1]).toEqual({ kind: "run", ms: 1_000, startedAt: 4_000, ts: 9_000 });
  });

  it("takes off a wait raised under the card when the card the turn opened under is answered first", () => {
    const t = reduceAll([...before, atRest(3_000), status("waiting_permission", 4_000), said("half", 5_000),
      status("waiting_permission", 6_000), status("running", 7_500), said("done", 8_000), status("idle", 9_000)]);
    expect(runBlocks(t)[1]).toEqual({ kind: "run", ms: 3_500, startedAt: 4_000, ts: 9_000 });
  });
});

describe("a request that arrives with no turn in flight", () => {
  const status = (s: "idle" | "running" | "waiting_permission", ts: number) => sessionEvent("status", { status: s }, ts);
  const request = sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "touch probe.txt" }, title: "Allow Bash?", suggestions: [] }, 3_100);
  const settled = [sessionEvent("user_message", { text: "launch it", attachments: [] }, 1_000), status("running", 1_100), status("idle", 2_000)];

  const arrive = (before: Transcript) => markArrivalAtRest(before, reduceTranscript(before, request), request);

  it("is marked as arrived at rest when the wait marked between turns comes first, as the adapter sends the two", () => {
    expect(arrive(reduceAll([...settled, atRest(3_000)])).pendingPermissions[0]).toHaveProperty("atRest", true);
  });

  it("is marked as arrived at rest when it comes ahead of its wait, as the server's broker sends the two", () => {
    expect(reduceTranscript(arrive(reduceAll(settled)), atRest(3_200)).pendingPermissions[0]).toHaveProperty("atRest", true);
  });

  it("is not marked when it arrives in a turn", () => {
    const t = arrive(reduceAll([sessionEvent("user_message", { text: "go", attachments: [] }, 1_000), status("running", 1_100), status("waiting_permission", 3_000)]));
    expect(t.pendingPermissions[0]).not.toHaveProperty("atRest");
  });

  it("is not marked when it is read back from the log, where the person opens a session to answer it", () => {
    expect(reduceAll([...settled, atRest(3_000), request]).pendingPermissions[0]).not.toHaveProperty("atRest");
  });

  it("marks the request that arrived and no other", () => {
    const earlier = sessionEvent("permission_request", { requestId: "r0", toolName: "Bash", input: { command: "ls" }, title: "Allow Bash?", suggestions: [] }, 1_200);
    const t = arrive(reduceAll([sessionEvent("user_message", { text: "go", attachments: [] }, 1_000), status("running", 1_100), earlier, status("idle", 2_000)]));
    expect(t.pendingPermissions.map((p) => p.atRest)).toEqual([undefined, true]);
  });
});

describe("the between-turns mark the prompter reads off the last status", () => {
  const status = (s: "idle" | "running" | "waiting_permission", ts: number) => sessionEvent("status", { status: s }, ts);
  const card = sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] });

  it("is set by a status event that carries it", () => {
    expect(reduceAll([atRest(1)]).betweenTurns).toBe(true);
  });

  it("stays through the idle that closes the card, which carries it too", () => {
    expect(reduceAll([atRest(1), sessionEvent("status", { status: "idle", betweenTurns: true }, 2)]).betweenTurns).toBe(true);
  });

  it("stays through the events that are not statuses", () => {
    const t = reduceAll([atRest(1), card, sessionEvent("assistant_delta", { messageId: "m1", delta: "He" }), sessionEvent("permission_response", { requestId: "r1", decision: "allow" })]);
    expect(t.betweenTurns).toBe(true);
  });

  it.each(["waiting_permission", "running", "idle"] as const)("is gone at the next status event that does not carry it, a plain %s", (next) => {
    expect(reduceAll([atRest(1), status(next, 2)])).not.toHaveProperty("betweenTurns");
  });

  it("is never set on a transcript whose statuses never carried it", () => {
    const t = reduceAll([status("running", 0), status("waiting_permission", 1), status("running", 2), status("idle", 3)]);
    expect(t).not.toHaveProperty("betweenTurns");
  });

  it("leaves the transcript the same object when a status changes neither the run nor the mark", () => {
    const t = reduceAll([status("running", 0), status("idle", 3)]);
    expect(reduceTranscript(t, status("idle", 4))).toBe(t);
    const marked = reduceAll([atRest(1)]);
    expect(reduceTranscript(marked, atRest(2))).toBe(marked);
  });
});

describe("feedback", () => {
  const rate = (messageId: string, rating: "up" | "down" | null) => sessionEvent("feedback", { messageId, rating });

  it("lets the reader change their mind, and take the verdict back entirely", () => {
    // Three states, not two: absent is "not judged", which a boolean could not tell from "down".
    const up = reduceAll([rate("m1", "up")]);
    expect(up.feedback).toEqual({ m1: "up" });
    const down = reduceAll([rate("m1", "up"), rate("m1", "down")]);
    expect(down.feedback).toEqual({ m1: "down" });
    const withdrawn = reduceAll([rate("m1", "up"), rate("m1", null)]);
    expect(withdrawn.feedback).toEqual({});
  });

  it("never touches the blocks — a verdict is about a message, not a thing in the scrollback", () => {
    const before = reduceAll([sessionEvent("assistant_text", { messageId: "m1", text: "hello" })]);
    const after = reduceTranscript(before, rate("m1", "up"));
    expect(after.blocks).toBe(before.blocks);
  });
});

describe("what the window is carrying", () => {
  const usage = (over: Record<string, unknown> = {}) =>
    sessionEvent("usage", { costUsd: 1, inputTokens: 10, outputTokens: 2, numTurns: 1, ...over });

  it("keeps the last measurement when the next turn's usage states none", () => {
    // The adapter pushes the result's four numbers straight away and restates them a beat later with
    // the measurement (claude-adapter.ts `reportContextUsage`). Replacing wholesale would blank the
    // ring in that gap — a meter flickering off and on after every single turn. Occupancy does not
    // reset between turns, so the last measurement is still the last true thing known about it.
    let t = emptyTranscript();
    t = reduceTranscript(t, usage({ contextTokens: 40_000, contextWindow: 200_000 }));
    t = reduceTranscript(t, usage({ costUsd: 2, numTurns: 2 }));
    expect(t.usage).toMatchObject({ costUsd: 2, numTurns: 2, contextTokens: 40_000, contextWindow: 200_000 });
  });

  it("takes a new measurement over the old one, downward included", () => {
    // The mutant: keeping the higher of the two, or carrying unconditionally. A window that has been
    // trimmed must be allowed to report as trimmed.
    let t = emptyTranscript();
    t = reduceTranscript(t, usage({ contextTokens: 190_000, contextWindow: 200_000 }));
    t = reduceTranscript(t, usage({ contextTokens: 31_000, contextWindow: 200_000 }));
    expect(t.usage.contextTokens).toBe(31_000);
  });

  it("carries nothing at all when nothing was ever measured", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, usage());
    expect(t.usage).not.toHaveProperty("contextTokens");
    expect(t.usage).not.toHaveProperty("contextWindow");
  });
});

describe("a conversation the harness summarised and dropped", () => {
  it("banks the seam and drops the meter to what the window now holds", () => {
    // Without the seam the transcript still shows every message the agent can no longer see, and the
    // meter would keep reporting the pre-compaction figure until the NEXT turn measured again —
    // which on a long turn is minutes of a number known to be wrong.
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("usage", { costUsd: 1, inputTokens: 1, outputTokens: 1, numTurns: 4, contextTokens: 186_000, contextWindow: 200_000 }));
    t = reduceTranscript(t, sessionEvent("compacted", { trigger: "auto", preTokens: 186_000, postTokens: 34_000 }, 500));
    expect(t.blocks.at(-1)).toEqual({ kind: "compacted", preTokens: 186_000, postTokens: 34_000, ts: 500 });
    expect(t.usage.contextTokens).toBe(34_000);
    // The window did not change — only what is in it.
    expect(t.usage.contextWindow).toBe(200_000);
  });

  it("leaves the meter alone when the harness did not say what is left", () => {
    // The mutant: `postTokens ?? 0`, which would empty the ring on a build that simply does not
    // report the after-figure.
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("usage", { costUsd: 1, inputTokens: 1, outputTokens: 1, numTurns: 4, contextTokens: 186_000 }));
    t = reduceTranscript(t, sessionEvent("compacted", { trigger: "auto", preTokens: 186_000 }, 500));
    expect(t.usage.contextTokens).toBe(186_000);
    expect(t.blocks.at(-1)).not.toHaveProperty("postTokens");
  });
});

describe("a session that changed agents mid-turn", () => {
  const retrying = (attempt: number) => sessionEvent("retrying", { reason: "transient", attempt, waitMs: 1000 });

  it("banks the seam where it happened, so a reader can see whose voice is whose", () => {
    // The whole point of persisting a handoff: everything above is one agent and everything below is
    // another, and without the line a reader is left comparing two voices and guessing.
    const t = reduceAll([
      sessionEvent("assistant_text", { messageId: "m1", text: "from Claude" }),
      sessionEvent("handoff", { from: "claude", to: "codex", reason: "usage_limit", note: "Claude hit its usage limit. Continuing on Codex.", attempt: 0 }),
      sessionEvent("assistant_text", { messageId: "m2", text: "from Codex" }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["assistant", "handoff", "assistant"]);
    expect(t.blocks[1]).toMatchObject({ kind: "handoff", from: "claude", to: "codex", attempt: 0 });
  });

  it("replaces the retry line rather than stacking it", () => {
    // Attempt 2 says what attempt 1 said, one number later. A transcript that keeps every one of
    // them is a transcript reporting the wait instead of the work.
    const t = reduceAll([retrying(1), retrying(2), retrying(3)]);
    expect(t.blocks).toHaveLength(1);
    expect(t.blocks[0]).toMatchObject({ kind: "retrying", attempt: 3 });
  });

  it("draws the recovery INSTEAD of the failure it recovered from", () => {
    // "Claude hit its usage limit" as a red alert, directly above "Claude hit its usage limit,
    // continuing on Codex", tells the reader twice — and the first telling says the turn failed
    // when it did not. Both events are still persisted; only one of them is drawn.
    const t = reduceAll([
      sessionEvent("error", { message: "Claude AI usage limit reached|123" }),
      sessionEvent("handoff", { from: "claude", to: "codex", reason: "usage_limit", note: "n", attempt: 0 }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["handoff"]);
  });

  it("keeps the failure when the ladder runs out — that one IS final", () => {
    // The other direction, and the reason the rule is symmetric rather than one-way: after the last
    // retry fails there is no recovery to supersede it, and swallowing it would leave a transcript
    // whose last word was "Retrying…" for a turn that stopped.
    const t = reduceAll([retrying(3), sessionEvent("error", { message: "socket hang up" })]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["error"]);
  });

  it("never reaches back past the turn it is in", () => {
    // Trailing only. An error from an earlier turn is that turn's history, and a later turn's
    // recovery must not erase it.
    const t = reduceAll([
      sessionEvent("error", { message: "an old, unrelated failure" }),
      sessionEvent("assistant_text", { messageId: "m1", text: "then we carried on" }),
      sessionEvent("error", { message: "usage limit reached" }),
      sessionEvent("handoff", { from: "claude", to: "codex", reason: "usage_limit", note: "n", attempt: 0 }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["error", "assistant", "handoff"]);
    expect(t.blocks[0]).toMatchObject({ message: "an old, unrelated failure" });
  });

  it("clears the pending retry when the handoff lands", () => {
    // The waiting is over — it just did not end the way the line above it was predicting. Leaving
    // "Retrying…" above "Continuing on Codex" would show two contradictory promises at once.
    const t = reduceAll([
      retrying(1),
      sessionEvent("handoff", { from: "claude", to: "codex", reason: "usage_limit", note: "n", attempt: 1 }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["handoff"]);
  });

});

describe("a background sub-agent's start and stop", () => {
  const tool = (id: string, name: string) => sessionEvent("tool_call", { toolUseId: id, name, input: {}, parentToolUseId: null });

  it("marks the launching call running, then stopped", () => {
    const t = reduceAll([
      tool("t1", "Agent"),
      sessionEvent("background_task", { toolUseId: "t1", status: "running" }),
    ]);
    expect(t.blocks.find((b) => b.kind === "tool" && b.toolUseId === "t1")).toMatchObject({ background: "running" });
    const done = reduceAll([
      tool("t1", "Agent"),
      sessionEvent("background_task", { toolUseId: "t1", status: "running" }),
      sessionEvent("background_task", { toolUseId: "t1", status: "stopped", summary: "done" }),
    ]);
    expect(done.blocks.find((b) => b.kind === "tool" && b.toolUseId === "t1")).toMatchObject({ background: "stopped" });
  });

  it("ignores a stop for a call that was never running — the sub-agent's own shell command", () => {
    /* The harness notifies about EVERY task it finishes, including the `sleep` a background agent
       ran inside itself, and that notification names the Bash call's real tool_use_id. Marking that
       block would be recording an agent's end on a call that never had an agent behind it. */
    const t = reduceAll([
      tool("b1", "Bash"),
      sessionEvent("background_task", { toolUseId: "b1", status: "stopped", summary: "Sleep for 12 seconds" }),
    ]);
    expect(t.blocks.find((b) => b.kind === "tool" && b.toolUseId === "b1")).not.toHaveProperty("background");
  });

  it("ignores a task naming a call this transcript never saw", () => {
    const t = reduceAll([tool("t1", "Agent"), sessionEvent("background_task", { toolUseId: "nope", status: "running" })]);
    expect(t.blocks).toHaveLength(1);
  });

  it("keeps how the run ended on the launching call, in the harness's own word", () => {
    for (const outcome of ["completed", "failed", "stopped"] as const) {
      const t = reduceAll([
        tool("w1", "Workflow"),
        sessionEvent("background_task", { toolUseId: "w1", status: "running" }),
        sessionEvent("background_task", { toolUseId: "w1", status: "stopped", outcome }),
      ]);
      expect(t.blocks.find((b) => b.kind === "tool" && b.toolUseId === "w1")).toMatchObject({ background: "stopped", outcome });
    }
  });

  it("keeps no outcome for a stop that carried none, and none while the run works", () => {
    const running = reduceAll([tool("w1", "Workflow"), sessionEvent("background_task", { toolUseId: "w1", status: "running" })]);
    expect(running.blocks[0]).not.toHaveProperty("outcome");
    const stopped = reduceTranscript(running, sessionEvent("background_task", { toolUseId: "w1", status: "stopped" }));
    expect(stopped.blocks[0]).toMatchObject({ background: "stopped" });
    expect(stopped.blocks[0]).not.toHaveProperty("outcome");
  });

  it("forgets how an earlier run ended when the same call is announced running again", () => {
    const t = reduceAll([
      tool("a1", "Agent"),
      sessionEvent("background_task", { toolUseId: "a1", status: "running" }),
      sessionEvent("background_task", { toolUseId: "a1", status: "stopped", outcome: "failed" }),
      sessionEvent("background_task", { toolUseId: "a1", status: "running" }),
    ]);
    expect(t.blocks[0]).toMatchObject({ background: "running" });
    expect(t.blocks[0]).not.toHaveProperty("outcome");
  });
});

describe("a request's once mark", () => {
  const request = (over: Record<string, unknown> = {}) =>
    sessionEvent("permission_request", { requestId: "r1", toolName: "Workflow", input: { script: "return 1" }, title: "Allow Workflow?", suggestions: [], ...over });

  it("is carried to the card that will draw the request", () => {
    expect(reduceAll([request({ once: true })]).pendingPermissions).toEqual([
      { requestId: "r1", toolName: "Workflow", input: { script: "return 1" }, title: "Allow Workflow?", once: true },
    ]);
  });

  it("is added to no request that did not carry it, whatever its suggestions hold", () => {
    expect(reduceAll([request()]).pendingPermissions[0]).not.toHaveProperty("once");
    expect(reduceAll([request({ suggestions: [{ type: "addRules" }] })]).pendingPermissions[0]).not.toHaveProperty("once");
  });
});

/**
 * The generated prompt hint on the transcript.
 *
 * Two rules, and the second is the one that keeps ⇥ from typing a stale sentence: the hint was
 * written about the turn that had just ended, so the moment the user sends anything it stops being
 * about the last turn and has to go.
 */
describe("the prompt hint", () => {
  const hint = (text: string, throughSeq: number) => sessionEvent("prompt_hint", { text, throughSeq });

  it("takes the newest hint, and never an older one arriving late", () => {
    // Same forward-only rule the summary has: on a slow machine a hint generated for an earlier turn
    // can land after a newer one, and the newer answer is the one about the transcript on screen.
    const t = reduceAll([hint("newer", 9), hint("older", 4)]);
    expect(t.promptHint).toEqual({ text: "newer", throughSeq: 9 });
  });

  it("is dropped the moment the user sends anything", () => {
    const t = reduceAll([
      sessionEvent("user_message", { text: "go", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: "done" }),
      hint("Write tests for it.", 2),
      sessionEvent("user_message", { text: "actually do this", attachments: [] }),
    ]);
    /* The mutant: keeping it here. The prompter would offer "Write tests for it." under a transcript
       whose last line is a different request, and ⇥ would send it. */
    expect(t.promptHint).toBeNull();
  });

});

describe("a question put to the user", () => {
  const codex = { kind: "agent" as const, name: "Codex", agent: "codex" as const };
  const ask = { asker: codex, mode: "question" as const, questions: [{ id: "base", prompt: "Which branch?", kind: "choice" as const, options: [{ value: "main", label: "main" }] }] };
  const request = (over: Record<string, unknown> = {}, ts = 20) =>
    sessionEvent("permission_request", { requestId: "q1", toolName: "item/tool/requestUserInput", input: {}, title: "Which branch?", suggestions: [], ask, ...over }, ts);
  const answer = (answers?: Record<string, string>) => sessionEvent("permission_response", { requestId: "q1", decision: answers ? "allow" : "deny", ...(answers ? { answers } : {}) }, 30);

  it("keeps its place in the log and takes its answer when the answer arrives", () => {
    // THE MUTANT: leave `permission_response` as it was, clearing the pending card and nothing else.
    // The answer is persisted and never drawn — the gap this block exists to close.
    let t = reduceAll([sessionEvent("assistant_text", { messageId: "m1", text: "Let me ask." }, 10), request()]);
    expect(t.blocks.at(-1)).toMatchObject({ kind: "question", requestId: "q1", card: { asker: codex } });
    expect(t.blocks.at(-1)).not.toHaveProperty("decision");
    t = reduceTranscript(t, answer({ base: "main" }));
    expect(t.blocks.at(-1)).toMatchObject({ kind: "question", decision: "allow", answers: { base: "main" } });
    expect(t.pendingPermissions).toEqual([]);
    expect(blockKey(t.blocks.at(-1)!, 0)).toBe("question:q1");
  });

  it("takes the place of the call that asked it, whichever of the two arrives first", () => {
    const input = { questions: [{ id: "base", prompt: "Which branch?", kind: "choice", options: [{ label: "main" }] }] };
    const call = sessionEvent("tool_call", { toolUseId: "t1", name: "mcp__realm__realm-ui__ui_ask", input, parentToolUseId: null }, 15);
    const asked = request({ toolName: "ui_ask", input });
    for (const events of [[call, asked], [asked, call]]) {
      const t = reduceAll([...events, answer({ base: "main" }), sessionEvent("tool_result", { toolUseId: "t1", content: "The user answered", isError: false })]);
      expect(t.blocks.map((b) => b.kind)).toEqual(["question"]);
      expect(t.blocks[0]).toMatchObject({ toolUseId: "t1", answers: { base: "main" } });
    }
  });

  it("leaves a different call's row alone, and makes no question of a permission", () => {
    const t = reduceAll([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls" }, parentToolUseId: null }),
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["tool"]);
  });

  it("records a skip, and a request Realm declined itself, as answered without answers", () => {
    expect(reduceAll([request(), answer()]).blocks.at(-1)).toMatchObject({ kind: "question", decision: "deny" });
    const refused = reduceAll([request({ ask: { ...ask, mode: "form", refused: "It asked for a password." } }), answer()]);
    expect(refused.blocks.at(-1)).toMatchObject({ kind: "question", card: { refused: "It asked for a password." }, decision: "deny" });
  });
});

describe("a message sent as the person's own input", () => {
  it("keeps the stamp on its block, where Retry reads how the message first went", () => {
    const t = reduceAll([sessionEvent("user_message", { text: "ultracode review this", attachments: [], human: true }, 5)]);
    expect(t.blocks).toEqual([{ kind: "user", text: "ultracode review this", human: true, ts: 5 }]);
  });

  it("puts no stamp on the block of a message that carried none, whatever else the message carried", () => {
    const plain = reduceAll([sessionEvent("user_message", { text: "Implement this plan: Ship it", attachments: [] }, 5)]);
    expect(plain.blocks).toEqual([{ kind: "user", text: "Implement this plan: Ship it", ts: 5 }]);
    const continued = reduceAll([sessionEvent("user_message", { text: "Keep going.", attachments: [], goal: "continuation" }, 5)]);
    expect(continued.blocks[0]).not.toHaveProperty("human");
  });
});

describe("the harness's answer about Ultracode", () => {
  const init = (over: Record<string, unknown> = {}) =>
    sessionEvent("init", { providerSessionId: "p1", model: "claude-opus-5", tools: [], cwd: "/tmp", ...over });

  it("stays on the transcript from the restatement that carries it, a refusal as well as a yes", () => {
    expect(reduceAll([init(), init({ ultracodeAvailable: true })]).init).toMatchObject({ ultracodeAvailable: true });
    expect(reduceAll([init(), init({ ultracodeAvailable: false })]).init).toMatchObject({ ultracodeAvailable: false });
  });

  it("survives a later handshake for the same model that says nothing of it", () => {
    expect(reduceAll([init({ ultracodeAvailable: false }), init()]).init).toMatchObject({ ultracodeAvailable: false });
    expect(reduceAll([init({ ultracodeAvailable: true }), init({ supportsFastMode: true })]).init)
      .toEqual({ providerSessionId: "p1", model: "claude-opus-5", tools: [], supportsFastMode: true, ultracodeAvailable: true });
  });

  it("does not survive a handshake for another model, which that answer was not about", () => {
    expect(reduceAll([init({ ultracodeAvailable: false }), init({ model: "claude-sonnet-5" })]).init).not.toHaveProperty("ultracodeAvailable");
  });

  it("gives way to a later answer for the same model", () => {
    expect(reduceAll([init({ ultracodeAvailable: false }), init({ ultracodeAvailable: true })]).init).toMatchObject({ ultracodeAvailable: true });
    expect(reduceAll([init({ ultracodeAvailable: true }), init({ ultracodeAvailable: false })]).init).toMatchObject({ ultracodeAvailable: false });
  });

  it("stays unstated after a handshake that never said", () => {
    expect(reduceAll([init()]).init).not.toHaveProperty("ultracodeAvailable");
  });
});

describe("the harness's answer about the keyword", () => {
  const init = (over: Record<string, unknown> = {}) =>
    sessionEvent("init", { providerSessionId: "p1", model: "claude-opus-5", tools: [], cwd: "/tmp", ...over });

  it("stays on the transcript from the restatement that carries it, a no as well as a yes", () => {
    expect(reduceAll([init(), init({ ultracodeKeyword: true })]).init).toMatchObject({ ultracodeKeyword: true });
    expect(reduceAll([init(), init({ ultracodeKeyword: false })]).init).toMatchObject({ ultracodeKeyword: false });
  });

  it("is kept beside the answer about Ultracode when one restatement carries both", () => {
    expect(reduceAll([init(), init({ ultracodeAvailable: false, ultracodeKeyword: true })]).init)
      .toEqual({ providerSessionId: "p1", model: "claude-opus-5", tools: [], ultracodeAvailable: false, ultracodeKeyword: true });
  });

  it("survives a later handshake for the same model that says nothing of the keyword", () => {
    expect(reduceAll([init({ ultracodeKeyword: false }), init()]).init).toMatchObject({ ultracodeKeyword: false });
    expect(reduceAll([init({ ultracodeKeyword: true }), init({ supportsFastMode: true })]).init).toMatchObject({ supportsFastMode: true, ultracodeKeyword: true });
  });

  it("does not survive a handshake for another model, on the terms the answer about Ultracode is kept on", () => {
    expect(reduceAll([init({ ultracodeKeyword: false }), init({ model: "claude-sonnet-5" })]).init).not.toHaveProperty("ultracodeKeyword");
  });

  it("gives way to a later answer about the keyword for the same model", () => {
    expect(reduceAll([init({ ultracodeKeyword: false }), init({ ultracodeKeyword: true })]).init).toMatchObject({ ultracodeKeyword: true });
    expect(reduceAll([init({ ultracodeKeyword: true }), init({ ultracodeKeyword: false })]).init).toMatchObject({ ultracodeKeyword: false });
  });

  it("stays unstated about the keyword after a handshake that never said", () => {
    expect(reduceAll([init()]).init).not.toHaveProperty("ultracodeKeyword");
  });
});
