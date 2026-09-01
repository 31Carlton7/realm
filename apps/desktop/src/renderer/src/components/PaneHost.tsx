import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { findLeaf, type Item, type Layout, type LayoutSplit } from "@realm/contracts";
import type { DropEdge } from "../state/store";
import { PanelBar } from "./PanelBar";
import { PaneFor } from "../panes/registry";

export type PaneHostProps = {
  layout: Layout; items: Item[]; focusedLeafId: string | null;
  /** The group's FOCUSED pane (Plan: pane groups). When set — and still present in `layout` — only that
   *  leaf renders, filling the host. The tree itself is untouched: this is a view state, and clearing
   *  it puts every pane back exactly where it was. A stale id renders the ordinary split. */
  zoomedLeafId?: string | null;
  onFocus: (leafId: string) => void;
  /** Called when the user asks a pane to fill the host (the panel bar's focus button / menu). */
  onZoom?: (leafId: string) => void;
  /** Called by the zoomed pane's own "Unfocus" control. */
  onUnzoom?: () => void;
  /** Layout-only close: the item leaves the layout but keeps existing (SPACE group). */
  onClose: (itemId: string) => void;
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
  /** Double-click on a divider: put every child of that split back on equal shares. */
  onEqualize?: (splitId: string) => void;
  /** Task 7 wires the drop-zone UI; the store's openItemAt is already self-drop-safe. */
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;
};

/** The custom MIME type sidebar rows carry (see ItemList.tsx). Filtering on it keeps ordinary OS file
 *  drags (which only ever carry "Files" and friends) from lighting up the drop overlays. */
const REALM_ITEM_TYPE = "application/x-realm-item";

function isRealmDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE);
}

const EDGES = ["left", "right", "top", "bottom", "center"] as const;
const EDGE_THRESHOLD = 0.32;

/**
 * Pure pointer→edge mapping: (x, y) relative to a panel-sized rect → the nearest edge zone within
 * EDGE_THRESHOLD of that edge, else "center". At a corner, both axes can be in range; the axis whose
 * fraction is smaller (the pointer has penetrated further into that edge's territory) wins. On an exact
 * tie, horizontal (left/right) beats vertical (top/bottom) — an arbitrary but fixed choice.
 * Coordinates outside the rect (the pointer has overshot the panel mid-drag) are not clamped: the
 * overshot side's fraction just goes negative, which is still <= EDGE_THRESHOLD, so it keeps winning
 * that edge deterministically instead of collapsing to "center".
 */
export function zoneAt(x: number, y: number, rect: { width: number; height: number }): DropEdge {
  const { width, height } = rect;
  if (width <= 0 || height <= 0) return "center";
  const all: { edge: DropEdge; frac: number }[] = [
    { edge: "left", frac: x / width },
    { edge: "right", frac: (width - x) / width },
    { edge: "top", frac: y / height },
    { edge: "bottom", frac: (height - y) / height },
  ];
  const candidates = all.filter((c) => c.frac <= EDGE_THRESHOLD);
  if (candidates.length === 0) return "center";
  return candidates.reduce((best, c) => (c.frac < best.frac ? c : best)).edge;
}

function zoneAtEvent(e: ReactDragEvent<HTMLElement>): DropEdge {
  const rect = e.currentTarget.getBoundingClientRect();
  return zoneAt(e.clientX - rect.left, e.clientY - rect.top, rect);
}

/** Per-leaf drop-zone overlay. Its `hot` state is local so two panels never highlight together. */
function DropOverlay({ leafId, onDropItem }: { leafId: string; onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void }) {
  const [hot, setHot] = useState<DropEdge | null>(null);
  return (
    <div className="drop-overlay"
      onDragOver={(e) => { if (isRealmDrag(e)) { e.preventDefault(); setHot(zoneAtEvent(e)); } }}
      onDragLeave={() => setHot(null)}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
        if (id) onDropItem?.(id, leafId, zoneAtEvent(e));
        setHot(null);
      }}>
      {EDGES.map((edge) => (
        <div key={edge} className="drop-zone" data-edge={edge} data-hot={hot === edge || undefined} />
      ))}
    </div>
  );
}

export function PaneHost(p: PaneHostProps) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  const [dragging, setDragging] = useState(false);

  // Window-level, not per-panel: a drag can start over the sidebar (a different subtree) and must light
  // up every panel's overlay at once; it ends on dragend (cancelled) or drop (completed) anywhere.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => { if (isRealmDrag(e)) setDragging(true); };
    const onDragEnd = () => setDragging(false);
    const onDrop = () => setDragging(false);
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // A focused pane renders ALONE — not a `display:none` on its siblings, which would keep every other
  // pane mounted and (for terminals and browser views) fighting for size behind the one on screen.
  const zoomed = p.zoomedLeafId ? findLeaf(p.layout, p.zoomedLeafId) : null;
  return <div className="panehost" data-zoomed={zoomed ? true : undefined}>{renderNode(zoomed ?? p.layout)}</div>;

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const item = n.itemId ? byId.get(n.itemId) ?? null : null;
      return (
        <div className="panel" data-leaf-id={n.id} data-focused={n.id === p.focusedLeafId || undefined}
          data-empty={!item || undefined} onPointerDownCapture={() => p.onFocus(n.id)}>
          {item && <PanelBar item={item} leafId={n.id} onSplit={(dir) => p.onSplit(n.id, dir)} onClose={() => p.onClose(item.id)}
            zoomed={n.id === p.zoomedLeafId} onZoom={p.onZoom ? () => p.onZoom!(n.id) : undefined} onUnzoom={p.onUnzoom} />}
          <div className="panel-body">
            {!item && <div className="pane-placeholder muted">Open something from the sidebar.</div>}
            {/* Keyed by item.id: openItem's primary gesture replaces a leaf's item in place, and this
                div is otherwise the same React position across totally different sessions/terminals.
                Keying forces a remount so component-local state (composer draft, expanded thinking
                blocks, …) never leaks from the old item to the new one — and lets .panel-body .pane-slot's
                rl-settle animation (styles.css) naturally replay on every swap. */}
            {item && <div key={item.id} className="pane-slot"><PaneFor item={item} visible focused={n.id === p.focusedLeafId} /></div>}
          </div>
          {dragging && <DropOverlay leafId={n.id} onDropItem={p.onDropItem} />}
        </div>
      );
    }
    return <SplitGroup node={n} onResize={p.onResize} onEqualize={p.onEqualize}>{n.children.map((c) => <Fragment key={c.id}>{renderNode(c)}</Fragment>)}</SplitGroup>;
  }
}

/**
 * One layout split as a PanelGroup. PanelGroup reads `defaultSize` at mount only, which was fine
 * while every size change originated in a drag (the group is the source of truth mid-drag) — but
 * W2.4's sheet-snap/restore changes an EXISTING split's sizes in the STORE, so those are pushed
 * imperatively (setLayout — instant, resize is on the do-NOT-animate list). The onLayout echo
 * round-trips through resizeSplit, whose sameSizes guard stops the loop.
 */
function SplitGroup({ node, onResize, onEqualize, children }: {
  node: LayoutSplit; onResize?: (splitId: string, sizes: number[]) => void;
  onEqualize?: (splitId: string) => void; children: JSX.Element[];
}) {
  const ref = useRef<ImperativePanelGroupHandle>(null);
  const sizes = node.sizes;
  useEffect(() => {
    const g = ref.current; if (!g) return;
    const current = g.getLayout();
    if (current.length !== sizes.length) return; // children changed — the remount path owns this
    if (sizes.some((want, i) => Math.abs(want - (current[i] ?? NaN)) >= 0.01)) g.setLayout(sizes);
  }, [sizes]);
  return (
    <PanelGroup ref={ref} id={node.id} direction={node.dir === "row" ? "horizontal" : "vertical"} onLayout={(s) => onResize?.(node.id, s)}>
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {/* Double-click restores the whole group's equal shares — the sizes every split is born
              with — rather than only the two panels this handle sits between, so one gesture per
              divider is enough to undo any amount of dragging. It goes through the STORE, not
              setLayout: the sizes effect above is what pushes the result into the group, and the
              store no-ops on an already-equal split, so an undragged divider ignores the gesture. */}
          {i > 0 && <PanelResizeHandle className="resize-handle" onDoubleClick={() => onEqualize?.(node.id)} />}
          <Panel id={c.id} order={i} defaultSize={node.sizes[i] ?? 100 / node.children.length} minSize={10}>{children[i]}</Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
