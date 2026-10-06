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
 * A "nice" axis covering `lo..hi` — `niceScale` for a line, which need not start at zero.
 *
 * The same 1/2/5 steps, with the bottom rounded DOWN as the top is rounded up, so every value lands
 * inside the ticks. A flat range is opened around itself rather than divided by zero.
 */
export function niceRange(lo: number, hi: number, count = 4): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (lo >= 0 && hi <= 0) return { min: 0, max: 1, ticks: [0, 1] };
  if (hi - lo <= 0) { const pad = Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
  const rough = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const first = Math.floor(lo / step);
  const last = Math.ceil(hi / step);
  const ticks: number[] = [];
  // Counted rather than accumulated, as in `niceScale`; the zero fix keeps `-0` off an axis.
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toPrecision(12)) || 0);
  return { min: ticks[0]!, max: ticks.at(-1)!, ticks };
}

/**
 * A line's points, as polyline strings — one per run of reported values.
 *
 * A null is a value nobody reported, so the line breaks there rather than diving to zero or
 * bridging the gap with a slope nobody measured. A run of one point is still returned: the chart
 * marks it with a dot, since a polyline of one point draws nothing at all.
 */
export function lineRuns(values: readonly (number | null)[], slot: number, padLeft: number, padTop: number, h: number, min: number, max: number): string[] {
  const span = max - min;
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) { if (run.length) runs.push(run.join(" ")); run = []; return; }
    const y = padTop + h - (span > 0 ? ((v - min) / span) * h : h / 2);
    run.push(`${slotCenter(i, slot, padLeft).toFixed(2)},${y.toFixed(2)}`);
  });
  if (run.length) runs.push(run.join(" "));
  return runs;
}

/**
 * Where each line's label sits at the plot's right end, so no two overlap.
 *
 * Each label wants the height of its line's last point. Sorted top-down, a label closer than `gap`
 * to the one above is pushed down; the ones that then run past the bottom are pulled back up, each
 * only as far as it must. Labels too many to fit simply sit `gap` apart past the end — the order
 * still matches the lines', which is what makes a direct label readable at all.
 */
export function spreadLabels(wanted: readonly { key: string; y: number }[], gap: number, top: number, bottom: number): Map<string, number> {
  const s = [...wanted].sort((a, b) => a.y - b.y).map((w) => ({ ...w }));
  const down = () => s.forEach((l, i) => { l.y = Math.max(l.y, top, i > 0 ? s[i - 1]!.y + gap : top); });
  down();
  // Back up from the bottom: only the labels that ran past it move, and only as far as they must.
  for (let i = s.length - 1; i >= 0; i--) s[i]!.y = Math.min(s[i]!.y, i === s.length - 1 ? bottom : s[i + 1]!.y - gap);
  down();
  return new Map(s.map((l) => [l.key, l.y]));
}

/** The pixels one label needs on the x axis, from its text: `tickIndices`' spacing for labels a
 *  writer chose, which unlike `bucketLabel`'s formats have no bounded width. */
export const labelTickPx = (labels: readonly string[]): number =>
  Math.max(56, Math.ceil(Math.max(0, ...labels.map((l) => l.length)) * 6) + 12);

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
