import { memo, useEffect, useLayoutEffect, useRef, type WheelEvent } from "react";
import { useApp } from "../../state/store";
import { createDragSwipe, type SwipePhase, type SwipeUpdate } from "../../state/gesture";
import { SpaceHeader } from "./SpaceHeader";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";
import { NewItemMenu } from "./NewItemMenu";

const IDLE_MS = 320;
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

  const apply = (r: SwipeUpdate) => {
    const i = indexRef.current;
    if (r.type === "move") setTransform(`translateX(calc(${-i * 100}% - ${r.offset}px))`, false);
    else if (r.type === "settle") setTransform(base(i), true);
    else if (r.type === "commit") run(() => (r.dir === "next" ? nextSpace() : prevSpace())); // layout effect eases to the new page
  };

  // React owns the resting position; gestures only deviate from it transiently.
  useLayoutEffect(() => { setTransform(base(index), true); }, [index, spaces.length]);
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
      const now = performance.now();
      const t = tracker();
      if (p) {
        // Only gestures that begin over the sidebar drive the swiper; ended/momentum always reach the
        // tracker so a gesture that wandered off still resolves.
        if (p === "began" && !hoverRef.current) return;
        apply(t.phase(p, now));
      }
      // Deltas ride on 'changed' (and 'began'); the tap's point deltas share the DOM wheel sign (fingers left → +dx → next).
      if ((m.phase === "changed" || m.phase === "began") && (m.dx !== 0 || m.dy !== 0)) apply(t.wheel(m.dx, m.dy, now, bounds()));
      armIdle(4200); // stale-hold safety only
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWheel = (e: WheelEvent) => {
    if (nativeRef.current) return; // native stream owns the gesture
    apply(tracker().wheel(e.deltaX, e.deltaY, performance.now(), bounds()));
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

const ActiveSpaceBody = memo(function ActiveSpaceBody() {
  const items = useApp((s) => s.items);
  const pinned = items.filter((i) => i.pinned), rest = items.filter((i) => !i.pinned);
  return (
    <>
      {pinned.length > 0 && <PinnedGrid items={pinned} />}
      <ItemList items={rest} />
      <NewItemMenu />
    </>
  );
});
