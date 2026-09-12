import { Icon } from "@realm/ui";
import { useMemo, useState } from "react";
import { emptyLayout, itemIdOfLeaf, type Item, type Layout } from "@realm/contracts";
import { useApp, type AppState } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { useItemContextMenu } from "./ItemContextMenu";
import { dotFor } from "../../panes/machine/MachineBar";
import { MACHINE_WORDS } from "../../panes/machine/MachinePane";

const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

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
 * A small picture of the arrangement, with this item's pane lit.
 *
 * An `<svg>` rather than a CSS grid of spans, because the thing being drawn is not a grid: rects can
 * sit at any fraction of the box, which is what lets an arbitrary tree be drawn exactly.
 */
export function ItemGlyph({ layout, itemId }: { layout: Layout; itemId: string }) {
  const rects = paneMapOf(layout, itemId);
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

/** Sidebar item rows. "open" = the OPEN group (items currently in the layout): the row's x closes the item
 *  from the layout only (it stays around, unopened), and the row shows the quadrant glyph. "space" = the
 *  SPACE group (everything else): no x, no glyph, just click-to-open. "archived" = the shelf: no x, no
 *  glyph, and the row's click RESTORES before it opens (see below). Row clicks call openItem either
 *  way, but the store treats an already-open item as "go there" (focus its pane, no layout change);
 *  only SPACE rows actually open into the focused leaf. Moving an open item is a drag, or the row
 *  menu's "Open here". */
/**
 * Sessions with events this user has not read.
 *
 * `seenSeq` is stamped when a session's pane has the keyboard, so this set is exactly "something
 * happened while you were looking elsewhere" — which, with a server that keeps working while the app
 * is closed, is the question the sidebar could not answer before.
 *
 * Derived with `useMemo` from the `sessions` slice rather than computed inside the selector: a
 * selector that builds a fresh Set returns a new reference every time the store is read, which zustand
 * compares by identity and reads as a change — an unconditional re-render loop.
 */
const unseenSessions = (sessions: AppState["sessions"]): Set<string> => {
  const out = new Set<string>();
  for (const row of Object.values(sessions)) if (row.seenSeq > 0 && row.lastEventSeq > row.seenSeq) out.add(row.id);
  return out;
};

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
  const sessionRows = useApp((s) => s.sessions);
  const unseen = useMemo(() => unseenSessions(sessionRows), [sessionRows]);
  const browserDriving = useApp((s) => s.browserDriving);
  const machineState = useApp((s) => s.machineState);
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
                  : it.kind === "session" && unseen.has(it.refId) ? `${it.title} — new since you were here`
                  : it.kind === "browser" && browserDriving[it.refId] ? `${it.title} — agent is driving`
                  : it.kind === "machine" ? `${it.title} — ${MACHINE_WORDS[machineState[it.refId]?.status ?? "off"]}` : it.title}
                onClick={() => activate(it)}>
                <Icon name={it.kind} size={16} /><span className="item-title">{it.title}</span>
                {it.kind === "session" && sessionStatus[it.refId] && (
                  <span className="status-dot item-status" data-status={sessionStatus[it.refId]} title={STATUS_LABEL[sessionStatus[it.refId]!]} />
                )}
                {/* Something happened here that you have not seen. Drawn only when the session is
                    NOT already wearing a status dot, because two marks on one row would be asking a
                    reader to tell apart "this is running" from "this said something" at four pixels
                    — and a session that is running is one whose news you are about to get anyway.
                    A session with no live handle gets no chrome of its own: Realm starts adapters
                    lazily, so "not live" is the resting state of most of the sidebar. */}
                {it.kind === "session" && !sessionStatus[it.refId] && unseen.has(it.refId) && (
                  <span className="status-dot item-status" data-status="unseen" title="New since you were here" />
                )}
                {/* W4: a browser row wears the driving dot only WHILE an agent act is in flight —
                    the same status-dot idiom sessions use, a new `driving` state on the same rail. */}
                {it.kind === "browser" && browserDriving[it.refId] && (
                  <span className="status-dot item-status" data-status="driving" title="Agent is driving" />
                )}
                {/* Plan 25 W3: a machine row wears its state ALWAYS, not only while a pane is open.
                    That is the whole answer to the one honest risk in letting the pane's × be a
                    layout-only close — a machine you are still connected to is invisible compute
                    otherwise, and `browserDriving` set the precedent that the row carries it. */}
                {it.kind === "machine" && (
                  <span className="status-dot item-status" data-status={dotFor(machineState[it.refId]?.status ?? "off")}
                    title={MACHINE_WORDS[machineState[it.refId]?.status ?? "off"]} />
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
