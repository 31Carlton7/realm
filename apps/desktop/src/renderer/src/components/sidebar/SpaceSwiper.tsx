import { useEffect, useRef, useState, type WheelEvent } from "react";
import { useApp } from "../../state/store";
import { createSwipeTracker } from "../../state/gesture";
import { SpaceHeader } from "./SpaceHeader";
import { PinnedGrid } from "./PinnedGrid";
import { ItemList } from "./ItemList";
import { NewItemMenu } from "./NewItemMenu";

const SWIPE = { threshold: 90, idleMs: 150 } as const;
const PREVIEW_MAX = 40;
const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));

/** Horizontal track with one page per space; two-finger horizontal wheel switches the active space.
 *  Only the active page subscribes to items — the others render just their header. */
export function SpaceSwiper() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const nextSpace = useApp((s) => s.nextSpace);
  const prevSpace = useApp((s) => s.prevSpace);
  const run = useApp((s) => s.run);
  const tracker = useRef(createSwipeTracker(SWIPE));
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState(0);
  const index = Math.max(0, spaces.findIndex((s) => s.id === activeSpaceId));

  useEffect(() => () => { if (idle.current) clearTimeout(idle.current); }, []);

  const onWheel = (e: WheelEvent) => {
    const dir = tracker.current.wheel(e.deltaX, e.deltaY, performance.now());
    if (dir) {
      setPreview(0);
      run(() => (dir === "next" ? nextSpace() : prevSpace()));
    } else {
      let off = tracker.current.offset();
      const atEnd = (off > 0 && index >= spaces.length - 1) || (off < 0 && index <= 0);
      if (atEnd) off *= 0.3; // rubber-band: resist beyond the first/last space
      setPreview(clamp(off, PREVIEW_MAX));
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setPreview(0), SWIPE.idleMs);
  };

  return (
    <div className="swiper" data-swiper onWheel={onWheel}>
      <div className="swiper-track" style={{ transform: `translateX(calc(${-index * 100}% - ${preview}px))`, transition: preview === 0 ? undefined : "none" }}>
        {spaces.map((sp) => (
          <div key={sp.id} className="space-page" data-space-page={sp.id} aria-hidden={sp.id !== activeSpaceId || undefined}>
            <SpaceHeader space={sp} />
            {sp.id === activeSpaceId && <ActiveSpaceBody />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ActiveSpaceBody() {
  const items = useApp((s) => s.items);
  const pinned = items.filter((i) => i.pinned), rest = items.filter((i) => !i.pinned);
  return (
    <div className="space-body">
      <PinnedGrid items={pinned} />
      <ItemList items={rest} />
      <NewItemMenu />
    </div>
  );
}
