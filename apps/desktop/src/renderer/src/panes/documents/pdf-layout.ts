/**
 * Where a PDF's pages sit in their scroller, as numbers: the column of sheets, which one the reader is
 * on, what "fit" comes to, and the reader's place as a page and a fraction of it.
 *
 * Pure, so the rules a reader feels — a rewrite keeps the page, a zoom keeps the page, fit width
 * never blows a portrait page up to a poster — are tested without a window (pdf-layout.test.ts).
 *
 * Sizes are CSS pixels at 100%: a PDF point is 1/72 in and a CSS pixel 1/96, so a Letter page is
 * 816 × 1056 at 100%, which is the size Preview and Chromium call 100% too.
 */

/** CSS px per PDF point. */
export const PT_TO_PX = 96 / 72;
/** Above the first page and below the last. */
export const PAD_Y = 24;
/** Either side of the column. */
export const PAD_X = 16;
/** Between two pages. The page grid spaces them; there is no rule. */
export const PAGE_GAP = 16;
/** The widest a fitted page gets — Quick Look's page cap. A portrait page in a 2000px pane is read at
 *  this width, not blown up to a poster; a wider zoom is still one press away. */
export const MAX_FIT_WIDTH = 900;
/** The page the reader is ON is the one whose box holds this line of the scroller. */
export const READING_LINE = 0.4;

export type PageSize = { w: number; h: number };
/** "width" and "page" re-fit as the pane changes; a number is a fixed scale (1 = 100%). */
export type PdfZoom = "width" | "page" | number;

export type PdfLayout = {
  scale: number;
  /** Each page's top edge in the scroller's content, and its drawn size. */
  tops: number[];
  sizes: PageSize[];
  /** The content's full height and width. */
  height: number;
  width: number;
};

/** The column at `scale`: pages one under another, each centred, spaced by the gap. */
export function layoutPages(natural: readonly PageSize[], scale: number): PdfLayout {
  const tops: number[] = [];
  const sizes: PageSize[] = [];
  let y = PAD_Y, widest = 0;
  for (const p of natural) {
    const s = { w: Math.round(p.w * scale), h: Math.round(p.h * scale) };
    tops.push(y);
    sizes.push(s);
    y += s.h + PAGE_GAP;
    widest = Math.max(widest, s.w);
  }
  const height = natural.length === 0 ? 0 : y - PAGE_GAP + PAD_Y;
  return { scale, tops, sizes, height, width: widest + 2 * PAD_X };
}

/** The scale a zoom comes to for these pages in a box. Fit is measured against the WIDEST page, so a
 *  deck with one landscape page among portrait ones never runs off the side. */
export function scaleFor(zoom: PdfZoom, natural: readonly PageSize[], box: PageSize): number {
  if (typeof zoom === "number") return zoom;
  const w = Math.max(0, ...natural.map((p) => p.w));
  if (w <= 0 || box.w <= 0) return 1;
  const across = Math.min(box.w - 2 * PAD_X, MAX_FIT_WIDTH) / w;
  if (zoom === "width") return Math.max(0.1, across);
  const h = Math.max(0, ...natural.map((p) => p.h));
  const down = h > 0 && box.h > 0 ? (box.h - 2 * PAD_Y) / h : across;
  return Math.max(0.1, Math.min((box.w - 2 * PAD_X) / w, down));
}

/** The last page whose box starts at or above `y`, so a gap belongs to the page above it. */
function pageAt(layout: PdfLayout, y: number): number {
  const { tops } = layout;
  let lo = 0, hi = tops.length - 1, at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! <= y) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

/** The page the reader is on: the one under the reading line (0-based). */
export function currentPage(layout: PdfLayout, scrollTop: number, viewport: number): number {
  if (layout.tops.length === 0) return 0;
  return pageAt(layout, scrollTop + viewport * READING_LINE);
}

/** A place in the document that survives a zoom and a rewrite: the page at the scroller's top edge,
 *  and how far down it the edge is. Pixels change with every zoom; a page does not. */
export type PdfPlace = { page: number; fraction: number };

export function placeOf(layout: PdfLayout, scrollTop: number): PdfPlace {
  if (layout.tops.length === 0) return { page: 0, fraction: 0 };
  const page = pageAt(layout, scrollTop);
  return { page, fraction: (scrollTop - layout.tops[page]!) / Math.max(1, layout.sizes[page]!.h) };
}

/** Where the scroller goes to show `place`. A page past the end — a rewrite made the file shorter —
 *  comes back as the last page's top. */
export function scrollTopFor(layout: PdfLayout, place: PdfPlace): number {
  const n = layout.tops.length;
  if (n === 0) return 0;
  const p = clampPlace(place, n);
  return Math.max(0, Math.round(layout.tops[p.page]! + p.fraction * layout.sizes[p.page]!.h));
}

export function clampPlace(place: PdfPlace, pages: number): PdfPlace {
  if (pages <= 0) return { page: 0, fraction: 0 };
  if (place.page >= pages) return { page: pages - 1, fraction: 0 };
  if (place.page < 0) return { page: 0, fraction: 0 };
  return place;
}

/** The pages worth drawing: those within `reach` viewports of what is on screen. Everything else is
 *  a sized placeholder holding no bitmap, so a 300-page scan holds a handful of canvases, not 300. */
export function pagesInReach(layout: PdfLayout, scrollTop: number, viewport: number, reach = 2): { first: number; last: number } {
  const n = layout.tops.length;
  if (n === 0) return { first: 0, last: -1 };
  const first = pageAt(layout, Math.max(0, scrollTop - reach * viewport));
  const last = pageAt(layout, scrollTop + (reach + 1) * viewport);
  return { first, last };
}

/** Where the scroller has to be after a zoom so the point under the pointer stays under it. Down the
 *  column the point is a place (page + fraction), so it lands on the same line of the same page;
 *  across, the column is centred, so the point keeps its share of the content's width. */
export function anchorZoom(i: {
  from: PdfLayout; to: PdfLayout; at: { x: number; y: number }; scroll: { left: number; top: number }; box: PageSize;
}): { left: number; top: number } {
  const place = placeOf(i.from, i.scroll.top + i.at.y);
  const top = scrollTopFor(i.to, place) - i.at.y;
  const fromW = Math.max(i.from.width, i.box.w), toW = Math.max(i.to.width, i.box.w);
  const left = ((i.scroll.left + i.at.x) / fromW) * toW - i.at.x;
  return {
    top: Math.max(0, Math.min(top, i.to.height - i.box.h)),
    left: Math.max(0, Math.min(left, toW - i.box.w)),
  };
}

/** The reader's place in each PDF, kept across the unmount a space switch causes — the same promise
 *  scroll-memory.ts makes every other scroller, kept as a place rather than an offset because the
 *  pixels under it change with every zoom. Module-level and not persisted, like scroll-memory. */
const places = new Map<string, { place: PdfPlace; zoom: PdfZoom }>();
export const rememberPdfPlace = (key: string, place: PdfPlace, zoom: PdfZoom): void => { places.set(key, { place, zoom }); };
export const recallPdfPlace = (key: string): { place: PdfPlace; zoom: PdfZoom } | null => places.get(key) ?? null;
export const forgetPdfPlaces = (): void => { places.clear(); };
