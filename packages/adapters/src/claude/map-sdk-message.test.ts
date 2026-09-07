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

  describe("contextTokens — the size of the prompt this turn actually sent", () => {
    const result = (usage: unknown) => createSdkMapper().map({
      type: "result", subtype: "success", session_id: "s", uuid: "u", is_error: false, num_turns: 3,
      total_cost_usd: 1.5, usage, modelUsage: {}, permission_denials: [], result: "ok",
    } as never).find((e) => e.type === "usage");

    it("counts the cache alongside the fresh input — a cached prompt is still a prompt the model read", () => {
      // The mutant: emitting `input_tokens` alone. With prompt caching that is the SMALL half by an
      // order of magnitude, so a 190k-token conversation would report as 4k of context used and the
      // meter would sit near empty right up to the moment the window overflowed.
      const e = result({ input_tokens: 4_000, output_tokens: 900, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 6_000 });
      expect(e?.type === "usage" && e.payload.contextTokens).toBe(190_000);
      // …and the other three numbers are untouched by it.
      expect(e?.type === "usage" && e.payload.inputTokens).toBe(4_000);
      expect(e?.type === "usage" && e.payload.costUsd).toBe(1.5);
    });

    it("tolerates a result whose usage names no cache fields at all", () => {
      const e = result({ input_tokens: 4_000, output_tokens: 900 });
      expect(e?.type === "usage" && e.payload.contextTokens).toBe(4_000);
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

    it("says nothing rather than zero when the result carried no usage — a zero would claim the model read nothing", () => {
      const e = result(undefined);
      expect(e?.type === "usage" && e.payload.contextTokens).toBeUndefined();
      expect(e?.type === "usage" && "contextTokens" in e.payload).toBe(false);
    });
  });
});
