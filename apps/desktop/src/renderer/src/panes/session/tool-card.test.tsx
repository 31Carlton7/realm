import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { ToolCard, ToolGroup, RESULT_CLAMP } from "./ToolCard";
import { editStat } from "./tool-summary";
import { GROUP_MIN, formatDuration, formatToolRun, groupTranscript, summarizeToolRun, type ToolBlock } from "./tool-group";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

const block = (content: string, isError = false): ToolBlock =>
  ({ kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "ls" }, result: { content, isError }, ts: 0 });

const mount = (content: string) => render(<ToolCard block={block(content)} sessionStatus="idle" />);
const openCard = () => fireEvent.click(screen.getByRole("button", { name: /Bash tool call/ }));
const resultWell = () => document.querySelector<HTMLElement>(".tool-section:last-child .tool-well")!;

afterEach(() => cleanup());

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
    fireEvent.click(screen.getByRole("button", { name: "Copy input" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("ls"));
  });
});

/** A finished tool call. `ts` is a millisecond stamp, as it is on the wire. */
const tool = (id: string, name: string, input: Record<string, unknown>, ts = 0, done = true): ToolBlock =>
  ({ kind: "tool", toolUseId: id, name, input, result: done ? { content: "ok", isError: false } : null, ts });
const say = (text: string): Block => ({ kind: "assistant", messageId: text, text, streaming: false, ts: 0 });

describe("tool-run grouping (§5: group consecutive tools under a collapsed summary line)", () => {
  it(`leaves a run shorter than ${GROUP_MIN} inline`, () => {
    const blocks = [tool("t1", "Read", { file_path: "/a" }), tool("t2", "Read", { file_path: "/b" })];
    expect(groupTranscript(blocks).map((i) => i.kind)).toEqual(["block", "block"]);
  });

  it(`folds a run of ${GROUP_MIN} or more into one group, keeping each card's ungrouped key`, () => {
    const blocks = [tool("t1", "Read", {}), tool("t2", "Read", {}), tool("t3", "Read", {})];
    const items = groupTranscript(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("group");
    expect(items[0]!.kind === "group" && items[0]!.steps.map((s) => s.key)).toEqual(["tool:t1", "tool:t2", "tool:t3"]);
    expect(items[0]!.key).toBe("group:tool:t1");
  });

  it("a non-tool block breaks the run: three tools split 2 + prose + 3 group into two blocks, prose, one group", () => {
    const items = groupTranscript([
      tool("t1", "Read", {}), tool("t2", "Read", {}),
      say("thinking out loud"),
      tool("t3", "Read", {}), tool("t4", "Read", {}), tool("t5", "Read", {}),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["block", "block", "block", "group"]);
    expect(items[3]!.kind === "group" && items[3]!.steps).toHaveLength(3);
  });

  it("non-tool blocks keep the positional keys the transcript renders them under", () => {
    const items = groupTranscript([say("a"), say("b")]);
    expect(items.map((i) => i.key)).toEqual(["assistant:0", "assistant:1"]);
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
    expect(s).toEqual({ tools: 3, files: 1, commands: 2, durationMs: 372_000 });
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
  });
});

describe("editStat (Plan 9 W2: ThinkingState's measured +/− counts)", () => {
  it("counts an Edit's lines from both sides of its own payload", () => {
    expect(editStat("Edit", { file_path: "/a", old_string: "one", new_string: "one\ntwo" })).toEqual({ add: 2, del: 1 });
    expect(editStat("Edit", { file_path: "/a", old_string: "", new_string: "x" })).toEqual({ add: 1, del: 0 });
  });

  it("sums a MultiEdit's edits and counts a Write's content as pure adds", () => {
    expect(editStat("MultiEdit", { edits: [
      { old_string: "a", new_string: "a\nb" },
      { old_string: "c\nd", new_string: "e" },
    ] })).toEqual({ add: 3, del: 3 });
    expect(editStat("Write", { file_path: "/a", content: "l1\nl2\nl3" })).toEqual({ add: 3, del: 0 });
  });

  it("refuses to invent counts where the payload does not carry both sides", () => {
    expect(editStat("Edit", { file_path: "/a" })).toBeNull();       // permission previews carry no strings
    expect(editStat("Read", { file_path: "/a" })).toBeNull();
    expect(editStat("Bash", { command: "ls" })).toBeNull();
    expect(editStat("MultiEdit", { edits: "nope" })).toBeNull();
    expect(editStat("apply_patch", { changes: [{ path: "/a" }] })).toBeNull();
  });

  it("renders the counts on the row — green adds, red deletes", () => {
    render(<ToolCard sessionStatus="idle" block={
      { kind: "tool", toolUseId: "t1", name: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "x\ny\nz" }, result: { content: "ok", isError: false }, ts: 0 }
    } />);
    const stat = document.querySelector(".tool-stat")!;
    expect(stat.querySelector(".tool-stat-add")).toHaveTextContent("+3");
    expect(stat.querySelector(".tool-stat-del")).toHaveTextContent("−1");
  });
});

const steps = (blocks: ToolBlock[]) => blocks.map((b) => ({ key: b.toolUseId, block: b, enter: false }));
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
    ({ blocks, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null });
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
