import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DOMPurify from "dompurify";
import { Transcript, WINDOW_BLOCKS, EARLIER_BLOCKS, windowStart } from "./Transcript";
import { Markdown } from "./Markdown";
import { createEnterTracker } from "./transcript-enter";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

/** A long session: `turns` prompts, each answered by `perTurn - 1` blocks of prose. */
function session(turns: number, perTurn: number): Block[] {
  const out: Block[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ kind: "user", text: `prompt ${t}`, ts: t * 1000, seq: t });
    for (let k = 1; k < perTurn; k++) out.push({ kind: "assistant", messageId: `m${t}-${k}`, text: `answer ${t}.${k}`, streaming: false, ts: t * 1000 + k });
  }
  return out;
}

describe("a long transcript draws its newest part", () => {
  it("starts on the prompt just before the cut, and draws everything when the session is short", () => {
    const blocks = session(100, 10);
    // 1000 blocks: the cut lands at 600, which is a prompt — turn 60.
    expect(windowStart(blocks)).toBe(blocks.length - WINDOW_BLOCKS);
    expect(blocks[windowStart(blocks)]!.kind).toBe("user");
    // A cut inside a turn moves back to that turn's prompt.
    expect(windowStart(blocks, 395)).toBe(600);
    expect(windowStart(session(10, 10))).toBe(0);
  });

  it("does not reach further back than a few hundred blocks just to open on a prompt", () => {
    // One turn of 2,000 blocks: no prompt within reach of the cut, so it cuts mid-answer.
    const blocks = session(1, 2000);
    expect(windowStart(blocks)).toBe(2000 - WINDOW_BLOCKS);
  });

  it("renders only the window — THE mutant is rendering `transcript.blocks` whole again", () => {
    const blocks = session(200, 10);
    render(<Transcript transcript={model(blocks)} sessionStatus="idle" onDecide={() => {}} />);
    expect(screen.queryByText("prompt 0")).toBeNull();
    expect(screen.getByText("prompt 199")).toBeTruthy();
    expect(document.querySelectorAll(".msg-user-row").length).toBe(WINDOW_BLOCKS / 10);
  });

  it("draws further back on Show earlier, keeping every row already drawn mounted", () => {
    const blocks = session(200, 10);
    render(<Transcript transcript={model(blocks)} sessionStatus="idle" onDecide={() => {}} />);
    const newest = screen.getByText("prompt 199").closest(".msg-user-row");
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect(document.querySelectorAll(".msg-user-row").length).toBe((WINDOW_BLOCKS + EARLIER_BLOCKS) / 10);
    // Keys are the whole transcript's, so drawing more above remounts nothing below.
    expect(screen.getByText("prompt 199").closest(".msg-user-row")).toBe(newest);
  });

  it("offers no Show earlier once the whole session is drawn", () => {
    render(<Transcript transcript={model(session(5, 4))} sessionStatus="idle" onDecide={() => {}} />);
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  it("draws a prompt the Library asks for, however far back it is", () => {
    const blocks = session(200, 10);
    const { rerender } = render(<Transcript transcript={model(blocks)} sessionStatus="idle" onDecide={() => {}} track />);
    const rowFor = (text: string) => [...document.querySelectorAll(".msg-user-row")].find((r) => r.textContent?.includes(text)) ?? null;
    expect(rowFor("prompt 3")).toBeNull();
    rerender(<Transcript transcript={model(blocks)} sessionStatus="idle" onDecide={() => {}} track reveal={{ seq: 3, n: 1 }} />);
    expect(rowFor("prompt 3")).not.toBeNull();
  });

  it("holds the window still while the reader is reading, as more arrives below", () => {
    const blocks = session(200, 10);
    const { rerender } = render(<Transcript transcript={model(blocks)} sessionStatus="idle" onDecide={() => {}} />);
    const el = document.querySelector(".transcript") as HTMLElement;
    // jsdom has no layout: say the reader is far from the end, and scroll.
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 10_000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
    el.scrollTop = 1000;
    fireEvent.scroll(el);
    const first = document.querySelector(".msg-user-row")!.textContent;
    act(() => { rerender(<Transcript transcript={model([...blocks, ...session(1, 50).map((b) => ({ ...b, ts: b.ts + 1e9 }))])} sessionStatus="idle" onDecide={() => {}} />); });
    // The first drawn row is the same one: the window did not slide out from under the reader.
    expect(document.querySelector(".msg-user-row")!.textContent).toBe(first);
  });
});

describe("history drawn further back is not news", () => {
  it("is seen without entering", () => {
    const t = createEnterTracker();
    t.observe(["user:600", "assistant:601"]);
    const entering = t.observe(["user:200", "user:600", "assistant:601", "assistant:1001"], ["user:200"]);
    expect(entering.has("user:200")).toBe(false);
    expect(entering.has("assistant:1001")).toBe(true);
  });
});

describe("a message's Markdown is parsed once", () => {
  it("is not parsed again because the caller handed a new path handler", () => {
    /* The handler is usually an inline arrow, new on every render of the pane — and keyed on its
       identity, every message re-parsed and re-sanitised on each keystroke and each streamed word. */
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    const { rerender } = render(<Markdown text="see `src/app.ts`" onPath={() => {}} />);
    const after = sanitize.mock.calls.length;
    rerender(<Markdown text="see `src/app.ts`" onPath={() => {}} />);
    rerender(<Markdown text="see `src/app.ts`" onPath={() => {}} />);
    expect(sanitize.mock.calls.length).toBe(after);
    sanitize.mockRestore();
  });
});
