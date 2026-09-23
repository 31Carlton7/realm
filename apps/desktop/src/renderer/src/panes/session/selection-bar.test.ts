import { describe, expect, it } from "vitest";
import { BAR_GAP, BAR_MARGIN, placeBar, selectionTarget } from "./selection-bar";

/**
 * Where the bar lands, as arithmetic.
 *
 * This file is the only place the placement can be tested at all: a `Range` in jsdom reports every
 * rect as zero, so a suite that drove a real selection would assert against a bar at the origin and
 * would pass whatever `placeBar` returned. The real geometry is measured in the Electron window by
 * `selection-bar-live.mjs`; what is checked here is the decision, which is pure.
 *
 * The named mutants:
 *
 *   - prefer below rather than above        → "opens above the passage"
 *   - clamp order reversed                  → "a pane narrower than the bar"
 *   - no horizontal clamp                   → "never hangs off either edge"
 *   - flip below whenever below also fits   → "flips below only when above will not take it"
 */

const WRAP = { left: 100, top: 50, width: 600, height: 400 };
const BAR = { width: 160, height: 30 };
/** A selection rect in VIEWPORT coordinates, like `Range.getBoundingClientRect()` hands back. */
const sel = (over: Partial<{ left: number; top: number; width: number; height: number }> = {}) =>
  ({ left: 300, top: 200, width: 120, height: 18, ...over });

describe("placeBar", () => {
  it("opens above the passage, centred on it", () => {
    // Above, because that is the side the pointer is NOT on: at the end of a downward drag the
    // cursor is at the selection's bottom edge, and a bar there opens under the user's own hand.
    const at = placeBar(sel(), WRAP, BAR)!;
    expect(at.below).toBe(false);
    // 300 - 100 = 200 into the wrap; centred: 200 + 60 - 80 = 180.
    expect(at.left).toBe(180);
    // 200 - 50 = 150 into the wrap; above: 150 - 30 - 8 = 112.
    expect(at.top).toBe(150 - BAR.height - BAR_GAP);
  });

  it("flips below only when above will not take it", () => {
    // THE MUTANT: flip whenever below fits too. The bar would then sit under the selection for every
    // ordinary passage in the middle of the pane, which is where the pointer already is.
    const high = placeBar(sel({ top: 52 }), WRAP, BAR)!;
    expect(high.below).toBe(true);
    expect(high.top).toBe(52 - 50 + 18 + BAR_GAP);
    // One pixel of room more than it needs, and it stays above.
    const just = placeBar(sel({ top: 50 + BAR.height + BAR_GAP + BAR_MARGIN }), WRAP, BAR)!;
    expect(just.below).toBe(false);
  });

  it("never hangs off either edge", () => {
    // THE MUTANT: return the centred value unclamped. A passage selected against the right rail
    // puts half the bar outside the pane, where it is both unreadable and unclickable.
    expect(placeBar(sel({ left: 105, width: 20 }), WRAP, BAR)!.left).toBe(BAR_MARGIN);
    expect(placeBar(sel({ left: 660, width: 30 }), WRAP, BAR)!.left).toBe(WRAP.width - BAR.width - BAR_MARGIN);
  });

  it("stays on screen in a pane narrower than the bar itself", () => {
    // THE MUTANT: `Math.max` then `Math.min`. With the two clamps in disagreement that order returns
    // the NEGATIVE right-hand bound, parking the bar off the left edge of a narrow pane.
    const narrow = { left: 0, top: 0, width: 100, height: 400 };
    expect(placeBar(sel({ left: 10, top: 200 }), narrow, BAR)!.left).toBe(BAR_MARGIN);
  });

  it("refuses a passage that has been scrolled out of the pane", () => {
    // A selection survives scrolling, so a reader who selects something and scrolls away still has
    // one. THE MUTANT: place it anyway. Today it lands at a negative coordinate and is invisible by
    // accident — right up until something clamps coordinates into view, at which point a bar parks
    // at the top edge pointing at a passage nobody can see.
    expect(placeBar(sel({ top: -40 }), WRAP, BAR)).toBeNull();
    expect(placeBar(sel({ top: 500 }), WRAP, BAR)).toBeNull();
    // Still overlapping by a pixel is still on screen.
    expect(placeBar(sel({ top: WRAP.top - 17 }), WRAP, BAR)).not.toBeNull();
    expect(placeBar(sel({ top: WRAP.top + WRAP.height - 1 }), WRAP, BAR)).not.toBeNull();
  });

  it("does not mistake an unmeasured pane for one the passage has left", () => {
    // THE MUTANT: drop the `wrap.height > 0` gate. An unmeasured box is all zeros and every
    // selection fails an overlap test against it, so the bar would refuse to place itself on its
    // first frame — before the wrapper has been laid out — on no information at all.
    expect(placeBar({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 0, height: 0 }, BAR)).not.toBeNull();
  });

  it("keeps a selection taller than the pane above rather than below the fold", () => {
    // Neither side fits. Above is the honest fallback: clamped to the top margin it is still on
    // screen, where `below` would place it past the bottom edge of the pane entirely.
    const at = placeBar(sel({ top: 55, height: 380 }), WRAP, BAR)!;
    expect(at.below).toBe(false);
    expect(at.top).toBe(BAR_MARGIN);
  });
});

/* `selectionTarget` reads the DOM but never its geometry, so jsdom answers for it honestly. */
describe("selectionTarget", () => {
  const mount = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };
  const selectionOver = (node: Node, text: string) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return { isCollapsed: false, rangeCount: 1, toString: () => text, getRangeAt: () => range } as unknown as Selection;
  };

  it("takes a passage inside one finished message", () => {
    const root = mount(`<div class="msg-assistant-row" data-state="complete"><div class="msg-assistant"><p>hello there</p></div></div>`);
    const p = root.querySelector("p")!;
    expect(selectionTarget(selectionOver(p, "hello there"), root)?.text).toBe("hello there");
  });

  it("refuses a selection that is only whitespace", () => {
    // A click that drags two pixels is a click. A bar that opens on it opens when the reader was
    // only putting the caret somewhere.
    const root = mount(`<div class="msg-assistant"><p> </p></div>`);
    expect(selectionTarget(selectionOver(root.querySelector("p")!, "  \n "), root)).toBeNull();
    expect(selectionTarget(null, root)).toBeNull();
  });

  it("refuses a selection crossing two messages", () => {
    // THE MUTANT: resolve the message from `startContainer` alone. A drag from an answer into the
    // next user message would then quote the pair as though the agent had said both.
    const root = mount(`<div class="msg-assistant"><p>one</p></div><div class="msg-user"><p>two</p></div>`);
    expect(selectionTarget(selectionOver(root, "onetwo"), root)).toBeNull();
  });

  it("refuses a message that is still being written", () => {
    // Text still arriving moves under the selection, and a bar pinned to a rect about to go stale is
    // worse than no bar — `MessageActions` withholds itself from a streaming message for this reason.
    const root = mount(`<div class="msg-assistant-row" data-state="streaming"><div class="msg-assistant"><p>partial</p></div></div>`);
    expect(selectionTarget(selectionOver(root.querySelector("p")!, "partial"), root)).toBeNull();
  });

  it("refuses everything that is not prose", () => {
    // Tool cards, permission cards and plans are structured records. A quote of their rendered text
    // is a quote of the interface, not of anything the agent said.
    const root = mount(`<div class="tool-card"><p>ran a command</p></div>`);
    expect(selectionTarget(selectionOver(root.querySelector("p")!, "ran a command"), root)).toBeNull();
  });
});
