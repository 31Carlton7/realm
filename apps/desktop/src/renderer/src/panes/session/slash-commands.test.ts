import { describe, expect, it } from "vitest";
import { filterSlashCommands, slashQueryAt, type SlashCommand } from "./slash-commands";
import { exportFileName, exportSessionMarkdown } from "./export-session";
import { emptyTranscript, type Block, type Transcript } from "./transcript-model";

const cmd = (id: string, label: string): SlashCommand =>
  ({ id, label, hint: "", icon: "add", run: () => {} });

describe("slashQueryAt", () => {
  it("opens only at the very start of the draft", () => {
    expect(slashQueryAt("/exp", 4)).toEqual({ start: 0, end: 4, query: "exp" });
    // The whole reason for the stricter rule: a slash is a path separator, a division sign and half
    // of every URL. A picker that opened inside these would fire constantly mid-sentence.
    expect(slashQueryAt("look in src/renderer", 14)).toBeNull();
    expect(slashQueryAt("and/or", 5)).toBeNull();
    expect(slashQueryAt("see https://x.test/a", 20)).toBeNull();
  });

  it("takes the WHOLE token even when the caret is inside it", () => {
    // Picking replaces start..end, so a completion in the middle of `/exp|ort` must not leave `ort`.
    expect(slashQueryAt("/export", 4)).toEqual({ start: 0, end: 7, query: "exp" });
  });

  it("steps aside once the user has typed past the token into a sentence", () => {
    expect(slashQueryAt("/export the thing", 17)).toBeNull();
    // …but is still open while the caret is on the token itself.
    expect(slashQueryAt("/export the thing", 7)).toEqual({ start: 0, end: 7, query: "export" });
  });

  it("opens on the bare slash, with an empty query", () => {
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });
});

describe("filterSlashCommands", () => {
  const all = [cmd("export", "Export session"), cmd("connections", "Manage connections"), cmd("diff", "Show changes")];

  it("matches by PREFIX, so typing a command's name narrows toward it", () => {
    // Substring matching (the mention picker's rule) would keep offering `/connections` to someone
    // three letters into `/export`, because "ex" appears nowhere in it but "o" does in both.
    expect(filterSlashCommands(all, "ex").map((c) => c.id)).toEqual(["export"]);
    expect(filterSlashCommands(all, "e").map((c) => c.id)).toEqual(["export"]);
    expect(filterSlashCommands(all, "conn").map((c) => c.id)).toEqual(["connections"]);
  });

  it("matches the label too, for a command whose name is not the word you would reach for", () => {
    expect(filterSlashCommands(all, "show").map((c) => c.id)).toEqual(["diff"]);
  });

  it("offers everything on a bare slash, and nothing on a miss", () => {
    expect(filterSlashCommands(all, "")).toHaveLength(3);
    expect(filterSlashCommands(all, "zzz")).toEqual([]);
  });
});

const t = (blocks: Block[], over: Partial<Transcript> = {}): Transcript => ({ ...emptyTranscript(), blocks, ...over });
const NOW = new Date(2026, 8, 7, 9, 30).getTime();
const base = { agentLabel: "Claude", model: "claude-opus-5", cwd: "/w/realm", now: NOW };

describe("exportSessionMarkdown", () => {
  it("leads with the four facts a pasted excerpt loses", () => {
    const md = exportSessionMarkdown({ ...base, title: "Fix the parser", transcript: t([]) });
    expect(md).toContain("# Fix the parser");
    expect(md).toContain("**Agent:** Claude");
    expect(md).toContain("**Model:** claude-opus-5");
    expect(md).toContain("**Workspace:** `/w/realm`");
    expect(md).toContain("**Exported:**");
  });

  it("names the speakers and keeps the prose exactly as it was written", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "user", text: "why is it slow?", ts: 1 },
      { kind: "assistant", messageId: "m1", text: "Because of `N+1`.\n\n- one\n- two", streaming: false, ts: 2 },
    ]) });
    expect(md).toContain("## User\n\nwhy is it slow?");
    expect(md).toContain("## Assistant\n\nBecause of `N+1`.\n\n- one\n- two");
  });

  it("attributes a message another session delivered, rather than passing it off as the user's", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "user", text: "check this", from: { sessionId: "s2", title: "Reviewer" }, ts: 1 },
    ]) });
    expect(md).toContain("## Asked by Reviewer");
    expect(md).not.toContain("## User");
  });

  it("summarises a tool call rather than dumping its payload", () => {
    // Forty tool bodies would bury the conversation the export exists to carry. The one line the
    // card's own header shows is what goes; someone who needs the payload needs the session.
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "tool", toolUseId: "t1", name: "Write", input: { file_path: "/w/a.ts", content: "x".repeat(5000) }, result: { content: "ok", isError: false }, ts: 1 },
      { kind: "tool", toolUseId: "t2", name: "Bash", input: { command: "pnpm test" }, result: { content: "boom", isError: true }, ts: 2 },
    ]) });
    expect(md).toContain("- `Write` `/w/a.ts`");
    expect(md).toContain("- `Bash` `pnpm test` — failed");
    expect(md).not.toContain("xxxx");
  });

  it("neutralises a backtick inside a summary instead of spilling markup into the document", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "echo `date`" }, result: { content: "", isError: false }, ts: 1 },
    ]) });
    expect(md).toContain("``echo `date` ``");
  });

  it("exports a plan as a real task list, statuses and all", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "plan", planId: "p1", text: "Two passes.", steps: [
        { text: "read it", status: "completed" }, { text: "fix it", status: "in_progress" }, { text: "test it", status: "pending" },
      ], ts: 1 },
    ]) });
    expect(md).toContain("- [x] read it");
    expect(md).toContain("- [ ] fix it _(in progress)_");
    expect(md).toContain("- [ ] test it");
  });

  it("folds thinking away, the way the transcript does", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([{ kind: "thinking", messageId: "m1", text: "hmm", ts: 1 }]) });
    expect(md).toContain("<summary>Thinking</summary>");
  });

  it("leaves out the elapsed-time line and an answer that has no text yet", () => {
    // One is a fact about watching the session happen; the other would be a heading over nothing,
    // which reads as a lost answer.
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([
      { kind: "run", ms: 4200, startedAt: 1, ts: 2 },
      { kind: "assistant", messageId: "m1", text: "", streaming: true, ts: 3 },
    ]) });
    expect(md).not.toContain("## Assistant");
    expect(md).not.toContain("4200");
  });

  it("says what the session cost only when there is something to say", () => {
    const withCost = exportSessionMarkdown({ ...base, title: "S", transcript: t([], { usage: { costUsd: 1.5, inputTokens: 0, outputTokens: 0, numTurns: 3 } }) });
    expect(withCost).toContain("_3 turns · $1.50_");
    expect(exportSessionMarkdown({ ...base, title: "S", transcript: t([]) })).not.toMatch(/turns/);
  });

  it("ends with exactly one newline, like every other text file", () => {
    const md = exportSessionMarkdown({ ...base, title: "S", transcript: t([{ kind: "user", text: "hi", ts: 1 }]) });
    expect(md.endsWith("hi\n")).toBe(true);
  });
});

describe("exportFileName", () => {
  it("carries the session's title and the date, with nothing a filesystem would refuse", () => {
    expect(exportFileName("Fix: parser/lexer?", NOW)).toBe("Fix- parser-lexer- 2026-09-07.md");
  });
  it("names an untitled session rather than producing a bare extension", () => {
    expect(exportFileName("   ", NOW)).toBe("Session 2026-09-07.md");
  });
  it("clips a runaway title instead of writing a 400-character filename", () => {
    expect(exportFileName("a".repeat(300), NOW).length).toBeLessThan(80);
  });
});
