import { useMemo } from "react";
import { findLeaf, mainOf, type Layout } from "@realm/contracts";
import { useApp } from "../../state/store";

/**
 * The layout, as rectangles.
 *
 * Every leaf of the split tree becomes a rect in a unit square, positioned and sized by the SAME
 * `sizes` the real panes are laid out with — so the glyph is a picture of the window rather than a
 * category of window. An empty leaf is drawn too: a pane with nothing in it is still part of the
 * arrangement, and leaving it out would move every rect beside it.
 *
 * This replaces two earlier answers that were both approximations. The first read only the root
 * split, so splitting one half into rows gave every pane in that half the same mark. The second
 * collapsed the tree onto two axes — the outermost horizontal split for a column, the outermost
 * vertical one for a row — which draws a rectangular grid, and a layout that is not a rectangular
 * grid does not have one. The arrangement in a real session (two columns, the left one split into
 * rows, one of those rows split again) has no honest cell in a grid of any size, and both versions
 * had to either lie about it or refuse to draw at all past four slots.
 *
 * A treemap has neither problem: there is no nesting depth or slot count it cannot express, because
 * it is not summarising the tree — it is the tree.
 *
 * Null when there is nothing to say: the item is not in this layout, or the layout is a single leaf
 * (one pane filling the window is not an arrangement, and a glyph on every row of an unsplit session
 * would be a mark that never varies).
 */
export type PaneRect = { x: number; y: number; w: number; h: number; active: boolean };

export function paneMapOf(layout: Layout, itemId: string): PaneRect[] | null {
  if (layout.type !== "split") return null;
  const rects: PaneRect[] = [];
  const walk = (node: Layout, x: number, y: number, w: number, h: number): void => {
    if (node.type === "leaf") { rects.push({ x, y, w, h, active: node.itemId === itemId }); return; }
    // The stored sizes, defended: a tree written by an older build (or mid-drag) can carry a short
    // `sizes`, a zero, or a set that does not total anything in particular. Falling back to equal
    // shares keeps the picture honest about the STRUCTURE even when the proportions are unusable,
    // which is the half that matters most for telling two panes apart.
    const raw = node.children.map((_, i) => (Number.isFinite(node.sizes[i]) && node.sizes[i]! > 0 ? node.sizes[i]! : 0));
    const total = raw.reduce((a, b) => a + b, 0);
    const shares = total > 0 ? raw.map((v) => v / total) : node.children.map(() => 1 / node.children.length);
    let off = 0;
    node.children.forEach((child, i) => {
      const f = shares[i]!;
      if (node.dir === "row") walk(child, x + off * w, y, f * w, h);
      else walk(child, x, y + off * h, w, f * h);
      off += f;
    });
  };
  walk(layout, 0, 0, 1, 1);
  return rects.some((r) => r.active) ? rects : null;
}

/**
 * The split as the window draws it: the main panes — never the side panel, which is the window's and
 * not a pane of the split, so a session beside it alone is a session filling its place and wears no
 * glyph (the owner, 10-05: a session filling the window wore a half-lit glyph for a side pane) — and
 * one pane filling their place under pane focus (⌘⇧F) is that pane alone.
 *
 * Null while the panel fills the window itself, when no main pane is drawn.
 */
export function layoutOnScreen(layout: Layout, { zoomedLeafId = null }: { zoomedLeafId?: string | null } = {}): Layout | null {
  const zoomed = zoomedLeafId ? findLeaf(layout, zoomedLeafId) : null;
  if (zoomed?.tabs) return null;
  return zoomed ?? mainOf(layout);
}

/** The glyph's drawing box, and the gap between panes, in its own units. A 24-unit box at a 12px
 *  render is two units per CSS pixel — enough that a 1-unit gutter is one device pixel on retina
 *  rather than a blur across two. */
const GLYPH_BOX = 24;
const GLYPH_GAP = 1;
/** No rect ever thinner than this, however deep the split. A pane squeezed to nothing on screen is
 *  still a pane the reader is being asked to find, and a rect rounded to zero would silently vanish
 *  from a picture whose whole job is completeness. */
const GLYPH_MIN = 1.5;

/**
 * A small picture of the arrangement on screen, with this item's pane lit — none for a pane that
 * fills the window, or one the window is not drawing (`layoutOnScreen`).
 *
 * An `<svg>` rather than a CSS grid of spans, because the thing being drawn is not a grid: rects can
 * sit at any fraction of the box, which is what lets an arbitrary tree be drawn exactly.
 */
export function ItemGlyph({ layout, itemId }: { layout: Layout; itemId: string }) {
  // Read here rather than handed in, so every list that draws the glyph pictures the same window.
  const zoomedLeafId = useApp((s) => s.view?.zoomedLeafId ?? null);
  const rects = useMemo(() => {
    const shown = layoutOnScreen(layout, { zoomedLeafId });
    return shown ? paneMapOf(shown, itemId) : null;
  }, [layout, itemId, zoomedLeafId]);
  if (!rects) return null;
  return (
    <svg className="item-glyph" viewBox={`0 0 ${GLYPH_BOX} ${GLYPH_BOX}`} width="12" height="12" aria-hidden="true">
      {rects.map((r, i) => {
        // The gutter is taken out of each rect rather than added between them, so the outer edges of
        // the glyph stay flush with its box and the whole picture keeps the layout's proportions.
        const w = Math.max(GLYPH_MIN, r.w * GLYPH_BOX - GLYPH_GAP);
        const h = Math.max(GLYPH_MIN, r.h * GLYPH_BOX - GLYPH_GAP);
        return <rect key={i} x={r.x * GLYPH_BOX + GLYPH_GAP / 2} y={r.y * GLYPH_BOX + GLYPH_GAP / 2}
          width={w} height={h} rx={0.75} data-on={r.active || undefined} />;
      })}
    </svg>
  );
}
