import { describe, expect, it } from "vitest";
import { DRAW_LIMIT, parseMatches, parseTodos, splitExitCode, stripLineNumbers, toolInputView, toolResultView } from "./tool-view";

describe("parseTodos", () => {
  it("reads TodoWrite's list, carrying a missing activeForm as null rather than faking one", () => {
    expect(parseTodos({ todos: [
      { content: "Write the parser", status: "completed", activeForm: "Writing the parser" },
      { content: "Wire the card", status: "in_progress" },
    ] })).toEqual([
      { content: "Write the parser", status: "completed", activeForm: "Writing the parser" },
      { content: "Wire the card", status: "in_progress", activeForm: null },
    ]);
  });

  it("declines anything that is not the documented shape, so the card falls back to the raw payload", () => {
    expect(parseTodos({})).toBeNull();
    expect(parseTodos({ todos: [] })).toBeNull();
    expect(parseTodos({ todos: ["just a string"] })).toBeNull();
    expect(parseTodos({ todos: [{ content: "x", status: "blocked" }] })).toBeNull();
    expect(parseTodos({ todos: [{ status: "pending" }] })).toBeNull();
  });

  it("one unreadable row rejects the whole list — a plan missing a step is worse than no plan", () => {
    expect(parseTodos({ todos: [{ content: "a", status: "pending" }, { content: "b" }] })).toBeNull();
  });
});

describe("splitExitCode", () => {
  it("lifts the trailing [exit N] the Codex mapper appends", () => {
    expect(splitExitCode("boom\n[exit 2]")).toEqual({ output: "boom", exitCode: 2 });
    expect(splitExitCode("ok\n[exit 0]\n")).toEqual({ output: "ok", exitCode: 0 });
  });

  it("reports no code at all when the result never carried one", () => {
    // Claude's Bash result is bare output. Reading that as "exit 0" would put a green success badge
    // on a command whose status nobody recorded.
    expect(splitExitCode("total 8\ndrwxr-xr-x")).toEqual({ output: "total 8\ndrwxr-xr-x", exitCode: null });
    expect(splitExitCode("see [exit 3] in the log")).toEqual({ output: "see [exit 3] in the log", exitCode: null });
  });
});

describe("stripLineNumbers", () => {
  it("strips Read's cat -n gutter and keeps the file's real first line", () => {
    expect(stripLineNumbers("     1\tconst a = 1;\n     2\tconst b = 2;")).toEqual({ text: "const a = 1;\nconst b = 2;", firstLine: 1 });
    expect(stripLineNumbers("    40\tfourty\n    41\tfourty-one")).toEqual({ text: "fourty\nfourty-one", firstLine: 40 });
  });

  it("refuses text that is not a numbered listing", () => {
    expect(stripLineNumbers("plain output")).toBeNull();
    expect(stripLineNumbers("     1\tone\nnot numbered")).toBeNull();
    // Numbers that do not count up are data in a tab-separated file, not a gutter.
    expect(stripLineNumbers("  7\tseven\n  9\tnine")).toBeNull();
  });

  it("keeps the leading tab's content intact, including further tabs", () => {
    expect(stripLineNumbers("     1\ta\tb")!.text).toBe("a\tb");
  });
});

describe("parseMatches", () => {
  it("groups path:line:text results by file", () => {
    const out = parseMatches("/repo/a.ts:12:const a = 1;\n/repo/a.ts:40:const b = 2;\n/repo/b.ts:3:x")!;
    expect(out.groups.map((g) => g.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(out.groups[0]!.matches).toEqual([{ line: 12, text: "const a = 1;" }, { line: 40, text: "const b = 2;" }]);
  });

  it("reads a bare path list (Glob, Grep's files_with_matches) as files with no match rows", () => {
    const out = parseMatches("/repo/a.ts\n/repo/src/b.tsx")!;
    expect(out.groups).toEqual([{ path: "/repo/a.ts", matches: [] }, { path: "/repo/src/b.tsx", matches: [] }]);
  });

  it("lifts Grep's own preamble and truncation notice out of the results", () => {
    const out = parseMatches("Found 2 files\n/repo/a.ts:1:x\n(Results are truncated. Consider a more specific path)")!;
    expect(out.note).toBe("Found 2 files · (Results are truncated. Consider a more specific path)");
    expect(out.groups).toHaveLength(1);
  });

  it("declines when any line is not a result, rather than silently dropping it", () => {
    // Half a search result is the one thing worse than a raw dump: the reader cannot see what is
    // missing.
    expect(parseMatches("No files found")).toBeNull();
    expect(parseMatches("/repo/a.ts:1:x\nsomething went wrong")).toBeNull();
    expect(parseMatches("")).toBeNull();
  });
});

describe("toolInputView", () => {
  it("draws the tools whose payload IS a picture, and declines the rest", () => {
    expect(toolInputView("Edit", { file_path: "/a", old_string: "a", new_string: "b" })?.kind).toBe("diff");
    expect(toolInputView("Bash", { command: "ls -la" })).toEqual({ kind: "command", command: "ls -la", cwd: null, description: null });
    expect(toolInputView("TodoWrite", { todos: [{ content: "x", status: "pending" }] })?.kind).toBe("todos");
    expect(toolInputView("WebFetch", { url: "https://example.com", prompt: "summarise" })?.kind).toBe("request");
    expect(toolInputView("Read", { file_path: "/a" })).toBeNull();
    expect(toolInputView("mcp__thing__do", { anything: 1 })).toBeNull();
  });

  it("declines a command tool whose payload has no command — the raw well then shows what it does have", () => {
    expect(toolInputView("Bash", { timeout: 5000 })).toBeNull();
  });
});

describe("toolResultView", () => {
  it("draws a diff printed into ANY result, whichever tool printed it", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(toolResultView("Bash", { command: "git diff" }, patch, false)).toMatchObject({ kind: "diff" });
  });

  it("a command result is a terminal, with an exit code only where one was stated", () => {
    expect(toolResultView("Bash", {}, "hello", false)).toEqual({ kind: "terminal", output: "hello", exitCode: null });
    expect(toolResultView("exec_command", {}, "bad\n[exit 1]", false)).toEqual({ kind: "terminal", output: "bad", exitCode: 1 });
  });

  it("a Read is a numbered file preview, and keeps its numbering when the listing carries none", () => {
    expect(toolResultView("Read", { file_path: "/a.ts" }, "     1\tconst a = 1;", false))
      .toEqual({ kind: "code", path: "/a.ts", text: "const a = 1;", firstLine: 1 });
    expect(toolResultView("Read", { file_path: "/a.ts" }, "raw contents", false))
      .toEqual({ kind: "code", path: "/a.ts", text: "raw contents", firstLine: null });
  });

  it("a search result is a match list, and unparseable output falls back to the raw well", () => {
    expect(toolResultView("Grep", {}, "/a.ts:1:x", false)).toMatchObject({ kind: "matches" });
    expect(toolResultView("Grep", {}, "No matches found", false)).toBeNull();
  });

  it("never draws an error or an empty result — both belong in the well as they arrived", () => {
    expect(toolResultView("Bash", {}, "command not found", true)).toBeNull();
    expect(toolResultView("Bash", {}, "", false)).toBeNull();
  });
});

describe("the draw limit", () => {
  it("hands a result at or past the clamp back to the raw well, whatever shape it is", () => {
    // A-M2's "Show all (N KB)" expander is the only thing standing between the transcript and an
    // agent that cats a bundle; a drawn view would swallow it.
    expect(toolResultView("Bash", {}, "x".repeat(DRAW_LIMIT), false)).toBeNull();
    expect(toolResultView("Bash", {}, "x".repeat(DRAW_LIMIT - 1), false)).toMatchObject({ kind: "terminal" });
  });
});
