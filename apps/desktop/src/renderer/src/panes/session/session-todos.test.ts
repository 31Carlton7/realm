import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { reduceAll } from "./transcript-model";
import { latestTodos } from "./session-todos";

const todo = (content: string, status: "pending" | "in_progress" | "completed") => ({ content, status, activeForm: null });

/** Built through `reduceAll` rather than as hand-made blocks: what the pinned plan has to survive is
 *  a reload, and a reload is exactly this fold over the session's persisted events. */
const write = (id: string, todos: unknown, parentToolUseId: string | null = null) =>
  sessionEvent("tool_call", { toolUseId: id, name: "TodoWrite", input: { todos }, parentToolUseId });

describe("latestTodos", () => {
  it("is empty for a session that has never written a plan", () => {
    expect(latestTodos(reduceAll([sessionEvent("user_message", { text: "hi", attachments: [] })]).blocks)).toEqual([]);
  });

  it("reads the newest plan, not the first — every TodoWrite restates the whole list", () => {
    const t = reduceAll([
      write("t1", [{ content: "Read the spec", status: "pending" }]),
      sessionEvent("assistant_text", { messageId: "m", text: "working" }),
      write("t2", [{ content: "Read the spec", status: "completed" }, { content: "Write it", status: "in_progress" }]),
    ]);
    expect(latestTodos(t.blocks)).toEqual([todo("Read the spec", "completed"), todo("Write it", "in_progress")]);
  });

  it("carries activeForm through, since the strip says what the agent is doing in its own words", () => {
    const t = reduceAll([write("t1", [{ content: "Run the suite", status: "in_progress", activeForm: "Running the suite" }])]);
    expect(latestTodos(t.blocks)[0]!.activeForm).toBe("Running the suite");
  });

  it("clears when the agent drops its plan, rather than restoring the one before it", () => {
    const t = reduceAll([
      write("t1", [{ content: "Read the spec", status: "pending" }]),
      write("t2", []),
    ]);
    expect(latestTodos(t.blocks)).toEqual([]);
  });

  it("ignores a sub-agent's list — a delegated child's plan is not this session's", () => {
    const t = reduceAll([
      write("t1", [{ content: "Read the spec", status: "pending" }]),
      write("t2", [{ content: "Child's own step", status: "in_progress" }], "task1"),
    ]);
    expect(latestTodos(t.blocks)).toEqual([todo("Read the spec", "pending")]);
  });

  it("is empty when the newest payload is not the shape TodoWrite documents", () => {
    const t = reduceAll([write("t1", [{ content: "Read the spec", status: "hurrying" }])]);
    expect(latestTodos(t.blocks)).toEqual([]);
  });
});
