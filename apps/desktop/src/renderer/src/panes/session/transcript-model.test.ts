import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { emptyTranscript, reduceAll, reduceTranscript } from "./transcript-model";

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
    expect(t.pendingPermission?.requestId).toBe("r1");
    t = reduceTranscript(t, sessionEvent("permission_response", { requestId: "other", decision: "allow" }));
    expect(t.pendingPermission?.requestId).toBe("r1");
    t = reduceTranscript(t, sessionEvent("permission_response", { requestId: "r1", decision: "allow" }));
    expect(t.pendingPermission).toBeNull();
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
