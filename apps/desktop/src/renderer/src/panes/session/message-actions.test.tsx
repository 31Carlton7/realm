import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Transcript } from "./Transcript";
import { renderMarkdown } from "./Markdown";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(() => cleanup());

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {} });

const assistant = (text: string, streaming: boolean, messageId = "m1"): Block =>
  ({ kind: "assistant", messageId, text, streaming, ts: 1 });

const user = (text: string): Block => ({ kind: "user", text, ts: 0 });

const fetched = (url: string): Block =>
  ({ kind: "tool", toolUseId: `t:${url}`, name: "WebFetch", input: { url }, result: { content: "page", isError: false }, ts: 0 });

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

  it("shows the verdict already on the message, and only on that message", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRate={() => {}}
      transcript={{ ...model([assistant("one", false), assistant("two", false, "m2")]), feedback: { m2: "down" } }} />);
    const bars = [...document.querySelectorAll(".msg-actions")];
    expect(bars[0]!.querySelector('[aria-label="Bad response"]')).toHaveAttribute("aria-pressed", "false");
    expect(bars[1]!.querySelector('[aria-label="Bad response"]')).toHaveAttribute("aria-pressed", "true");
    expect(bars[1]!.querySelector('[aria-label="Good response"]')).toHaveAttribute("aria-pressed", "false");
  });

  it("rates the message by its own id, not by where it sits", () => {
    // The mutant: keying feedback on the block index. Blocks are appended constantly, and a verdict
    // that moved to a different message on the next turn would be worse than none.
    const onRate = vi.fn();
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRate={onRate}
      transcript={model([assistant("one", false), assistant("two", false, "m2")])} />);
    const bars = [...document.querySelectorAll(".msg-actions")];
    fireEvent.click(bars[1]!.querySelector('[aria-label="Good response"]')!);
    expect(onRate).toHaveBeenCalledWith("m2", "up");
  });

  it("pressing the verdict that is already showing takes it back", () => {
    const onRate = vi.fn();
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onRate={onRate}
      transcript={{ ...model([assistant("one", false)]), feedback: { m1: "up" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Good response" }));
    expect(onRate).toHaveBeenCalledWith("m1", null);
  });

  it("draws no thumbs at all where nothing can record them", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([assistant("one", false)])} />);
    expect(screen.queryByRole("button", { name: "Good response" })).toBeNull();
  });

  it("folds the sources away until the reader asks, and names how many there are", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([user("q"), fetched("https://a.test/one"), fetched("https://b.test/two"), assistant("answer", false)])} />);
    const toggle = screen.getByRole("button", { name: /2 sources/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".msg-sources-list")).toHaveAttribute("hidden");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".msg-sources-list a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://a.test/one", "https://b.test/two"]);
    // target=_blank is the whole mechanism for reaching the OS browser; without it a click would
    // navigate the renderer itself out of the app.
    expect(links[0]!.getAttribute("target")).toBe("_blank");
  });

  it("says nothing at all about sources when the turn fetched nothing", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([user("q"), assistant("an answer with https://typed.test/x in it", false)])} />);
    expect(document.querySelector(".msg-sources")).toBeNull();
  });

  it("credits the answer whose turn did the fetching, not the one after it", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}}
      transcript={model([
        user("first"), fetched("https://a.test/one"), assistant("one", false),
        user("second"), assistant("two", false, "m2"),
      ])} />);
    const bars = [...document.querySelectorAll(".msg-assistant-row")];
    expect(bars[0]!.querySelector(".msg-sources")).not.toBeNull();
    expect(bars[1]!.querySelector(".msg-sources")).toBeNull();
  });
});

describe("inline citation markers", () => {
  it("numbers a link the agent actually fetched, matching the sources list", () => {
    const html = renderMarkdown("See [the docs](https://a.test/one) and [more](https://b.test/two).",
      ["https://a.test/one", "https://b.test/two"]);
    expect(html).toContain('<sup class="md-cite">1</sup>');
    expect(html).toContain('<sup class="md-cite">2</sup>');
  });

  it("leaves a link the agent never fetched unmarked — a typed url is not a citation", () => {
    // The mutant this kills: marking every link, which would present the model's own recollection
    // as evidence it went and checked.
    const html = renderMarkdown("Fetched [one](https://a.test/one), guessed [two](https://guess.test/x).",
      ["https://a.test/one"]);
    expect(html.match(/md-cite/g)).toHaveLength(1);
    expect(html).toContain('<sup class="md-cite">1</sup>');
    expect(html).not.toContain('<sup class="md-cite">2</sup>');
  });

  it("marks nothing when nothing was fetched, and leaves the prose byte-identical", () => {
    const text = "Read more at [the docs](https://a.test/one).";
    expect(renderMarkdown(text)).toBe(renderMarkdown(text, []));
    expect(renderMarkdown(text)).not.toContain("md-cite");
  });
});
