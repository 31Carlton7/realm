import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

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
 *
 * `axis` picks which pair of ends is being asked about. A horizontal strip has exactly the same
 * question to answer — "is there more of me off to the side" — and answering it with a second copy
 * of this hook would be two implementations of one tolerance.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, axis: "y" | "x" = "y"): { start: boolean; end: boolean } {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const slack = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      const at = axis === "y" ? el.scrollTop : el.scrollLeft;
      setEdges({
        start: at > 2,
        // 2px of tolerance at both ends: sub-pixel layout and elastic scrolling both land a pixel
        // short of the exact number, and a band that flickers on at rest is worse than none.
        end: slack > 2 && at < slack - 2,
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
  }, [ref, axis]);
  return edges;
}

/**
 * The bands themselves, positioned against the scroller's own offset parent.
 *
 * Rendered as siblings rather than children of the scroller so they do not scroll with it — a band
 * inside the box it is fading would travel with the content and fade the middle of the list.
 */
export function ScrollFades({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const { start, end } = useScrollEdges(scroller);
  return (
    <>
      <span className="edge-fade" data-edge="top" data-on={start || undefined} aria-hidden="true" />
      <span className="edge-fade" data-on={end || undefined} aria-hidden="true" />
    </>
  );
}

/** The same two bands turned on their side, for a strip that scrolls sideways. Same primitive, same
 *  tokens, same gating — a horizontal scroller that dissolved differently from every vertical one
 *  would read as a different material. */
export function ScrollFadesX({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const { start, end } = useScrollEdges(scroller, "x");
  return (
    <>
      <span className="edge-fade" data-edge="start" data-on={start || undefined} aria-hidden="true" />
      <span className="edge-fade" data-edge="end" data-on={end || undefined} aria-hidden="true" />
    </>
  );
}

/** Convenience for the common case: one ref, wired to one scrolling column. */
export function useFadedScroller() {
  const ref = useRef<HTMLDivElement>(null);
  return { ref, fades: <ScrollFades scroller={ref} /> };
}

/**
 * The page pattern's reading column, with its two bands.
 *
 * The bands used to hang off `.page-body`, which is the column AND the rail beside it — so the top
 * band was drawn over the rail: over the first tab wide, and over the whole tab strip once the body
 * stands its parts up into a column at narrow widths. A blurred navigation row reads as a rendering
 * fault, and it is the one thing on the page that must stay legible while the content under it
 * scrolls. The wrapper is exactly the scroller, so a band has nothing but content to fade.
 *
 * It owns the ref as well, because every page that had one used it for nothing else.
 */
export function PageScroll({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div className="page-scroll">
      <ScrollFades scroller={scroller} />
      <div className="page-content" ref={scroller}>{children}</div>
    </div>
  );
}
