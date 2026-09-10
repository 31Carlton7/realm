import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TranscriptSummary, recapSession, summaryLine, summaryText } from "./TranscriptSummary";
import type { Block } from "./transcript-model";

afterEach(() => cleanup());

const ok = { content: "done", isError: false };
const wrote = (path: string, ts: number): Block =>
  ({ kind: "tool", toolUseId: `t${ts}`, name: "Write", input: { file_path: path }, result: ok, ts });
const said = (text: string, ts: number): Block =>
  ({ kind: "assistant", messageId: `m${ts}`, text, streaming: false, ts });

describe("summaryLine", () => {
  it("counts what the session produced, and says nothing when that is nothing", () => {
    // The gate that lets this line be shown by default at all: "no outputs" under every
    // conversational answer would be noise attached to the ordinary case.
    expect(summaryLine([said("just talking", 1)])).toBeNull();
    expect(summaryLine([wrote("/a/one.md", 1), wrote("/a/two.md", 2)])).toBe("2 files");
  });

  it("keeps the singular singular", () => {
    expect(summaryLine([wrote("/a/one.md", 1)])).toBe("1 file");
  });

  it("joins the kinds it found", () => {
    const blocks: Block[] = [
      wrote("/a/one.md", 1),
      said("shipped to https://app.test/live", 2),
      { kind: "plan", planId: "p1", text: "# do it", ts: 3 },
      { kind: "user", text: "look", attachments: [{ path: "/u/a.pdf", mime: "application/pdf" }], ts: 4 },
    ];
    expect(summaryLine(blocks)).toBe("1 file · 1 link · 1 plan · 1 attached");
  });
});

describe("summaryText", () => {
  const asked = (text: string, ts: number): Block => ({ kind: "user", text, ts });
  const ran = (cmd: string, ts: number, isError = false): Block =>
    ({ kind: "tool", toolUseId: `b${ts}`, name: "Bash", input: { command: cmd }, result: { content: "", isError }, ts });
  const read = (path: string, ts: number): Block =>
    ({ kind: "tool", toolUseId: `r${ts}`, name: "Read", input: { file_path: path }, result: ok, ts });

  it("says what was asked, what the agent did, and what came out — not just the residue", () => {
    /* The line this replaces read "This session produced 1 file · 4 attached": true, and no help
       to someone coming back to the session. The mutant is that line. */
    const blocks: Block[] = [
      asked("Fix the library fade so cards stop bleeding through", 1),
      read("/r/styles.css", 2), ran("pnpm vitest run styles", 3),
      wrote("/r/styles.css", 4), wrote("/r/tokens.css", 5),
      { kind: "user", text: "look", attachments: [{ path: "/u/a.png", mime: "image/png" }], ts: 6 },
      said("Done.", 7),
    ];
    expect(summaryText(blocks)).toBe(
      "You asked: “Fix the library fade so cards stop bleeding through”. Over 2 turns the agent edited 2 files (styles.css, tokens.css), ran 1 command and read 1 file. It produced 2 files · 1 attached.");
  });

  it("names the first three edited files and counts the rest, by every harness's tool name", () => {
    const codex: Block = { kind: "tool", toolUseId: "c1", name: "apply_patch", input: { changes: [{ path: "/r/d.ts" }] }, result: ok, ts: 4 };
    const r = recapSession([wrote("/r/a.ts", 1), wrote("/r/b.ts", 2), wrote("/r/c.ts", 3), codex, wrote("/r/a.ts", 5)]);
    expect(r.edited).toEqual(["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"]); // Codex's envelope is read too; a repeat is one file
    expect(summaryText([asked("go", 0), wrote("/r/a.ts", 1), wrote("/r/b.ts", 2), wrote("/r/c.ts", 3), wrote("/r/d.ts", 4)]))
      .toContain("edited 4 files (a.ts, b.ts, c.ts, +1)");
  });

  it("counts a failed edit as an error, not as an edited file", () => {
    const failed: Block = { kind: "tool", toolUseId: "f", name: "Edit", input: { file_path: "/r/x.ts" }, result: { content: "no match", isError: true }, ts: 2 };
    expect(summaryText([asked("edit x", 1), failed, ran("ls", 3)])).toBe("You asked: “edit x”. The agent ran 1 command, with 1 error along the way.");
  });

  it("clips a long ask to its first line", () => {
    const text = `${"a".repeat(200)}\nsecond line`;
    expect(recapSession([asked(text, 1)]).asked).toHaveLength(110);
    expect(recapSession([asked(text, 1)]).asked.endsWith("…")).toBe(true);
  });

  it("says nothing for a session that only talked, and skips a message another session delivered", () => {
    expect(summaryText([asked("hi", 1), said("hello", 2)])).toBeNull();
    const relayed: Block = { kind: "user", text: "from the other one", from: { sessionId: "x", title: "Other" }, ts: 1 };
    expect(recapSession([relayed, asked("mine", 2)]).asked).toBe("mine");
    expect(recapSession([relayed, asked("mine", 2)]).turns).toBe(1);
  });
});

describe("the closing line", () => {
  const blocks = [wrote("/a/one.md", 1)];
  const mount = (o: Partial<Parameters<typeof TranscriptSummary>[0]> = {}) =>
    render(<TranscriptSummary blocks={blocks} status="idle" {...o} />);

  it("is there as soon as the turn settles, with no waiting", () => {
    // THE MUTANT: put an elapsed-time threshold back. The line then exists only for someone who left
    // and came back, on a transcript whose whole value is that it is open in front of them — which
    // is the behaviour this replaced.
    mount();
    expect(screen.getByRole("note")).toHaveTextContent("The agent edited 1 file (one.md). It produced 1 file.");
  });

  it("never appears while a turn is live", () => {
    // Mid-turn the counts are still climbing, and a total that changes while it is read is not a
    // summary of anything.
    for (const status of ["running", "waiting_permission"] as const) {
      cleanup();
      mount({ status });
      expect(screen.queryByRole("note"), status).toBeNull();
    }
  });

  it("says nothing about a session that produced nothing to count", () => {
    mount({ blocks: [said("just talking", 1)] });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says nothing on an empty session", () => {
    mount({ blocks: [] });
    expect(screen.queryByRole("note")).toBeNull();
  });
});
