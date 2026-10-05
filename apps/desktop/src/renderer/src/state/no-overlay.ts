import { newId, type Layout, type LayoutLeaf } from "@realm/contracts";

/**
 * Plan 11 W2 — the no-overlay layout, as pure geometry.
 *
 * The native browser view composites over EVERY piece of renderer DOM inside its rectangle
 * (proven by W1's screen-sampled live check), so "position the popover above the view" is not a
 * thing that exists. The invariant — no floating surface may intersect a browser view's rect —
 * is enforced here, in the two positioning primitives every floating surface goes through, not by
 * per-callsite discipline:
 *
 *   - anchored surfaces (menus, pickers): `placeAnchored` — preferred side, flip, slide along the
 *     anchor edge, and only then a complement-centered fallback;
 *   - centered surfaces (palette, sheets): `centerOverComplement` — the widest non-browser column;
 *   - the toast stack: `placeToastStack`, along the window's foot (and `yieldViewTo` where nothing
 *     along it is clear); the tooltip: `placeTooltip`, beside its anchor or not at all.
 *
 * Everything here is pure and jsdom-free so the numbers are testable directly (jsdom rects are all
 * zero, so wiring-level tests must mock measurements — these functions are where the real
 * arithmetic lives).
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** The narrowest sheet the app opens. A complement column narrower than this triggers W2.4's
 *  snap (the layout moves instead of the sheet overlaying). */
export const SHEET_MIN_WIDTH = 420;

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The widest non-browser COLUMN of `win`: the widest x-interval not covered by the union of the
 * browser rects' x-projections, as a full-height rect. The union matters — two browser panes
 * side by side must not leave the seam between them looking "free" (each rect individually avoids
 * it, their union does not). Degenerate layouts (browsers spanning the full width) return a
 * zero-width column at the left edge; callers treat that as "no room" rather than dividing by it.
 */
export function complementOf(win: Rect, browserRects: readonly Rect[]): Rect {
  const spans = browserRects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r): [number, number] => [Math.max(win.x, r.x), Math.min(win.x + win.width, r.x + r.width)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let best: [number, number] = [win.x, win.x]; // zero-width fallback when browsers cover everything
  let cursor = win.x;
  for (const [a, b] of merged) {
    if (a - cursor > best[1] - best[0]) best = [cursor, a];
    cursor = Math.max(cursor, b);
  }
  if (win.x + win.width - cursor > best[1] - best[0]) best = [cursor, win.x + win.width];
  return { x: best[0], y: win.y, width: best[1] - best[0], height: win.height };
}

export type AnchoredInput = {
  /** The trigger's rect; a point-placed (context) menu passes a zero-size rect at the point. */
  anchor: Rect;
  /** The surface's own measured size — a 0×0 size would make every position "clear" and the whole
   *  function untestable, so callers measure first (render hidden, then place). */
  size: Size;
  win: Size;
  align: "left" | "right";
  placement: "down" | "up";
  /** Gap between the anchor edge and the surface: 4 for anchored menus, 0 for point placement. */
  gap: number;
  margin: number;
  /** Browser view rects. Empty reproduces the pre-W2 behavior exactly. */
  avoid: readonly Rect[];
};
export type AnchoredPlacement = {
  left: number; top: number;
  /** The surface sits above its anchor (drives transform-origin). */
  above: boolean;
  /** No position along the anchor edge was clear of the browser views on either side; the surface
   *  was centered over the complement instead. */
  fallback: boolean;
};

/**
 * Anchored placement with rect-avoidance. Order: preferred placement → flipped placement → slid
 * along the anchor edge (nearest clear spot, preferred side first) → complement-centered fallback.
 * The window-edge flip rule is byte-for-byte the pre-W2 one, so with no browser rects nothing
 * about menu placement changes.
 */
export function placeAnchored(i: AnchoredInput): AnchoredPlacement {
  const { anchor: a, size, win, margin, gap } = i;
  const clampX = (x: number) => Math.max(margin, Math.min(x, win.width - size.width - margin));
  const clampY = (y: number) => Math.max(margin, Math.min(y, win.height - size.height - margin));
  const baseLeft = clampX(i.align === "right" ? a.x + a.width - size.width : a.x);
  const below = { top: a.y + a.height + gap, above: false };
  const above = { top: a.y - size.height - gap, above: true };
  const fitsBelow = below.top + size.height <= win.height - margin;
  const fitsAbove = above.top >= margin;
  const primary = i.placement === "down" ? (fitsBelow || !fitsAbove ? below : above)
    : (fitsAbove || !fitsBelow ? above : below);
  const secondary = primary === below ? above : below;
  // The other side only where it FITS. Clamped back into the window, a flip with no room is drawn
  // over the anchor itself: a menu off a strip under the window's top edge, with a browser view below,
  // came up over its own "+" and the tabs beside it. Sliding along the edge keeps both in sight.
  const sides = (secondary.above ? fitsAbove : fitsBelow) ? [primary, secondary] : [primary];
  const clear = (r: Rect) => !i.avoid.some((b) => b.width > 0 && b.height > 0 && intersects(r, b));
  const at = (left: number, top: number): Rect => ({ x: left, y: clampY(top), width: size.width, height: size.height });

  for (const s of sides) {
    if (clear(at(baseLeft, s.top))) return { left: baseLeft, top: clampY(s.top), above: s.above, fallback: false };
  }
  // Slide along the (horizontal) anchor edge: candidate lefts are just past the far edges of the
  // offending rects; the nearest clear one to the anchor-aligned left wins.
  for (const s of sides) {
    const top = clampY(s.top);
    const slid = i.avoid
      .flatMap((b) => [b.x - size.width - margin, b.x + b.width + margin])
      .filter((x) => x >= margin && x <= win.width - size.width - margin)
      .filter((x) => clear({ x, y: top, width: size.width, height: size.height }))
      .sort((p, q) => Math.abs(p - baseLeft) - Math.abs(q - baseLeft));
    if (slid.length > 0) return { left: slid[0]!, top, above: s.above, fallback: false };
  }
  // Literally no clear position along the anchor edge on either side: center over the complement
  // rather than cover the view.
  const col = complementOf({ x: 0, y: 0, width: win.width, height: win.height }, i.avoid);
  return {
    left: clampX(col.x + (col.width - size.width) / 2),
    top: clampY((win.height - size.height) / 2),
    above: false, fallback: true,
  };
}

/**
 * Where a centered surface (palette, sheet) goes while browser rects exist: horizontally centered
 * over the widest non-browser column, width capped to that column. Null when there are no rects —
 * callers keep their plain CSS centering (zero behavior change without a browser pane).
 *
 * The 120px floor is a last-resort degrade: a layout whose complement is geometrically too narrow
 * for anything (W2.4's snap did not or could not widen it) yields a squeezed surface at the
 * column, never an invisible zero-width one.
 */
export function centerOverComplement(
  win: Size, avoid: readonly Rect[], preferredWidth: number, pad = 12,
): { left: number; width: number } | null {
  if (avoid.length === 0) return null;
  const col = complementOf({ x: 0, y: 0, width: win.width, height: win.height }, avoid);
  const width = Math.max(120, Math.min(preferredWidth, win.width - 2 * pad, col.width - 2 * pad));
  const left = Math.max(0, Math.min(col.x + (col.width - width) / 2, win.width - width));
  return { left, width };
}

/** `[lo, hi]` with every blocked span taken out of it, left to right. */
function freeSpans(lo: number, hi: number, blocked: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  let cursor = lo;
  for (const [a, b] of [...blocked].sort((p, q) => p[0] - q[0])) {
    if (a > cursor) out.push([cursor, Math.min(a, hi)]);
    cursor = Math.max(cursor, b);
    if (cursor >= hi) break;
  }
  if (cursor < hi) out.push([cursor, hi]);
  return out.filter(([a, b]) => b > a);
}

export type ToastPlacement = { left: number; bottom: number; width: number };

/**
 * Where the toast stack stands (v2): the window's bottom-right corner, unless something there must
 * not be covered.
 *
 * - `avoid` — the browser views. A toast drawn over one is a toast nobody sees, so the stack moves
 *   along the window's foot to the right-most stretch no view covers, shrinking to `minWidth` before
 *   it gives up.
 * - `lift` — the prompters. The stack may stand ABOVE one, never on it: the send button is at the
 *   corner a bottom-right toast would land on, and a notice that covers the next action is in its way.
 *
 * `height` is the stack's height FANNED OUT, because that is what it becomes under the pointer — a spot
 * clear only of the collapsed stack would let the hover push its upper toasts under a view.
 *
 * Every spot at full width is tried before any narrower one, lowest first and right-most first. Null
 * when no spot along the foot is clear at all: views cover it end to end, which with the sidebar
 * open cannot happen (its column is never a view), so it means a browser filling a window whose
 * sidebar is folded away. The caller then asks the view beneath to give up the corner instead
 * (`yieldViewTo`).
 */
export function placeToastStack(i: {
  win: Size; width: number; minWidth: number; height: number; margin: number;
  avoid: readonly Rect[]; lift: readonly Rect[];
}): ToastPlacement | null {
  const { win, height, margin } = i;
  const live = (r: Rect) => r.width > 0 && r.height > 0;
  const bottoms = [margin, ...i.lift.filter(live).map((r) => win.height - r.y + margin)]
    .filter((b, k, all) => all.indexOf(b) === k && b + height + margin <= win.height)
    .sort((a, b) => a - b);
  for (const want of [i.width, i.minWidth]) {
    for (const bottom of bottoms) {
      const top = win.height - bottom - height;
      const blocked = [...i.avoid, ...i.lift]
        .filter((r) => live(r) && r.y < top + height && top < r.y + r.height)
        .map((r) => [r.x - margin, r.x + r.width + margin] as const);
      const free = freeSpans(margin, win.width - margin, blocked);
      for (let k = free.length - 1; k >= 0; k--) {
        const [a, b] = free[k]!;
        if (b - a < want) continue;
        const width = Math.min(i.width, b - a);
        return { left: b - width, bottom, width };
      }
    }
  }
  return null;
}

/**
 * The bounds a browser view takes while the toasts hold `reserve`: its own, with the bottom given up
 * down to the reserve's top wherever the two overlap. Only ever reached when `placeToastStack` had no
 * spot — the view yields a strip for a few seconds, as the page gives the find bar its height, rather
 * than painting over the one thing the window is trying to say.
 */
export function yieldViewTo(view: Rect, reserve: Rect | null): Rect {
  if (!reserve || !intersects(view, reserve)) return view;
  return { ...view, height: Math.max(0, Math.min(view.height, reserve.y - view.y)) };
}

/**
 * A tooltip's spot against its anchor (v2): centred under it, or over it where the window's foot or a
 * browser view is in the way below — and null where neither side is clear. A tooltip is only worth
 * anything beside the thing it names, so there is no third place to go: the caller hands the element
 * back to the system's own tooltip, which macOS draws above every view.
 */
export function placeTooltip(i: { anchor: Rect; size: Size; win: Size; gap: number; margin: number; avoid: readonly Rect[] }): { left: number; top: number; above: boolean } | null {
  const { anchor: a, size, win, gap, margin } = i;
  const left = Math.max(margin, Math.min(a.x + (a.width - size.width) / 2, win.width - size.width - margin));
  const clear = (top: number) => top >= margin && top + size.height <= win.height - margin
    && !i.avoid.some((b) => b.width > 0 && b.height > 0 && intersects({ x: left, y: top, width: size.width, height: size.height }, b));
  const below = a.y + a.height + gap;
  if (clear(below)) return { left, top: below, above: false };
  const above = a.y - gap - size.height;
  if (clear(above)) return { left, top: above, above: true };
  return null;
}

/**
 * W2.4 — the degenerate case. Cap every browser leaf at half of every row split on its path (the
 * freed share is redistributed to the other children in proportion), and wrap a browser leaf that
 * sits under NO row split (i.e. spans the full pane-host width) in a fresh [50,50] row split with
 * an empty sibling. Returns the SAME reference when nothing needed to change, so callers can tell
 * "snap happened" from "nothing to snap".
 */
export function snapBrowserLeaves(layout: Layout, browserItemIds: ReadonlySet<string>): Layout {
  const isBrowserLeaf = (n: Layout): boolean => n.type === "leaf" && n.itemId !== null && browserItemIds.has(n.itemId);
  const containsBrowser = (n: Layout): boolean => (n.type === "leaf" ? isBrowserLeaf(n) : n.children.some(containsBrowser));

  function walk(n: Layout, underRow: boolean): Layout {
    if (n.type === "leaf") {
      if (!underRow && isBrowserLeaf(n)) {
        const empty: LayoutLeaf = { type: "leaf", id: newId(), itemId: null };
        return { type: "split", id: newId(), dir: "row", sizes: [50, 50], children: [n, empty] };
      }
      return n;
    }
    const children = n.children.map((c) => walk(c, underRow || n.dir === "row"));
    let sizes = n.sizes;
    if (n.dir === "row") {
      const capped = n.children.map((c, idx) => containsBrowser(c) && (n.sizes[idx] ?? 0) > 50);
      if (capped.some(Boolean)) {
        const excess = n.sizes.reduce((acc, s, idx) => acc + (capped[idx] ? s - 50 : 0), 0);
        const freeTotal = n.sizes.reduce((acc, s, idx) => acc + (capped[idx] ? 0 : s), 0);
        const freeCount = capped.filter((c) => !c).length;
        sizes = n.sizes.map((s, idx) => {
          if (capped[idx]) return 50;
          return freeTotal > 0 ? s + (excess * s) / freeTotal : s + (freeCount > 0 ? excess / freeCount : 0);
        });
      }
    }
    const changed = sizes !== n.sizes || children.some((c, idx) => c !== n.children[idx]);
    return changed ? { ...n, sizes, children } : n;
  }
  return walk(layout, false);
}
