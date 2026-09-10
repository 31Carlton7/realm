import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { blockKey, emptyTranscript, reduceAll, reduceTranscript } from "./transcript-model";

describe("a message another session delivered (Plan 20)", () => {
  it("carries `from` onto the user block, and leaves it undefined for a message the user typed", () => {
    let t = emptyTranscript();
    t = reduceTranscript(t, sessionEvent("user_message", { text: "I typed this", attachments: [] }));
    // Absence is the ordinary case and must stay absent — a block that claimed an author for every
    // message would attribute the user's own words to a session.
    expect(t.blocks.at(-1)).not.toHaveProperty("from");
    t = reduceTranscript(t, sessionEvent("user_message", { text: "an agent asked this", attachments: [], from: { sessionId: "s1", title: "Refactor the parser" } }));
    // Kills the reducer dropping the field, which silently un-labels every injected message: the pane
    // would then render another agent's words as something the user typed.
    expect(t.blocks.at(-1)).toMatchObject({ kind: "user", text: "an agent asked this", from: { sessionId: "s1", title: "Refactor the parser" } });
  });
});

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

  it("survives a reload: the same events replayed rebuild the same single card", () => {
    const events = [plan("p1", { steps: [{ text: "A", status: "pending" }] }, 10), plan("p1", { steps: [{ text: "A", status: "completed" }] }, 30)];
    expect(reduceAll(events).blocks).toEqual([{ kind: "plan", planId: "p1", steps: [{ text: "A", status: "completed" }], ts: 10 }]);
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
    const before = t;
    t = reduceTranscript(t, sessionEvent("status", { status: "idle" }));
    expect(t).toBe(before);
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

  it("keeps the label seed on the block so the settled line can name the same verb", () => {
    const t = reduceAll([status("running", 777), status("idle", 1_777)]);
    expect(runBlocks(t)).toMatchObject([{ startedAt: 777 }]);
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
});

describe("feedback", () => {
  const rate = (messageId: string, rating: "up" | "down" | null) => sessionEvent("feedback", { messageId, rating });

  it("keeps a rating against the message it judges, and nothing against the ones it does not", () => {
    const t = reduceAll([
      sessionEvent("assistant_text", { messageId: "m1", text: "one" }),
      sessionEvent("assistant_text", { messageId: "m2", text: "two" }),
      rate("m1", "up"),
    ]);
    expect(t.feedback).toEqual({ m1: "up" });
  });

  it("lets the reader change their mind, and take the verdict back entirely", () => {
    // Three states, not two: absent is "not judged", which a boolean could not tell from "down".
    const up = reduceAll([rate("m1", "up")]);
    expect(up.feedback).toEqual({ m1: "up" });
    const down = reduceAll([rate("m1", "up"), rate("m1", "down")]);
    expect(down.feedback).toEqual({ m1: "down" });
    const withdrawn = reduceAll([rate("m1", "up"), rate("m1", null)]);
    expect(withdrawn.feedback).toEqual({});
  });

  it("survives the relaunch, because it is in the log the transcript is rebuilt from", () => {
    // The whole reason this is an event and not a settings row.
    const events = [
      sessionEvent("user_message", { text: "hi", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: "hello" }),
      rate("m1", "down"),
    ];
    expect(reduceAll(events).feedback).toEqual({ m1: "down" });
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

  it("gives the two blocks distinct keys, so React does not reuse one as the other", () => {
    const t = reduceAll([
      retrying(1),
      sessionEvent("handoff", { from: "claude", to: "codex", reason: "auth", note: "n", attempt: 1 }),
    ]);
    expect(new Set(t.blocks.map(blockKey)).size).toBe(t.blocks.length);
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
});
