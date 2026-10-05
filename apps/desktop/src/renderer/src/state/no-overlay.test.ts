import { describe, expect, it } from "vitest";
import type { Layout } from "@realm/contracts";
import {
  centerOverComplement, complementOf, intersects, placeAnchored, placeToastStack, placeTooltip, snapBrowserLeaves, yieldViewTo,
  type AnchoredInput, type Rect,
} from "./no-overlay";

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** A realistic window: 1440×900, sidebar 0–260 (never a browser), pane host 260–1440. */
const WIN = { width: 1440, height: 900 };
const WIN_RECT = r(0, 0, 1440, 900);

describe("intersects", () => {
  it("overlap, touch, and miss", () => {
    expect(intersects(r(0, 0, 100, 100), r(50, 50, 100, 100))).toBe(true);
    expect(intersects(r(0, 0, 100, 100), r(100, 0, 50, 50))).toBe(false); // edge-touching is clear
    expect(intersects(r(0, 0, 100, 100), r(200, 200, 10, 10))).toBe(false);
    expect(intersects(r(50, 50, 10, 10), r(0, 0, 200, 200))).toBe(true); // containment
  });
});

describe("complementOf — the widest non-browser column", () => {

  it("browser in the middle: the wider flank wins", () => {
    const c = complementOf(WIN_RECT, [r(500, 0, 400, 900)]);
    expect(c).toEqual(r(900, 0, 540, 900)); // right flank 540 beats left flank 500
  });

  it("TWO browser panes: the complement is against the UNION, not each rect individually", () => {
    // Browsers at 260–850 and 850–1440 tile the pane host; only the sidebar is free. A per-rect
    // check would happily call 850 (the seam) or the other browser's rect "free".
    const c = complementOf(WIN_RECT, [r(260, 40, 590, 860), r(850, 40, 590, 860)]);
    expect(c).toEqual(r(0, 0, 260, 900));
  });

  it("two browsers with a gap between them: the gap can win when it is widest", () => {
    const c = complementOf(WIN_RECT, [r(0, 0, 400, 900), r(1200, 0, 240, 900)]);
    expect(c).toEqual(r(400, 0, 800, 900));
  });

  it("overlapping rects merge before the gaps are measured", () => {
    const c = complementOf(WIN_RECT, [r(300, 0, 400, 900), r(500, 0, 500, 900)]);
    expect(c).toEqual(r(1000, 0, 440, 900)); // union is 300–1000; right flank 440 > left flank 300
  });

  it("browsers covering the full width: a zero-width column, not a crash", () => {
    const c = complementOf(WIN_RECT, [r(0, 0, 1440, 900)]);
    expect(c.width).toBe(0);
  });

  it("zero-size rects (a hidden or unmeasured view) are ignored", () => {
    const c = complementOf(WIN_RECT, [r(500, 0, 0, 0)]);
    expect(c).toEqual(WIN_RECT);
  });
});

describe("placeAnchored", () => {
  const base = (over: Partial<AnchoredInput> = {}): AnchoredInput => ({
    anchor: r(600, 100, 50, 20), size: { width: 160, height: 120 }, win: WIN,
    align: "left", placement: "down", gap: 4, margin: 6, avoid: [], ...over,
  });

  describe("with no browser rects the pre-W2 behavior is unchanged", () => {
    it("opens below the anchor at its left edge", () => {
      expect(placeAnchored(base())).toMatchObject({ left: 600, top: 124, above: false, fallback: false });
    });
    it("flips above when there is no room below", () => {
      const p = placeAnchored(base({ anchor: r(600, 820, 50, 20) }));
      expect(p).toMatchObject({ left: 600, top: 696, above: true }); // 820 - 120 - 4
    });
    it("placement='up' opens above, flipping below near the top edge", () => {
      expect(placeAnchored(base({ placement: "up", anchor: r(600, 500, 50, 20) })))
        .toMatchObject({ top: 376, above: true }); // 500 - 120 - 4
      expect(placeAnchored(base({ placement: "up", anchor: r(600, 2, 50, 20) })))
        .toMatchObject({ top: 26, above: false }); // flipped: 2 + 20 + 4
    });
    it("align='right' lines the surface's right edge up with the anchor's", () => {
      expect(placeAnchored(base({ align: "right" })).left).toBe(490); // 650 - 160
    });
  });

  it("preferred position covered by a browser rect: flips to the other side of the anchor", () => {
    // Browser view starts just below the anchor row; opening down would land inside it, and there
    // is clear air above. This flip is rect-driven, not window-edge-driven (both sides fit).
    const avoid = [r(260, 320, 1180, 580)];
    const p = placeAnchored(base({ anchor: r(600, 300, 50, 20), avoid }));
    expect(p).toMatchObject({ left: 600, top: 176, above: true, fallback: false }); // 300 - 120 - 4
    expect(avoid.some((b) => intersects(r(p.left, p.top, 160, 120), b))).toBe(false);
  });

  it("MUTANT: a menu must never FLIP INTO a view — flip blocked, it slides along the edge instead", () => {
    // Anchor near the bottom (no room below), browser view directly above the anchor: the pre-W2
    // rule would flip up, straight into the view. It must slide along the edge instead.
    const avoid = [r(500, 200, 500, 640)]; // view 500–1000 x, ends at y=840
    const p = placeAnchored(base({ anchor: r(600, 850, 50, 20), avoid }));
    expect(p.fallback).toBe(false);
    const placed = r(p.left, p.top, 160, 120);
    expect(avoid.some((b) => intersects(placed, b))).toBe(false);
    // Nearest clear left along the edge: just left of the view (500 - 160 - 6 = 334) beats just
    // right of it (1006), from base left 600.
    expect(p.left).toBe(334);
  });

  it("MUTANT: a flip with no room is never clamped over its own anchor — it slides instead", () => {
    // A side pane's "+": the strip is the window's top 40px, the browser view starts under the page's
    // own chrome. Below is covered and above has no room; clamped into the window, the "flip" sat on
    // top of the + and the tabs beside it (measured live: y=8 over an anchor at y=6).
    const anchor = r(1047, 6, 28, 28);
    const view = r(891, 80, 609, 820);
    const p = placeAnchored(base({ anchor, size: { width: 214, height: 66 }, avoid: [view] }));
    const placed = r(p.left, p.top, 214, 66);
    expect(intersects(placed, view)).toBe(false);
    expect(intersects(placed, anchor)).toBe(false);
    expect(p).toMatchObject({ top: 38, above: false, fallback: false, left: 671 }); // 891 - 214 - 6
  });

  it("slides right when that side is nearer", () => {
    const avoid = [r(500, 200, 500, 640)];
    const p = placeAnchored(base({ anchor: r(950, 850, 50, 20), avoid }));
    expect(p.left).toBe(1006); // 500+500+6, nearer to 950 than 334
    expect(p.above).toBe(true);
  });

  it("browser views tiling the pane host: the slide lands the menu in the sidebar column", () => {
    // Views cover 260–1440 at every y. Sliding along the anchor edge finds the only clear x — the
    // sidebar column — before any fallback is needed.
    const avoid = [r(260, 0, 590, 900), r(850, 0, 590, 900)];
    const p = placeAnchored(base({ anchor: r(600, 850, 50, 20), avoid }));
    expect(p.fallback).toBe(false);
    const placed = r(p.left, p.top, 160, 120);
    expect(avoid.some((b) => intersects(placed, b))).toBe(false);
    expect(p.left).toBe(94); // 260 - 160 - 6: right edge 6px clear of the first view
  });

  it("literally no clear position (complement narrower than the menu): complement-centered fallback", () => {
    // Free column is 0–100 but the menu is 160 wide — no position anywhere is fully clear. The
    // fallback centers on the complement (clamped to the window margin) instead of sitting mid-view.
    const p = placeAnchored(base({ anchor: r(600, 850, 50, 20), avoid: [r(100, 0, 1340, 900)] }));
    expect(p.fallback).toBe(true);
    expect(p.left).toBe(6); // (100-160)/2 = -30, clamped to the margin — hugging the free column
    expect(p.top).toBe(390); // vertically centered: (900-120)/2
  });

});

describe("centerOverComplement", () => {
  it("null without browser rects — CSS centering stays in charge", () => {
    expect(centerOverComplement(WIN, [], 560)).toBeNull();
  });

  it("MUTANT: a sheet must not center over a browser rect — it centers over the complement", () => {
    const avoid = [r(850, 40, 590, 860)]; // browser right of 850
    const c = centerOverComplement(WIN, avoid, 560)!;
    expect(c.width).toBe(560);
    expect(c.left).toBe(145); // (850 - 560) / 2
    expect(intersects(r(c.left, 0, c.width, 900), avoid[0]!)).toBe(false);
  });

  it("column narrower than the surface: the surface shrinks into the column", () => {
    const avoid = [r(500, 0, 940, 900)]; // complement is 0–500
    const c = centerOverComplement(WIN, avoid, 560)!;
    expect(c.width).toBe(476); // 500 - 2*12
    expect(c.left).toBe(12);
  });

  it("geometrically impossible complement: floors at 120 wide instead of vanishing", () => {
    const c = centerOverComplement(WIN, [r(0, 0, 1440, 900)], 560)!;
    expect(c.width).toBe(120);
  });
});

describe("snapBrowserLeaves", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const row = (id: string, sizes: number[], children: Layout[]): Layout => ({ type: "split", id, dir: "row", sizes, children });
  const col = (id: string, sizes: number[], children: Layout[]): Layout => ({ type: "split", id, dir: "col", sizes, children });
  const B = new Set(["browser1"]);

  it("caps an over-half browser column at 50 and gives the rest to its siblings in proportion", () => {
    const l = row("s", [80, 15, 5], [leaf("a", "browser1"), leaf("b", "t1"), leaf("c", "t2")]);
    const out = snapBrowserLeaves(l, B);
    expect(out).not.toBe(l);
    expect((out as Extract<Layout, { type: "split" }>).sizes).toEqual([50, 37.5, 12.5]); // +30 split 15:5
    expect((out as Extract<Layout, { type: "split" }>).children).toEqual(l.type === "split" ? l.children : []);
  });

  it("returns the SAME reference when every browser column is already at most half", () => {
    const l = row("s", [50, 50], [leaf("a", "browser1"), leaf("b", "t1")]);
    expect(snapBrowserLeaves(l, B)).toBe(l);
  });

  it("a full-width browser leaf (root) is wrapped in a fresh [50,50] row split with an empty sibling", () => {
    const l = leaf("a", "browser1");
    const out = snapBrowserLeaves(l, B);
    expect(out.type).toBe("split");
    const s = out as Extract<Layout, { type: "split" }>;
    expect(s.dir).toBe("row");
    expect(s.sizes).toEqual([50, 50]);
    expect(s.children[0]).toBe(l); // the browser leaf keeps its identity (same leaf id)
    expect(s.children[1]).toMatchObject({ type: "leaf", itemId: null });
  });

  it("a browser under only col splits still spans the full width and gets wrapped", () => {
    const l = col("c", [60, 40], [leaf("a", "browser1"), leaf("b", "t1")]);
    const out = snapBrowserLeaves(l, B) as Extract<Layout, { type: "split" }>;
    expect(out.dir).toBe("col");
    const top = out.children[0] as Extract<Layout, { type: "split" }>;
    expect(top.type).toBe("split");
    expect(top.dir).toBe("row");
    expect(top.sizes).toEqual([50, 50]);
  });

  it("a browser inside a col split inside a capped row column is NOT double-wrapped", () => {
    const l = row("s", [70, 30], [col("c", [50, 50], [leaf("a", "browser1"), leaf("b", "t1")]), leaf("d", "t2")]);
    const out = snapBrowserLeaves(l, B) as Extract<Layout, { type: "split" }>;
    expect(out.sizes).toEqual([50, 50]);
    const child = out.children[0] as Extract<Layout, { type: "split" }>;
    expect(child.dir).toBe("col");
    expect(child.children[0]).toMatchObject({ type: "leaf", id: "a" }); // still a bare leaf
  });

  it("non-browser layouts pass through untouched (same reference)", () => {
    const l = row("s", [80, 20], [leaf("a", "t1"), leaf("b", "t2")]);
    expect(snapBrowserLeaves(l, B)).toBe(l);
  });
});

/* v2: the toast stack. It stands at the window's foot, and the two things it may not land on are a
   browser view (it would be invisible) and a prompter (it would cover the send button). */
describe("placeToastStack — the window's foot, clear of every view and every prompter", () => {
  const stack = (over: Partial<Parameters<typeof placeToastStack>[0]> = {}) =>
    placeToastStack({ win: WIN, width: 340, minWidth: 240, height: 200, margin: 16, avoid: [], lift: [], ...over });
  const box = (p: { left: number; bottom: number; width: number }, h = 200): Rect => r(p.left, WIN.height - p.bottom - h, p.width, h);

  it("with nothing in the way, the bottom-right corner", () => {
    expect(stack()).toEqual({ left: 1440 - 16 - 340, bottom: 16, width: 340 });
  });

  it("a browser on the right half: the corner of the pane beside it, never over the view", () => {
    // THE mutant: ignore `avoid` and the stack lands at 1084 — inside the view, painted over.
    const view = r(850, 80, 590, 820);
    const p = stack({ avoid: [view] })!;
    expect(intersects(box(p), view)).toBe(false);
    expect(p).toEqual({ left: 850 - 16 - 340, bottom: 16, width: 340 });
  });

  it("a browser on top and a pane under it: the corner stays, because nothing covers the foot", () => {
    expect(stack({ avoid: [r(260, 40, 1180, 400)] })).toEqual({ left: 1084, bottom: 16, width: 340 });
  });

  it("a browser filling the panes: the sidebar's column, as wide as it allows", () => {
    // 0–356 is the rail and a 280px sidebar; a view is never there.
    const p = stack({ avoid: [r(356, 40, 1084, 860)] })!;
    expect(p.left).toBe(16);
    expect(p.width).toBe(356 - 16 - 16);
    expect(intersects(box(p), r(356, 40, 1084, 860))).toBe(false);
  });

  it("a narrow stretch at the corner is taken over a wide one across the window", () => {
    // A view through the middle leaves 308px at the right edge and 568px on the left. THE mutant:
    // prefer full width, and the toast jumps to x 244 to gain 32px.
    expect(stack({ avoid: [r(600, 40, 500, 860)] })).toEqual({ left: 1116, bottom: 16, width: 308 });
  });

  it("a prompter beside a view lifts the stack within its stretch rather than pushing it across", () => {
    // Session on the left half with its prompter docked, browser on the right half.
    const view = r(850, 80, 590, 820), prompter = r(380, 740, 446, 140);
    const p = stack({ avoid: [view], lift: [prompter] })!;
    expect(intersects(box(p), view)).toBe(false);
    expect(intersects(box(p), prompter)).toBe(false);
    expect(p).toEqual({ left: 850 - 16 - 340, bottom: WIN.height - 740 + 16, width: 340 });
  });

  it("a prompter under the corner lifts the stack above it — it never covers the send button", () => {
    // THE mutant: treat the prompter like nothing and the stack sits on the send button at 1084.
    const prompter = r(560, 740, 720, 140);
    const p = stack({ lift: [prompter] })!;
    expect(intersects(box(p), prompter)).toBe(false);
    expect(p.bottom).toBe(WIN.height - 740 + 16);
    expect(p.left).toBe(1084);
  });

  it("…but beside a prompter there is room, it stays down at the corner", () => {
    const prompter = r(300, 740, 600, 140);
    expect(stack({ lift: [prompter] })).toEqual({ left: 1084, bottom: 16, width: 340 });
  });

  it("views end to end along the foot and no column beside them: nowhere, so the caller reserves one", () => {
    expect(stack({ avoid: [r(76, 40, 1364, 860)] })).toBeNull();
  });
});

describe("yieldViewTo — the corner a view gives up while the toasts have nowhere else", () => {
  it("gives up its bottom down to the reserve's top", () => {
    expect(yieldViewTo(r(76, 40, 1364, 860), r(1068, 668, 372, 232))).toEqual(r(76, 40, 1364, 628));
  });
  it("keeps its bounds when there is no reserve, or the reserve is elsewhere", () => {
    const view = r(76, 40, 600, 860);
    expect(yieldViewTo(view, null)).toBe(view);
    expect(yieldViewTo(view, r(1068, 668, 372, 232))).toBe(view);
  });
});

describe("placeTooltip — beside its anchor, or nowhere", () => {
  const tip = { width: 120, height: 24 };
  it("centred under its anchor", () => {
    expect(placeTooltip({ anchor: r(400, 8, 28, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [] }))
      .toEqual({ left: 400 + 14 - 60, top: 42, above: false });
  });
  it("over it where the window's foot is in the way", () => {
    expect(placeTooltip({ anchor: r(400, 860, 28, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [] }))
      .toEqual({ left: 354, top: 860 - 6 - 24, above: true });
  });
  it("over it where a browser view is below — a toolbar button sits right on the page", () => {
    // THE mutant: drop `avoid` and the tip is drawn on the page, where the view paints over it.
    const view = r(260, 80, 1180, 820);
    const p = placeTooltip({ anchor: r(400, 46, 28, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [view] })!;
    expect(p.above).toBe(true);
    expect(intersects(r(p.left, p.top, tip.width, tip.height), view)).toBe(false);
  });
  it("held inside the window at its edges", () => {
    expect(placeTooltip({ anchor: r(1430, 8, 10, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [] })!.left).toBe(1440 - 6 - 120);
    expect(placeTooltip({ anchor: r(0, 8, 10, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [] })!.left).toBe(6);
  });
  it("null where neither side is clear, so the system's own tooltip can be the one shown", () => {
    const view = r(0, 0, 1440, 900);
    expect(placeTooltip({ anchor: r(400, 300, 28, 28), size: tip, win: WIN, gap: 6, margin: 6, avoid: [view] })).toBeNull();
  });
});
