import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { SelectionBar } from "./SelectionBar";

/**
 * The bar's behaviour, minus its geometry — which jsdom cannot answer for at all (every `Range` rect
 * is zero here) and which `selection-bar.test.ts` tests as arithmetic instead.
 *
 * What IS testable here is everything about whether the bar exists and what pressing it does, and
 * that is most of the bug surface: the listener it opens on, the mousedown guard that stops a button
 * from destroying the selection it is about to act on, and the absent-callback rule.
 *
 * The named mutants:
 *
 *   - `mouseup` instead of `selectionchange`   → "opens for a keyboard selection too"
 *   - no `onMouseDown` guard                   → "pressing a button cannot collapse the selection"
 *   - Quote drawn when `onQuote` is absent     → "draws no Quote it cannot honour"
 */

afterEach(() => { cleanup(); document.getSelection()?.removeAllRanges(); });

function Host({ onQuote }: { onQuote?: (text: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div className="transcript-wrap" ref={wrap}>
      <SelectionBar scrollRef={scroll} wrapRef={wrap} onQuote={onQuote} />
      <div className="transcript" ref={scroll}>
        <div className="msg-assistant-row" data-state="complete">
          <div className="msg-assistant"><p>a clean restart would probably be</p></div>
        </div>
        <div className="msg-assistant-row" data-state="streaming">
          <div className="msg-assistant"><p>still arriving</p></div>
        </div>
      </div>
    </div>
  );
}

/** Select a node's contents for real, then fire the event the browser would. jsdom implements enough
 *  of Selection to carry a range; only the rects are fiction, and nothing here reads one. */
function select(selector: string) {
  const node = document.querySelector(selector)!;
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

const bar = () => screen.queryByRole("toolbar", { name: "Selected text" });

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});

describe("the selection bar", () => {
  it("opens for a keyboard selection too, not only for a drag", () => {
    // THE MUTANT: listen for `mouseup` on the transcript. Shift+Arrow and ⌘A make a selection with
    // no pointer anywhere near it, and a reader who never touches a mouse would never see the bar.
    render(<Host onQuote={() => {}} />);
    expect(bar()).toBeNull();
    select(".msg-assistant p");
    expect(bar()).toBeInTheDocument();
  });

  it("closes when the selection collapses", () => {
    render(<Host onQuote={() => {}} />);
    select(".msg-assistant p");
    document.getSelection()!.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(bar()).toBeNull();
  });

  it("stays shut over a message that is still being written", () => {
    render(<Host onQuote={() => {}} />);
    select('[data-state="streaming"] p');
    expect(bar()).toBeNull();
  });

  it("hands the selected text to Quote and then gets out of the way", () => {
    const onQuote = vi.fn();
    render(<Host onQuote={onQuote} />);
    select(".msg-assistant p");
    fireEvent.click(screen.getByRole("button", { name: /Quote/ }));
    expect(onQuote).toHaveBeenCalledWith("a clean restart would probably be");
    // The passage is in the prompter; the bar has nothing left to offer about it.
    expect(bar()).toBeNull();
  });

  it("pressing a button cannot collapse the selection it is about to act on", () => {
    // THE MUTANT: drop the `onMouseDown` preventDefault. The press moves focus, the selection
    // collapses, and the click handler reads an empty range — the bug every selection toolbar has
    // once. Asserted as the event being defaulted-prevented, which is the actual mechanism.
    render(<Host onQuote={() => {}} />);
    select(".msg-assistant p");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("button", { name: /Quote/ }), down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("copies the selection, not the message around it", () => {
    render(<Host onQuote={() => {}} />);
    select(".msg-assistant p");
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("a clean restart would probably be");
  });

  it("draws no Quote it cannot honour", () => {
    // The read-only mounts pass no `onQuote`. `onRate`'s rule: absent means the control is not drawn
    // at all, rather than drawn dead — and Copy still works, because it needs nothing from the pane.
    render(<Host />);
    select(".msg-assistant p");
    expect(screen.queryByRole("button", { name: /Quote/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy selection" })).toBeInTheDocument();
  });

  it("Escape dismisses the bar without taking the selection with it", () => {
    // The reader may have pressed it to see the text under the bar. Clearing their selection would
    // undo the drag they just made.
    render(<Host onQuote={() => {}} />);
    select(".msg-assistant p");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(bar()).toBeNull();
    expect(document.getSelection()!.toString()).toBe("a clean restart would probably be");
  });
});
