import { describe, expect, it } from "vitest"; import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createSdkMapper } from "./map-sdk-message";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "turn.json"), "utf8")) as unknown[];
const asst = (content: unknown[], parent: string | null = null, id = "msg_x") => ({ type: "assistant", session_id: "s", parent_tool_use_id: parent, uuid: "u", message: { id, type: "message", role: "assistant", model: "m", content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
describe("map-sdk-message", () => {
  it("maps a recorded turn to normalized events", () => {
    const m = createSdkMapper(); const out = fixture.flatMap((msg) => m.map(msg as never));
    const types = out.map((e) => e.type);
    expect(types[0]).toBe("init");
    expect(types).toContain("assistant_delta"); expect(types).toContain("assistant_text"); expect(types).toContain("tool_call"); expect(types).toContain("tool_result"); expect(types).toContain("usage");
    const call = out.find((e) => e.type === "tool_call")!; expect(call.type === "tool_call" && call.payload.name).toBe("Read");
    const res = out.find((e) => e.type === "tool_result")!; expect(res.type === "tool_result" && res.payload.toolUseId).toBe("toolu_01");
    const usage = out.find((e) => e.type === "usage")!; expect(usage.type === "usage" && usage.payload.numTurns).toBe(2);
    expect(types).not.toContain("error");
  });
  it("delta and final text share a messageId", () => {
    const m = createSdkMapper(); const out = fixture.flatMap((msg) => m.map(msg as never));
    const delta = out.find((e) => e.type === "assistant_delta")!; const text = out.find((e) => e.type === "assistant_text")!;
    expect(delta.type === "assistant_delta" && text.type === "assistant_text" && delta.payload.messageId === text.payload.messageId).toBe(true);
  });
  it("maps thinking blocks", () => {
    const out = createSdkMapper().map(asst([{ type: "thinking", thinking: "hmm", signature: "x" }, { type: "text", text: "ok" }]) as never);
    expect(out.map((e) => e.type)).toEqual(["thinking", "assistant_text"]);
    expect(out[0]!.type === "thinking" && out[0]!.payload.text).toBe("hmm");
  });
  it("drops subagent assistant/delta output (parent_tool_use_id set) but keeps its tool calls", () => {
    const m = createSdkMapper();
    const sub = m.map(asst([{ type: "text", text: "inner" }, { type: "tool_use", id: "t2", name: "Grep", input: {} }], "toolu_parent") as never);
    expect(sub.map((e) => e.type)).toEqual(["tool_call"]);
    const d = m.map({ type: "stream_event", session_id: "s", parent_tool_use_id: "toolu_parent", uuid: "u", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } } as never);
    expect(d).toEqual([]);
  });
  it("an interim assistant snapshot after the thinking block completes must not retire the streaming id — every text delta for the turn keeps sharing it with the final assistant_text", () => {
    const m = createSdkMapper();
    const push = (msg: unknown) => m.map(msg as never);
    const se = (uuid: string, event: unknown) => ({ type: "stream_event", session_id: "s", parent_tool_use_id: null, uuid, event });
    push(se("u0", { type: "message_start", message: { id: "msg_1", content: [] } }));
    push(se("u1", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    push(se("u2", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }));
    // The SDK reports the thinking block as done via an interim `assistant` snapshot before the
    // trailing text block has even started — this must not retire the id the text deltas need.
    push(asst([{ type: "thinking", thinking: "hmm", signature: "x" }], null, "msg_1"));
    push(se("u3", { type: "content_block_stop", index: 0 }));
    push(se("u4", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    const d1 = push(se("u5", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Yes" } }));
    const d2 = push(se("u6", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " — it overflows." } }));
    const fin = push(asst([{ type: "thinking", thinking: "hmm", signature: "x" }, { type: "text", text: "Yes — it overflows." }], null, "msg_1"));
    push(se("u7", { type: "message_stop" }));

    const delta1 = d1.find((e) => e.type === "assistant_delta")!;
    const delta2 = d2.find((e) => e.type === "assistant_delta")!;
    const text = fin.find((e) => e.type === "assistant_text")!;
    expect(delta1.type === "assistant_delta" && delta1.payload.messageId).toBe(delta2.type === "assistant_delta" && delta2.payload.messageId);
    expect(delta1.type === "assistant_delta" && delta1.payload.messageId).toBe(text.type === "assistant_text" && text.payload.messageId);
  });
  it("maps ExitPlanMode to a plan carrying the markdown, not to a tool call", () => {
    const out = createSdkMapper().map(asst([{ type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input: { plan: "# Ship it\n\n1. Do the thing", planFilePath: "/tmp/p.md" } }]) as never);
    // The mutant: dropping the ExitPlanMode branch. The plan then reaches the transcript as a generic
    // tool call whose summary clips the whole document to one line.
    expect(out.map((e) => e.type)).toEqual(["plan"]);
    expect(out[0]!.type === "plan" && out[0]!.payload).toEqual({ planId: "toolu_p", text: "# Ship it\n\n1. Do the thing" });
  });
  it("keys the plan on the tool use id, so a re-proposed plan is a second card and a resend is not", () => {
    const m = createSdkMapper();
    const first = m.map(asst([{ type: "tool_use", id: "toolu_a", name: "ExitPlanMode", input: { plan: "v1" } }]) as never);
    const second = m.map(asst([{ type: "tool_use", id: "toolu_b", name: "ExitPlanMode", input: { plan: "v2" } }]) as never);
    expect([first[0]!, second[0]!].map((e) => e.type === "plan" && e.payload.planId)).toEqual(["toolu_a", "toolu_b"]);
  });
  it.each([
    ["no plan field", { planFilePath: "/tmp/p.md" }],
    ["a non-string plan", { plan: { markdown: "nope" } }],
    ["a blank plan", { plan: "   " }],
  ])("falls back to the ordinary tool call when the call carries %s — a plan card with no plan is worse than the generic one", (_name, input) => {
    const out = createSdkMapper().map(asst([{ type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input }]) as never);
    expect(out.map((e) => e.type)).toEqual(["tool_call"]);
  });
  it("leaves every other tool alone — a TodoWrite whose input happens to have a `plan` key is still a tool call", () => {
    const out = createSdkMapper().map(asst([{ type: "tool_use", id: "t9", name: "TodoWrite", input: { plan: "not mine" } }]) as never);
    expect(out.map((e) => e.type)).toEqual(["tool_call"]);
  });
  it("result with is_error emits usage then error, and resets text dedupe", () => {
    const m = createSdkMapper();
    m.map(asst([{ type: "text", text: "same" }], null, "m1") as never);
    const r = m.map({ type: "result", subtype: "error_during_execution", session_id: "s", uuid: "u", is_error: true, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: ["boom"] } as never);
    expect(r.map((e) => e.type)).toEqual(["usage", "error"]);
    expect(m.map(asst([{ type: "text", text: "same" }], null, "m1") as never).map((e) => e.type)).toEqual(["assistant_text"]);
  });

  describe("compact_boundary — the seam nothing else on the wire reports", () => {
    const boundary = (compact_metadata: unknown) => createSdkMapper().map({
      type: "system", subtype: "compact_boundary", session_id: "s", uuid: "u", compact_metadata,
    } as never);

    it("reports the drop with both numbers, so the line has something to compare", () => {
      const out = boundary({ trigger: "auto", pre_tokens: 186_000, post_tokens: 34_000 });
      expect(out.map((e) => e.type)).toEqual(["compacted"]);
      const e = out[0]!;
      expect(e.type === "compacted" && e.payload).toEqual({ trigger: "auto", preTokens: 186_000, postTokens: 34_000 });
    });

    it("keeps a manual compaction distinct from an automatic one", () => {
      // Carried and not rendered today, but the record is the record: a compaction the user asked
      // for and one the harness forced are different events in the session's history.
      const e = boundary({ trigger: "manual", pre_tokens: 100, post_tokens: 10 })[0]!;
      expect(e.type === "compacted" && e.payload.trigger).toBe("manual");
    });

    it("treats an unrecognised trigger as automatic, which is the one the user did not ask for", () => {
      // Fail toward the reading that owes the user an explanation. A future trigger coerced to
      // `manual` would claim they asked for something they did not.
      const e = boundary({ pre_tokens: 100 })[0]!;
      expect(e.type === "compacted" && e.payload.trigger).toBe("auto");
    });

    it("omits the after-figure a build did not report rather than inventing a zero", () => {
      // The mutant: `post_tokens ?? 0`, which would draw "186k → 0" and claim the window was emptied.
      const e = boundary({ trigger: "auto", pre_tokens: 186_000 })[0]!;
      expect(e.type === "compacted" && "postTokens" in e.payload).toBe(false);
      expect(e.type === "compacted" && e.payload.preTokens).toBe(186_000);
    });

    it("does not mistake a compaction for a background task, or a background task for a compaction", () => {
      // Both arrive as `system` messages with a subtype, and the compaction branch sits ahead of the
      // task one — an over-broad match there would swallow every task notification in the session.
      const out = createSdkMapper().map({
        type: "system", subtype: "compact_boundary", session_id: "s", uuid: "u",
        compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 1 },
      } as never);
      expect(out.every((e) => e.type !== "background_task")).toBe(true);
    });
  });

  describe("the result states no context, because it cannot", () => {
    const result = (usage: unknown) => createSdkMapper().map({
      type: "result", subtype: "success", session_id: "s", uuid: "u", is_error: false, num_turns: 3,
      total_cost_usd: 1.5, usage, modelUsage: {}, permission_denials: [], result: "ok",
    } as never).find((e) => e.type === "usage");

    it("never derives one from the result's own usage, however much it looks like the right sum", () => {
      // The mutant is what this code USED to do: `input + cache_read + cache_creation`, which reads
      // exactly like the size of the prompt just sent. It is not. The SDK's per-turn `usage` sums
      // every REQUEST the turn made, so a turn with thirty tool calls counts its cached prompt
      // thirty times — 1.19M against a 1M window, a meter that could only climb and was pinned at
      // 100% on a session nowhere near full. Occupancy comes from `getContextUsage`; see
      // claude-adapter.ts.
      const e = result({ input_tokens: 4_000, output_tokens: 900, cache_read_input_tokens: 1_180_000, cache_creation_input_tokens: 6_000 });
      expect(e?.type === "usage" && "contextTokens" in e.payload).toBe(false);
      expect(e?.type === "usage" && "contextWindow" in e.payload).toBe(false);
      // …and the numbers the result CAN state are untouched.
      expect(e?.type === "usage" && e.payload.inputTokens).toBe(4_000);
      expect(e?.type === "usage" && e.payload.outputTokens).toBe(900);
      expect(e?.type === "usage" && e.payload.costUsd).toBe(1.5);
      expect(e?.type === "usage" && e.payload.numTurns).toBe(3);
    });

    it("reports what fast mode DID, and why it could not, rather than what was asked for", () => {
      const e = createSdkMapper().map({
        type: "result", subtype: "success", session_id: "s", uuid: "u", is_error: false, num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
        fast_mode_state: "off", fast_mode_disabled_reason: "free",
      } as never).find((x) => x.type === "usage");
      expect(e?.type === "usage" && e.payload.fastMode).toBe("off");
      expect(e?.type === "usage" && e.payload.fastModeReason).toBe("free");
    });

    it("carries no reason once it is actually serving", () => {
      const e = createSdkMapper().map({
        type: "result", subtype: "success", session_id: "s", uuid: "u", is_error: false, num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
        fast_mode_state: "on", fast_mode_disabled_reason: "pending",
      } as never).find((x) => x.type === "usage");
      expect(e?.type === "usage" && e.payload.fastMode).toBe("on");
      expect(e?.type === "usage" && "fastModeReason" in e.payload).toBe(false);
    });

    it("leaves the state unstated for a build that does not report it, and for one that reports nonsense", () => {
      // Absent is "this build does not say", which is a different thing from `off` — and coercing an
      // unrecognised string into `off` would report a newer build's new state as a refusal.
      for (const state of [undefined, "turbo"]) {
        const e = createSdkMapper().map({
          type: "result", subtype: "success", session_id: "s", uuid: "u", is_error: false, num_turns: 1,
          total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [],
          ...(state === undefined ? {} : { fast_mode_state: state }),
        } as never).find((x) => x.type === "usage");
        expect(e?.type === "usage" && "fastMode" in e.payload, String(state)).toBe(false);
      }
    });

    it("still reports the turn when the result carried no usage at all", () => {
      const e = result(undefined);
      expect(e?.type === "usage" && e.payload.inputTokens).toBe(0);
      expect(e?.type === "usage" && "contextTokens" in e.payload).toBe(false);
    });
  });

  /**
   * Background sub-agents. The signals are `system` messages, not anything on the assistant or user
   * turns — see `background-task.test.ts`, which drives the whole live capture through this mapper.
   * What is worth pinning HERE is that the system branch still does its original job.
   */
  describe("background sub-agents", () => {
    it("keeps mapping system/init while also reading the task protocol", () => {
      const out = createSdkMapper().map({ type: "system", subtype: "init", session_id: "s", model: "m", tools: [], cwd: "/w", uuid: "u" } as never);
      expect(out.map((e) => e.type)).toEqual(["init"]);
    });

    it("says nothing for a system message it does not recognise", () => {
      expect(createSdkMapper().map({ type: "system", subtype: "hook_started", uuid: "u", session_id: "s" } as never)).toEqual([]);
    });

    it("no longer reads the launch text off a tool result — an ordinary result stays one event", () => {
      // The first attempt at this feature matched "Async agent launched successfully" here. It is
      // prose the harness writes for the model, it never crossed this wire in a live run, and a
      // transcript that merely quotes it must not start a phantom run.
      const userMsg = { type: "user", session_id: "s", parent_tool_use_id: null, uuid: "u",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "Async agent launched successfully. agentId: a02" }] } };
      expect(createSdkMapper().map(userMsg as never).map((e) => e.type)).toEqual(["tool_result"]);
    });
  });
});
