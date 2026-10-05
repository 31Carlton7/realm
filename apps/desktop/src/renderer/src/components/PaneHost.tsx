import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { VIEW_MAX_PANES, findLeaf, firstLeaf, primaryLeaves, type Item, type Layout, type LayoutLeaf, type LayoutSplit } from "@realm/contracts";
import type { DropEdge } from "../state/store";
import { Icon } from "@realm/ui";
import { PanelBar } from "./PanelBar";
import { PaneFor } from "../panes/registry";
import { closeIntent } from "../state/close-intent";
import { isRealmPaneDrag, REALM_ITEM_TYPE, REALM_NEW_SESSION_TYPE } from "./drag-types";

export type PaneHostProps = {
  layout: Layout; items: Item[]; focusedLeafId: string | null;
  /** The view's FOCUSED pane (⌘⇧F). When set — and still present in `layout` — only that
   *  leaf renders, filling the host. The tree itself is untouched: this is a view state, and clearing
   *  it puts every pane back exactly where it was. A stale id renders the ordinary split. */
  zoomedLeafId?: string | null;
  /** Every side pane put away (the toggle at the window's top right): still mounted — a browser's
   *  page, a terminal's scrollback and an agent's hold on them stay — but not drawn, and the panes
   *  they serve take their width. */
  sidePanesHidden?: boolean;
  onFocus: (leafId: string) => void;
  /** Called when the user asks a pane to fill the host (the panel bar's focus button / menu). */
  onZoom?: (leafId: string) => void;
  /** Called by the zoomed pane's own "Unfocus" control. */
  onUnzoom?: () => void;
  /** Layout-only close: the item leaves the screen but keeps existing in its space. */
  onClose: (itemId: string) => void;
  /** Drop an EMPTY pane out of the layout. Keyed by leaf, because there is no item to key on. */
  onCloseEmpty?: (leafId: string) => void;
  /** Take a session out of the split it shares — ⌘W's answer for that pane (`closeIntent`). Keyed by
   *  leaf, because what leaves is decided by where the pane is. */
  onUnsplit?: (leafId: string) => void;
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
  /** Double-click on a divider: put every child of that split back on equal shares. */
  onEqualize?: (splitId: string) => void;
  /** Task 7 wires the drop-zone UI; the store's openItemAt is already self-drop-safe. */
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;
  /** Create a fresh session at the selected drop zone. Unlike an item drag, no session exists until drop. */
  onDropNewSession?: (leafId: string, edge: DropEdge) => void;
};

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

/** The leaf at the window's top right, whose bar the side pane's toggle sits over: the last child of
 *  a row and the first of a column, all the way down. A side pane that is put away is not there. */
export function topRightLeaf(n: Layout, sidesHidden = false): LayoutLeaf | null {
  if (n.type === "leaf") return sidesHidden && n.tabs ? null : n;
  for (const c of n.dir === "row" ? [...n.children].reverse() : n.children) {
    const leaf = topRightLeaf(c, sidesHidden);
    if (leaf) return leaf;
  }
  return null;
}

/** Per-leaf drop-zone overlay. Its `hot` state is local so two panels never highlight together. */
function DropOverlay({ leafId, onDropItem, onDropNewSession }: {
  leafId: string;
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;
  onDropNewSession?: (leafId: string, edge: DropEdge) => void;
}) {
  const [hot, setHot] = useState<DropEdge | null>(null);
  return (
    <div className="drop-overlay"
      onDragOver={(e) => { if (isRealmPaneDrag(e)) { e.preventDefault(); setHot(zoneAtEvent(e)); } }}
      onDragLeave={() => setHot(null)}
      onDrop={(e) => {
        e.preventDefault();
        const edge = zoneAtEvent(e);
        if (Array.from(e.dataTransfer.types).includes(REALM_NEW_SESSION_TYPE)) onDropNewSession?.(leafId, edge);
        else {
          const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
          if (id) onDropItem?.(id, leafId, edge);
        }
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
    const onDragStart = (e: DragEvent) => { if (isRealmPaneDrag(e)) setDragging(true); };
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
  const root = zoomed ?? p.layout;
  // The leaf at the host's top-left, which is the first one depth-first for both split directions.
  // With the sidebar collapsed its bar is what sits under the macOS traffic lights, and it is the
  // only pane that has to leave room for them — a fact about where a pane IS, which CSS cannot ask.
  const firstLeafId = firstLeaf(root).id;
  // …and the one at its top right, which leaves room for the side pane's toggle the same way.
  const sidesHidden = !!p.sidePanesHidden;
  const topRightId = topRightLeaf(root, sidesHidden)?.id;
  /* A view with ONE leaf looks identical focused and unfocused, so its bar takes no focus toggle —
     a control whose entire effect is invisible is the dead chrome the pane bar bans, and it would be
     on screen for the app's most common shape (one pane, full width). Still offered while a zoom is
     live, because closing a sibling can leave a focused solo pane and a toggle that vanished would
     strand it lit-with-no-off. */
  const canFocus = p.layout.type !== "leaf" || !!zoomed;
  /* The window shows one view of at most two panes (Plan 27), so a split it would refuse is not
     offered: a control whose only outcome is nothing happening is dead chrome. */
  const canSplit = primaryLeaves(p.layout).length < VIEW_MAX_PANES;
  /* A session's bar has no close; while it shares the window its menu can take it out of the split.
     Not under pane focus, where the other pane is out of sight and the row would remove the one on
     screen to show a pane nobody was looking at — ⌘W still does it, as it closes whatever has focus. */
  const unsplits = (leafId: string) => !zoomed && closeIntent(p.layout, leafId, (id) => byId.get(id))?.kind === "unsplit";
  return <div className="panehost" data-zoomed={zoomed ? true : undefined}>{renderNode(root)}</div>;

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const item = n.itemId ? byId.get(n.itemId) ?? null : null;
      const tabs = n.tabs ? n.tabs.map((id) => byId.get(id)).filter((t): t is Item => !!t) : undefined;
      return (
        <div className="panel" data-leaf-id={n.id} data-focused={n.id === p.focusedLeafId || undefined}
          data-tabbed={tabs ? true : undefined}
          data-first-leaf={n.id === firstLeafId || undefined} data-top-right={n.id === topRightId || undefined}
          data-empty={!item || undefined} onPointerDownCapture={() => p.onFocus(n.id)}>
          {item && <PanelBar item={item} leafId={n.id} tabs={tabs} onSplit={canSplit ? (dir) => p.onSplit(n.id, dir) : undefined} onClose={() => p.onClose(item.id)}
            onUnsplit={p.onUnsplit && unsplits(n.id) ? () => p.onUnsplit!(n.id) : undefined}
            zoomed={n.id === p.zoomedLeafId}
            onZoom={canFocus && p.onZoom ? () => p.onZoom!(n.id) : undefined} onUnzoom={canFocus ? p.onUnzoom : undefined} />}
          {/* An empty pane gets a bar of its own — a title-less strip whose only control is the trash
              that drops the box. It had no bar at all, which left ⌘W as the one way to be rid of it
              and no way to discover that: the pane said "open something from the sidebar" and gave
              no answer to "and if I do not want to".

              The trash rather than the ×, and the difference is the design language's own (design.md):
              a × lifts an open thing out of the layout and leaves it in the space, and there is
              nothing here to leave. Nothing is deleted either — which is why it takes no confirm,
              unlike the trash on a page or a terminal.

              A direct child of `.panel`, which is what lets the traffic-light padding reach it
              (`.panel[data-first-leaf] > .panel-bar`) when this empty pane is the first leaf and the
              sidebar is collapsed. That attribute lives on the panel, not on the bar. */}
          {!item && p.onCloseEmpty && (
            <div className="panel-bar panel-bar-empty">
              <span className="panel-actions">
                <button className="icon-btn" aria-label="Close this empty pane"
                  title="Close this pane (⌘W)" onClick={() => p.onCloseEmpty!(n.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          )}
          <div className="panel-body">
            {!item && <div className="pane-placeholder muted">Open something from the sidebar.</div>}
            {/* Keyed by item.id: openItem's primary gesture replaces a leaf's item in place, and this
                div is otherwise the same React position across totally different sessions/terminals.
                Keying forces a remount so component-local state (composer draft, expanded thinking
                blocks, …) never leaks from the old item to the new one — and lets .panel-body .pane-slot's
                rl-settle animation (styles.css) naturally replay on every swap. */}
            {item && !tabs && <div key={item.id} className="pane-slot"><PaneFor item={item} visible focused={n.id === p.focusedLeafId} /></div>}
            {/* A side pane mounts the tab showing, and every BROWSER tab behind it, hidden. A browser's
                view exists only while a pane holds it or main retains it, and main retains three: a
                tab never mounted is a page an agent cannot drive ("the pane is not open in the
                app"), and one unmounted is a view the fourth retain evicts. Mounted with
                `visible={false}`, the view is hidden and kept — what a column per browser bought,
                without the columns. Every other kind mounts only while it is the tab showing. */}
            {/* Put away (`sidePanesHidden`), the strip stays mounted and shows nothing: a browser's view
                is hidden and kept rather than given up. */}
            {item && tabs && tabs.filter((t) => t.id === item.id || t.kind === "browser").map((t) => (
              <div key={t.id} className="pane-slot" hidden={t.id !== item.id || undefined}>
                <PaneFor item={t} visible={t.id === item.id && !sidesHidden} focused={t.id === item.id && n.id === p.focusedLeafId} />
              </div>
            ))}
          </div>
          {dragging && <DropOverlay leafId={n.id} onDropItem={p.onDropItem} onDropNewSession={p.onDropNewSession} />}
        </div>
      );
    }
    return (
      <SplitGroup node={n} onResize={p.onResize} onEqualize={p.onEqualize} hidden={n.children.map((c) => sidesHidden && c.type === "leaf" && !!c.tabs)}>
        {n.children.map((c) => <Fragment key={c.id}>{renderNode(c)}</Fragment>)}
      </SplitGroup>
    );
  }
}

/**
 * One layout split as a PanelGroup. PanelGroup reads `defaultSize` at mount only, which was fine
 * while every size change originated in a drag (the group is the source of truth mid-drag) — but
 * W2.4's sheet-snap/restore changes an EXISTING split's sizes in the STORE, so those are pushed
 * imperatively (setLayout — instant, resize is on the do-NOT-animate list). The onLayout echo
 * round-trips through resizeSplit, whose sameSizes guard stops the loop.
 */
function SplitGroup({ node, onResize, onEqualize, hidden, children }: {
  node: LayoutSplit; onResize?: (splitId: string, sizes: number[]) => void;
  onEqualize?: (splitId: string) => void;
  /** Children not drawn — a side pane put away — with the divider before each. Still in the group,
   *  so the group's sizes hold and the pane comes back at the width it had; the visible panel's flex
   *  share is then the whole row's. */
  hidden?: boolean[]; children: JSX.Element[];
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
          {i > 0 && <PanelResizeHandle className="resize-handle" style={hidden?.[i] ? { display: "none" } : undefined}
            onDoubleClick={() => onEqualize?.(node.id)} />}
          <Panel id={c.id} order={i} defaultSize={node.sizes[i] ?? 100 / node.children.length} minSize={10}
            style={hidden?.[i] ? { display: "none" } : undefined}>{children[i]}</Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
