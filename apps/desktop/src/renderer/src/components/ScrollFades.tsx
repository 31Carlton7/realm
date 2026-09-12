import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * The two ends of a scroller, dissolved when there is something under them.
 *
 * A fade that is always drawn softens the first line of a list that has not been scrolled — which on
 * a settings page means the section heading arrives smudged, reading as a rendering fault rather
 * than as depth. The dissolve's whole job is to say "there is more this way", so it appears exactly
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
  /* No dependency array, and an identity check instead. The element a ref points at is not a
     dependency React can see: a pane that reads "Reading the working tree…" first and renders its
     list a beat later has a null ref on the mount this would otherwise have run on, and an effect
     keyed on `[ref, axis]` never runs again — so the scroller that finally appeared was never
     listened to and never dissolved. Running on every render costs an identity comparison in the
     case where nothing changed, which is every render but one. */
  const attached = useRef<{ el: HTMLElement | null; axis: string; off: () => void } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (attached.current && attached.current.el === el && attached.current.axis === axis) return;
    attached.current?.off();
    if (!el) { attached.current = null; return; }
    const measure = () => {
      const slack = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      const at = axis === "y" ? el.scrollTop : el.scrollLeft;
      setEdges({
        start: at > 2,
        // 2px of tolerance at both ends: sub-pixel layout and elastic scrolling both land a pixel
        // short of the exact number, and an end that flickers on at rest is worse than none.
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
    attached.current = { el, axis, off: () => { el.removeEventListener("scroll", measure); ro?.disconnect(); } };
  });
  useEffect(() => () => { attached.current?.off(); attached.current = null; }, []);
  return edges;
}

/**
 * The dissolve itself: a MASK on the scroller, marked up as `data-dissolve` for the stylesheet.
 *
 * This used to be two absolutely-positioned bands that blurred their backdrop and washed to the
 * pane's ground. Both halves of that only work over an OPAQUE surface, and the panes are no longer
 * opaque — they are the window ground at `--ground-alpha` over the macOS material, the way the
 * sidebar's column has always been. A backdrop-filter over a translucent surface filters the
 * window's own transparency and composites toward black, so the band renders as a dark smudge; a
 * wash to a fixed tone stripes the surface with a colour the material shows straight through.
 * `styles.css` carries the same finding against the sidebar's list, which has been masked for
 * exactly this reason and is the surface this now matches.
 *
 * A mask paints nothing. Over its last `--fade-h` the content's own alpha runs to zero and what is
 * revealed is whatever was always behind it — the material, or the opaque page tone under reduced
 * transparency. It needs no sibling element, no fallback, and no second frame of filtering per
 * scroll, which is most of what the fade bands cost the battery.
 *
 * Written as an attribute rather than as an inline style so the depths stay in the stylesheet with
 * the rest of the fade tokens: a surface that wants a shallower top band sets `--fade-top-h`, and
 * the mask follows it.
 */
export function useDissolve(ref: RefObject<HTMLElement | null>, axis: "y" | "x" = "y") {
  const { start, end } = useScrollEdges(ref, axis);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const key = axis === "y" ? "dissolve" : "dissolveX";
    // Every render, for the reason above: the element may not have existed on the last one.
    /* Set even when neither end is active, and left set on the way out. The attribute is what
       declares the mask, and the depths inside it are what animate: remove it and the mask goes in
       one frame, which is the pop the bands' opacity transition used to cover. With it in place and
       no ends named, both depths run to zero and the dissolve fades out instead. */
    el.dataset[key] = [start ? "start" : "", end ? "end" : ""].filter(Boolean).join(" ");
  });
}

/**
 * The dissolve as a component, so the call sites that already stand one beside their scroller keep
 * reading the way they did. It renders nothing: what it does is mark the scroller it was given.
 */
export function ScrollFades({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  useDissolve(scroller);
  return null;
}

/** The same, for a strip that scrolls sideways. Same primitive, same tokens, same gating — a
 *  horizontal scroller that dissolved differently from every vertical one would read as a different
 *  material. */
export function ScrollFadesX({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  useDissolve(scroller, "x");
  return null;
}

/** Convenience for the common case: one ref, wired to one scrolling column. */
export function useFadedScroller() {
  const ref = useRef<HTMLDivElement>(null);
  return { ref, fades: <ScrollFades scroller={ref} /> };
}

/**
 * The page pattern's reading column, with its dissolve.
 *
 * The dissolve belongs to the SCROLLER, not to `.page-body`, which is the column AND the rail beside
 * it: a band hung off the parent was drawn over the rail — over the first tab wide, and over the
 * whole tab strip once the body stands its parts up into a column at narrow widths. A smeared
 * navigation row reads as a rendering fault, and it is the one thing on the page that must stay
 * legible while the content under it scrolls. Masking the scroller cannot reach the rail at all.
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
