/**
 * The edge blur as a filter on the scroller. Not a backdrop filter: Chromium lays a backdrop filter's
 * result over its backdrop, and over the content's clear ground that left every line under a bar
 * sharp with a blurred copy on top (11-18). A filter replaces what the element paints.
 *
 * Inside each band the radius grows toward the bar in short steps, each cross-faded only into the
 * next: a sharp line faded straight into a 6px blur reads as the same doubling. The depths are the
 * mask's (`--fade-top-h`, `--fade-h`), so the blur covers exactly what the dissolve fades. A filter
 * is drawn in CSS pixels, unlike a backdrop filter's device pixels. The scrollbar's strip is left
 * out: the thumb is chrome.
 */

const NS = "http://www.w3.org/2000/svg";
const SCROLLBAR = 10;
/** Where the near radius is reached, from the band's inner edge. */
const NEAR_AT = 0.6;
let defs: SVGSVGElement | null = null;
let ids = 0;
const ramps = new Map<string, string>();

/** The blur at `t` across a band (0 at its inner edge, 1 at the bar). */
export function radiusAt(t: number, near: number, far: number): number {
  if (t <= 0) return 0;
  if (t < NEAR_AT) return near * (t / NEAR_AT);
  return near + (far - near) * Math.min(1, (t - NEAR_AT) / (1 - NEAR_AT));
}

/** The fixed radii a band is built from: none, steps up to the near one, then on to the far one. */
export function radiiFor(near: number, far: number): number[] {
  return [0, near / 4, near / 2, near, (near + far) / 2, far];
}

/** How much of radius `levels[i]` (over `levels[i - 1]`) a point at `t` takes. */
export function weightAt(t: number, levels: number[], i: number, near: number, far: number): number {
  const r = radiusAt(t, near, far);
  return Math.max(0, Math.min(1, (r - levels[i - 1]!) / (levels[i]! - levels[i - 1]!)));
}

/** The weight of one radius down a band `depth` px deep, as a one-pixel-wide image, drawn with the
 *  bar at the top (`flip` for a bottom band). Null where no canvas can be had. */
function ramp(depth: number, i: number, near: number, far: number, flip: boolean): string | null {
  const key = `${depth}:${i}:${near}:${far}:${flip}`;
  const hit = ramps.get(key);
  if (hit) return hit;
  const levels = radiiFor(near, far);
  const rows = Math.max(2, Math.round(depth * 2));
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  let url: string | null = null;
  if (ctx) {
    const image = ctx.createImageData(1, rows);
    for (let y = 0; y < rows; y++) {
      const fromBar = (y + 0.5) / rows;
      const t = 1 - (flip ? 1 - fromBar : fromBar);
      image.data.set([255, 255, 255, Math.round(weightAt(t, levels, i, near, far) * 255)], y * 4);
    }
    ctx.putImageData(image, 0, 0);
    url = canvas.toDataURL();
  }
  if (url) ramps.set(key, url);
  return url;
}

export type EdgeBlurShape = { width: number; height: number; top: number; bottom: number; near: number; far: number };

/**
 * Build the filter's primitives into `filter` for a box: for each band, the radii blurred over the
 * band alone, folded from the bar inward (R = lower × (1 − w) + R × w), and the content outside both
 * bands left as it was. The images are returned so the caller can slide them. False where a ramp
 * could not be drawn, in which case the filter must not be used.
 */
export function buildEdgeBlur(filter: SVGFilterElement, s: EdgeBlurShape): { top: SVGFEImageElement[]; bottom: SVGFEImageElement[] } | null {
  const set = (node: Element, attrs: Record<string, string | number>) => { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); return node; };
  const add = (tag: string, attrs: Record<string, string | number>) => filter.appendChild(set(document.createElementNS(NS, tag), attrs));
  filter.replaceChildren();
  set(filter, { x: 0, y: 0, width: s.width, height: s.height, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
  const levels = radiiFor(s.near, s.far);
  const width = Math.max(0, s.width - SCROLLBAR);
  const images = { top: [] as SVGFEImageElement[], bottom: [] as SVGFEImageElement[] };
  let current = "SourceGraphic";
  for (const edge of ["top", "bottom"] as const) {
    const depth = edge === "top" ? s.top : s.bottom;
    if (!(depth > 0)) continue;
    const flip = edge === "bottom";
    const y = flip ? s.height - depth : 0;
    // A blur reads past its region by about three radii, so each samples a little beyond the band.
    const reach = s.far * 3;
    for (let i = 1; i < levels.length; i++) {
      add("feGaussianBlur", { in: "SourceGraphic", stdDeviation: levels[i]!, edgeMode: "duplicate", x: 0, y: flip ? y - reach : y, width, height: depth + reach, result: `${edge}-r${i}` });
    }
    let folded = `${edge}-r${levels.length - 1}`;
    for (let i = levels.length - 1; i >= 1; i--) {
      const href = ramp(depth, i, s.near, s.far, flip);
      if (!href) return null;
      images[edge].push(add("feImage", { href, x: 0, y, width, height: depth, preserveAspectRatio: "none", result: `${edge}-w${i}` }) as SVGFEImageElement);
      const lower = i === 1 ? current : `${edge}-r${i - 1}`;
      add("feComposite", { in: folded, in2: `${edge}-w${i}`, operator: "in", result: `${edge}-a${i}` });
      add("feComposite", { in: lower, in2: `${edge}-w${i}`, operator: "out", result: `${edge}-b${i}` });
      add("feComposite", { in: `${edge}-a${i}`, in2: `${edge}-b${i}`, operator: "arithmetic", k1: 0, k2: 1, k3: 1, k4: 0, result: `${edge}-f${i}` });
      folded = `${edge}-f${i}`;
    }
    current = folded;
  }
  return images;
}

const px = (style: CSSStyleDeclaration, name: string, fallback: number) => {
  const v = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
};
const ms = (v: string) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) || 0;

/**
 * Keep `el` wearing the edge blur at the ends that are open: its filter is named on it as
 * `--edge-blur`, which the stylesheet applies (and takes away under Low power and Reduce
 * Transparency). An end that opens slides its blur in from the bar, and one that closes slides it
 * back out; with both closed and settled the element wears none. A band is only as far in as its end
 * is open, all the way once the content runs a band's depth past the bar: at full strength the moment
 * an end opened, the foot band smudged the last line when the scroll stood 34px short of the end, with
 * nothing passing under the bar (11-18). Scrolling moves it with the scroll. Returns the update and
 * the cleanup.
 */
export function attachEdgeBlur(el: HTMLElement): { set: (start: boolean, end: boolean) => void; stop: () => void } {
  if (!defs?.isConnected) {
    defs = document.createElementNS(NS, "svg");
    defs.setAttribute("class", "edge-blur-defs");
    defs.setAttribute("aria-hidden", "true");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    document.body.append(defs);
  }
  const filter = document.createElementNS(NS, "filter");
  filter.id = `rl-edge-blur-${++ids}`;
  defs.append(filter);
  let images: { top: SVGFEImageElement[]; bottom: SVGFEImageElement[] } | null = null;
  let shape: EdgeBlurShape | null = null;
  const want = { top: false, bottom: false };
  const shown = { top: 0, bottom: 0 };
  let frame = 0;
  let last = 0;
  /** How far in `end`'s band may be: the content past the bar there, over the band's depth. */
  const open = (end: "top" | "bottom") => {
    if (!want[end] || !shape) return want[end] ? 1 : 0;
    const past = end === "top" ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
    const depth = end === "top" ? shape.top : shape.bottom;
    return depth > 0 ? Math.max(0, Math.min(1, past / depth)) : 1;
  };

  const place = () => {
    if (!images || !shape) return;
    for (const img of images.top) img.setAttribute("y", String(-shape.top * (1 - shown.top)));
    for (const img of images.bottom) img.setAttribute("y", String(shape.height - shape.bottom * shown.bottom));
    if (shown.top > 0 || shown.bottom > 0) el.style.setProperty("--edge-blur", `url(#${filter.id})`);
    else el.style.removeProperty("--edge-blur");
  };
  const fit = () => {
    const style = getComputedStyle(el);
    const next: EdgeBlurShape = { width: el.clientWidth, height: el.clientHeight, top: px(style, "--fade-top-h", 40), bottom: px(style, "--fade-h", 68), near: px(style, "--fade-blur-near", 2), far: px(style, "--fade-blur-far", 6) };
    if (shape && Object.entries(next).every(([k, v]) => shape![k as keyof EdgeBlurShape] === v)) return;
    shape = next;
    images = next.width > 0 && next.height > 0 ? buildEdgeBlur(filter, next) : null;
    place();
  };
  const step = (now: number) => {
    frame = 0;
    const dur = ms(getComputedStyle(el).getPropertyValue("--dur-fast"));
    // The first frame has no interval yet, so it moves one sixtieth of the way.
    const by = dur > 0 ? (now - (last || now)) / dur : 1;
    last = now;
    let moving = false;
    for (const end of ["top", "bottom"] as const) {
      const goal = open(end);
      if (shown[end] === goal) continue;
      shown[end] = goal > shown[end] ? Math.min(goal, shown[end] + (by || 1 / 60)) : Math.max(goal, shown[end] - (by || 1 / 60));
      moving ||= shown[end] !== goal;
    }
    place();
    if (moving) frame = requestAnimationFrame(step);
    else last = 0;
  };
  // Drawn the first time an end opens, so a scroller that never moves builds nothing.
  const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (shape) fit(); });
  sized?.observe(el);
  // The scroll is already continuous, so a band follows it at once rather than easing after it. Most
  // of a scroll is far from both ends, where neither band moves and the filter is left alone.
  const scrolled = () => {
    if (frame || !images) return;
    const top = open("top"), bottom = open("bottom");
    if (top === shown.top && bottom === shown.bottom) return;
    shown.top = top;
    shown.bottom = bottom;
    place();
  };
  el.addEventListener("scroll", scrolled, { passive: true });
  return {
    set(start, end) {
      want.top = start;
      want.bottom = end;
      if (!shape && (start || end)) fit();
      if (!images) { shown.top = open("top"); shown.bottom = open("bottom"); return; }
      if (!frame) { last = 0; frame = requestAnimationFrame(step); }
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      sized?.disconnect();
      el.removeEventListener("scroll", scrolled);
      filter.remove();
      el.style.removeProperty("--edge-blur");
    },
  };
}
