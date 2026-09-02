import { memo, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type WheelEvent } from "react";
import { Icon } from "@realm/ui";
import { allItems, type Item, type PaneGroup } from "@realm/contracts";
import { useApp } from "../../state/store";
import { createDragSwipe, type SwipePhase, type SwipeUpdate } from "../../state/gesture";
import { SpaceHeader } from "./SpaceHeader";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";
import { GroupRenameInput } from "../RenameInput";

const IDLE_MS = 320;
const DEBUG = () => { try { return localStorage.getItem("realm.debugSwipe") === "1"; } catch { return false; } };
const EASE = "transform 380ms cubic-bezier(.2,.85,.2,1)";

/** Map the native helper's (phase, momentum) pair to the tracker's phase vocabulary. */
export function toSwipePhase(m: { phase: string; momentum: string }): SwipePhase | null {
  if (m.momentum === "began") return "momentumBegan";
  if (m.momentum === "ended" || m.momentum === "cancelled") return "momentumEnded";
  if (m.momentum !== "none") return null; // momentum "changed": deltas keep coming via wheel; ignore
  switch (m.phase) {
    case "began": case "mayBegin": return "began";
    case "changed": case "stationary": return "changed";
    case "ended": return "ended";
    case "cancelled": return "cancelled";
    default: return null;
  }
}

/** Horizontal track with one page per space. Two-finger drag follows the fingers 1:1 (transform
 *  written straight to the DOM — no React state per wheel event), rubber-bands at the ends, holds
 *  wherever you rest, and on lift either commits (past half a page, or a flick) or eases back.
 *  Finger lift comes from the native ScrollPhase helper when available; otherwise a quiet-gap timer.
 *  Only the active page subscribes to items — the others render just their header. */
export function SpaceSwiper() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const nextSpace = useApp((s) => s.nextSpace);
  const prevSpace = useApp((s) => s.prevSpace);
  const run = useApp((s) => s.run);
  const swipeInvert = useApp((s) => s.swipeInvert);
  const invertRef = useRef(swipeInvert); invertRef.current = swipeInvert;
  const trackRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<ReturnType<typeof createDragSwipe> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = Math.max(0, spaces.findIndex((s) => s.id === activeSpaceId));
  const indexRef = useRef(index); indexRef.current = index;
  const countRef = useRef(spaces.length); countRef.current = spaces.length;
  const hoverRef = useRef(false);
  const nativeRef = useRef(false); // once the native helper streams, it is the single source (deltas + phases)

  const base = (i: number) => `translateX(${-i * 100}%)`;
  const setTransform = (t: string, ease: boolean) => {
    const el = trackRef.current; if (!el) return;
    el.style.transition = ease ? EASE : "none";
    el.style.transform = t;
  };
  const tracker = () => (trackerRef.current ??= createDragSwipe({ width: hostRef.current?.clientWidth || 240, idleMs: IDLE_MS }));

  // §6 does not animate "sidebar space swipes triggered by keyboard". A page slide is the tail of a
  // gesture the fingers already started, so only a gesture commit arms it; ⌃⇥, a click on the space
  // strip, or a space activated from anywhere else lands on the new page instantly.
  const fromGesture = useRef(false);

  const apply = (r: SwipeUpdate) => {
    const i = indexRef.current;
    if (DEBUG() && r.type !== "ignore") console.debug("[swipe]", r.type, r.type === "move" ? r.offset.toFixed(1) : r.type === "commit" ? r.dir : "", "idx", i);
    if (r.type === "move") { fromGesture.current = false; setTransform(`translateX(calc(${-i * 100}% - ${r.offset}px))`, false); }
    else if (r.type === "settle") setTransform(base(i), true);
    else if (r.type === "commit") { fromGesture.current = true; run(() => (r.dir === "next" ? nextSpace() : prevSpace())); } // layout effect eases to the new page
  };

  // React owns the resting position; gestures only deviate from it transiently.
  useLayoutEffect(() => { setTransform(base(index), fromGesture.current); fromGesture.current = false; }, [index, spaces.length]);
  useLayoutEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);

  const bounds = () => { const i = indexRef.current; return { canPrev: i > 0, canNext: i < countRef.current - 1 }; };
  const armIdle = (ms: number) => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => apply(tracker().idle(performance.now())), ms);
  };

  // Native stream (macOS): phases AND deltas come from the helper, in order, so 'ended' can never
  // overtake the gesture's own deltas (which happens if we mix in DOM wheel events). Once it's flowing,
  // DOM wheel is ignored entirely.
  useEffect(() => {
    const sub = window.realm?.onScrollPhase;
    if (!sub) return;
    return sub((m) => {
      nativeRef.current = true;
      const p = toSwipePhase(m);
      if (DEBUG() && (p || m.dx)) console.debug("[swipe:native]", m.phase, m.momentum, "dx", m.dx, "→", p ?? "-", "hover", hoverRef.current);
      const now = performance.now();
      const t = tracker();
      if (p) {
        // Only gestures that begin over the sidebar drive the swiper; ended/momentum always reach the
        // tracker so a gesture that wandered off still resolves.
        if (p === "began" && !hoverRef.current) return;
        apply(t.phase(p, now));
      }
      // Deltas ride on 'changed' (and 'began'). The tap's point deltas are opposite to DOM wheel: fingers left → -dx,
      // and Arc convention is fingers-left → next (the space to the right), so negate.
      const sgn = invertRef.current ? 1 : -1;
      if ((m.phase === "changed" || m.phase === "began") && (m.dx !== 0 || m.dy !== 0)) apply(t.wheel(sgn * m.dx, sgn * m.dy, now, bounds()));
      armIdle(4200); // stale-hold safety only
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWheel = (e: WheelEvent) => {
    if (DEBUG()) console.debug("[swipe:dom]", e.deltaX, e.deltaY, "native?", nativeRef.current);
    if (nativeRef.current) return; // native stream owns the gesture
    const sgn = invertRef.current ? -1 : 1;
    apply(tracker().wheel(sgn * e.deltaX, sgn * e.deltaY, performance.now(), bounds()));
    armIdle(IDLE_MS + 20); // fallback: quiet gap = release
  };

  return (
    <div className="swiper" data-swiper ref={hostRef} onWheel={onWheel}
      onPointerEnter={() => { hoverRef.current = true; }} onPointerLeave={() => { hoverRef.current = false; }}>
      <div className="swiper-track" ref={trackRef} style={{ transform: base(index) }}>
        {spaces.map((sp) => (
          <div key={sp.id} className="space-page" data-space-page={sp.id} aria-hidden={sp.id !== activeSpaceId || undefined} inert={sp.id !== activeSpaceId || undefined}>
            <SpaceHeader space={sp} />
            {sp.id === activeSpaceId && <ActiveSpaceBody />}
          </div>
        ))}
      </div>
    </div>
  );
}

const REALM_ITEM_TYPE = "application/x-realm-item";

/**
 * One sidebar section per PANE GROUP, then SPACE for everything open in no group at all.
 *
 * This is where the old single "Open" list went. The list was never wrong, only flat: a space had one
 * arrangement, so "open" was unambiguous. With groups the same rows still say "these are open", but
 * now also WHERE — and clicking a row in a group that is not on screen switches to it (openItem's
 * "go there"), which is the cheap arrangement-switching the whole feature exists for.
 */
const ActiveSpaceBody = memo(function ActiveSpaceBody() {
  const items = useApp((s) => s.items);
  const groups = useApp((s) => s.groups);
  const newPaneGroup = useApp((s) => s.newPaneGroup);
  const run = useApp((s) => s.run);
  // Archived rows are split off FIRST, ahead of open/pinned/unopened, and `byId` is built from the
  // live half alone — so a row still sitting in some group's layout when it is archived (another
  // window did it; this one has not reconciled yet) is listed on the shelf and nowhere else, never in
  // two sections at once.
  const archived = items.filter((i) => i.archived);
  const live = items.filter((i) => !i.archived);
  const byId = new Map(live.map((i) => [i.id, i]));
  const paneGroups = groups?.groups ?? [];
  const openSet = new Set(paneGroups.flatMap((g) => allItems(g.layout)));
  const unopened = live.filter((i) => !openSet.has(i.id));
  const pinned = unopened.filter((i) => i.pinned), rest = unopened.filter((i) => !i.pinned);
  // A lone group keeps the old heading exactly: someone who never makes a second group should not
  // have to learn a new word for the list they already had.
  const soleGroup = paneGroups.length < 2;
  return (
    <>
      <div className="space-body">
        {paneGroups.map((g) => {
          // Follows the group's own open order (allItems is depth-first), not the items array's.
          const open = allItems(g.layout).map((id) => byId.get(id)).filter((i): i is Item => !!i);
          if (soleGroup && open.length === 0) return null;
          return <GroupSection key={g.id} group={g} items={open} active={g.id === groups!.activeGroupId} sole={soleGroup} />;
        })}
        {groups && (
          <button className="group-new" onClick={() => run(() => newPaneGroup())}>
            <Icon name="add" size={12} /><span>New group</span>
          </button>
        )}
        <div className="group-label">Space</div>
        {live.length === 0 && <div className="space-empty">Nothing here yet — start one with New session above</div>}
        {pinned.length > 0 && <PinnedGrid items={pinned} />}
        <ItemList items={rest} variant="space" />
        {archived.length > 0 && <ArchivedSection items={archived} />}
      </div>
    </>
  );
});

/**
 * The shelf: archived rows, last in the sidebar and collapsed until asked for. Collapsed is the whole
 * point — a section that unfolded itself on every render would undo the putting-away — and it is
 * absent entirely when nothing is archived, the same dead-chrome rule the destinations nav keeps.
 *
 * Local `useState`, not store state: it is a disclosure triangle, and one that survived a restart
 * would be a preference nobody asked for.
 */
function ArchivedSection({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="group-label group-head archived-head">
        <button className="group-head-name archived-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="archived-caret" data-open={open || undefined} aria-hidden="true"><Icon name="chevronRight" size={11} /></span>
          <span>Archived</span>
          <span className="archived-count">{items.length}</span>
        </button>
      </div>
      {open && <ItemList items={items} variant="archived" />}
    </>
  );
}

/** One group's heading and rows. The heading is a drop target: dragging a row onto it moves that pane
 *  into the group, the sidebar twin of dropping onto a tab in the GroupBar. */
function GroupSection({ group, items, active, sole }: { group: PaneGroup; items: Item[]; active: boolean; sole: boolean }) {
  const renamingGroupId = useApp((s) => s.renamingGroupId);
  const requestGroupRename = useApp((s) => s.requestGroupRename);
  const activatePaneGroup = useApp((s) => s.activatePaneGroup);
  const moveItemToPaneGroup = useApp((s) => s.moveItemToPaneGroup);
  const run = useApp((s) => s.run);
  const [hot, setHot] = useState(false);
  if (group.id === renamingGroupId) {
    return <div className="group-label group-label-renaming"><GroupRenameInput group={group} onDone={() => requestGroupRename(null)} /></div>;
  }
  return (
    <>
      <div className="group-label group-head" data-active={active || undefined} data-drop={hot || undefined}
        onDragOver={(e: ReactDragEvent) => {
          if (!Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE)) return;
          e.preventDefault(); setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(e: ReactDragEvent) => {
          e.preventDefault(); setHot(false);
          const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
          if (id) run(() => moveItemToPaneGroup(id, group.id));
        }}>
        {sole ? <span>Open</span> : (
          <button className="group-head-name" aria-label={`Show ${group.name}`} aria-current={active || undefined}
            onClick={() => run(() => activatePaneGroup(group.id))}>{group.name}</button>
        )}
        {group.zoomedLeafId && <span className="group-head-badge" title="A pane in this group is focused">focused</span>}
      </div>
      <ItemList items={items} variant="open" layout={group.layout} />
    </>
  );
}
