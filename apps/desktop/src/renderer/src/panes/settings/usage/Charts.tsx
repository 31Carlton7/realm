import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  bucketLabel, columnGeometry, nearestSlot, niceScale, plotHeight, plotWidth,
  slotCenter, sparklinePoints, stackSegments, tickIndices, type ChartBox,
} from "./chart-model";
import type { UsageBucketKind } from "@realm/contracts";

/**
 * The Usage tab's charts. Hand-rolled SVG — the app ships no charting library, and adding one to
 * draw two forms would put a bundle in the renderer to avoid ~200 lines of `<rect>` arithmetic that
 * `chart-model.ts` already owns and tests.
 *
 * Two rules run through all of it:
 *
 * - **Colour is by slot, never by rank.** Every series carries a `colorIndex` the server assigned
 *   from an intrinsic order, so sorting the table beside the chart repaints nothing. Slots are the
 *   validated eight in `tokens.css`; there is no ninth, and nothing here generates a hue.
 * - **The tooltip enhances, it never gates.** Everything hoverable is also in the table below the
 *   chart, and focus shows exactly what hover shows, so a keyboard reader loses nothing.
 */

/** Slot n of the categorical palette, 0-indexed. Clamped rather than cycled: a cycled 9th hue is
 *  indistinguishable from slot 1 under simulated CVD, and the server's fold to "Other" is what
 *  guarantees the clamp is never actually reached. */
export const seriesColor = (i: number): string => `var(--series-${Math.min(8, Math.max(1, i + 1))})`;

export type StackSeries = { key: string; label: string; colorIndex: number; values: number[] };

type TooltipRow = { label: string; value: string; colorIndex: number };
type Tip = { x: number; y: number; title: string; rows: TooltipRow[]; total?: string } | null;

/** The floating readout. Values lead and labels follow — the reader already has the series and wants
 *  the number, which is the legend's hierarchy inverted on purpose. Series are keyed by a short
 *  stroke rather than a filled box: at this density a box is data-weight ink doing a label's job. */
function Tooltip({ tip, width }: { tip: NonNullable<Tip>; width: number }) {
  // Flip to the left of the pointer near the right edge so the readout never leaves the card.
  const flip = tip.x > width - 160;
  return (
    <div className="chart-tip" role="presentation" style={{ left: tip.x, top: tip.y, transform: `translate(${flip ? "calc(-100% - 12px)" : "12px"}, -50%)` }}>
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div className="chart-tip-row" key={r.label}>
          <span className="chart-tip-key" style={{ background: seriesColor(r.colorIndex) }} />
          <span className="chart-tip-val">{r.value}</span>
          <span className="chart-tip-label">{r.label}</span>
        </div>
      ))}
      {tip.total !== undefined && <div className="chart-tip-total"><span className="chart-tip-val">{tip.total}</span><span className="chart-tip-label">total</span></div>}
    </div>
  );
}

const BOX: ChartBox = { width: 720, height: 240, padTop: 12, padRight: 12, padBottom: 28, padLeft: 52 };

/**
 * The plot's width in REAL pixels, measured rather than assumed.
 *
 * A fixed viewBox stretched with `preserveAspectRatio="none"` would be simpler and is wrong twice
 * over: it scales the tick labels horizontally (text distorts, and the wider the settings pane the
 * more it distorts), and it makes the 24px bar cap a lie — a bar drawn 24 viewBox units wide renders
 * at 24 × (actual / 720) px, so the cap tightens or loosens with the pane. Measuring and drawing 1:1
 * keeps a pixel a pixel.
 *
 * jsdom has no real layout, so `contentRect.width` is 0 there and the fallback holds — which is
 * exactly what the geometry tests assume (test-setup.ts already stubs an inert ResizeObserver).
 */
function useMeasuredWidth(fallback: number): [number, React.RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      // A floor rather than the raw measurement: mid-transition the pane can report a few pixels,
      // and a 3px plot would divide the axis into slots narrower than their own gap.
      if (w > 0) setWidth(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [width, ref];
}

/**
 * Stacked columns over time — the page's main chart.
 *
 * Stacked rather than grouped because the reader's first question is "how much, in total, and when",
 * with "by which engine" second; grouped bars answer the second at the cost of the first. One axis
 * only: a second scale for tokens beside dollars would invent a correlation that is not in the data,
 * so the metric toggle swaps what the single axis MEANS instead of adding another.
 */
export function StackedColumns({ buckets, bucketKind, series, format, label }: {
  buckets: number[];
  bucketKind: UsageBucketKind;
  series: StackSeries[];
  format: (n: number) => string;
  label: string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<number>(-1);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleId = useId();
  const [width, wrapRef] = useMeasuredWidth(BOX.width);
  const box: ChartBox = { ...BOX, width };

  const w = plotWidth(box), h = plotHeight(box);
  const totals = buckets.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const { max, ticks } = niceScale(Math.max(0, ...totals));
  const { slot, bar } = columnGeometry(w, buckets.length);
  const labelled = tickIndices(buckets.length, slot);

  const showAt = (i: number) => {
    if (i < 0 || i >= buckets.length) return;
    setActive(i);
    const rows = series
      .map((s) => ({ label: s.label, value: format(s.values[i] ?? 0), colorIndex: s.colorIndex, raw: s.values[i] ?? 0 }))
      // One tooltip, every series — but a series that contributed nothing to THIS column is noise,
      // not information, and on a 7-series chart it is most of the readout.
      .filter((r) => r.raw > 0)
      .sort((a, b) => b.raw - a.raw);
    setTip({
      x: slotCenter(i, slot, box.padLeft), y: box.padTop + h / 2,
      title: bucketLabel(buckets[i]!, bucketKind),
      rows: rows.map(({ label: l, value, colorIndex }) => ({ label: l, value, colorIndex })),
      total: format(totals[i] ?? 0),
    });
  };
  const clear = () => { setActive(-1); setTip(null); };

  // The wrapper still mounts on the empty path, so the observer is attached before there is
  // anything to draw and the first real render already knows its width.
  if (buckets.length === 0) return <div className="chart-wrap" ref={wrapRef}><p className="chart-empty">Nothing ran in this range.</p></div>;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        ref={svgRef} className="chart" viewBox={`0 0 ${box.width} ${box.height}`}
        role="img" aria-labelledby={titleId}
        // The crosshair finds the X: the whole plot is live, so the pointer only has to be nearest a
        // column, never on it. Aiming at a 24px bar is a game; aiming at a date is a glance.
        onPointerMove={(e) => {
          const r = svgRef.current?.getBoundingClientRect();
          if (!r || r.width === 0) return;
          showAt(nearestSlot(((e.clientX - r.left) / r.width) * box.width, box.padLeft, slot, buckets.length));
        }}
        onPointerLeave={clear}
      >
        <title id={titleId}>{label}</title>
        {ticks.map((t) => {
          const y = box.padTop + h - (t / max) * h;
          return (
            <g key={t}>
              <line className="chart-grid-line" x1={box.padLeft} x2={box.padLeft + w} y1={y} y2={y} />
              <text className="chart-tick" x={box.padLeft - 8} y={y} textAnchor="end" dominantBaseline="middle">{format(t)}</text>
            </g>
          );
        })}
        <line className="chart-axis-line" x1={box.padLeft} x2={box.padLeft + w} y1={box.padTop + h} y2={box.padTop + h} />

        {buckets.map((b, i) => {
          const segs = stackSegments(series.map((s) => s.values[i] ?? 0), max, h);
          const cx = slotCenter(i, slot, box.padLeft);
          return (
            <g key={b} data-active={i === active || undefined}>
              {i === active && <rect className="chart-crosshair" x={cx - slot / 2} y={box.padTop} width={slot} height={h} />}
              {segs.map((seg, si) => seg.height <= 0 ? null : (
                <rect
                  key={series[si]!.key} className="chart-bar"
                  x={cx - bar / 2} y={box.padTop + seg.y} width={bar} height={seg.height}
                  fill={seriesColor(series[si]!.colorIndex)}
                  // Rounded at the data end only, and only on the topmost drawn segment: a radius on
                  // an interior segment would round a join that is not an end.
                  rx={si === segs.length - 1 || segs.slice(si + 1).every((s) => s.height <= 0) ? Math.min(4, bar / 2) : 0}
                />
              ))}
            </g>
          );
        })}

        {labelled.map((i) => (
          <text key={i} className="chart-tick" x={slotCenter(i, slot, box.padLeft)} y={box.height - 8} textAnchor="middle">
            {bucketLabel(buckets[i]!, bucketKind)}
          </text>
        ))}
      </svg>

      {/* Keyboard parity: one focusable control walks the same columns the pointer snaps to, and
          shows the same readout. A chart reachable only by pointer is a chart half the readers
          cannot use. */}
      <div
        className="chart-kbd" tabIndex={0} role="slider" aria-label={`${label} — step through buckets`}
        aria-valuemin={0} aria-valuemax={Math.max(0, buckets.length - 1)} aria-valuenow={Math.max(0, active)}
        aria-valuetext={active >= 0 ? `${bucketLabel(buckets[active]!, bucketKind)}: ${format(totals[active] ?? 0)}` : "no bucket selected"}
        onFocus={() => showAt(active >= 0 ? active : buckets.length - 1)}
        onBlur={clear}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); showAt(Math.min(buckets.length - 1, active + 1)); }
          if (e.key === "ArrowLeft") { e.preventDefault(); showAt(Math.max(0, active - 1)); }
          if (e.key === "Home") { e.preventDefault(); showAt(0); }
          if (e.key === "End") { e.preventDefault(); showAt(buckets.length - 1); }
        }}
      />
      {tip && <Tooltip tip={tip} width={box.width} />}
    </div>
  );
}

/**
 * A horizontal bar per row — the breakdown's shape.
 *
 * Horizontal because the categories have long names (a model id, a worktree with its branch) and a
 * column chart would either clip them or turn them on their side. ONE colour per bar, its entity's
 * slot: colouring by value would spend the identity channel re-encoding the length the bar already
 * shows, and would break the categorical checks by construction.
 */
export function BreakdownBars({ rows, format, label }: {
  rows: { key: string; label: string; colorIndex: number; value: number; caption: string }[];
  format: (n: number) => string;
  label: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="chart-empty">Nothing to break down in this range.</p>;
  return (
    <ul className="bd-bars" aria-label={label}>
      {rows.map((r) => (
        <li className="bd-bar-row" key={r.key}>
          <span className="bd-bar-label" title={r.label}>{r.label}</span>
          <span className="bd-bar-track">
            <span className="bd-bar-fill" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, background: seriesColor(r.colorIndex) }} />
          </span>
          {/* The value rides OUTSIDE the bar, always. Inside, it would need measuring against every
              bar's rendered width and would be clipped on the short ones — and a cropped number is
              worse than one that simply sits beside its bar. */}
          <span className="bd-bar-value">{format(r.value)}</span>
          <span className="bd-bar-caption">{r.caption}</span>
        </li>
      ))}
    </ul>
  );
}

/** A 12-point trend for a stat tile. Decorative by contract — it carries no axis and no labels, and
 *  every value it draws is in the chart and the table below. */
export function Sparkline({ values, colorIndex = 0 }: { values: number[]; colorIndex?: number }) {
  const pts = sparklinePoints(values, 96, 24);
  if (!pts) return null;
  return (
    <svg className="sparkline" viewBox="0 0 96 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={seriesColor(colorIndex)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A single ratio against a limit — the budget meter.
 *
 * The fill carries severity and the unfilled track is a lighter step of the SAME ramp, so the state
 * reads across the whole bar rather than only where it happens to end. `over` is capped visually at
 * 100% but the label says the real number: a bar that silently stops at full would hide exactly the
 * case the meter exists for.
 */
export function BudgetMeter({ spent, budget, projected }: { spent: number; budget: number; projected: number | null }) {
  const ratio = budget > 0 ? spent / budget : 0;
  const state = ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
  const projRatio = projected !== null && budget > 0 ? Math.min(1, projected / budget) : null;
  return (
    <div className="budget-meter" data-state={state}
      role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent}
      aria-label="Monthly agent spend against budget">
      <div className="budget-track">
        <div className="budget-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        {/* Where a straight-line month is heading. A thin rule, not a second fill: it is a
            projection, and drawing it as filled area would state it as spend that has happened. */}
        {projRatio !== null && projRatio > ratio && (
          <div className="budget-projection" style={{ left: `${projRatio * 100}%` }} title="Projected month end" />
        )}
      </div>
    </div>
  );
}

/**
 * The legend. Always present at two or more series, because colour-matching alone is not an identity
 * channel anyone should be made to rely on — and mirrored in shape to the mark it stands for (a rect
 * for the bars these charts draw).
 */
export function Legend({ series }: { series: { key: string; label: string; colorIndex: number }[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}><span className="chart-legend-swatch" style={{ background: seriesColor(s.colorIndex) }} />{s.label}</li>
      ))}
    </ul>
  );
}
