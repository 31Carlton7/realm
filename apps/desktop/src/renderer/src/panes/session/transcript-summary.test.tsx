import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TranscriptSummary, summaryLine } from "./TranscriptSummary";
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

describe("the closing line", () => {
  const blocks = [wrote("/a/one.md", 1)];
  const mount = (o: Partial<Parameters<typeof TranscriptSummary>[0]> = {}) =>
    render(<TranscriptSummary blocks={blocks} status="idle" {...o} />);

  it("is there as soon as the turn settles, with no waiting", () => {
    // THE MUTANT: put an elapsed-time threshold back. The line then exists only for someone who left
    // and came back, on a transcript whose whole value is that it is open in front of them — which
    // is the behaviour this replaced.
    mount();
    expect(screen.getByRole("note")).toHaveTextContent("This session produced 1 file.");
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
