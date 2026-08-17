import { memo, useLayoutEffect, useRef, type WheelEvent } from "react";
import { useApp } from "../../state/store";
import { createDragSwipe } from "../../state/gesture";
import { SpaceHeader } from "./SpaceHeader";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";
import { NewItemMenu } from "./NewItemMenu";

const IDLE_MS = 220; // matches gesture.ts hold window: rest holds the drag, release settles
const EASE = "transform 320ms cubic-bezier(.22,.9,.24,1)";

/** Horizontal track with one page per space. Two-finger drag follows the fingers 1:1 (transform
 *  written straight to the DOM — no React state per wheel event), rubber-bands at the ends,
 *  commits past half a page (or on a flick) and eases into place; released early, it eases back.
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
  const indexRef = useRef(index);
  indexRef.current = index;

  const base = (i: number) => `translateX(${-i * 100}%)`;
  const setTransform = (t: string, ease: boolean) => {
    const el = trackRef.current; if (!el) return;
    el.style.transition = ease ? EASE : "none";
    el.style.transform = t;
  };

  // React owns the resting position; gestures only deviate from it transiently.
  useLayoutEffect(() => { setTransform(base(index), true); }, [index, spaces.length]);
  useLayoutEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);

  const onWheel = (e: WheelEvent) => {
    const width = hostRef.current?.clientWidth || 240;
    const tracker = (trackerRef.current ??= createDragSwipe({ width, idleMs: IDLE_MS }));
    const i = indexRef.current;
    const r = tracker.wheel(e.deltaX, e.deltaY, performance.now(), { canPrev: i > 0, canNext: i < spaces.length - 1 });
    if (r.type === "move") setTransform(`translateX(calc(${-i * 100}% - ${r.offset}px))`, false);
    else if (r.type === "commit") run(() => (r.dir === "next" ? nextSpace() : prevSpace())); // layout effect eases to the new page

    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (trackerRef.current?.idle(performance.now()).type === "settle") setTransform(base(indexRef.current), true);
    }, IDLE_MS + 20);
  };

  return (
    <div className="swiper" data-swiper ref={hostRef} onWheel={onWheel}>
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
