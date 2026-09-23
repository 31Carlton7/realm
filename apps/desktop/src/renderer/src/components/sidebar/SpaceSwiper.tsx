import { memo, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type WheelEvent } from "react";
import { Icon } from "@realm/ui";
import { allItems, type Item, type PaneGroup, type SpaceGroups } from "@realm/contracts";
import { useApp, useAppStore, useProfileSpaces } from "../../state/store";
import { createDragSwipe, type SwipePhase, type SwipeUpdate } from "../../state/gesture";
import { createSpring } from "../../state/spring";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";

const IDLE_MS = 320;
const DEBUG = () => { try { return localStorage.getItem("realm.debugSwipe") === "1"; } catch { return false; } };

/* The endgame is a SPRING, not a curve over a duration.
 *
 * It was `transform 300ms cubic-bezier(.32,.72,0,1)`, and three things follow from that which no
 * amount of tuning the curve fixes. A page thrown hard and a page nudged over the line landed at the
 * same speed, because the transition started from rest either way — the seam between the gesture and
 * its animation. The slide could not be caught: grabbing a page mid-flight fought the transition and
 * jumped. And a reversal was a cut, because the outgoing transition was replaced rather than
 * re-aimed.
 *
 * A spring has none of those: it starts from where the thing IS, at the speed it is already going,
 * and a new target is just a new target.
 *
 * Both are critically damped, and the bounce Apple gives a thrown sheet is deliberately refused
 * here: this is a PAGER. Overshoot on a sheet shows a little more of the sheet; overshoot on a page
 * that fills the column shows the edge of the page after the one you asked for, which reads as a
 * mis-landing rather than as life. What a throw gets instead is the velocity handoff and a shorter
 * response — it arrives sooner because it was thrown harder, not because it bounces.
 */
const THROW = { damping: 1, response: 0.3 };
const SETTLE = { damping: 1, response: 0.35 };
/** How long the outgoing page's rows stay rendered after a commit. Generous — the spring has no
 *  duration, and a page whose content vanished mid-flight is the bug this guards. */
const LEAVE_MS = 700;

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
 *  wherever you rest, and on lift either commits (past a third of a page, or a flick projected past
 *  it) or springs back — at the speed the fingers left, and catchable mid-flight.
 *  Finger lift comes from the native ScrollPhase helper when available; otherwise a quiet-gap timer.
 *  Only the active page subscribes to items; the page being left keeps a snapshot of its rows for
 *  the length of the slide, so a commit never animates a blank page out. */
export function SpaceSwiper() {
  // The ACTIVE PROFILE's spaces, not every space in the home (see SpaceStrip): a swipe is a bounded
  // move inside one profile, and crossing profiles is the profile chip's job. Twelve spaces meant a
  // twelve-page track where the gesture could never tell you how far it had left to go.
  const spaces = useProfileSpaces();
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

  const rafRef = useRef<number | null>(null);
  const queuedRef = useRef<string | null>(null);
  const store = useAppStore();
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The page being swiped AWAY from, and the rows it had at the moment of the commit.
  //
  // Without this the outgoing page empties the instant activeSpaceId flips — selectSpace clears
  // `items` synchronously and refills them a round trip later — so a commit slid a blank page out
  // and a blank page in, and the rows popped in after it landed. Arc slides real content. The
  // snapshot is render-only: the page is `inert` for the 300ms it is on screen.
  const [leaving, setLeaving] = useState<{ id: string; items: Item[]; groups: SpaceGroups | null } | null>(null);
  const freeze = () => {
    const st = store.getState();
    if (!st.activeSpaceId) return;
    setLeaving({ id: st.activeSpaceId, items: st.items, groups: st.groups });
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setLeaving(null), LEAVE_MS);
  };

  /* The track's position is ONE number: how far it is displaced from the page it is resting on, in
     px. The fingers write it directly; everything after a lift is a spring converging on 0. Keeping
     both in the same variable is what makes a gesture and its animation continuous — there is no
     handover, only who is holding the pen. */
  const springRef = useRef<ReturnType<typeof createSpring> | null>(null);
  const spring = () => (springRef.current ??= createSpring(0, SETTLE));
  /** The displacement the last gesture left behind, snapshotted when a new drag starts. A drag that
   *  begins mid-flight has to continue from where the page IS — reading the tracker's own offset,
   *  which starts at 0, would snap it to the base and undo the interruption. */
  const carryRef = useRef<number | null>(null);
  /** A commit the store has not applied yet, and the speed the fingers left at. */
  const pendingRef = useRef<{ dir: "next" | "prev"; velocity: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const paintRef = useRef<number | null>(null);

  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  /** Write the current displacement to the DOM. The only place a transform is set. */
  const paint = () => {
    const el = trackRef.current; if (!el) return;
    const x = springRef.current?.value() ?? 0;
    el.style.transform = x === 0 ? `translateX(${-indexRef.current * 100}%)` : `translateX(calc(${-indexRef.current * 100}% + ${x}px))`;
  };
  /** Drag frames are coalesced to one write per frame. A 120 Hz trackpad otherwise forces several
   *  style recalcs per frame that the compositor throws away — the work that made the drag stutter
   *  rather than track the fingers. */
  const paintSoon = () => {
    if (paintRef.current !== null) return;
    paintRef.current = requestAnimationFrame(() => { paintRef.current = null; paint(); });
  };
  const stopFrames = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (paintRef.current !== null) cancelAnimationFrame(paintRef.current);
    frameRef.current = null; paintRef.current = null;
  };
  const step = (ts: number) => {
    /* The first frame takes a nominal 16ms rather than `ts - performance.now()`: the two clocks can
       be a frame apart in a real renderer, and in a test driving frames by hand they share no origin
       at all — either way the spring must not be handed a bogus first delta. */
    const dt = lastTickRef.current < 0 ? 16 : ts - lastTickRef.current;
    lastTickRef.current = ts;
    const moving = spring().tick(dt);
    paint();
    frameRef.current = moving ? requestAnimationFrame(step) : null;
  };
  /** Let the spring run. Reduced motion takes the same journey with no frames in between. */
  const animate = () => {
    if (reduced()) { spring().set(spring().target()); stopFrames(); paint(); return; }
    if (frameRef.current !== null) return;
    lastTickRef.current = -1;
    frameRef.current = requestAnimationFrame(step);
  };
  const tracker = () => (trackerRef.current ??= createDragSwipe({ width: hostRef.current?.clientWidth || 240, idleMs: IDLE_MS }));

  const apply = (r: SwipeUpdate) => {
    if (DEBUG() && r.type !== "ignore") console.debug("[swipe]", r.type, r.type === "move" ? r.offset.toFixed(1) : r.type === "commit" ? r.dir : "", "idx", indexRef.current);
    if (r.type === "move") {
      // The fingers own the value outright while they are down: a hard set, no spring under it.
      if (carryRef.current === null) { carryRef.current = spring().value(); stopFrames(); }
      spring().set(carryRef.current - r.offset);
      paintSoon();
    } else if (r.type === "settle") {
      carryRef.current = null;
      spring().to(0, SETTLE);
      // The tracker counts towards `next`; the track moves the other way, and in px per second.
      spring().nudge(-r.velocity * 1000);
      animate();
    } else if (r.type === "commit") {
      carryRef.current = null;
      pendingRef.current = { dir: r.dir, velocity: r.velocity };
      freeze();
      run(() => (r.dir === "next" ? nextSpace() : prevSpace())); // the layout effect below flies it home
    }
  };

  /* React owns which page is resting under the track; this keeps the PIXELS continuous across that
     change. On a gesture commit the base moves one page, so the displacement gains a page in the
     opposite direction and the spring flies it back to zero from exactly where the fingers left it —
     no jump, at the speed they were going. Every other way of changing space (⌃⇥, the strip, a
     command) lands with no animation at all, which is §6's rule. */
  useLayoutEffect(() => {
    const width = hostRef.current?.clientWidth || 240;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      const s = spring();
      s.set(s.value() + (pending.dir === "next" ? width : -width), -pending.velocity * 1000);
      s.to(0, THROW);
      animate();
    } else {
      stopFrames();
      spring().set(0);
    }
    paint();
  }, [index, spaces.length]);
  useLayoutEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); if (leaveTimer.current) clearTimeout(leaveTimer.current); stopFrames(); }, []);

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
      <div className="swiper-track" ref={trackRef} style={{ transform: `translateX(${-index * 100}%)` }}>
        {/* A page is its ROWS. The space's name heads the whole column now (Sidebar.tsx) — one per
            page was one "Space menu" button per space, all with the same accessible name. */}
        {spaces.map((sp) => (
          <div key={sp.id} className="space-page" data-space-page={sp.id} aria-hidden={sp.id !== activeSpaceId || undefined} inert={sp.id !== activeSpaceId || undefined}>
            {sp.id === activeSpaceId ? <ActiveSpaceBody /> : leaving?.id === sp.id ? <SpaceBody items={leaving.items} groups={leaving.groups} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const REALM_ITEM_TYPE = "application/x-realm-item";

/**
 * One sidebar section per PANE GROUP, then SESSIONS for everything open in no group at all.
 *
 * This is where the old single "Open" list went. The list was never wrong, only flat: a space had one
 * arrangement, so "open" was unambiguous. With groups the same rows still say "these are open", but
 * now also WHERE — and clicking a row in a group that is not on screen switches to it (openItem's
 * "go there"), which is the cheap arrangement-switching the whole feature exists for.
 */
const ActiveSpaceBody = memo(function ActiveSpaceBody() {
  const items = useApp((s) => s.items);
  const groups = useApp((s) => s.groups);
  return <SpaceBody items={items} groups={groups} />;
});

/** The rows themselves, from whatever items/groups they are handed — the live set for the active
 *  page, a commit-time snapshot for the page sliding away. */
const SpaceBody = memo(function SpaceBody({ items, groups }: { items: Item[]; groups: SpaceGroups | null }) {
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
        <div className="group-label">Sessions</div>
        {live.length === 0 && <div className="space-empty">Nothing here yet — start one with New session above</div>}
        {pinned.length > 0 && <PinnedGrid items={pinned} />}
        <ItemList items={rest} variant="space" />
        {archived.length > 0 && <ArchivedSection items={archived} />}
      </div>
      {/* No fade element: the list dissolves at its bottom by a mask on .space-body itself, and its
          bottom padding is what keeps the last row clear of the ramp — see --fade-h in styles.css. */}
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
  const everOpened = useRef(false);
  everOpened.current ||= open;
  return (
    <>
      <div className="group-label group-head archived-head">
        <button className="group-head-name archived-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="archived-caret" data-open={open || undefined} aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
          <span>Archived</span>
          <span className="archived-count">{items.length}</span>
        </button>
      </div>
      {/* The shelf unfolds on the tool row's technique — grid-template-rows 0fr→1fr, the only way to
          animate to a height nobody can know in advance — which needs the rows in the DOM on both
          sides of the flip. So they are built on first open and stay built: folding it back animates
          too, and re-opening is instant. Built on first open rather than always, because a shelf
          nobody has asked for should cost nothing; `inert` keeps a folded row's controls out of the
          tab order and the accessibility tree. */}
      {everOpened.current && (
        <div className="archived-wrap" data-open={open || undefined}>
          <div className="archived-clip" inert={!open || undefined}>
            <ItemList items={items} variant="archived" />
          </div>
        </div>
      )}
    </>
  );
}

/** One group's heading and rows. The heading is a drop target: dragging a row onto it moves that pane
 *  into the group, the sidebar twin of dropping onto a tab in the GroupBar. */
function GroupSection({ group, items, active, sole }: { group: PaneGroup; items: Item[]; active: boolean; sole: boolean }) {
  const activatePaneGroup = useApp((s) => s.activatePaneGroup);
  const moveItemToPaneGroup = useApp((s) => s.moveItemToPaneGroup);
  const run = useApp((s) => s.run);
  const [hot, setHot] = useState(false);
  /* No rename editor here, deliberately. The only gesture that arms one is the tab strip's own
     context menu, and this used to answer it too — so BOTH surfaces mounted an autoFocus input for
     the same group, the second stole focus from the first, the first's blur committed an unchanged
     name and cleared the request, and the field vanished in the same tick it appeared. Renaming a
     group was impossible for as long as the two existed together, which is whenever the strip is on
     screen at all. The editor belongs where the gesture happened. */
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
