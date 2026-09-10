import { describe, expect, it } from "vitest";
import { factLines, nothingToSummarize, sessionEvent, sessionFacts } from "./index";

describe("counting what a session did", () => {
  it("credits a tool only once its result lands", () => {
    // A call with no result has not done anything — it is in flight, or the turn died under it.
    // Counting it would claim work the log cannot show, in a line handed to a model as fact.
    const f = sessionFacts([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: {}, parentToolUseId: null }),
      sessionEvent("tool_call", { toolUseId: "t2", name: "Bash", input: {}, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t1", content: "", isError: false }),
    ]);
    expect(f.commands).toBe(1);
  });

  it("counts a failed call as an error and not as work done", () => {
    const f = sessionFacts([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Edit", input: { file_path: "/a.ts" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t1", content: "denied", isError: true }),
    ]);
    expect(f.edited).toEqual([]);
    expect(f.errors).toBe(1);
  });

  it("lists each edited path once, in first-touch order, under any harness's argument name", () => {
    const edit = (id: string, input: Record<string, unknown>) => [
      sessionEvent("tool_call", { toolUseId: id, name: "Edit", input, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: id, content: "", isError: false }),
    ];
    const f = sessionFacts([
      ...edit("a", { file_path: "/b.ts" }),
      ...edit("b", { path: "/a.ts" }),
      ...edit("c", { file_path: "/b.ts" }),
    ]);
    expect(f.edited).toEqual(["/b.ts", "/a.ts"]);
  });

  it("does not count a message another session delivered as a turn the user took", () => {
    const f = sessionFacts([
      sessionEvent("user_message", { text: "mine", attachments: [] }),
      sessionEvent("user_message", { text: "a peer's", attachments: [], from: { sessionId: "s2", title: "Other" } }),
    ]);
    expect(f.turns).toBe(1);
    expect(f.asked).toBe("mine");
  });

  it("reads a namespaced tool by its bare name", () => {
    const f = sessionFacts([
      sessionEvent("tool_call", { toolUseId: "t", name: "mcp__realm-fs__write_file", input: { path: "/x" }, parentToolUseId: null }),
      sessionEvent("tool_result", { toolUseId: "t", content: "", isError: false }),
    ]);
    expect(f.edited).toEqual(["/x"]);
  });

  it("holds back on a session that only said hello", () => {
    expect(nothingToSummarize(sessionFacts([sessionEvent("user_message", { text: "hi", attachments: [] })]))).toBe(true);
  });

  it("is willing once a second turn arrives, even with no tools at all", () => {
    const f = sessionFacts([
      sessionEvent("user_message", { text: "explain this", attachments: [] }),
      sessionEvent("user_message", { text: "and this", attachments: [] }),
    ]);
    expect(nothingToSummarize(f)).toBe(false);
  });

  it("writes the counts as lines a model can quote, basenames only", () => {
    const lines = factLines({ asked: "x", turns: 2, edited: ["/deep/path/login.ts"], commands: 3, reads: 0, errors: 1 });
    expect(lines).toContain("edited 1 file: login.ts");
    expect(lines).toContain("ran 3 commands");
    expect(lines).toContain("hit 1 error");
    expect(lines).not.toContain("read "); // a zero is not a fact worth stating
  });
});
