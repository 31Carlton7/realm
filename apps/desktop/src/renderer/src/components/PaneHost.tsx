import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { clampPanelShare, findLeaf, firstLeaf, minRoomOf, primaryLeaves, tabOwner, type Item, type Layout, type LayoutLeaf, type LayoutSplit, type Room } from "@realm/contracts";
import type { DropEdge } from "../state/store";
import type { PanelPlace } from "../state/view-room";
import { Icon } from "@realm/ui";
import { PanelBar } from "./PanelBar";
import { PanelEdge } from "./PanelEdge";
import { OwnerCueContext } from "./owner-cue";
import { PaneFor } from "../panes/registry";
import { closeIntent } from "../state/close-intent";
import { useChord } from "./sidebar/use-sidebar-model";
import { isRealmPaneDrag, REALM_ITEM_TYPE, REALM_NEW_SESSION_TYPE } from "./drag-types";

export type PaneHostProps = {
  layout: Layout; items: Item[]; focusedLeafId: string | null;
  /** The view's FOCUSED pane (⌘⇧F). When set — and still present in `layout` — that pane fills the
   *  main panes' place (the panel stays beside it), or, for the panel, the panel fills the host. The
   *  tree itself is untouched: this is a view state, and clearing it puts every pane back exactly
   *  where it was. A stale id renders the ordinary split. */
  zoomedLeafId?: string | null;
  /** Where the side panel stands (state/view-room.ts): beside the main panes at a width, put away by
   *  the toggle, stepping aside for want of room, filling the host, or not there. Absent, it is read
   *  off `sidePanesHidden` and drawn beside the panes at its share. Put away or aside it stays
   *  MOUNTED — a browser's page, a terminal's scrollback and an agent's hold on them stay — and is not
   *  drawn, and the main panes take its width. */
  panelPlace?: PanelPlace;
  /** The panel put away (the toggle at the window's top right), for a host given no `panelPlace`. */
  sidePanesHidden?: boolean;
  /** The panel's share of the host, for the frame before the host has measured itself. */
  panelShare?: number;
  /** The host measured itself: the room the main panes and the panel share. */
  onRoom?: (room: Room) => void;
  /** The panel's edge dragged (or reset) to `share` of the host. */
  onResizePanel?: (share: number, opts: { commit?: boolean }) => void;
  /** Why splitting `leafId` along `dir` is not offered, or null when it is — the sentence its menu row
   *  and its drop zones wear. Absent: every split is. */
  splitRefusal?: (leafId: string, dir: "row" | "col") => string | null;
  onFocus: (leafId: string) => void;
  /** Called when the user asks a pane to fill the host (the panel bar's focus button / menu). */
  onZoom?: (leafId: string) => void;
  /** Called by the zoomed pane's own "Unfocus" control. */
  onUnzoom?: () => void;
  /** Layout-only close: the item leaves the screen but keeps existing in its space. */
  onClose: (itemId: string) => void;
  /** Drop an EMPTY pane out of the layout. Keyed by leaf, because there is no item to key on. */
  onCloseEmpty?: (leafId: string) => void;
  /** An EMPTY pane's "New session": a new session made in that pane, by leaf. Absent: the pane only
   *  says what can be dragged into it. */
  onNewSessionHere?: (leafId: string) => void;
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

/** What an empty pane offers: the shortest path to work in it — a session made right here — and the
 *  other way it fills, a drag from the sidebar. */
function EmptyPane({ onNewSession }: { onNewSession?: () => void }) {
  const chord = useChord("session.new");
  if (!onNewSession) return <div className="pane-placeholder muted">Drag something here from the sidebar.</div>;
  return (
    <div className="pane-placeholder">
      <button className="btn" title={chord ? `Start a session in this pane (${chord})` : "Start a session in this pane"} onClick={onNewSession}>New session</button>
      <div className="muted">or drag something here from the sidebar</div>
    </div>
  );
}

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

/** The leaf at the top right of `n`: the last child of a row and the first of a column, all the way
 *  down — the one whose bar the side panel's toggle sits over when the panel is not drawn. */
export function topRightLeaf(n: Layout, sidesHidden = false): LayoutLeaf | null {
  if (n.type === "leaf") return sidesHidden && n.tabs ? null : n;
  for (const c of n.dir === "row" ? [...n.children].reverse() : n.children) {
    const leaf = topRightLeaf(c, sidesHidden);
    if (leaf) return leaf;
  }
  return null;
}

/** The panel when the layout is in the view's shape: the second child of a row at the root. */
function rootPanelOf(l: Layout): LayoutLeaf | null {
  if (l.type !== "split" || l.dir !== "row" || l.children.length !== 2) return null;
  const last = l.children[1]!;
  return last.type === "leaf" && last.tabs ? last : null;
}

/** Per-leaf drop-zone overlay. Its `hot` state is local so two panels never highlight together. An
 *  edge a split would not fit in lights as refused, and says why on the zone; the panel offers its
 *  middle only, since a drop there is a tab. */
function DropOverlay({ leafId, edges, refusal, onDropItem, onDropNewSession }: {
  leafId: string;
  edges: boolean;
  refusal?: (dir: "row" | "col") => string | null;
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;
  onDropNewSession?: (leafId: string, edge: DropEdge) => void;
}) {
  const [hot, setHot] = useState<DropEdge | null>(null);
  const zone = (e: ReactDragEvent<HTMLElement>): DropEdge => (edges ? zoneAtEvent(e) : "center");
  const why = (edge: DropEdge) => (edge === "center" ? null : refusal?.(edge === "top" || edge === "bottom" ? "col" : "row") ?? null);
  return (
    <div className="drop-overlay"
      onDragOver={(e) => { if (isRealmPaneDrag(e)) { e.preventDefault(); setHot(zone(e)); } }}
      onDragLeave={() => setHot(null)}
      onDrop={(e) => {
        e.preventDefault();
        const edge = zone(e);
        setHot(null);
        // A refused edge takes no drop: the zone already says why, and the store would only say it again.
        if (why(edge)) return;
        if (Array.from(e.dataTransfer.types).includes(REALM_NEW_SESSION_TYPE)) onDropNewSession?.(leafId, edge);
        else {
          const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
          if (id) onDropItem?.(id, leafId, edge);
        }
      }}>
      {(edges ? EDGES : (["center"] as const)).map((edge) => (
        <div key={edge} className="drop-zone" data-edge={edge} data-hot={hot === edge || undefined} data-refused={hot === edge && why(edge) ? true : undefined} />
      ))}
      {/* Across the pane rather than in the zone, which is a third of it and would stack the words. */}
      {hot && why(hot) && <div className="drop-zone-why" role="status">{why(hot)}</div>}
    </div>
  );
}

export function PaneHost(p: PaneHostProps) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  const [dragging, setDragging] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);

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

  /* The host's own box is the room: the window less the rail and the sidebar, whatever they are doing.
     Observed rather than computed from the window, because the sidebar slides and drags. */
  const onRoom = p.onRoom;
  const [room, setRoom] = useState<Room | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const next = { width: Math.round(r.width), height: Math.round(r.height) };
      setRoom((cur) => (cur && cur.width === next.width && cur.height === next.height ? cur : next));
      onRoom?.(next);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onRoom]);

  const layout = p.layout;
  const panel = rootPanelOf(layout);
  const main = panel ? (layout as LayoutSplit).children[0]! : layout;
  // A focused pane renders ALONE in its place — not a `display:none` on its siblings, which would keep
  // every other pane mounted and (for terminals and browser views) fighting for size behind it.
  const zoomed = p.zoomedLeafId ? findLeaf(layout, p.zoomedLeafId) : null;
  const place: PanelPlace = !panel ? { kind: "none" }
    : p.panelPlace ?? (zoomed?.id === panel.id ? { kind: "full" } : p.sidePanesHidden ? { kind: "away" } : { kind: "beside", width: 0 });
  const panelDrawn = place.kind === "beside" || place.kind === "full";
  const shownMain = place.kind === "full" ? null : zoomed && !zoomed.tabs ? zoomed : main;
  // The leaf at the host's top-left, which is the first one depth-first for both split directions.
  // With the sidebar collapsed its bar is what sits under the macOS traffic lights, and it is the
  // only pane that has to leave room for them — a fact about where a pane IS, which CSS cannot ask.
  const firstLeafId = firstLeaf(shownMain ?? panel!).id;
  // …and the one at its top right, which leaves room for the side panel's toggle the same way: the
  // panel's own bar while it is drawn, else the main panes' top right.
  const topRightId = panelDrawn ? panel!.id : shownMain ? topRightLeaf(shownMain, true)?.id : undefined;
  const mainCount = primaryLeaves(main).length;
  /* A pane alone in the main panes' place looks the same focused and unfocused, so its bar takes no
     focus toggle — a control whose entire effect is invisible is the dead chrome the pane bar bans.
     Still offered while a zoom is live, because closing a sibling can leave a focused solo pane and a
     toggle that vanished would strand it lit-with-no-off. The panel always has one: its full view
     takes the main panes' place too. */
  const canFocus = (leaf: LayoutLeaf) => !!leaf.tabs || mainCount > 1 || !!zoomed;
  /* A session's bar has no close; while it shares the window its menu can take it out of the split.
     Not under pane focus, where the other panes are out of sight and the row would remove the one on
     screen to show panes nobody was looking at — ⌘W still does it, as it closes whatever has focus. */
  const unsplits = (leafId: string) => !zoomed && closeIntent(layout, leafId, (id) => byId.get(id))?.kind === "unsplit";

  /* The owner cue. While several sessions' tabs share the strip, the pane whose session owns the tab
     the keyboard is in wears the mark, and a tab under the pointer marks its own session's pane. */
  const owners = panel?.tabs ? new Set(panel.tabs.map((t) => tabOwner(panel, t))) : new Set<string | undefined>();
  const shared = owners.size > 1;
  const activeOwner = shared && panel && p.focusedLeafId === panel.id && panel.itemId ? tabOwner(panel, panel.itemId) : undefined;
  const cue = useCallback((owner: string | null) => {
    const el = host.current; if (!el) return;
    for (const n of el.querySelectorAll("[data-owner-hover]")) n.removeAttribute("data-owner-hover");
    if (!owner) return;
    for (const n of el.querySelectorAll<HTMLElement>(".panel[data-item]")) if (n.dataset.item === owner) n.setAttribute("data-owner-hover", "");
  }, []);

  const roomWidth = room?.width ?? 0;
  const need = shownMain ? minRoomOf(shownMain).width : 0;
  const panelStyle = place.kind === "beside"
    ? (place.width > 0 ? { width: place.width } : { width: `${clampPanelShare(p.panelShare) * 100}%` })
    : undefined;
  return (
    <OwnerCueContext.Provider value={cue}>
      <div className="panehost" ref={host} data-zoomed={zoomed ? true : undefined} data-panel={panel ? place.kind : undefined}>
        {shownMain && <div key="main" className="view-main">{renderNode(shownMain)}</div>}
        {panel && place.kind === "beside" && (
          <PanelEdge key="edge" width={place.width} roomWidth={roomWidth} need={need} column={column} onResize={p.onResizePanel ?? (() => {})} />
        )}
        {panel && (
          <div key="panel" id="side-panel" ref={column} className="view-panel" data-full={place.kind === "full" || undefined}
            hidden={!panelDrawn || undefined} style={panelStyle}>
            {renderNode(panel)}
          </div>
        )}
      </div>
    </OwnerCueContext.Provider>
  );

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const item = n.itemId ? byId.get(n.itemId) ?? null : null;
      const tabs = n.tabs ? n.tabs.map((id) => byId.get(id)).filter((t): t is Item => !!t) : undefined;
      const isPanel = n.id === panel?.id;
      // Shown: a tab of a panel that is not drawn is mounted (its view kept) and not visible.
      const live = !isPanel || panelDrawn;
      const refusal = !n.tabs && p.splitRefusal ? (dir: "row" | "col") => p.splitRefusal!(n.id, dir) : undefined;
      return (
        <div className="panel" data-leaf-id={n.id} data-item={n.itemId ?? undefined} data-focused={n.id === p.focusedLeafId || undefined}
          data-tabbed={tabs ? true : undefined}
          data-first-leaf={n.id === firstLeafId || undefined} data-top-right={n.id === topRightId || undefined}
          data-owner-active={!n.tabs && n.itemId !== null && n.itemId === activeOwner ? true : undefined}
          data-empty={!item || undefined}
          onPointerDownCapture={(e) => {
            // A tab chosen from the panel's strip shows without taking the keyboard from the prompter
            // that has it; a click into the tab itself is what moves it.
            if (isPanel && (e.target as Element).closest(".panel-bar")) return;
            p.onFocus(n.id);
          }}>
          {item && <PanelBar item={item} leafId={n.id} tabs={tabs} owners={isPanel && shared ? n.owners : undefined}
            onSplit={n.tabs ? undefined : (dir) => p.onSplit(n.id, dir)}
            splitRefusal={refusal}
            onClose={() => p.onClose(item.id)}
            onUnsplit={p.onUnsplit && unsplits(n.id) ? () => p.onUnsplit!(n.id) : undefined}
            zoomed={n.id === p.zoomedLeafId}
            onZoom={canFocus(n) && p.onZoom ? () => p.onZoom!(n.id) : undefined} onUnzoom={canFocus(n) ? p.onUnzoom : undefined} />}
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
            {!item && <EmptyPane onNewSession={p.onNewSessionHere ? () => p.onNewSessionHere!(n.id) : undefined} />}
            {/* Keyed by item.id: openItem's primary gesture replaces a leaf's item in place, and this
                div is otherwise the same React position across totally different sessions/terminals.
                Keying forces a remount so component-local state (composer draft, expanded thinking
                blocks, …) never leaks from the old item to the new one — and lets .panel-body .pane-slot's
                rl-settle animation (styles.css) naturally replay on every swap. */}
            {item && !tabs && <div key={item.id} className="pane-slot"><PaneFor item={item} visible focused={n.id === p.focusedLeafId} /></div>}
            {/* The panel mounts the tab showing, and every BROWSER tab behind it, hidden. A browser's
                view exists only while a pane holds it or main retains it, and main retains three: a
                tab never mounted is a page an agent cannot drive ("the pane is not open in the
                app"), and one unmounted is a view the fourth retain evicts. Mounted with
                `visible={false}`, the view is hidden and kept — what a column per browser bought,
                without the columns. Every other kind mounts only while it is the tab showing. */}
            {/* Put away or stepping aside, the strip stays mounted and shows nothing: a browser's view
                is hidden and kept rather than given up. */}
            {item && tabs && tabs.filter((t) => t.id === item.id || t.kind === "browser").map((t) => (
              <div key={t.id} className="pane-slot" hidden={t.id !== item.id || undefined}>
                <PaneFor item={t} visible={t.id === item.id && live} focused={t.id === item.id && n.id === p.focusedLeafId} />
              </div>
            ))}
          </div>
          {dragging && <DropOverlay leafId={n.id} edges={!n.tabs} refusal={refusal} onDropItem={p.onDropItem} onDropNewSession={p.onDropNewSession} />}
        </div>
      );
    }
    return (
      <SplitGroup node={n} onResize={p.onResize} onEqualize={p.onEqualize}>
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
function SplitGroup({ node, onResize, onEqualize, children }: {
  node: LayoutSplit; onResize?: (splitId: string, sizes: number[]) => void;
  onEqualize?: (splitId: string) => void;
  children: JSX.Element[];
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
