import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { ToolCard, ToolCwd, ToolGroup, RESULT_CLAMP } from "./ToolCard";
import { editStat, failureReason, mcpParts, statedExit, toolVerb } from "./tool-summary";
import * as summaryModule from "./tool-summary";
import { GROUP_MIN, formatDuration, formatToolRun, groupTranscript, summarizeToolRun, withEnter, type ToolBlock, type ToolNode } from "./tool-group";
import { stampLabel, stampTitle } from "./timestamps";
import { Transcript } from "./Transcript";
import { waitingToolIds, type Block, type PendingPermission, type Transcript as TranscriptModel } from "./transcript-model";

const block = (content: string, isError = false): ToolBlock =>
  ({ kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "ls" }, result: { content, isError }, ts: 0 });

const mount = (content: string) => render(<ToolCard block={block(content)} sessionStatus="idle" />);
const openCard = () => fireEvent.click(screen.getByRole("button", { name: /Bash tool call/ }));
const resultWell = () => document.querySelector<HTMLElement>(".tool-section:last-child .tool-well")!;

afterEach(() => cleanup());

/** ⌥-click on a disclosure, Finder's gesture, applied to the ledger. It is unadvertised, so the
 *  thing to hold is that it stays out of the way: a plain click must be exactly what it was, and one
 *  press must not cascade into a second round of presses. */
describe("⌥-click opens the whole ledger", () => {
  // Prose between the calls, because a run of GROUP_MIN folds into a ToolGroup and the cards inside a
  // closed one are not rendered at all. Three cards standing on their own is the shape under test.
  const three = (): TranscriptModel => ({
    blocks: (["a", "b", "c"].flatMap((id, i) => [
      { kind: "tool", toolUseId: id, name: "Bash", input: { command: id }, result: { content: id, isError: false }, ts: i * 2 },
      { kind: "assistant", messageId: `m${i}`, text: "and then", streaming: false, ts: i * 2 + 1 },
    ]) as Block[]),
    pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null,
  });
  const rows = () => screen.getAllByRole("button", { name: /tool call/ });
  const openStates = () => rows().map((r) => r.getAttribute("aria-expanded"));

  it("a plain click still opens only the card it landed on", () => {
    render(<Transcript transcript={three()} sessionStatus="idle" onDecide={() => {}} />);
    fireEvent.click(rows()[0]!);
    expect(openStates()).toEqual(["true", "false", "false"]);
  });

  it("⌥-click carries every other card to the SAME state, rather than flipping each to its own", () => {
    render(<Transcript transcript={three()} sessionStatus="idle" onDecide={() => {}} />);
    fireEvent.click(rows()[1]!); // one card already open, so a blind toggle-all would close it
    fireEvent.click(rows()[0]!, { altKey: true });
    expect(openStates()).toEqual(["true", "true", "true"]);
    fireEvent.click(rows()[0]!, { altKey: true });
    expect(openStates()).toEqual(["false", "false", "false"]);
  });

  it("does not cascade: the clicks it sends carry no modifier of their own", () => {
    // Each synthetic press re-enters the same handler, so a press that inherited `altKey` would send
    // its own round — quadratic on a transcript that runs to hundreds of cards.
    render(<Transcript transcript={three()} sessionStatus="idle" onDecide={() => {}} />);
    const presses = vi.spyOn(HTMLElement.prototype, "click");
    fireEvent.click(rows()[0]!, { altKey: true });
    expect(presses).toHaveBeenCalledTimes(2); // the two siblings, and nothing they went on to press
    presses.mockRestore();
  });
});

describe("ToolCard output clamp (A-M2)", () => {
  it("a result at exactly the clamp limit renders in full with no expander", () => {
    mount("x".repeat(RESULT_CLAMP));
    openCard();
    expect(resultWell().textContent).toHaveLength(RESULT_CLAMP);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("one char over the limit clamps to exactly the limit and offers 'Show all (N KB)'; clicking expands to the full text", () => {
    const content = "a".repeat(RESULT_CLAMP) + "Z";
    mount(content);
    openCard();
    expect(resultWell().textContent).toHaveLength(RESULT_CLAMP);
    expect(resultWell().textContent!.endsWith("Z")).toBe(false);
    const expand = screen.getByRole("button", { name: `Show all (${Math.ceil(content.length / 1024)} KB)` });
    fireEvent.click(expand);
    expect(resultWell().textContent).toHaveLength(content.length);
    expect(resultWell().textContent!.endsWith("Z")).toBe(true);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

describe("ToolCard copy buttons (A-M3)", () => {
  it("copies the full input/result text to the clipboard — the untruncated text, even while clamped", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const content = "b".repeat(RESULT_CLAMP) + "END";
    mount(content);
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    expect(writeText).toHaveBeenCalledWith(content);
    fireEvent.click(screen.getByRole("button", { name: "Copy arguments" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("ls"));
  });
});

/** A finished tool call. `ts` is a millisecond stamp, as it is on the wire. */
const tool = (id: string, name: string, input: Record<string, unknown>, ts = 0, done = true): ToolBlock =>
  ({ kind: "tool", toolUseId: id, name, input, result: done ? { content: "ok", isError: false } : null, ts });
const say = (text: string): Block => ({ kind: "assistant", messageId: text, text, streaming: false, ts: 0 });

describe("tool-run grouping (§5: group consecutive tools under a collapsed summary line)", () => {
  it(`leaves a run shorter than ${GROUP_MIN} inline`, () => {
    const blocks = [tool("t1", "Read", { file_path: "/a" })];
    expect(groupTranscript(blocks).map((i) => i.kind)).toEqual(["block"]);
  });

  it(`folds a run of ${GROUP_MIN} or more into one group, keeping each card's ungrouped key`, () => {
    const blocks = [tool("t1", "Read", {}), tool("t2", "Read", {})];
    const items = groupTranscript(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("group");
    expect(items[0]!.kind === "group" && items[0]!.steps.map((s) => s.key)).toEqual(["tool:t1", "tool:t2"]);
    expect(items[0]!.key).toBe("group:tool:t1");
  });

  it("a non-tool block breaks the run: a lone tool + prose + 3 tools yields a block, prose, one group", () => {
    const items = groupTranscript([
      tool("t1", "Read", {}),
      say("thinking out loud"),
      tool("t3", "Read", {}), tool("t4", "Read", {}), tool("t5", "Read", {}),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["block", "block", "group"]);
    expect(items[2]!.kind === "group" && items[2]!.steps).toHaveLength(3);
  });

  it("non-tool blocks keep the positional keys the transcript renders them under", () => {
    const items = groupTranscript([say("a"), say("b")]);
    expect(items.map((i) => i.key)).toEqual(["assistant:0", "assistant:1"]);
  });

  it("never folds a call that drew a view: the view is what the call was for", () => {
    // THE MUTANT: let it fold, and a settled run shows "Worked for 8s" with the chart behind it.
    const chart: ToolBlock = { ...tool("t2", "mcp__realm__Charts__show_chart", {}), view: { viewId: "V1", serverId: "S1", serverName: "Charts", tool: "show_chart" } };
    const items = groupTranscript([tool("t1", "Read", {}), chart, tool("t3", "Read", {}), tool("t4", "Read", {})]);
    expect(items.map((i) => i.kind)).toEqual(["block", "block", "group"]);
    expect(items[1]!.kind === "block" && items[1]!.block).toBe(chart);
  });
});

/** A tool call a sub-agent made: same shape, plus the Task call it was made under. */
const sub = (id: string, parent: string, name: string, input: Record<string, unknown>, ts = 0, done = true): ToolBlock =>
  ({ ...tool(id, name, input, ts, done), parentToolUseId: parent });

describe("in-harness sub-agents (Claude's parent_tool_use_id)", () => {
  it("hangs a sub-agent's calls off the Task call that spawned them instead of leaving them in the stream", () => {
    const items = groupTranscript([
      tool("task1", "Task", { description: "audit the mapper" }),
      sub("s1", "task1", "Read", { file_path: "/a.ts" }),
      sub("s2", "task1", "Grep", { pattern: "foo" }),
    ]);
    // Kills "ignore parentToolUseId and keep folding by position": that renders three sibling cards
    // in one run, and the reader cannot tell which two the sub-agent made.
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === "block" && items[0]!.block.kind === "tool" && items[0]!.block.name).toBe("Task");
    expect(items[0]!.kind === "block" && items[0]!.nested.map((n) => n.key)).toEqual(["tool:s1", "tool:s2"]);
  });

  it("closes the gap the lifted calls leave: the parent's own calls either side of them become one run", () => {
    const items = groupTranscript([
      tool("t1", "Read", { file_path: "/a" }),
      sub("s1", "task1", "Read", { file_path: "/x" }),
      tool("t2", "Read", { file_path: "/b" }),
    ]);
    // s1 names a parent this transcript does not hold, so it stays top-level and splits the run.
    expect(items.map((i) => i.kind)).toEqual(["group"]);
    expect(items[0]!.kind === "group" && items[0]!.steps.map((x) => x.key)).toEqual(["tool:t1", "tool:s1", "tool:t2"]);

    const withParent = groupTranscript([
      tool("task1", "Task", { description: "go" }),
      tool("t1", "Read", { file_path: "/a" }),
      sub("s1", "task1", "Read", { file_path: "/x" }),
      tool("t2", "Read", { file_path: "/b" }),
    ]);
    // Kills "lift the child but leave a hole where it was": t1 and t2 were one run all along, and a
    // hole would have them read as two separate stretches of work.
    expect(withParent.map((i) => i.kind)).toEqual(["group"]);
    expect(withParent[0]!.kind === "group" && withParent[0]!.steps.map((x) => x.key)).toEqual(["tool:task1", "tool:t1", "tool:t2"]);
  });

  it("nests recursively, and never loses a call to an id it cannot resolve", () => {
    const flatKeys = (ns: readonly ToolNode[]): string[] => ns.flatMap((n) => [n.key, ...flatKeys(n.nested)]);
    const items = groupTranscript([
      tool("task1", "Task", { description: "outer" }),
      sub("task2", "task1", "Task", { description: "inner" }),
      sub("s1", "task2", "Bash", { command: "ls" }),
      sub("orphan", "gone", "Read", { file_path: "/o" }),
      sub("selfie", "selfie", "Read", { file_path: "/s" }),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0]!;
    // Kills "drop any call whose parent cannot be resolved", which silently swallows work the agent
    // really did — and kills losing a self-referential id down its own hole.
    expect(group.kind === "group" && group.steps.map((x) => x.key)).toEqual(["tool:task1", "tool:orphan", "tool:selfie"]);
    expect(group.kind === "group" && flatKeys(group.steps[0]!.nested)).toEqual(["tool:task2", "tool:s1"]);
  });

  it("cannot be talked into a cycle by two calls naming each other", () => {
    const items = groupTranscript([
      sub("ping", "pong", "Read", { file_path: "/p" }),
      sub("pong", "ping", "Read", { file_path: "/q" }),
    ]);
    // A parent is only ever a call already seen. THE MUTANT: resolve against every call in the
    // transcript instead, and this pair nests into each other — both leave the render entirely, and
    // walking the tree to mark enter flags recurses until the stack goes.
    expect(items.map((i) => i.key)).toEqual(["tool:ping"]);
    expect(items[0]!.kind === "block" && items[0]!.nested.map((n) => n.key)).toEqual(["tool:pong"]);
  });

  it("counts the sub-agent's calls in the run that spawned them, over the run's real span", () => {
    // The child outlives the parent's own next call, which is the ordinary shape: they run
    // concurrently, so the LAST call in tree order is not the last one to happen.
    const items = groupTranscript([
      tool("t1", "Read", { file_path: "/a.ts" }, 1_000),
      tool("task1", "Task", { description: "audit" }, 2_000),
      tool("t2", "Read", { file_path: "/c.ts" }, 5_000),
      sub("s1", "task1", "Read", { file_path: "/b.ts" }, 302_000),
    ]);
    const group = items[0]!;
    render(<ToolGroup steps={withEnter(group.kind === "group" ? group.steps : [], () => false)} sessionStatus="idle" />);
    // TWO MUTANTS. Summarize the top-level steps alone: nesting took the child's call out of the run,
    // so the counts under-report it and the span ends when the parent stopped, not when the work did.
    // Or keep first→last instead of min→max: tree order ends on `t2` at 5s, and a row that ticked
    // upward for five minutes would freeze at "3s" the instant it settled.
    const row = screen.getByRole("button", { name: "4 tool calls" });
    expect(row).toHaveTextContent("Worked for 5m 1s");
    expect(row).toHaveAttribute("title", "4 tools · 3 files · 5m 1s");
  });

  it("draws the sub-agent's steps under its Task row, labelled as the sub-agent's own work", () => {
    const nested = [
      { key: "tool:s1", block: sub("s1", "task1", "Read", { file_path: "/a.ts" }), enter: false, nested: [] },
      { key: "tool:s2", block: sub("s2", "task1", "Bash", { command: "pnpm test" }, 0, false), enter: false, nested: [] },
    ];
    render(<ToolCard sessionStatus="running" nested={nested}
      block={{ kind: "tool", toolUseId: "task1", name: "Task", input: { description: "audit the mapper" }, result: null, ts: 0 }} />);
    // Named apart from the agent's own runs: directly under a Task row, a bare "Worked for" reads as
    // the Task's elapsed time rather than the child's.
    const row = screen.getByRole("button", { name: "2 sub-agent tool calls" });
    expect(row).toHaveTextContent("Sub-agent worked for");
    // Open while the child is still working — the one thing this treatment must not do is collapse
    // live activity out of sight.
    expect(cards().map((c) => c.querySelector(".tool-name")!.textContent)).toEqual(["Delegate", "Read", "Run"]);
  });
});

describe("tool-run summary line", () => {
  it("counts distinct files, not file touches — reading one file four times edited one file", () => {
    const s = summarizeToolRun([
      tool("t1", "Read", { file_path: "/a.ts" }), tool("t2", "Read", { file_path: "/a.ts" }),
      tool("t3", "Edit", { file_path: "/a.ts" }), tool("t4", "Write", { file_path: "/b.ts" }),
    ]);
    expect(s.files).toBe(2);
    expect(s.tools).toBe(4);
  });

  it("counts shell tools as commands and measures the run from first to last stamp", () => {
    const s = summarizeToolRun([
      tool("t1", "Bash", { command: "ls" }, 1_000),
      tool("t2", "Read", { file_path: "/a" }, 2_000),
      tool("t3", "exec_command", { command: "pwd" }, 373_000),
    ]);
    expect(s).toMatchObject({ tools: 3, files: 1, commands: 2, reads: 1, durationMs: 372_000 });
  });

  it("renders the ledger line, dropping the parts that are zero", () => {
    expect(formatToolRun({ tools: 18, files: 5, commands: 2, durationMs: 372_000 })).toBe("18 tools · 5 files · 2 commands · 6m 12s");
    expect(formatToolRun({ tools: 3, files: 0, commands: 0, durationMs: 0 })).toBe("3 tools");
    expect(formatToolRun({ tools: 1, files: 1, commands: 1, durationMs: 4_000 })).toBe("1 tool · 1 file · 1 command · 4s");
  });

  it("formats the collapsed row's `Worked for` duration — a sub-second run says <1s, never 0s", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(400)).toBe("<1s");
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(372_000)).toBe("6m 12s");
    // Past the hour the seconds are noise, and "62m 3s" is arithmetic the reader should not do.
    expect(formatDuration(3_723_000)).toBe("1h 2m");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
  });
});

describe("editStat (Plan 9 W2: ThinkingState's measured +/− counts)", () => {
  /* Plan 24 W1 moved these onto the same diff the card below the row now draws (`fileDiffsFor`), so
     the two can never disagree — and so the counts mean what a diff means. The old arithmetic
     counted every line of an Edit's two fragments, calling a one-line change inside twenty lines of
     unchanged context "+20 −20". */
  it("counts an Edit's CHANGED lines — context on both sides is not a change", () => {
    expect(editStat("Edit", { file_path: "/a", old_string: "one", new_string: "one\ntwo" })).toEqual({ add: 1, del: 0 });
    expect(editStat("Edit", { file_path: "/a", old_string: "", new_string: "x" })).toEqual({ add: 1, del: 0 });
    expect(editStat("Edit", { file_path: "/a", old_string: "a\nb", new_string: "a\nB" })).toEqual({ add: 1, del: 1 });
  });

  it("sums a MultiEdit's edits and counts a Write's content as pure adds", () => {
    expect(editStat("MultiEdit", { edits: [
      { old_string: "a", new_string: "a\nb" },
      { old_string: "c\nd", new_string: "e" },
    ] })).toEqual({ add: 2, del: 2 });
    expect(editStat("Write", { file_path: "/a", content: "l1\nl2\nl3" })).toEqual({ add: 3, del: 0 });
  });

  it("counts an apply_patch off the patch it was handed", () => {
    expect(editStat("apply_patch", { changes: [{ path: "/a", diff: "--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx" }] })).toEqual({ add: 1, del: 1 });
  });

  it("refuses to invent counts where the payload does not carry both sides", () => {
    expect(editStat("Edit", { file_path: "/a" })).toBeNull();       // permission previews carry no strings
    expect(editStat("Read", { file_path: "/a" })).toBeNull();
    expect(editStat("Bash", { command: "ls" })).toBeNull();
    expect(editStat("MultiEdit", { edits: "nope" })).toBeNull();
    expect(editStat("apply_patch", { changes: [{ path: "/a" }] })).toBeNull();
    // An Edit that changes nothing has nothing to count, and "+0 −0" on the row says otherwise.
    expect(editStat("Edit", { file_path: "/a", old_string: "same", new_string: "same" })).toBeNull();
  });

  it("renders the counts on the row — green adds, red deletes, and no zero side", () => {
    render(<ToolCard sessionStatus="idle" block={
      { kind: "tool", toolUseId: "t1", name: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "x\ny\nz" }, result: { content: "ok", isError: false }, ts: 0 }
    } />);
    const stat = document.querySelector(".tool-stat")!;
    expect(stat.querySelector(".tool-stat-add")).toHaveTextContent("+2");
    expect(stat.querySelector(".tool-stat-del")).toBeNull();
  });
});

describe("an edit's row names the file it changed, one way for every agent", () => {
  const row = (b: ToolBlock, cwd: string | null = "/w/app") => {
    render(<ToolCwd.Provider value={cwd}><ToolCard sessionStatus="idle" block={b} /></ToolCwd.Provider>);
    const file = document.querySelector<HTMLElement>(".tool-row .tool-file");
    return { file, stat: document.querySelector(".tool-row .tool-stat")?.textContent ?? null };
  };
  const ok = { content: "ok", isError: false };

  it("draws Claude's Edit as the file's mark, its directory from where the agent stands, its name, and the counts", () => {
    const { file, stat } = row({ kind: "tool", toolUseId: "t1", name: "Edit", ts: 0, result: ok,
      input: { file_path: "/w/app/web/lib/orgs.ts", old_string: "a", new_string: "a\nb" } });
    expect(file!.querySelector(".tool-file-dir")!.textContent).toBe("web/lib/");
    expect(file!.querySelector(".tool-file-name")!.textContent).toBe("orgs.ts");
    // The file's mark is the row's lead glyph now, drawn once rather than beside the path as well.
    expect(document.querySelector(".tool-status [data-glyph]")).toHaveAttribute("data-glyph", "typescript");
    expect(file!.querySelector("svg")).toBeNull();
    expect(file!.title).toBe("/w/app/web/lib/orgs.ts");
    expect(stat).toBe("+1");
    // The raw-path chip is gone for an edit: the file IS the target.
    expect(document.querySelector(".tool-row .tool-summary")).toBeNull();
  });

  it("names a Codex patch by its first file, and says how many more it carried", () => {
    const { file, stat } = row({ kind: "tool", toolUseId: "t1", name: "apply_patch", ts: 0, result: ok, input: { changes: [
      { path: "/w/app/a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y" }, { path: "/w/app/b.ts" }, { path: "/w/app/c.ts" }] } });
    expect(file!.querySelector(".tool-file-name")!.textContent).toBe("a.ts");
    expect(file!.querySelector(".tool-file-more")!.textContent).toBe("and 2 more");
    expect(stat).toBe("+1−1");
  });

  it("reads an ACP agent's edit from what it said — its kind, its location, the diff in its result", () => {
    const { file, stat } = row({ kind: "tool", toolUseId: "t1", name: "Editing orgs.ts", ts: 0, toolKind: "edit", paths: ["/w/app/web/lib/orgs.ts"], input: {},
      result: { content: "--- /w/app/web/lib/orgs.ts\n+++ /w/app/web/lib/orgs.ts\n@@ -3,1 +3,2 @@\n-three\n+THREE\n+four", isError: false } });
    expect(file!.querySelector(".tool-file-name")!.textContent).toBe("orgs.ts");
    expect(stat).toBe("+2−1");
  });

  it("leaves every call that edits nothing exactly as it was", () => {
    row({ kind: "tool", toolUseId: "t1", name: "Bash", ts: 0, result: ok, input: { command: "npm test" } });
    expect(document.querySelector(".tool-row .tool-file")).toBeNull();
    expect(document.querySelector(".tool-row .tool-summary")!.textContent).toBe("npm test");
  });

  it("says a path whole when no session tells it where the agent stood", () => {
    const { file } = row({ kind: "tool", toolUseId: "t1", name: "Write", ts: 0, result: ok, input: { file_path: "/w/app/notes.md", content: "x" } }, null);
    expect(file!.querySelector(".tool-file-dir")!.textContent).toBe("/w/app/");
  });
});

const steps = (blocks: ToolBlock[]) => blocks.map((b) => ({ key: b.toolUseId, block: b, enter: false, nested: [] }));
const cards = () => [...document.querySelectorAll<HTMLElement>(".tool-card")];
const bodyOf = (card: HTMLElement) => card.querySelector(".tool-body");

describe("ToolGroup", () => {
  const run = [
    tool("t1", "Bash", { command: "alpha-cmd" }),
    tool("t2", "Bash", { command: "bravo-cmd" }),
    tool("t3", "Read", { file_path: "/charlie.ts" }),
  ];

  it("a finished run collapses to its `Worked for` row (Ara refresh §4) and shows no cards; the counts line survives as the tooltip", () => {
    render(<ToolGroup steps={steps(run)} sessionStatus="idle" />);
    const row = screen.getByRole("button", { name: "3 tool calls" });
    expect(row).toHaveTextContent("Worked for <1s"); // all three stamps are 0 — settled, sub-second
    expect(row).toHaveAttribute("title", "3 tools · 1 file · 2 commands");
    expect(cards()).toHaveLength(0);
  });

  it("the collapsed row live-ticks off the run's first stamp while working, then freezes on first→last when settled", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const working = [
        tool("t1", "Bash", { command: "ls" }, 90_000),
        tool("t2", "Read", { file_path: "/a" }, 95_000),
        tool("t3", "Read", { file_path: "/b" }, 98_000, false), // still running
      ];
      const { rerender } = render(<ToolGroup steps={steps(working)} sessionStatus="running" />);
      const row = () => screen.getByRole("button", { name: "3 tool calls" });
      expect(row()).toHaveTextContent("Worked for 10s"); // now − first stamp, not last − first
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(row()).toHaveTextContent("Worked for 15s"); // ticking
      // The run settles: the label freezes on the group's own stamps and stops ticking.
      const settled = [working[0]!, working[1]!, tool("t3", "Read", { file_path: "/b" }, 98_000)];
      rerender(<ToolGroup steps={steps(settled)} sessionStatus="idle" />);
      expect(row()).toHaveTextContent("Worked for 8s"); // 98s − 90s
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(row()).toHaveTextContent("Worked for 8s"); // frozen
    } finally { vi.useRealTimers(); }
  });

  it("expanding reveals every step of the run", () => {
    render(<ToolGroup steps={steps(run)} sessionStatus="idle" />);
    fireEvent.click(screen.getByRole("button", { name: "3 tool calls" }));
    expect(cards()).toHaveLength(3);
  });

  it("expanding a step inside a group opens THAT step and no other", () => {
    render(<ToolGroup steps={steps(run)} sessionStatus="idle" />);
    fireEvent.click(screen.getByRole("button", { name: "3 tool calls" }));
    const [first, second, third] = cards();
    fireEvent.click(within(second!).getByRole("button", { name: /Bash tool call/ }));
    expect(second).toHaveAttribute("data-open");
    expect(bodyOf(second!)).toHaveTextContent("bravo-cmd");
    for (const other of [first!, third!]) {
      expect(other).not.toHaveAttribute("data-open");
      expect(bodyOf(other)).toBeNull(); // never built, so it cannot be showing the wrong input
    }
  });

  it("opens itself while the agent is still working through the run, so live activity is never hidden", () => {
    const live = [run[0]!, run[1]!, tool("t3", "Read", { file_path: "/c" }, 0, false)];
    render(<ToolGroup steps={steps(live)} sessionStatus="running" />);
    expect(cards()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "3 tool calls" })); // and a manual collapse wins
    expect(cards()).toHaveLength(0);
  });

  it("does not auto-open a finished run just because the session is live again", () => {
    render(<ToolGroup steps={steps(run)} sessionStatus="running" />);
    expect(cards()).toHaveLength(0);
  });

  /** Plan 9 W2 mutant: ThinkingState marking a step done while its tool call is still unsettled.
   *  The spinner→check progression must be each block's REAL result, never a clock. */
  it("a step settles only when its own result lands: unfinished steps say running, finished say done", () => {
    const live = [run[0]!, run[1]!, tool("t3", "Read", { file_path: "/c" }, 0, false)];
    const { rerender } = render(<ToolGroup steps={steps(live)} sessionStatus="running" />);
    const labels = () => cards().map((c) => c.querySelector(".tool-status")!.getAttribute("aria-label"));
    expect(labels()).toEqual(["done", "done", "running"]);
    // The header shimmers exactly while a step is unsettled — data-working is derived, not timed.
    expect(document.querySelector(".tool-group")).toHaveAttribute("data-working");
    rerender(<ToolGroup steps={steps([run[0]!, run[1]!, tool("t3", "Read", { file_path: "/c" })])} sessionStatus="running" />);
    expect(document.querySelector(".tool-group")).not.toHaveAttribute("data-working");
    fireEvent.click(screen.getByRole("button", { name: "3 tool calls" })); // settled runs fold; reopen to see the steps
    expect(labels()).toEqual(["done", "done", "done"]);
  });
});

describe("ToolCard expand (§6: grid-template-rows, content mounted on both sides of the flip)", () => {
  it("builds no body until the first open, then keeps it built so the collapse animates too", () => {
    mount("hello-result");
    const card = cards()[0]!;
    expect(bodyOf(card)).toBeNull();
    expect(card.querySelector(".tool-body-wrap")).not.toBeNull(); // the animating row exists from the start
    openCard();
    expect(bodyOf(card)).toHaveTextContent("hello-result");
    expect(card.querySelector(".tool-body-clip")).not.toHaveAttribute("inert");
    openCard(); // collapse
    expect(card).not.toHaveAttribute("data-open");
    expect(bodyOf(card)).not.toBeNull();
    // Still in the DOM, so it must be out of the tab order and the a11y tree while hidden.
    expect(card.querySelector(".tool-body-clip")).toHaveAttribute("inert");
  });
});

describe("copy ✓ (§6 icon swap)", () => {
  beforeEach(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true }); });

  it("flips to the check glyph on copy and back after a beat — both glyphs stay mounted to cross-fade", () => {
    vi.useFakeTimers();
    try {
      mount("x");
      openCard();
      fireEvent.click(screen.getByRole("button", { name: "Show raw" }));
      const copy = screen.getByRole("button", { name: "Copy result" });
      expect(copy.querySelector(".copy-icon")).not.toBeNull();
      expect(copy.querySelector(".copied-icon")).not.toBeNull();
      expect(copy).not.toHaveAttribute("data-copied");
      fireEvent.click(copy);
      expect(copy).toHaveAttribute("data-copied");
      expect(screen.getByRole("button", { name: "Copy result" })).toBe(copy); // name never changes
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(copy).not.toHaveAttribute("data-copied");
    } finally { vi.useRealTimers(); }
  });
});

describe("tool groups inside the transcript", () => {
  const model = (blocks: Block[]): TranscriptModel =>
    ({ blocks, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null });
  const run = (n: number) => model(Array.from({ length: n }, (_, k) => tool(`t${k + 1}`, "Read", { file_path: `/f${k}.ts` })));
  const view = (n: number) => <Transcript transcript={run(n)} sessionStatus="idle" onDecide={() => {}} />;

  it("keeps the group's expanded state — and each card's — as more tools land in the run", () => {
    const { rerender } = render(view(3));
    fireEvent.click(screen.getByRole("button", { name: "3 tool calls" }));
    fireEvent.click(within(cards()[1]!).getByRole("button", { name: /Read tool call/ }));
    rerender(view(4));
    expect(screen.getByRole("button", { name: "4 tool calls" })).toBeInTheDocument();
    expect(cards()).toHaveLength(4);            // still expanded: the group was not remounted
    expect(cards()[1]).toHaveAttribute("data-open"); // and the open card is still the one opened
    expect(cards()[0]).not.toHaveAttribute("data-open");
  });
});

/* The transcript re-renders on every frame of a streaming answer. Settled tool cards must not come
   with it: re-deriving 300 summaries and edit stats 60 times a second, behind a message the reader
   is watching type, is work with nothing at the end of it. `toolSummary` is the observable proxy —
   ToolCard calls it exactly once per render. */
describe("settled tool cards do not re-render behind a streaming answer", () => {
  it("re-derives nothing for cards whose call has landed", () => {
    const cards: ToolBlock[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "tool", toolUseId: `t${i}`, name: "Bash", input: { command: `echo ${i}` },
      result: { content: "ok", isError: false }, ts: i,
    }));
    // Below GROUP_MIN consecutive calls per run would fold them into a ToolGroup, so each card is
    // separated by a message — this is a transcript of individual cards, which is what we're counting.
    const settled: Block[] = cards.flatMap((c, i) => [{ kind: "user", text: `q${i}`, ts: i } as Block, c]);
    const withStream = (text: string): TranscriptModel => ({
      blocks: [...settled, { kind: "assistant", messageId: "live", text, streaming: true, ts: 99 }],
      pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null,
    });

    const spy = vi.spyOn(summaryModule, "toolSummary");
    const view = render(<Transcript transcript={withStream("Hel")} sessionStatus="running" onDecide={() => {}} />);
    expect(spy).toHaveBeenCalledTimes(cards.length); // the first paint derives each card once
    expect(document.querySelectorAll(".tool-card")).toHaveLength(cards.length);

    // Ten more deltas land. The blocks array is rebuilt each time (as the reducer does) but every
    // settled card keeps its object, so none of them re-derives.
    spy.mockClear();
    for (const text of ["Hell", "Hello", "Hello ", "Hello w", "Hello wo", "Hello wor", "Hello worl", "Hello world", "Hello world!", "Hello world!!"])
      view.rerender(<Transcript transcript={withStream(text)} sessionStatus="running" onDecide={() => {}} />);
    expect(spy).toHaveBeenCalledTimes(0);
    // Read as the message's text rather than as one text node: text that arrived mid-stream is split
    // across the prose's arrival-fade spans, the same way bold or a link would split it.
    expect(document.querySelector(".msg-assistant")!.textContent).toContain("Hello world!!");

    // A card that actually changes still re-renders: its block is a new object.
    const landed = withStream("Hello world!!");
    landed.blocks[1] = { ...cards[0]!, result: { content: "changed", isError: true } };
    view.rerender(<Transcript transcript={landed} sessionStatus="running" onDecide={() => {}} />);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("when a turn finished", () => {
  const ts = new Date(2026, 8, 7, 16, 12).getTime();

  it("rides the settled run line beside the duration, dated from the settle and not from now", () => {
    const blocks: Block[] = [{ kind: "run", ms: 125_000, startedAt: ts - 125_000, ts }];
    const t: TranscriptModel = { blocks, pendingPermissions: [],
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null };
    render(<Transcript transcript={t} sessionStatus="idle" onDecide={() => {}} />);
    const line = document.querySelector(".msg-run")!;
    expect(line.textContent).toContain("2m");
    const at = within(line as HTMLElement).getByTitle(stampTitle(ts));
    expect(at.textContent).toBe(stampLabel(ts, Date.now()));
    expect(at.getAttribute("datetime")).toBe(new Date(ts).toISOString());
  });
});

/* The row's anatomy: [lead] [verb] [object] [meta] [›]. The verb is the act in a plain word, the same
   for every agent, and the raw tool name moves to the tooltip and the accessible name. */
describe("the row says what the act is, not what the tool is called", () => {
  it("one verb per family of tools, whichever agent made the call", () => {
    const cases: [string, string][] = [
      ["Bash", "Run"], ["exec_command", "Run"],
      ["Edit", "Edit"], ["MultiEdit", "Edit"], ["apply_patch", "Edit"], ["Write", "Write"],
      ["Read", "Read"], ["Grep", "Search"], ["Glob", "Find files"],
      ["WebFetch", "Fetch"], ["WebSearch", "Search web"], ["TodoWrite", "Plan"], ["Task", "Delegate"],
      // An MCP call is its tool's own name said plainly, its server named apart.
      ["mcp__linear__save_issue", "Save issue"], ["mcp__realm__realm-browser__browser_open", "Browser open"],
      // A tool Realm has no word for keeps its bare name rather than gaining one it never had.
      ["frobnicate", "frobnicate"],
    ];
    for (const [name, verb] of cases) expect(toolVerb(name), name).toBe(verb);
    // An ACP agent names a call with a sentence; its stated kind is what the act was.
    expect(toolVerb("Editing orgs.ts", "edit")).toBe("Edit");
    expect(toolVerb("Running tests", "execute")).toBe("Run");
  });

  it("splits an MCP name into the server a person would name and its tool", () => {
    expect(mcpParts("mcp__linear__save_issue")).toEqual({ server: "Linear", tool: "save_issue" });
    expect(mcpParts("mcp__claude_ai_Linear__save_issue")).toEqual({ server: "Linear", tool: "save_issue" });
    expect(mcpParts("mcp__realm__realm-browser__browser_open")).toEqual({ server: "Realm", tool: "browser_open" });
    expect(mcpParts("Bash")).toBeNull();
  });

  it("draws the verb, the server before the object, and keeps the raw name in the title and the accessible name", () => {
    render(<ToolCard sessionStatus="idle" block={tool("t1", "mcp__linear__save_issue", { title: "Tool card redesign", team: "REA" })} />);
    const row = screen.getByRole("button", { name: "mcp__linear__save_issue tool call" });
    expect(row).toHaveAttribute("title", "mcp__linear__save_issue");
    expect(row.querySelector(".tool-name")).toHaveTextContent(/^Save issue$/);
    expect(row.querySelector(".tool-server")).toHaveTextContent("Linear");
    expect(row.querySelector(".tool-summary")).toHaveTextContent("Tool card redesign");
    // The vendor's own mark leads the row.
    expect(row.querySelector(".tool-status [data-glyph]")).toHaveAttribute("data-glyph", "linear");
  });

  it("sets a command as code and a query as quoted prose, with where it looked", () => {
    render(<>
      <ToolCard sessionStatus="idle" block={tool("t1", "Bash", { command: "pnpm test\nexit" })} />
      <ToolCard sessionStatus="idle" block={tool("t2", "Grep", { pattern: "isDelegationLine", path: "apps/desktop" })} />
    </>);
    const [run, search] = [...document.querySelectorAll(".tool-summary")];
    expect(run).toHaveAttribute("data-form", "code");
    expect(search).toHaveAttribute("data-form", "prose");
    expect(search).toHaveTextContent("“isDelegationLine” in apps/desktop");
  });

  it("a settled call leads with what KIND of act it was — never a column of identical ticks", () => {
    render(<>
      <ToolCard sessionStatus="idle" block={tool("t1", "Bash", { command: "ls" })} />
      <ToolCard sessionStatus="idle" block={tool("t2", "Grep", { pattern: "x" })} />
      <ToolCard sessionStatus="idle" block={tool("t3", "Task", { description: "audit" })} />
    </>);
    const glyphs = [...document.querySelectorAll(".tool-status [data-glyph]")].map((g) => g.getAttribute("data-glyph"));
    expect(glyphs).toEqual(["terminal", "search", "agents"]);
    // The state layer is empty and not shown: a settled ok call carries no glyph for its state.
    for (const status of document.querySelectorAll(".tool-status")) {
      expect(status).not.toHaveAttribute("data-on");
      expect(status.querySelector(".swap-on")!.childElementCount).toBe(0);
    }
  });
});

describe("the row's state reads without colour alone", () => {
  const pending = (id: string, name: string, input: Record<string, unknown>): ToolBlock =>
    ({ kind: "tool", toolUseId: id, name, input, result: null, ts: 0 });
  const failed = (content: string): ToolBlock =>
    ({ kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "pnpm typecheck" }, result: { content, isError: true }, ts: 0 });

  it("a call that never got a result says Stopped, in a word", () => {
    render(<ToolCard sessionStatus="idle" block={pending("t1", "Bash", { command: "pnpm dev" })} />);
    expect(document.querySelector(".tool-card")).toHaveAttribute("data-state", "none");
    expect(document.querySelector(".tool-meta")).toHaveTextContent(/^Stopped$/);
    expect(screen.getByRole("img", { name: "stopped" })).toBeInTheDocument();
  });

  it("a running call says how long it has been at it once that is worth reading, and not before", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      render(<ToolCard sessionStatus="running" block={{ ...pending("t1", "Bash", { command: "pnpm test" }), ts: 9_000 }} />);
      expect(document.querySelector(".tool-meta")).toBeNull(); // 1s in: a number would only flicker
      act(() => { vi.advanceTimersByTime(13_000); });
      expect(document.querySelector(".tool-meta")).toHaveTextContent(/^14s$/);
    } finally { vi.useRealTimers(); }
  });

  it("a failed call shows the error's first line under its row, without opening it", () => {
    render(<ToolCard sessionStatus="idle" block={failed("\n  src/main/index.ts(41,7): error TS2322: Type 'string' is not assignable\nmore")} />);
    const reason = document.querySelector(".tool-reason")!;
    expect(reason).toHaveTextContent(/^src\/main\/index.ts\(41,7\): error TS2322: Type 'string' is not assignable$/);
    expect(reason).toHaveAttribute("title", expect.stringContaining("more"));
    // Outside the expander: the body was never built.
    expect(document.querySelector(".tool-body")).toBeNull();
    expect(document.querySelector(".tool-meta")).toHaveTextContent(/^Failed$/);
    expect(screen.getByRole("img", { name: "failed" })).toBeInTheDocument();
  });

  it("says the exit code only where the payload stated one", () => {
    expect(statedExit("Exit code 2\nboom")).toEqual({ code: 2, rest: "boom" });
    expect(statedExit("boom\n[exit 3]")).toEqual({ code: 3, rest: "boom" });
    expect(statedExit("boom: exit code mentioned in passing")).toBeNull();
    // The stated code is the meta, so the reason line skips it to the words that explain it.
    expect(failureReason("Exit code 2\n\nsrc/a.ts: error")).toBe("src/a.ts: error");
    render(<ToolCard sessionStatus="idle" block={failed("Exit code 2\nsrc/a.ts: error")} />);
    expect(document.querySelector(".tool-meta")).toHaveTextContent(/^exit 2$/);
    expect(document.querySelector(".tool-reason")).toHaveTextContent(/^src\/a.ts: error$/);
  });

  it("a reason line that only introduces what follows carries on into it", () => {
    // "error during build:" alone says nothing; the line after it is the error.
    expect(failureReason("Exit code 1\nerror during build:\n[vite]: Rollup failed to resolve import")).toBe("error during build: [vite]: Rollup failed to resolve import");
    // A colon inside a line is a colon, not a lead-in.
    expect(failureReason("src/a.ts: error\nmore")).toBe("src/a.ts: error");
    expect(failureReason("Failed:")).toBe("Failed:");
  });

  it("an ok call draws no reason line and no state word", () => {
    render(<ToolCard sessionStatus="idle" block={tool("t1", "Bash", { command: "ls" })} />);
    expect(document.querySelector(".tool-reason")).toBeNull();
    expect(document.querySelector(".tool-meta")).toBeNull();
  });
});

describe("a call blocked on the person says Waiting for you", () => {
  const ask = (requestId: string, toolName: string, input: Record<string, unknown>): PendingPermission => ({ requestId, toolName, input, title: toolName });
  const open = (id: string, name: string, input: Record<string, unknown>): Block => ({ kind: "tool", toolUseId: id, name, input, result: null, ts: 0 });

  it("matches each open request to the last unresolved call with the same tool and the same input", () => {
    const blocks = [open("a", "Bash", { command: "rm -rf out" }), open("b", "Bash", { command: "ls" }), open("c", "Bash", { command: "rm -rf out" })];
    expect(waitingToolIds(blocks, [ask("r1", "Bash", { command: "rm -rf out" })])).toEqual(["c"]);
    // Key order is not a different input; a different command is.
    expect(waitingToolIds([open("a", "Edit", { file_path: "/a", old_string: "x" })], [ask("r1", "Edit", { old_string: "x", file_path: "/a" })])).toEqual(["a"]);
    expect(waitingToolIds(blocks, [ask("r1", "Bash", { command: "rm -rf build" })])).toEqual([]);
    // A permission may name a tool bare where its call carries the MCP prefix.
    expect(waitingToolIds([open("m", "mcp__realm__realm-simulator__simulator_tap", { x: 1 })], [ask("r1", "simulator_tap", { x: 1 })])).toEqual(["m"]);
  });

  it("the matched row says it in a word and a shield; another call keeps spinning", () => {
    const t: TranscriptModel = {
      blocks: [open("a", "Bash", { command: "rm -rf out" }), say("meanwhile"), open("b", "Bash", { command: "pnpm test" })],
      pendingPermissions: [ask("r1", "Bash", { command: "rm -rf out" })],
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null,
    };
    render(<Transcript transcript={t} sessionStatus="waiting_permission" onDecide={() => {}} />);
    const [a, b] = cards();
    expect(a).toHaveAttribute("data-state", "waiting");
    expect(a!.querySelector(".tool-meta")).toHaveTextContent(/^Waiting for you$/);
    expect(within(a!).getByRole("img", { name: "waiting for you" })).toBeInTheDocument();
    expect(a!.querySelector(".spinner")).toBeNull();
    expect(b).toHaveAttribute("data-state", "running");
  });
});

describe("a run's head names the work, not only how long it took", () => {
  const edit = (id: string, add: number, del: number, ts = 0): ToolBlock => tool(id, "Edit", {
    file_path: `/w/${id}.ts`,
    old_string: Array.from({ length: del }, (_, i) => `old${i}`).join("\n"),
    new_string: Array.from({ length: add }, (_, i) => `new${i}`).join("\n"),
  }, ts);
  const fail = (id: string, name: string, input: Record<string, unknown>, ts = 0): ToolBlock =>
    ({ kind: "tool", toolUseId: id, name, input, result: { content: "Exit code 1\nboom", isError: true }, ts });
  const run = (): ToolBlock[] => [
    tool("r1", "Read", { file_path: "/w/a.ts" }), tool("r2", "Read", { file_path: "/w/b.ts" }),
    edit("e1", 3, 1), edit("e2", 2, 1),
    tool("c1", "Bash", { command: "pnpm test" }), fail("c2", "Bash", { command: "pnpm typecheck" }),
    tool("g1", "Grep", { pattern: "x" }),
  ];

  it("counts reads, edits with their summed lines, searches and commands, and says what failed", () => {
    const s = summarizeToolRun(run());
    expect(s).toMatchObject({ reads: 2, edits: 2, add: 5, del: 2, searches: 1, commands: 2, failed: 1, liveStep: null });
    render(<ToolGroup steps={steps(run())} sessionStatus="idle" />);
    const row = screen.getByRole("button", { name: "7 tool calls" });
    expect(row.querySelector(".tool-group-work")).toHaveTextContent("· 2 reads · 2 edits +5 −2 · 1 search · 2 commands");
    expect(row.querySelector(".tool-group-failed")).toHaveTextContent("1 failed");
    // The tooltip keeps the old counts line.
    expect(row).toHaveAttribute("title", "7 tools · 4 files · 2 commands");
  });

  it("keeps the failure out of the part that yields, so no width can cut it", () => {
    render(<ToolGroup steps={steps(run())} sessionStatus="idle" />);
    const failed = document.querySelector(".tool-group-failed")!;
    // A sibling of the ellipsized work, after it — never inside it.
    expect(failed.closest(".tool-group-work")).toBeNull();
    expect(failed.previousElementSibling).toHaveClass("tool-group-work");
    expect(failed.querySelector("svg")).not.toBeNull(); // a glyph, so it is not colour alone
  });

  it("draws the work only as wide as the parts on its one line, so the failure follows the last count shown", () => {
    // jsdom has no layout: the line is staged — the first two parts on it, the rest wrapped below.
    const rect = (r: Partial<DOMRect>) => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...r }) as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("tool-group-work")) return rect({ left: 100, width: 300, top: 0 });
      const parts = this.parentElement?.classList.contains("tool-group-work") ? [...this.parentElement.children] : null;
      if (parts) { const i = parts.indexOf(this); return rect({ top: i < 2 ? 0 : 18, left: 100 + 80 * i, right: 100 + 80 * (i + 1) }); }
      return rect({});
    });
    try {
      render(<ToolGroup steps={steps(run())} sessionStatus="idle" />);
      // THE mutant: no fit — the box keeps the width it shrank to, and "1 failed" stands a gap away.
      expect((document.querySelector(".tool-group-work") as HTMLElement).style.maxWidth).toBe("160px");
    } finally { spy.mockRestore(); }
  });

  it("drops the parts that are zero, and says nothing of failures where there were none", () => {
    render(<ToolGroup steps={steps([tool("r1", "Read", { file_path: "/a" }), tool("r2", "Read", { file_path: "/b" })])} sessionStatus="idle" />);
    expect(document.querySelector(".tool-group-work")).toHaveTextContent(/^· 2 reads$/);
    expect(document.querySelector(".tool-group-failed")).toBeNull();
  });

  it("while live, says the call in flight rather than the counts so far", () => {
    const live = [tool("r1", "Read", { file_path: "/w/a.ts" }), { ...tool("c1", "Bash", { command: "pnpm test" }), result: null }];
    render(<ToolGroup steps={steps(live)} sessionStatus="running" />);
    expect(document.querySelector(".tool-group-work")).toHaveTextContent(/^· Run pnpm test$/);
  });

  it("a run the turn ended on with a failure opens itself; one that recovered, or ended well, stays folded", () => {
    const failedLast = [tool("r1", "Read", { file_path: "/a" }), fail("c1", "Bash", { command: "pnpm build" })];
    const { unmount } = render(<ToolGroup steps={steps(failedLast)} sessionStatus="idle" endsTurn />);
    expect(cards()).toHaveLength(2);
    // And a manual collapse still wins.
    fireEvent.click(screen.getByRole("button", { name: "2 tool calls" }));
    expect(cards()).toHaveLength(0);
    unmount();
    // The agent went on after it: the failure is on the head, the run stays folded.
    const { unmount: u2 } = render(<ToolGroup steps={steps(failedLast)} sessionStatus="idle" />);
    expect(cards()).toHaveLength(0);
    u2();
    // A failure in the middle that the run recovered from does not open it either.
    render(<ToolGroup steps={steps([fail("c1", "Bash", { command: "pnpm build" }), tool("r1", "Read", { file_path: "/a" })])} sessionStatus="idle" endsTurn />);
    expect(cards()).toHaveLength(0);
  });

  it("in a transcript, a run the turn closed on is one that ends it; one the agent talked after is not", () => {
    const model = (blocks: Block[]): TranscriptModel =>
      ({ blocks, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null });
    const failedRun: Block[] = [tool("r1", "Read", { file_path: "/a" }), fail("c1", "Bash", { command: "pnpm build" })];
    const { unmount } = render(<Transcript transcript={model([...failedRun, { kind: "run", ms: 4_000, startedAt: 0, ts: 4_000 }])} sessionStatus="idle" onDecide={() => {}} />);
    expect(cards()).toHaveLength(2);
    unmount();
    render(<Transcript transcript={model([...failedRun, say("I fixed it another way.")])} sessionStatus="idle" onDecide={() => {}} />);
    expect(cards()).toHaveLength(0);
  });
});

describe("a step in a run stands on the same lead column as every other row", () => {
  it("the rail sits 4px left of the steps' glyphs, and a step's row is inset by exactly the rail's offset", () => {
    render(<ToolGroup steps={steps([tool("r1", "Read", { file_path: "/a" }), { ...tool("c1", "Bash", { command: "x" }), result: null }])} sessionStatus="running" />);
    // jsdom has no layout; the arithmetic is the stylesheet's and is held in styles.test. Here: the
    // step cards are the ones the inset applies to.
    for (const c of cards()) expect(c.parentElement).toHaveClass("tool-group-steps");
  });
});
