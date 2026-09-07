import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { IDLE_AFTER_MS, IdleSummary, idleFor, idleSummaryText } from "./IdleSummary";
import type { Block } from "./transcript-model";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const ok = { content: "done", isError: false };
const wrote = (path: string, ts: number): Block =>
  ({ kind: "tool", toolUseId: `t${ts}`, name: "Write", input: { file_path: path }, result: ok, ts });
const said = (text: string, ts: number): Block =>
  ({ kind: "assistant", messageId: `m${ts}`, text, streaming: false, ts });

describe("idleFor", () => {
  it("rounds to the granularity the sentence actually uses", () => {
    expect(idleFor(5 * 60_000)).toBe("5 minutes");
    expect(idleFor(59 * 60_000)).toBe("59 minutes");
    expect(idleFor(62 * 60_000)).toBe("an hour");
    expect(idleFor(200 * 60_000)).toBe("3 hours");
  });
});

describe("idleSummaryText", () => {
  it("counts what the session produced, and says nothing when that is nothing", () => {
    // A line reading "no outputs" under every conversational answer would be noise attached to the
    // ordinary case.
    expect(idleSummaryText([said("just talking", 1)])).toBeNull();
    expect(idleSummaryText([wrote("/a/one.md", 1), wrote("/a/two.md", 2)])).toBe("2 files");
  });

  it("keeps the singular singular", () => {
    expect(idleSummaryText([wrote("/a/one.md", 1)])).toBe("1 file");
  });

  it("joins the kinds it found", () => {
    const blocks: Block[] = [
      wrote("/a/one.md", 1),
      said("shipped to https://app.test/live", 2),
      { kind: "plan", planId: "p1", text: "# do it", ts: 3 },
      { kind: "user", text: "look", attachments: [{ path: "/u/a.pdf", mime: "application/pdf" }], ts: 4 },
    ];
    expect(idleSummaryText(blocks)).toBe("1 file · 1 link · 1 plan · 1 attached");
  });
});

describe("the idle line", () => {
  const blocks = [wrote("/a/one.md", 1)];
  const mount = (o: Partial<Parameters<typeof IdleSummary>[0]> = {}) =>
    render(<IdleSummary blocks={blocks} status="idle" lastActivity={Date.now() - IDLE_AFTER_MS - 1000} {...o} />);

  it("appears once a settled session has been quiet past the threshold", () => {
    mount();
    expect(screen.getByRole("note")).toHaveTextContent(/Idle for 5 minutes — this session produced 1 file\./);
  });

  it("stays away before the threshold", () => {
    mount({ lastActivity: Date.now() - 60_000 });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("never appears while a turn is live", () => {
    // The named mutant: reading elapsed time alone. A turn that has been thinking for six minutes is
    // the opposite of idle, and telling its reader the session is idle would be plainly wrong.
    for (const status of ["running", "waiting_permission"] as const) {
      cleanup();
      mount({ status });
      expect(screen.queryByRole("note"), status).toBeNull();
    }
  });

  it("says nothing on an empty session, which has no activity to measure from", () => {
    mount({ lastActivity: null });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("arrives on its own when the threshold passes, without a new message", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const view = render(<IdleSummary blocks={blocks} status="idle" lastActivity={start} />);
    expect(screen.queryByRole("note")).toBeNull();
    vi.setSystemTime(start + IDLE_AFTER_MS + 1000);
    vi.advanceTimersByTime(30_000);
    view.rerender(<IdleSummary blocks={blocks} status="idle" lastActivity={start} />);
    expect(screen.getByRole("note")).toBeInTheDocument();
  });
});
