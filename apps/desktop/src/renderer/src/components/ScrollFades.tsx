import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The two bands at the ends of a scroller, shown only when there is something under them.
 *
 * A fade that is always drawn blurs the first line of a list that has not been scrolled — which on
 * a settings page means the section heading arrives smudged, reading as a rendering fault rather
 * than as depth. The band's whole job is to say "there is more this way", so it appears exactly
 * when that is true.
 *
 * `scrollTop` rather than an IntersectionObserver: the question is about the SCROLLER's position,
 * not about any particular child's visibility, and a list whose first row is taller than the
 * viewport would never trip an observer at all.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): { top: boolean; bottom: boolean } {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const slack = el.scrollHeight - el.clientHeight;
      setEdges({
        top: el.scrollTop > 2,
        // 2px of tolerance at both ends: sub-pixel layout and elastic scrolling both land a pixel
        // short of the exact number, and a band that flickers on at rest is worse than none.
        bottom: slack > 2 && el.scrollTop < slack - 2,
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Content arriving (a list loading, a card unfolding) changes whether there is anything below
    // without any scrolling happening.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, [ref]);
  return edges;
}

/**
 * The bands themselves, positioned against the scroller's own offset parent.
 *
 * Rendered as siblings rather than children of the scroller so they do not scroll with it — a band
 * inside the box it is fading would travel with the content and fade the middle of the list.
 */
export function ScrollFades({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const { top, bottom } = useScrollEdges(scroller);
  return (
    <>
      <span className="edge-fade" data-edge="top" data-on={top || undefined} aria-hidden="true" />
      <span className="edge-fade" data-on={bottom || undefined} aria-hidden="true" />
    </>
  );
}

/** Convenience for the common case: one ref, wired to one scrolling column. */
export function useFadedScroller() {
  const ref = useRef<HTMLDivElement>(null);
  return { ref, fades: <ScrollFades scroller={ref} /> };
}
