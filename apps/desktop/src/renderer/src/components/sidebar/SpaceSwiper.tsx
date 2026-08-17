import { memo, useEffect, useLayoutEffect, useRef, type WheelEvent } from "react";
import { useApp } from "../../state/store";
import { createDragSwipe, type SwipePhase, type SwipeUpdate } from "../../state/gesture";
import { SpaceHeader } from "./SpaceHeader";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";
import { NewItemMenu } from "./NewItemMenu";

const IDLE_MS = 220;
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

  // Native phases (macOS): decide hold/settle/commit exactly on finger lift.
  useEffect(() => {
    const sub = window.realm?.onScrollPhase;
    if (!sub) return;
    return sub((m) => {
      const p = toSwipePhase(m);
      if (!p) return;
      // Only gestures that started over the sidebar drive the swiper; a phase 'began' elsewhere is ignored,
      // but 'ended'/momentum always reach the tracker so a gesture that left the sidebar still resolves.
      if (p === "began" && !hoverRef.current) return;
      apply(tracker().phase(p, performance.now()));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWheel = (e: WheelEvent) => {
    const i = indexRef.current;
    apply(tracker().wheel(e.deltaX, e.deltaY, performance.now(), { canPrev: i > 0, canNext: i < countRef.current - 1 }));
    // Fallback only (no-op once native phases are flowing).
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => apply(tracker().idle(performance.now())), IDLE_MS + 20);
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
