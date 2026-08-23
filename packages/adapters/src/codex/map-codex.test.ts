import { describe, it, expect } from "vitest";
import { createCodexMapper } from "./map-codex";
import type { SessionEvent } from "@realm/contracts";

const types = (evs: SessionEvent[]) => evs.map((e) => e.type);

describe("createCodexMapper", () => {
  it("drops the userMessage echo so the transcript isn't duplicated", () => {
    const m = createCodexMapper();
    const out = m.map("item/started", { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } });
    expect(out).toEqual([]);
  });

  it("maps agent message deltas and the final text", () => {
    const m = createCodexMapper();
    expect(m.map("item/started", { item: { type: "agentMessage", id: "msg_1", text: "" } })).toEqual([]);
    const d = m.map("item/agentMessage/delta", { itemId: "msg_1", delta: "Run" });
    expect(d[0]).toMatchObject({ type: "assistant_delta", payload: { messageId: "msg_1", delta: "Run" } });
    const f = m.map("item/completed", { item: { type: "agentMessage", id: "msg_1", text: "Running it." } });
    expect(f[0]).toMatchObject({ type: "assistant_text", payload: { messageId: "msg_1", text: "Running it." } });
  });

  it("emits thinking once, from the completed reasoning item", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "reasoning", id: "rs_1", summary: [], content: [] } });
    expect(m.map("item/reasoning/summaryTextDelta", { itemId: "rs_1", delta: "Check", summaryIndex: 0 })).toEqual([]);
    const done = m.map("item/completed", { item: { type: "reasoning", id: "rs_1", summary: ["Checking the request."], content: [] } });
    expect(done[0]).toMatchObject({ type: "thinking", payload: { messageId: "rs_1", text: "Checking the request." } });
  });

  it("maps commandExecution to tool_call then tool_result", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "commandExecution", id: "call_1", command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp", status: "inProgress" } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "call_1", name: "exec_command", input: { command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp" }, parentToolUseId: null } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "call_1", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "call_1", content: "hi\n", isError: false } });
  });

  it("marks a failed command as an error result", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c2", command: "false", cwd: "/tmp" } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "c2", status: "failed", aggregatedOutput: "", exitCode: 1 } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { isError: true } });
  });

  it("maps fileChange to a tool_call with a readable diff summary", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes: [{ path: "/tmp/a.txt", kind: { type: "add" }, diff: "hello\n" }] } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "p1", name: "apply_patch" } });
    const done = m.map("item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes: [{ path: "/tmp/a.txt", kind: { type: "add" }, diff: "hello\n" }] } });
    expect(done[0]!.type).toBe("tool_result");
    expect((done[0] as { payload: { content: string } }).payload.content).toContain("add /tmp/a.txt");
  });

  it("force-closes open items when an interrupted turn completes", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c9", command: "sleep 60", cwd: "/tmp" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "interrupted", items: [] } });
    expect(types(out)).toEqual(["tool_result", "status"]);
    expect(out[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c9", isError: true, content: "interrupted" } });
    expect(out[1]).toMatchObject({ type: "status", payload: { status: "idle" } });
  });

  it("labels a force-closed item with the turn status when the turn wasn't interrupted", () => {
    // Pins the non-interrupted branch of the force-close wording: it should never read as if the
    // turn itself succeeded/failed with that word as its result — it should say what actually happened
    // (the item never got its own item/completed).
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c10", command: "sleep 60", cwd: "/tmp" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "completed", items: [] } });
    expect(out[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c10", isError: true, content: "turn ended without a result (completed)" } });
  });

  it("emits only status on a normal completion — no leftover tool_result once item/completed already closed the item", () => {
    // Regression guard for the openTools bookkeeping: if item/completed stopped deleting the id from
    // openTools, turn/completed would force-close it a second time and every tool call in every turn
    // would get a spurious extra error tool_result.
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c11", command: "echo hi", cwd: "/tmp" } });
    m.map("item/completed", { item: { type: "commandExecution", id: "c11", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "completed", items: [] } });
    expect(types(out)).toEqual(["status"]);
  });

  it("reports a failed turn as an error before going idle", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "failed", error: { message: "model exploded" }, items: [] } });
    expect(types(out)).toEqual(["error", "status"]);
    expect(out[0]).toMatchObject({ payload: { message: "model exploded" } });
  });

  it("uses tokenUsage.total, not last, and counts turns", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    const out = m.map("thread/tokenUsage/updated", {
      tokenUsage: { total: { totalTokens: 154, inputTokens: 120, outputTokens: 34 }, last: { inputTokens: 1, outputTokens: 1 }, modelContextWindow: 258400 },
    });
    expect(out[0]).toMatchObject({ type: "usage", payload: { costUsd: 0, inputTokens: 120, outputTokens: 34, numTurns: 1 } });
  });

  it("maps thread status changes", () => {
    const m = createCodexMapper();
    expect(m.map("thread/status/changed", { status: { type: "active", activeFlags: [] } })[0]).toMatchObject({ type: "status", payload: { status: "running" } });
    expect(m.map("thread/status/changed", { status: { type: "idle" } })[0]).toMatchObject({ type: "status", payload: { status: "idle" } });
  });

  it("maps the error notification", () => {
    const m = createCodexMapper();
    const out = m.map("error", { error: { message: "rate limited" }, willRetry: true });
    expect(out[0]).toMatchObject({ type: "error", payload: { message: "rate limited (retrying)" } });
  });

  it("maps mcpToolCall to tool_call then tool_result, using server.tool as the name", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "mcpToolCall", id: "mcp1", server: "figma", tool: "get_file", arguments: { fileId: "abc" } } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "mcp1", name: "figma.get_file", input: { fileId: "abc" }, parentToolUseId: null } });
    const done = m.map("item/completed", { item: { type: "mcpToolCall", id: "mcp1", status: "completed", result: "ok" } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "mcp1", content: "ok", isError: false } });
  });

  it("surfaces the mcpToolCall error field as the result content when the call fails", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "mcpToolCall", id: "mcp2", server: "notion", tool: "search", arguments: {} } });
    const done = m.map("item/completed", { item: { type: "mcpToolCall", id: "mcp2", status: "failed", error: "401 unauthorized" } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "mcp2", content: "401 unauthorized", isError: true } });
  });

  it("appends the exit code to a nonzero-exit command's output", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c3", command: "false", cwd: "/tmp" } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "c3", status: "failed", aggregatedOutput: "boom", exitCode: 1 } });
    expect((done[0] as { payload: { content: string } }).payload.content).toBe("boom\n[exit 1]");
  });

  it("closeOpenTools force-closes items awaiting item/completed and clears them", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c4", command: "sleep 5", cwd: "/tmp" } });
    m.map("item/started", { item: { type: "fileChange", id: "p2", status: "inProgress", changes: [] } });
    const closed = m.closeOpenTools("process exited");
    expect(closed).toHaveLength(2);
    expect(closed).toContainEqual({ type: "tool_result", ts: expect.any(Number), payload: { toolUseId: "c4", content: "process exited", isError: true } });
    expect(closed).toContainEqual({ type: "tool_result", ts: expect.any(Number), payload: { toolUseId: "p2", content: "process exited", isError: true } });
    // calling it again finds nothing left open
    expect(m.closeOpenTools("again")).toEqual([]);
  });

  it("returns no event for item/commandExecution/outputDelta (streamed stdout, coalesced by item/completed)", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c12", command: "echo hi", cwd: "/tmp" } });
    expect(m.map("item/commandExecution/outputDelta", { itemId: "c12", delta: "hi\n" })).toEqual([]);
  });

  it("maps a systemError thread status to the error status", () => {
    const m = createCodexMapper();
    expect(m.map("thread/status/changed", { status: { type: "systemError" } })[0]).toMatchObject({ type: "status", payload: { status: "error" } });
  });

  it("drops advisory and firehose notifications", () => {
    const m = createCodexMapper();
    for (const method of ["warning", "configWarning", "deprecationNotice", "mcpServer/startupStatus/updated", "account/rateLimits/updated", "rawResponse/completed", "serverRequest/resolved", "thread/started"]) {
      expect(m.map(method, {})).toEqual([]);
    }
  });
});
