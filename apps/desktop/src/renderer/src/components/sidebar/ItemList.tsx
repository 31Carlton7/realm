import { Icon } from "@realm/ui";
import { useState } from "react";
import { allItems, emptyLayout, itemIdOfLeaf, type Item, type Layout } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { useItemContextMenu } from "./ItemContextMenu";

const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

/** Depth-first leaves of a layout (including empty ones) — used only as a fallback when deriving the
 *  glyph's approximate quadrant on deep/irregular trees. */
function leavesOf(l: Layout): Layout[] {
  return l.type === "leaf" ? [l] : l.children.flatMap(leavesOf);
}

/**
 * A glanceable "which pane is this in" hint for the sidebar's 2x2 glyph — deliberately approximate, not a
 * faithful map of the layout. For the common case (the layout root is a two-way split), returns which side
 * of that split holds the item: 0 for the first child's subtree, 1 for the second. The caller pairs this
 * with the split's direction to light a whole column (row split) or row (col split) of the glyph.
 * For anything else — a single leaf (no split at all), or a root with more than two children — falls back
 * to the item's position in depth-first leaf order, modulo 4, so every layout still gets *some* cell lit.
 * Returns null only when there's no split at all, or the item isn't open anywhere in the tree.
 */
export function leafPositionOf(layout: Layout, itemId: string): 0 | 1 | 2 | 3 | null {
  if (layout.type === "leaf") return null;
  if (layout.children.length === 2) {
    const idx = layout.children.findIndex((c) => allItems(c).includes(itemId));
    if (idx === 0 || idx === 1) return idx;
  }
  const leaves = leavesOf(layout);
  const idx = leaves.findIndex((l) => l.type === "leaf" && l.itemId === itemId);
  return idx === -1 ? null : ((idx % 4) as 0 | 1 | 2 | 3);
}

/** Which of the glyph's 4 cells (row-major: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) get
 *  data-on, given leafPositionOf's resolved position and the layout's shape. A two-way split root lights a
 *  whole column (row split) or row (col split); anything else lights just the single resolved cell. */
function glyphCellsOn(layout: Layout, pos: 0 | 1 | 2 | 3): number[] {
  if (layout.type === "split" && layout.children.length === 2) {
    if (layout.dir === "row") return pos === 0 ? [0, 2] : [1, 3];
    return pos === 0 ? [0, 1] : [2, 3];
  }
  return [pos];
}

export function ItemGlyph({ layout, itemId }: { layout: Layout; itemId: string }) {
  const pos = leafPositionOf(layout, itemId);
  if (pos === null) return null;
  const on = new Set(glyphCellsOn(layout, pos));
  return (
    <span className="item-glyph" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => <span key={i} data-on={on.has(i) || undefined} />)}
    </span>
  );
}

/** Sidebar item rows. "open" = the OPEN group (items currently in the layout): the row's x closes the item
 *  from the layout only (it stays around, unopened), and the row shows the quadrant glyph. "space" = the
 *  SPACE group (everything else): no x, no glyph, just click-to-open. Row clicks call openItem either
 *  way, but the store treats an already-open item as "go there" (focus its pane, no layout change);
 *  only SPACE rows actually open into the focused leaf. Moving an open item is drag-only. */
export function ItemList({ items, variant }: { items: Item[]; variant: "open" | "space" }) {
  const layout = useApp((s) => s.layout) ?? emptyLayout();
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const openItem = useApp((s) => s.openItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  // The active row is the one in the focused leaf, not every open row — with a split, only one pane
  // actually has keyboard/composer focus, and the highlight should say which.
  const focusedItemId = itemIdOfLeaf(layout, focusedLeafId);
  return (
    <div className="item-list">
      {items.map((it) => (
        <div key={it.id} className="item" data-active={(variant === "open" && it.id === focusedItemId) || undefined}
          data-dragging={draggingId === it.id || undefined}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", it.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(it.id); }}
          onDragEnd={() => setDraggingId(null)}
          onContextMenu={onContextMenu(it)}>
          {renaming?.id === it.id ? <RenameInput item={it} onDone={() => setRenaming(null)} /> : (
            <>
              <button className="item-row" aria-label={it.title} onClick={() => run(() => openItem(it.id))}>
                <Icon name={it.kind} size={14} /><span className="item-title">{it.title}</span>
                {it.kind === "session" && sessionStatus[it.refId] && (
                  <span className="status-dot item-status" data-status={sessionStatus[it.refId]} title={STATUS_LABEL[sessionStatus[it.refId]!]} />
                )}
                {variant === "open" && <ItemGlyph layout={layout} itemId={it.id} />}
              </button>
              {variant === "open" && (
                <button className="item-close" aria-label={`Close ${it.title}`} onClick={() => run(() => closeFromLayout(it.id))}><Icon name="close" size={12} /></button>
              )}
            </>
          )}
        </div>
      ))}
      {element}
    </div>
  );
}
