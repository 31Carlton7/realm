import { describe, expect, it } from "vitest";
import { SessionEventSchema, sessionEvent } from "./session-events";
describe("session events", () => {
  it("parses each variant", () => {
    const evs = [
      sessionEvent("user_message", { text: "hi", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: "hello" }),
      sessionEvent("assistant_delta", { messageId: "m1", delta: "he" }),
      sessionEvent("thinking", { messageId: "m1", text: "..." }),
      sessionEvent("tool_call", { toolUseId: "t1", name: "Read", input: { file_path: "a" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false }),
      sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", suggestions: [] }),
      sessionEvent("permission_response", { requestId: "r1", decision: "allow" }),
      sessionEvent("status", { status: "running" }),
      sessionEvent("error", { message: "boom" }),
      sessionEvent("usage", { costUsd: 0.01, inputTokens: 10, outputTokens: 5, numTurns: 1 }),
      sessionEvent("init", { providerSessionId: "abc", model: "claude-opus-5", tools: ["Read"], cwd: "/x" }),
    ];
    for (const e of evs) expect(SessionEventSchema.parse(e).type).toBe(e.type);
  });
  it("rejects unknown type", () => { expect(SessionEventSchema.safeParse({ type: "nope", ts: 1, payload: {} }).success).toBe(false); });
});
