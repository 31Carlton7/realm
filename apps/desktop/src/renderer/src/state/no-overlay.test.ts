import { describe, expect, it } from "vitest";
import type { Layout } from "@realm/contracts";
import {
  centerOverComplement, complementOf, intersects, placeAnchored, snapBrowserLeaves,
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
  it("browser on the right half: the complement is the left half", () => {
    const c = complementOf(WIN_RECT, [r(850, 40, 590, 860)]);
    expect(c).toEqual(r(0, 0, 850, 900));
  });

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

  it("point placement (context menus): gap 0, zero-size anchor, same avoidance", () => {
    const p = placeAnchored(base({ anchor: r(400, 300, 0, 0), gap: 0, avoid: [r(380, 250, 600, 400)] }));
    const placed = r(p.left, p.top, 160, 120);
    expect(intersects(placed, r(380, 250, 600, 400))).toBe(false);
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

  it("TWO browser panes: centered against the union's complement, not between the rects", () => {
    const avoid = [r(260, 0, 590, 900), r(850, 0, 590, 900)];
    const c = centerOverComplement(WIN, avoid, 560)!;
    expect(c.left + c.width).toBeLessThanOrEqual(260); // entirely inside the sidebar column
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
