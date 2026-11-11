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

  it("counts a search as a search, not as a file read", () => {
    // A Read and a Grep closed on "read 2 files" under a ledger reading "1 read · 1 search".
    const searched: Block = { kind: "tool", toolUseId: "g", name: "Grep", input: { pattern: "TODO" }, result: ok, ts: 3 };
    expect(summaryText([asked("look around", 1), read("/r/README.md", 2), searched]))
      .toBe("You asked: “look around”. The agent read 1 file.");
  });

  it("names the first three edited files and counts the rest, by every harness's tool name", () => {
    const codex: Block = { kind: "tool", toolUseId: "c1", name: "apply_patch", input: { changes: [{ path: "/r/d.ts" }] }, result: ok, ts: 4 };
    const r = recapSession([wrote("/r/a.ts", 1), wrote("/r/b.ts", 2), wrote("/r/c.ts", 3), codex, wrote("/r/a.ts", 5)]);
    expect(r.edited).toEqual(["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"]); // Codex's envelope is read too; a repeat is one file
    expect(summaryText([asked("go", 0), wrote("/r/a.ts", 1), wrote("/r/b.ts", 2), wrote("/r/c.ts", 3), wrote("/r/d.ts", 4)]))
      .toContain("edited 4 files (a.ts, b.ts, c.ts, +1)");
  });

  it("leaves an ask's own full stop inside the quote, with nothing after it", () => {
    // It printed `merged PRs.”. Over 4 turns`: the ask's stop, the quote, then a second stop.
    expect(summaryText([asked("Cut the release from the merged PRs.", 1), read("/r/a.md", 2)]))
      .toBe("You asked: “Cut the release from the merged PRs.” The agent read 1 file.");
  });

  it("never doubles a stop, whatever the ask ends in and whatever follows it", () => {
    // The join rule, swept: every ending an ask can have, against every sentence that can follow it.
    const endings = ["", ".", "!", "?", "…", "...", ":"];
    const tails: Block[][] = [[read("/r/a.md", 2)], [wrote("/r/a.md", 2), ran("ls", 3, true)], [wrote("/r/a.md", 2), said("see https://x.test/y", 3)]];
    for (const end of endings) for (const tail of tails) {
      const text = summaryText([asked(`Cut the release${end}`, 1), ...tail])!;
      // A stop after a quote that already ended its sentence, two stops at a join, or a stray space.
      expect(text, text).not.toMatch(/[.!?…]”\.|[.!?]\.\s|\s\./u);
      expect(text.endsWith(".") || text.endsWith("”"), text).toBe(true);
    }
  });

  it("names two edited files that share a name by the folder that tells them apart", () => {
    // "edited 2 files (package.json, package.json)" read as one file listed twice.
    expect(summaryText([asked("bump", 1), wrote("/repo/package.json", 2), wrote("/repo/apps/desktop/package.json", 3)]))
      .toContain("edited 2 files (repo/package.json, desktop/package.json)");
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

  it("never quotes a sub-agent's brief as what you asked", () => {
    // Its first line is Realm's own wrapper, and its lead wrote the rest: "You asked: “You are a
    // delegated agent. Accomplish this goal:”" was false twice over. THE MUTANT: the brief not passed.
    const brief = "You are a delegated agent. Accomplish this goal:\n\nFold the report card.";
    expect(summaryText([asked(brief, 1), read("/r/viewer.tsx", 2)], brief)).toBe("The agent read 1 file.");
    expect(summaryText([asked(brief, 1), read("/r/viewer.tsx", 2), asked("and the tests?", 3)], brief))
      .toBe("You asked: “and the tests?” Over 2 turns the agent read 1 file.");
  });
});

describe("the closing line", () => {
  const blocks = [wrote("/a/one.md", 1)];
  it("shows the model's account when one has been written, and keeps the derived line when none has", () => {
    // The whole point of the feature: the derived line names the residue ("You asked… 8 files"),
    // the written one says what happened. Null is the ordinary case forever — no model on the
    // machine, a call still in flight, a session that has not settled — so the fold has to survive.
    const { unmount } = render(<TranscriptSummary blocks={blocks} status="idle" written="The redirect was wrong; it is fixed." />);
    expect(screen.getByRole("note")).toHaveTextContent("The redirect was wrong; it is fixed.");
    expect(screen.getByRole("note")).not.toHaveTextContent("You asked");
    unmount();
    render(<TranscriptSummary blocks={blocks} status="idle" written={null} />);
    expect(screen.getByRole("note")).toHaveTextContent(/You asked|agent/);
  });

  it("falls back rather than showing an empty line when the model returned whitespace", () => {
    render(<TranscriptSummary blocks={blocks} status="idle" written="   " />);
    expect(screen.getByRole("note").textContent?.trim()).not.toBe("");
  });

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

});
