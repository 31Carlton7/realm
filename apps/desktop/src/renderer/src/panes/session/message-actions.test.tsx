import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(() => cleanup());

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null });

const assistant = (text: string, streaming: boolean, messageId = "m1"): Block =>
  ({ kind: "assistant", messageId, text, streaming, ts: 1 });

const user = (text: string): Block => ({ kind: "user", text, ts: 0 });

const row = () => document.querySelector(".msg-assistant-row")!;

describe("the assistant message's action bar", () => {
  it("stays away until the message is finished", () => {
    const view = render(<Transcript sessionStatus="running" onDecide={() => {}}
      transcript={model([assistant("half a sen", true)])} />);
    expect(screen.queryByRole("group", { name: "Message actions" })).toBeNull();

    view.rerender(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([assistant("half a sentence, then the rest.", false)])} />);
    expect(screen.getByRole("group", { name: "Message actions" })).toBeInTheDocument();
  });

  it("says which of the two states it is in, on the container the reference puts it on", () => {
    const view = render(<Transcript sessionStatus="running" onDecide={() => {}}
      transcript={model([assistant("mid", true)])} />);
    expect(row()).toHaveAttribute("data-state", "streaming");
    expect(row()).toHaveAttribute("aria-busy", "true");

    view.rerender(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([assistant("mid stream, now done", false)])} />);
    expect(row()).toHaveAttribute("data-state", "complete");
    expect(row()).toHaveAttribute("aria-busy", "false");
  });

  it("copies the message's own source text, not the rendered prose", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    try {
      render(<Transcript sessionStatus="idle" onDecide={() => {}}
        transcript={model([assistant("# Heading\n\nwith `code`", false)])} />);
      const copy = screen.getByRole("button", { name: "Copy message" });
      // Both glyphs stay mounted — the tick is a state change on one control, so the swap rule has
      // something to cross-fade and the accessible name never moves.
      expect(copy.querySelector(".copy-icon")).not.toBeNull();
      expect(copy.querySelector(".copied-icon")).not.toBeNull();
      fireEvent.click(copy);
      expect(writeText).toHaveBeenCalledWith("# Heading\n\nwith `code`");
      expect(copy).toHaveAttribute("data-copied");
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(copy).not.toHaveAttribute("data-copied");
    } finally { vi.useRealTimers(); }
  });

  it("keeps the entrance mark on the element §6's rule can actually reach", () => {
    // The wrapper made the prose a grandchild of `.transcript-col`, and `> [data-enter]` does not
    // reach one — an entrance left on the inner div animates nothing at all. Only a block that is
    // genuinely arriving carries the mark, so this has to grow one to have anything to look at.
    const view = render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([assistant("first", false)])} />);
    view.rerender(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([assistant("first", false), assistant("second", false, "m2")])} />);
    expect(document.querySelector(".transcript-col > .msg-assistant-row[data-enter]")).not.toBeNull();
    expect(document.querySelector(".md[data-enter]")).toBeNull();
  });

  it("offers Retry on the newest answer only — the button acts on the last turn wherever it sits", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRetry={() => {}}
      transcript={model([user("one"), assistant("first", false), user("two"), assistant("second", false, "m2")])} />);
    const bars = [...document.querySelectorAll(".msg-actions")];
    expect(bars).toHaveLength(2);
    expect(bars[0]!.querySelector('[aria-label="Retry"]')).toBeNull();
    expect(bars[1]!.querySelector('[aria-label="Retry"]')).not.toBeNull();
  });

  it("does not offer Retry when there is nothing of the user's to ask again", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRetry={() => {}}
      transcript={model([assistant("unprompted", false)])} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("greys Retry while a turn is live rather than taking it away", () => {
    const view = render(<Transcript sessionStatus="running" onDecide={() => {}} onRetry={() => {}}
      transcript={model([user("one"), assistant("done", false)])} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    view.rerender(<Transcript sessionStatus="idle" onDecide={() => {}} onRetry={() => {}}
      transcript={model([user("one"), assistant("done", false)])} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("hands the click straight to the pane", () => {
    const retried = vi.fn();
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRetry={retried}
      transcript={model([user("one"), assistant("done", false)])} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toHaveBeenCalledTimes(1);
  });
});
