import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffView } from "./DiffView";
import { CodeBlock, CommandView, MatchList, RequestView, TerminalView, TodoList, clampGroups } from "./ToolViews";
import { fileDiffsFor, parseUnifiedDiff } from "./diff";
import { PermissionCard } from "../PermissionCard";
import { ToolCard } from "../ToolCard";
import type { ToolBlock } from "../tool-group";

const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => q(sel).map((e) => e.textContent);

describe("DiffView", () => {
  const edit = fileDiffsFor("Edit", {
    file_path: "/src/app.ts",
    old_string: "const a = 1;\nconst timeout = 30;\nreturn a;",
    new_string: "const a = 1;\nconst timeout = 60;\nreturn a;",
  })!;

  it("names the file and states what the change cost", () => {
    render(<DiffView files={edit} />);
    expect(screen.getByTitle("/src/app.ts")).toHaveTextContent("/src/app.ts");
    expect(text(".fd-add")).toEqual(["+1"]);
    expect(text(".fd-del")).toEqual(["−1"]);
  });

  it("tints only the span that actually changed", () => {
    render(<DiffView files={edit} />);
    expect(text(".fd-mark")).toEqual(["3", "6"]);
  });

  it("leaves the gutters empty for a fragment edit, which has no file line numbers to give", () => {
    render(<DiffView files={edit} />);
    expect(text(".fd-no").every((t) => t === "")).toBe(true);
    expect(q(".fd-body")[0]).not.toHaveAttribute("data-numbered");
  });

  it("shows the file's own numbers when the source carried them", () => {
    render(<DiffView files={parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@\n-old\n+new\n ctx")} />);
    expect(q(".fd-body")[0]).toHaveAttribute("data-numbered");
    expect(text(".fd-no")).toEqual(["10", "", "", "10", "11", "11"]);
  });

  it("says how many unchanged lines it skipped instead of jumping silently", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<DiffView files={fileDiffsFor("Edit", { file_path: "/x", old_string: long, new_string: long.replace("line 20", "CHANGED") })!} />);
    expect(q(".fd-skip")[0]).toHaveTextContent("16 unchanged lines");
  });

  it("folds a file longer than the clamp and says how much is behind the fold", () => {
    const content = Array.from({ length: 400 }, (_, i) => `l${i}`).join("\n");
    render(<DiffView files={fileDiffsFor("Write", { file_path: "/big.ts", content })!} />);
    expect(q(".fd-line")).toHaveLength(300);
    const more = screen.getByRole("button", { name: "Show all 400 lines" });
    fireEvent.click(more);
    expect(q(".fd-line")).toHaveLength(400);
  });

  it("carries a binary file's note rather than drawing an empty diff", () => {
    render(<DiffView files={parseUnifiedDiff("diff --git a/l.png b/l.png\nBinary files a/l.png and b/l.png differ")} />);
    expect(q(".fd-note")[0]).toHaveTextContent("Binary file");
    expect(q(".fd-line")).toHaveLength(0);
  });
});

describe("TodoList", () => {
  const todos = [
    { content: "Parse the payload", status: "completed" as const, activeForm: null },
    { content: "Draw the card", status: "in_progress" as const, activeForm: "Drawing the card" },
    { content: "Test it", status: "pending" as const, activeForm: null },
  ];

  it("states the plan's real arithmetic and fills the bar to match", () => {
    render(<TodoList todos={todos} />);
    expect(q(".todo-count")[0]).toHaveTextContent("1 of 3");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(q(".todo-fill")[0]!.style.width).toBe(`${(1 / 3) * 100}%`);
  });

  it("shows the in-flight item in its own words", () => {
    render(<TodoList todos={todos} />);
    expect(q(".todo-active")[0]).toHaveTextContent("Drawing the card");
  });

  it("falls back to the item's title when it carries no activeForm", () => {
    render(<TodoList todos={[{ content: "Just this", status: "in_progress", activeForm: null }]} />);
    expect(q(".todo-active")[0]).toHaveTextContent("Just this");
  });

  it("keeps finished items in the list rather than deleting them", () => {
    render(<TodoList todos={todos} />);
    expect(text(".todo-text")).toEqual(["Parse the payload", "Draw the card", "Test it"]);
    expect(q(".todo-list li").map((li) => li.dataset["status"])).toEqual(["completed", "in_progress", "pending"]);
  });
});

describe("CodeBlock", () => {
  it("colours a language it knows", () => {
    render(<CodeBlock text="const a = 1;" lang="typescript" />);
    expect(q(".code-body .hljs-keyword")[0]).toHaveTextContent("const");
  });

  it("leaves an unknown language uncoloured rather than guessing at it", () => {
    render(<CodeBlock text="const a = 1;" lang={null} />);
    expect(q(".code-body span")).toHaveLength(0);
    expect(q(".code-body")[0]).toHaveTextContent("const a = 1;");
  });

  it("escapes markup in the source instead of mounting it", () => {
    render(<CodeBlock text="<img src=x onerror=alert(1)>" lang={null} />);
    expect(q(".code-body img")).toHaveLength(0);
    expect(q(".code-body")[0]).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("runs the number rail from the file's own first line", () => {
    render(<CodeBlock text={"a\nb\nc"} lang={null} firstLine={40} />);
    expect(q(".code-gutter")[0]).toHaveTextContent("40 41 42");
  });

  it("has no rail at all when the listing carried no numbering", () => {
    render(<CodeBlock text={"a\nb"} lang={null} firstLine={null} />);
    expect(q(".code-gutter")).toHaveLength(0);
  });

  it("folds past the clamp and opens on demand", () => {
    render(<CodeBlock text={Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")} lang={null} clamp={5} />);
    expect(q(".code-body")[0]!.textContent!.split("\n")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 lines" }));
    expect(q(".code-body")[0]!.textContent!.split("\n")).toHaveLength(12);
  });
});

describe("CommandView / TerminalView", () => {
  it("keeps the prompt glyph out of the copyable command", () => {
    render(<CommandView command="pnpm test" cwd="/repo" description="Run the suite" />);
    expect(q(".cmd-line code")[0]).toHaveTextContent("pnpm test");
    expect(q(".cmd-line code")[0]!.textContent).not.toContain("$");
    expect(q(".cmd-meta")[0]).toHaveTextContent("Run the suite");
    expect(q(".cmd-meta")[0]).toHaveTextContent("in /repo");
  });

  it("badges an exit code only where the result carried one", () => {
    const { unmount } = render(<TerminalView output="boom" exitCode={1} />);
    expect(q(".term-exit")[0]).toHaveTextContent("exit 1");
    expect(q(".term-exit")[0]).toHaveAttribute("data-bad");
    unmount();
    render(<TerminalView output="fine" exitCode={null} />);
    expect(q(".term-exit")).toHaveLength(0);
  });
});

describe("MatchList", () => {
  const groups = [
    { path: "/repo/a.ts", matches: [{ line: 1, text: "one" }, { line: 9, text: "nine" }] },
    { path: "/repo/b.ts", matches: [] },
  ];

  it("groups matches under their file and keeps each line's number", () => {
    render(<MatchList groups={groups} note={null} />);
    expect(text(".match-path")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(text(".match-no")).toEqual(["1", "9"]);
  });

  it("shows the search's own note about itself", () => {
    render(<MatchList groups={groups} note="Found 2 files" />);
    expect(q(".matches-note")[0]).toHaveTextContent("Found 2 files");
  });

  it("clamps the FIRST files whole rather than one row from each", () => {
    // The search returned them in this order and that is the order being scanned; trimming a row off
    // every file would leave nothing readable anywhere.
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `/f${i}.ts`, matches: [{ line: 1, text: "x" }, { line: 2, text: "y" }] }));
    expect(clampGroups(many, 5)).toEqual([
      { path: "/f0.ts", matches: [{ line: 1, text: "x" }, { line: 2, text: "y" }] },
      { path: "/f1.ts", matches: [{ line: 1, text: "x" }] },
    ]);
  });
});

describe("RequestView", () => {
  it("pulls the host out as its own chip — on a permission card it is the whole question", () => {
    render(<RequestView url="https://docs.example.com/a/b?c=1" query={null} prompt="What does it say?" />);
    expect(q(".req-host")[0]).toHaveTextContent("docs.example.com");
    expect(q(".req-prompt")[0]).toHaveTextContent("What does it say?");
  });

  it("shows a search with no host at all rather than inventing one", () => {
    render(<RequestView url={null} query="realm electron" prompt={null} />);
    expect(q(".req-host")).toHaveLength(0);
    expect(q(".req-target")[0]).toHaveTextContent("realm electron");
  });
});

const tool = (name: string, input: Record<string, unknown>, result: string | null = null): ToolBlock =>
  ({ kind: "tool", toolUseId: "t1", name, input, result: result === null ? null : { content: result, isError: false }, ts: 0 });

describe("ToolCard with a drawn payload", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: /tool call/ }));

  it("an opened Edit shows the diff where the JSON well used to be", () => {
    render(<ToolCard sessionStatus="idle" block={tool("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }, "ok")} />);
    open();
    expect(q(".fd-line")).toHaveLength(2);
    expect(q(".tool-section .tool-well")).toHaveLength(1); // the result well survives; the input well is drawn
  });

  it("copy still puts the RAW payload on the clipboard, not the drawing of it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ToolCard sessionStatus="idle" block={tool("Bash", { command: "ls -la" }, "total 8")} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Copy input" }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ command: "ls -la" }, null, 2));
  });

  it("a tool with nothing better to draw keeps both raw wells", () => {
    render(<ToolCard sessionStatus="idle" block={tool("mcp__x__do", { anything: 1 }, "some result")} />);
    open();
    expect(q(".tool-well")).toHaveLength(2);
  });

  it("the row's +/− counts are the diff's, and a zero side is not printed", () => {
    render(<ToolCard sessionStatus="idle" block={tool("Edit", { file_path: "/a.ts", old_string: "keep", new_string: "keep\nadded" }, "ok")} />);
    expect(q(".tool-stat-add")[0]).toHaveTextContent("+1");
    expect(q(".tool-stat-del")).toHaveLength(0);
  });
});

describe("PermissionCard preview", () => {
  const ask = (toolName: string, input: Record<string, unknown>) =>
    render(<PermissionCard permission={{ requestId: "r1", toolName, input, title: "Edit this file?" }} onDecide={() => {}} />);

  it("shows the diff being approved OPEN — 'Allow' on a change nobody has seen is not consent", () => {
    ask("Edit", { file_path: "/a.ts", old_string: "const timeout = 30;", new_string: "const timeout = 60;" });
    expect(q(".permission-preview .fd-line")).toHaveLength(2);
    expect(text(".fd-mark")).toEqual(["3", "6"]);
    // The disclosure is still there, still shut, and still holds the exact payload.
    expect(q("details.permission-details")[0]).not.toHaveAttribute("open");
    expect(q("details.permission-details pre")[0]).toHaveTextContent('"old_string"');
  });

  it("keeps the plain 'Input' label where there is no drawing, so nothing reads as a lesser copy", () => {
    ask("mcp__x__do", { anything: 1 });
    expect(q(".permission-preview")).toHaveLength(0);
    expect(q("details.permission-details summary")[0]).toHaveTextContent("Input");
  });
});
