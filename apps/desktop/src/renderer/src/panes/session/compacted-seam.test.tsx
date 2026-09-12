import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

const compacted = (over: Partial<Extract<Block, { kind: "compacted" }>> = {}): Block =>
  ({ kind: "compacted", preTokens: 186_000, postTokens: 34_000, ts: 500, ...over });

describe("the line that says the agent can no longer see what is above it", () => {
  it("names the drop in the units the meter beside it uses", () => {
    render(<Transcript transcript={model([compacted()])} sessionStatus="idle" onDecide={() => {}} />);
    expect(screen.getByText("Context compacted")).toBeTruthy();
    // Same `formatTokens` as the ring's panel: two spellings of one number across a 60px gap is a
    // reader asking whether they are the same number.
    expect(screen.getByText("186k → 34k")).toBeTruthy();
  });

  it("wears the handover's shape, because it reports the same kind of thing", () => {
    // Both are seams — a rule across the column saying the transcript above reads differently from
    // the transcript below. A second near-identical class would be a distinction meaning nothing.
    render(<Transcript transcript={model([compacted()])} sessionStatus="idle" onDecide={() => {}} />);
    const seam = document.querySelector(".msg-handoff")!;
    expect(seam).toBeTruthy();
    expect(seam.getAttribute("role")).toBe("note");
  });

  it("draws no before-and-after when the harness reported only the before", () => {
    // The mutant: `postTokens ?? 0`, which renders "186k → 0" and claims the window was emptied.
    // Half a comparison is a number with nothing to compare it to, so the pair goes entirely.
    render(<Transcript transcript={model([compacted({ postTokens: undefined })])} sessionStatus="idle" onDecide={() => {}} />);
    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(document.querySelector(".msg-handoff-tries")).toBeNull();
  });

  it("stays in the scrollback where it happened, between the messages it divides", () => {
    // Summarised at the top it would answer "did this session compact"; it is here to answer "which
    // of these messages was the agent still holding", and only its position can say that.
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "assistant", messageId: "m1", text: "before", streaming: false, ts: 100 },
      compacted(),
      { kind: "assistant", messageId: "m2", text: "after", streaming: false, ts: 900 },
    ])} />);
    const col = document.querySelector(".transcript-col")!;
    // The prose is nested inside its row (which also carries the actions bar on the newest message),
    // so the row is read through its `.msg-assistant` — trimmed, because the markdown render leaves
    // the block's trailing newline in the text node.
    const order = [...col.children].map((el) =>
      el.classList.contains("msg-handoff") ? "seam" : el.querySelector(".msg-assistant")?.textContent?.trim() ?? "");
    expect(order.indexOf("seam")).toBeGreaterThan(order.indexOf("before"));
    expect(order.indexOf("seam")).toBeLessThan(order.indexOf("after"));
    expect(order.indexOf("before")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("after")).toBeGreaterThan(0);
  });
});
