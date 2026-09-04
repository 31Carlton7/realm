import { Icon } from "@realm/ui";
import { useState } from "react";
import { allItems, emptyLayout, itemIdOfLeaf, type Item, type Layout } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { useItemContextMenu } from "./ItemContextMenu";

const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

/** Past four the bars fall under a device pixel at the glyph's 12px and it reads as a smudge rather
 *  than as slots. gridPreset's widest split is three, so nothing reachable is turned away today. */
const MAX_GLYPH_SLOTS = 4;

/**
 * How many slots the layout's top-level split has, which one holds this item, and which way the
 * split runs — the three facts the sidebar's glyph draws.
 *
 * Only the TOP level is read, and that is the design rather than a shortcut: the glyph is 12px wide,
 * a nested tree drawn into it is mush, and "which half am I in" is the question a row in a split is
 * actually asked. So a two-way root answers by which child's SUBTREE holds the item, never by
 * depth-first leaf order — an item three levels down the first child is still in the first half.
 *
 * Returns null whenever there is nothing it can say truthfully: no split at all, the item is not
 * open in this tree, or the root has more slots than the glyph can draw. What used to fill that gap
 * was depth-first leaf index modulo 4, which was not an approximation but a wrong answer — under a
 * three-column layout (gridPreset makes them, and the command palette offers them) a pane at the far
 * right of a single row lit the bottom-left quadrant of a grid that had no bottom row. The glyph is
 * read by someone who cannot otherwise tell two rows apart, so pointing them at the wrong pane costs
 * more than saying nothing.
 */
export function paneSlotOf(layout: Layout, itemId: string): { index: number; count: number; dir: "row" | "col" } | null {
  if (layout.type !== "split") return null;
  const count = layout.children.length;
  if (count < 2 || count > MAX_GLYPH_SLOTS) return null;
  const index = layout.children.findIndex((c) => allItems(c).includes(itemId));
  return index === -1 ? null : { index, count, dir: layout.dir };
}

/** One bar per slot of the top-level split, laid out along that split's own axis, with this item's
 *  slot lit. The bar count and direction come from the layout, so the mark is a small picture of the
 *  arrangement rather than a fixed grid the arrangement has to be squeezed into. */
export function ItemGlyph({ layout, itemId }: { layout: Layout; itemId: string }) {
  const slot = paneSlotOf(layout, itemId);
  if (!slot) return null;
  return (
    <span className="item-glyph" data-dir={slot.dir} aria-hidden="true">
      {Array.from({ length: slot.count }, (_, i) => <span key={i} data-on={i === slot.index || undefined} />)}
    </span>
  );
}

/** Sidebar item rows. "open" = the OPEN group (items currently in the layout): the row's x closes the item
 *  from the layout only (it stays around, unopened), and the row shows the quadrant glyph. "space" = the
 *  SPACE group (everything else): no x, no glyph, just click-to-open. "archived" = the shelf: no x, no
 *  glyph, and the row's click RESTORES before it opens (see below). Row clicks call openItem either
 *  way, but the store treats an already-open item as "go there" (focus its pane, no layout change);
 *  only SPACE rows actually open into the focused leaf. Moving an open item is a drag, or the row
 *  menu's "Open here". */
export function ItemList({ items, variant, layout: groupLayout }: {
  items: Item[]; variant: "open" | "space" | "archived";
  /** The layout the quadrant glyph is drawn against — the owning GROUP's tree, which for a group that
   *  is not on screen is not the active layout. Defaults to the active one (SPACE rows, tests). */
  layout?: Layout;
}) {
  const activeLayoutValue = useApp((s) => s.layout) ?? emptyLayout();
  const layout = groupLayout ?? activeLayoutValue;
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const browserDriving = useApp((s) => s.browserDriving);
  const openItem = useApp((s) => s.openItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const archiveItem = useApp((s) => s.archiveItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  // The active row is the one in the focused leaf, not every open row — with a split, only one pane
  // actually has keyboard/composer focus, and the highlight should say which.
  const focusedItemId = itemIdOfLeaf(activeLayoutValue, focusedLeafId);
  // Clicking an archived row takes it OFF the shelf on the way to opening it. Opening one that stayed
  // archived would put a pane on screen for a row the sidebar only lists under "Archived" — the row
  // and the pane would then disagree about whether the thing is put away. The hover button is the
  // gesture for restoring without going there.
  const activate = (it: Item) => (variant === "archived"
    ? run(async () => { await archiveItem(it.id, false); await openItem(it.id); })
    : run(() => openItem(it.id)));
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
              {/* The status is part of the accessible name (A-L4): the dot alone is invisible to a reader. */}
              <button className="item-row"
                aria-label={it.kind === "session" && sessionStatus[it.refId] ? `${it.title} — ${STATUS_LABEL[sessionStatus[it.refId]!]}`
                  : it.kind === "browser" && browserDriving[it.refId] ? `${it.title} — agent is driving` : it.title}
                onClick={() => activate(it)}>
                <Icon name={it.kind} size={16} /><span className="item-title">{it.title}</span>
                {it.kind === "session" && sessionStatus[it.refId] && (
                  <span className="status-dot item-status" data-status={sessionStatus[it.refId]} title={STATUS_LABEL[sessionStatus[it.refId]!]} />
                )}
                {/* W4: a browser row wears the driving dot only WHILE an agent act is in flight —
                    the same status-dot idiom sessions use, a new `driving` state on the same rail. */}
                {it.kind === "browser" && browserDriving[it.refId] && (
                  <span className="status-dot item-status" data-status="driving" title="Agent is driving" />
                )}
                {variant === "open" && <ItemGlyph layout={layout} itemId={it.id} />}
              </button>
              {/* Sessions alone get the shelf. The gesture is a session's — put a conversation away
                  when it is done with — and the other kinds have no answer for what archiving means:
                  a destination page is one per space, a diff is a view of a checkout. The `archived`
                  column itself is kind-blind, so widening this is a one-line change here. */}
              {it.kind === "session" && (
                <button className="item-shelf" aria-label={`${variant === "archived" ? "Unarchive" : "Archive"} ${it.title}`}
                  title={variant === "archived" ? "Unarchive" : "Archive"}
                  onClick={() => run(() => archiveItem(it.id, variant !== "archived"))}>
                  <Icon name={variant === "archived" ? "unarchive" : "archive"} size={12} />
                </button>
              )}
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
