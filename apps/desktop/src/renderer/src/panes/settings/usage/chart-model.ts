import type { UsageBucketKind } from "@realm/contracts";

/**
 * The arithmetic behind the Usage tab's charts, with no React and no DOM in sight.
 *
 * jsdom has no layout, so a chart's correctness cannot be asserted by rendering it and measuring —
 * a `<rect>` with a NaN height and one with the right height look identical to `getBoundingClientRect`
 * under test (see the "verify pane layout with Electron" note). Everything that decides where a mark
 * lands therefore lives here, as pure functions over numbers, where a wrong scale is a failing
 * assertion rather than an invisible visual bug.
 */

/** Where the plot sits inside the SVG. The x-axis band is INSIDE the box, so a card sized to
 *  `height` never grows a nested scrollbar to reach its own tick labels. */
export type ChartBox = { width: number; height: number; padTop: number; padRight: number; padBottom: number; padLeft: number };
export const plotWidth = (b: ChartBox): number => Math.max(0, b.width - b.padLeft - b.padRight);
export const plotHeight = (b: ChartBox): number => Math.max(0, b.height - b.padTop - b.padBottom);

/**
 * A "nice" axis maximum at or above `max`, and the ticks to label it with.
 *
 * Ticks are round numbers (0 / 1,000 / 2,000) because they carry the values that are not directly
 * labelled. The 1/2/5 progression is the standard one: it keeps at most `count` gridlines while
 * never quantising a scale so coarsely that a real difference between two columns disappears.
 *
 * An all-zero range answers `{ max: 1 }` rather than 0 — dividing by a zero max is how every bar in
 * a chart becomes `NaN` tall, which renders as nothing at all and reads as "no data" for data that
 * is merely small.
 */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Accumulating `t += step` drifts on values like 0.1; multiplying a counter keeps every tick exact.
  for (let i = 0; i * step <= top + step / 2; i++) ticks.push(i * step);
  return { max: top, ticks };
}

/**
 * Column geometry for `n` slots across the plot.
 *
 * The bar is capped at 24px and never fills its slot: the leftover is air, which is what stops a
 * dense range reading as a solid block. `gap` is the 2px surface gap that separates touching bars —
 * subtracted from the bar rather than added around it, so slot centres stay exactly on the band.
 */
export function columnGeometry(width: number, n: number, maxBar = 24, gap = 2): { slot: number; bar: number } {
  if (n <= 0 || width <= 0) return { slot: 0, bar: 0 };
  const slot = width / n;
  const bar = Math.max(1, Math.min(maxBar, slot - gap));
  return { slot, bar };
}

/** The x of a slot's centre. */
export const slotCenter = (i: number, slot: number, padLeft: number): number => padLeft + slot * (i + 0.5);

/**
 * Stack one column's segments into y/height pairs, bottom-up, with a 2px surface gap between them.
 *
 * The gap comes out of the segment ABOVE the join, never out of the baseline segment's foot, so the
 * stack still starts exactly on the axis. A segment too short to survive its own gap is drawn at a
 * 1px minimum instead of inverted: a value that is small is not a value that is absent, and a
 * negative height renders as nothing.
 */
export function stackSegments(values: readonly number[], max: number, h: number, gap = 2): { y: number; height: number }[] {
  const out: { y: number; height: number }[] = [];
  let acc = 0;
  for (const v of values) {
    const raw = max > 0 ? (Math.max(0, v) / max) * h : 0;
    const top = h - ((acc + Math.max(0, v)) / max) * h;
    const height = raw <= 0 ? 0 : Math.max(1, raw - (acc > 0 ? gap : 0));
    out.push({ y: top, height });
    acc += Math.max(0, v);
  }
  return out;
}

/** Points of a sparkline across `width`, flat-lined down the middle when every value is equal (a
 *  zero range would otherwise divide to NaN and erase the line entirely). */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `0,${height / 2} ${width},${height / 2}`;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const stepX = width / (values.length - 1);
  return values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(span === 0 ? height / 2 : height - ((v - min) / span) * height).toFixed(2)}`)
    .join(" ");
}

/** How a bucket start reads on the x axis. Weeks say "w/c" so a Monday date is not mistaken for a day. */
export function bucketLabel(ts: number, kind: UsageBucketKind): string {
  const d = new Date(ts);
  if (kind === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  if (kind === "week") return `w/c ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Which slots get a tick label, so labels never collide.
 *
 * Measured in slots rather than in pixels-per-character: the label width is bounded by
 * `bucketLabel`'s formats, so "how many slots must one label span" is the honest question. The LAST
 * slot always gets one — the right edge is where a reader looks to find "now", and a range whose
 * final column is unlabelled reads as ending at an arbitrary date.
 */
export function tickIndices(n: number, slot: number, minPx = 56): number[] {
  if (n <= 0) return [];
  const every = Math.max(1, Math.ceil(minPx / Math.max(1, slot)));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= every) out.push(i);
  return out.reverse();
}

/**
 * The x-slot nearest a pointer — the crosshair's snap.
 *
 * Readers aim at a date, not at a 2px line, so the whole plot width is live and the nearest slot
 * wins. Clamped to the ends so a pointer in the left padding still reads the first column rather
 * than answering -1.
 */
export function nearestSlot(x: number, padLeft: number, slot: number, n: number): number {
  if (n <= 0 || slot <= 0) return -1;
  return Math.max(0, Math.min(n - 1, Math.floor((x - padLeft) / slot)));
}
