import { Icon } from "@realm/ui";
import { parseUiBlock, type ChartBlock, type CompareBlock, type UiBlock, type UiBlockKind } from "@realm/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Menu, type MenuItem } from "../../../components/Menu";
import { useDissolve } from "../../../components/ScrollFades";
import { useAppStoreMaybe } from "../../../state/store";
import { BreakdownBars, Legend, LineChart, Sparkline, StackedColumns, seriesColor, type StackSeries } from "../../settings/usage/Charts";
import { diagramTheme, useDiagramTheme } from "./block-theme";
import { blockPicture, chartSvg, copyPicture, copySvg, copyTable, diagramSvg } from "./block-export";
import { diagramName, drawDiagram, exportedDiagram, peekDiagram, placeDiagram, type DiagramResult, type DrawnDiagram } from "./mermaid";
import { blockKey, chartLabels, compareHtml, compareMarkdown, compareTitle, describeChart, unitFormat } from "./ui-block-model";

/**
 * A fenced block drawn as what it describes: a chart, a diagram, a comparison (`contracts/ui-blocks.ts`).
 *
 * The block is a panel the eye rests in, so it is the fenced-code panel — the same squircle, the same
 * head — with the drawing where the code was. Its head names it and holds its few controls: a chart's
 * values as a table, one click away, because a picture is never the only way to read a number; and
 * a menu that copies it as a picture, as an SVG or as the source it was drawn from.
 *
 * Nothing here is the agent's markup. Every label is text React writes, every colour is a palette
 * slot taken by position, and a diagram is Mermaid's drawing after the gate in `mermaid.ts`.
 */

export type BlockState =
  | { status: "pending" }
  | { status: "failed"; reason: string }
  | { status: "drawn"; block: UiBlock; diagram?: DrawnDiagram };

/** A block's body parsed and, for a diagram, drawn. Pending only while a diagram is being drawn for
 *  the first time in this face; every later mount reads the drawing synchronously. `skip` holds it
 *  at pending — a document's fence that has not closed is not a body to judge yet. */
export function useUiBlock(kind: UiBlockKind, source: string, { skip = false }: { skip?: boolean } = {}): BlockState {
  const parsed = useMemo(() => (skip ? null : parseUiBlock(kind, source)), [kind, source, skip]);
  const diagram = useDiagram(parsed?.ok && parsed.block.kind === "diagram" ? parsed.block.source : null);
  // One object per answer, not per render: a caller that keeps the last drawing compares by identity.
  return useMemo((): BlockState => {
    if (!parsed) return PENDING;
    if (!parsed.ok) return { status: "failed", reason: parsed.reason };
    if (parsed.block.kind !== "diagram") return { status: "drawn", block: parsed.block };
    if (!diagram) return PENDING;
    return diagram.ok ? { status: "drawn", block: parsed.block, diagram } : { status: "failed", reason: diagram.reason };
  }, [parsed, diagram]);
}

const PENDING: BlockState = { status: "pending" };

function useDiagram(source: string | null): DiagramResult | undefined {
  const theme = useDiagramTheme(source !== null);
  const [drawn, setDrawn] = useState<{ key: string; result: DiagramResult } | null>(null);
  const key = source !== null && theme ? `${theme.key}\n${source}` : null;
  const cached = source !== null && theme ? peekDiagram(source, theme) : undefined;
  const showing = drawn?.result.ok ?? false;
  useEffect(() => {
    if (source === null || !theme || cached) return;
    let live = true;
    // A body that changes under a drawing — its source being edited in a document — is drawn once it
    // pauses, rather than once per keystroke, with the last drawing up meanwhile.
    const timer = setTimeout(() => {
      void drawDiagram(source, theme).then((result) => { if (live) setDrawn({ key: `${theme.key}\n${source}`, result }); });
    }, showing ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [source, theme, cached, showing]);
  if (cached) return cached;
  if (drawn && drawn.key === key) return drawn.result;
  // The face changed under a drawing: it stays up until the new one lands, rather than dropping back
  // to the source for a beat.
  return drawn?.result.ok ? drawn.result : undefined;
}

/* What a reader switched on a block — its table, its source — kept by the block's identity, because
   a message that is still streaming rewrites its markup on every delta and remounts every block in
   it. Kept for the life of the window and no longer; a cap keeps a long one from keeping them all. */
const toggles = new Map<string, boolean>();
function useBlockToggle(key: string, initial = false): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => toggles.get(key) ?? initial);
  const set = (next: boolean) => {
    toggles.delete(key);
    toggles.set(key, next);
    while (toggles.size > 500) toggles.delete(toggles.keys().next().value!);
    setOn(next);
  };
  return [on, set];
}

/**
 * The transcript's block, portalled into the placeholder `Markdown.tsx` parked for a fence that
 * closed. A body that is not a block leaves the code where it is and says why in the code's head.
 */
export function UiBlockPortal({ kind, source, reasonSlot }: { kind: UiBlockKind; source: string; reasonSlot: HTMLElement | null }) {
  const state = useUiBlock(kind, source);
  const [shown, setShown] = useBlockToggle(`${blockKey(kind, source)}:source`);
  if (state.status === "failed") return reasonSlot ? createPortal(<>Not drawn — {state.reason}</>, reasonSlot) : null;
  if (state.status !== "drawn") return null;
  return <DrawnBlock state={state} kind={kind} source={source} sourceShown={shown}
    extraMenu={[{ kind: "separator" }, { label: shown ? "Hide source" : "Show source", icon: <Icon name="code" size={14} />, onSelect: () => setShown(!shown) }]} />;
}

const COPIED_MS = 1400;

/**
 * The drawn block itself — shared by the transcript and a Markdown document's rich view, which adds
 * its own controls (`actions`, `extraMenu`) for editing the source in place.
 */
export function DrawnBlock({ state, kind, source, sourceShown = false, actions, extraMenu = [] }: {
  state: Extract<BlockState, { status: "drawn" }>; kind: UiBlockKind; source: string; sourceShown?: boolean;
  actions?: ReactNode; extraMenu?: MenuItem[];
}) {
  const { block, diagram } = state;
  const figure = useRef<HTMLElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const key = blockKey(kind, source);
  const [table, setTable] = useBlockToggle(`${key}:table`);
  // A copy that failed already happened, so it is a toast — where there is a window to put one in.
  const store = useAppStoreMaybe();

  const done = (what: Promise<void>, failed: string) => {
    void what.then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }, (e: unknown) => {
      console.error("[blocks] copy failed", e);
      store?.getState().toast({ tone: "error", text: failed });
    });
  };
  // The block's ground in the face on screen, read when it is copied: a copy carries its own.
  const copyImage = () => {
    const el = figure.current;
    if (el) done(copyPicture(blockPicture(el, diagramTheme().ground)), "Couldn't copy the picture");
  };
  const svgMarkup = (): string | null => {
    if (diagram) return diagramSvg(exportedDiagram(diagram.svg), diagramTheme().ground);
    const svg = figure.current?.querySelector<SVGSVGElement>("svg.chart");
    return svg ? chartSvg(svg, diagramTheme().ground) : null;
  };

  // An SVG of its own is what a diagram, a column chart and a line chart ARE; bars and sparklines are
  // laid out by the page, so they copy as a picture and nothing that would pretend otherwise.
  const svgOwn = block.kind === "diagram" || (block.kind === "chart" && (block.chart.kind === "columns" || block.chart.kind === "lines"));
  const copyRows: MenuItem[] = [
    { label: "Copy image", icon: <Icon name="image" size={14} />, onSelect: copyImage },
    ...(block.kind === "compare"
      ? [{ label: "Copy table", icon: <Icon name="table" size={14} />, onSelect: () => done(copyTable(compareMarkdown(block.compare), compareHtml(block.compare)), "Couldn't copy the table") }]
      : svgOwn ? [{ label: "Copy SVG", icon: <Icon name="fileSvg" size={14} />, disabled: table,
          title: table ? "Show the chart to copy it as an SVG" : undefined,
          onSelect: () => { const m = svgMarkup(); if (m) done(copySvg(m), "Couldn't copy the SVG"); } }] : []),
    { label: "Copy source", icon: <Icon name="copy" size={14} />, onSelect: () => done(navigator.clipboard.writeText(source), "Couldn't copy the source") },
  ];

  const head = block.kind === "chart" ? { title: block.chart.title, sub: block.chart.unit ?? null }
    : block.kind === "compare" ? { title: compareTitle(block.compare), sub: null }
    : { title: diagram?.title ?? diagramName(diagram?.type ?? ""), sub: null };

  return (
    <figure ref={figure} className="ui-block" data-kind={block.kind} data-chart={block.kind === "chart" ? block.chart.kind : undefined}
      data-source={sourceShown || undefined}>
      <figcaption className="ui-block-head">
        <span className="ui-block-title" data-quiet={block.kind === "diagram" && !diagram?.title ? "" : undefined}>{head.title}</span>
        {head.sub && <span className="ui-block-sub">{head.sub}</span>}
        <span className="ui-block-acts">
          {actions}
          {block.kind === "chart" && (
            <button type="button" className="tool-copy ui-block-act" aria-pressed={table} title={table ? "Show the chart" : "Show the values as a table"}
              aria-label="Values as a table" onClick={() => setTable(!table)}>
              <Icon name="table" size={14} />
            </button>
          )}
          <button ref={more} type="button" className="tool-copy ui-block-act" aria-label="Copy, and more" title="Copy, and more"
            aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            <span className="icon-swap" data-on={copied || undefined}>
              <Icon name="more" size={14} className="swap-off" />
              <Icon name="check" size={14} className="swap-on ui-block-copied" />
            </span>
          </button>
        </span>
      </figcaption>
      {block.kind === "chart" && (table ? <ValuesTable chart={block.chart} /> : <ChartBody chart={block.chart} />)}
      {block.kind === "compare" && <CompareTable compare={block.compare} />}
      {block.kind === "diagram" && diagram && <DiagramBody diagram={diagram} />}
      {menu && <Menu items={[...copyRows, ...extraMenu]} onClose={() => setMenu(false)} anchorRef={more} align="right" label="Block" />}
    </figure>
  );
}

/** The narrowest a block's plot is drawn at its real size. Under it the drawing scales, rather than
 *  its axis giving the bars no room at all. */
const PLOT_MIN = 240;

/** A block's own width as laid out, for a layout that recomposes rather than shrinks. Zero until it
 *  is measured — and in jsdom, which measures nothing — which callers read as "wide". */
function useInlineSize(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** A chart's series, in the order written, on the palette's slots in that order. */
const seriesOf = (c: ChartBlock): StackSeries[] => c.series.map((s, i) => ({ key: String(i), label: s.label, colorIndex: i, values: s.values }));

function ChartBody({ chart }: { chart: ChartBlock }) {
  const { exact, short } = unitFormat(chart.unit);
  const series = seriesOf(chart);
  const labels = chartLabels(chart);
  const description = describeChart(chart);
  if (chart.kind === "columns") {
    return (
      <div className="ui-chart">
        <StackedColumns labels={labels} series={series} format={exact} tickFormat={short} label={chart.title} description={description} totals minWidth={PLOT_MIN} />
        <Legend series={series} />
      </div>
    );
  }
  if (chart.kind === "lines") {
    return (
      <div className="ui-chart">
        <LineChart labels={labels} series={series} format={exact} tickFormat={short} label={chart.title} description={description} minWidth={PLOT_MIN} />
      </div>
    );
  }
  if (chart.kind === "bars") {
    const only = chart.series[0]!;
    return (
      <div className="ui-chart" role="img" aria-label={`${chart.title}. ${description}`}>
        {/* One series, so one hue: the label beside each bar already says which bar is which, and a
            colour per bar would re-encode that and run out of palette at the ninth. */}
        <BreakdownBars label={chart.title} format={exact}
          rows={labels.map((l, i) => ({ key: String(i), label: l, colorIndex: 0, value: only.values[i] ?? null, caption: "" }))} />
      </div>
    );
  }
  return (
    <ul className="ui-sparks" aria-label={`${chart.title}. ${description}`}>
      {series.map((s) => {
        const seen = s.values.filter((v): v is number => v !== null);
        return (
          <li key={s.key} className="ui-spark">
            <span className="ui-spark-label" title={s.label}>{s.label}</span>
            <Sparkline values={seen} colorIndex={s.colorIndex} />
            <span className="ui-spark-value">{seen.length > 0 ? exact(seen.at(-1)!) : "—"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Every value the chart draws, readable without hovering anything — and the relief the light
 *  palette owes (`tokens.css`): three of its slots are under 3:1 on white. */
function ValuesTable({ chart }: { chart: ChartBlock }) {
  const { exact } = unitFormat(chart.unit);
  const labels = chartLabels(chart);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const stacked = chart.kind === "columns" && chart.series.length > 1;
  const cell = (v: number | null | undefined) => (v === null || v === undefined ? <span className="ui-none" aria-label="not reported">—</span> : exact(v));
  return (
    <div className="ui-block-scroll" data-values="" ref={scroller}>
      <table className="ui-values">
        <caption className="visually-hidden">{chart.title}, as a table</caption>
        <thead>
          <tr>
            <td />
            {chart.series.map((s, i) => (
              <th key={i} scope="col">
                {chart.series.length > 1 && <span className="usage-swatch" style={{ background: seriesColor(i) }} />}{s.label}
              </th>
            ))}
            {stacked && <th scope="col">Total</th>}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={i}>
              <th scope="row">{l}</th>
              {chart.series.map((s, si) => <td key={si}>{cell(s.values[i])}</td>)}
              {stacked && <td>{exact(chart.series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A comparison, its recommended column set apart.
 *
 * The pick stands on a raised band with its name said in words over it — never by colour alone —
 * and the band is a surface step, not the accent: the accent is for what can be clicked, and a column
 * is something to read.
 */
function CompareTable({ compare }: { compare: CompareBlock }) {
  const holder = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller, "x");
  const width = useInlineSize(holder);
  const pick = compare.pick === undefined ? -1 : compare.options.indexOf(compare.pick);
  const last = compare.rows.length - 1;
  // A column per option stops being readable well before it stops fitting, so a block too narrow
  // for every option to keep a readable column recomposes into one card per option instead.
  const cards = width > 0 && width < 36 + 110 + compare.options.length * 120;
  return (
    <div className="ui-compare-holder" ref={holder}>
      {cards ? <CompareCards compare={compare} pick={pick} /> : (
        <div className="ui-block-scroll" ref={scroller}>
          <table className="ui-compare" data-picked={pick >= 0 || undefined}>
            <caption className="visually-hidden">{compareTitle(compare)}{pick >= 0 ? `, recommended: ${compare.pick}` : ""}</caption>
            <thead>
              <tr>
                <td />
                {compare.options.map((o, i) => (
                  <th key={i} scope="col" data-pick={i === pick || undefined} data-end={i === pick ? "top" : undefined}>
                    {i === pick && <span className="ui-compare-pick">Recommended</span>}
                    <span className="ui-compare-option">{o}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.rows.map((r, ri) => (
                <tr key={ri}>
                  <th scope="row">{r.label}</th>
                  {r.values.map((v, i) => (
                    <td key={i} data-pick={i === pick || undefined} data-end={i === pick && ri === last ? "bottom" : undefined}>
                      {v ?? <span className="ui-none" aria-label="nothing to say">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The comparison for a narrow block: an option to a card, each row its label and that option's
 *  value, the pick on the same raised surface the table's band is drawn in. */
function CompareCards({ compare, pick }: { compare: CompareBlock; pick: number }) {
  return (
    <div className="ui-compare-cards" aria-label={`${compareTitle(compare)}${pick >= 0 ? `, recommended: ${compare.pick}` : ""}`} role="group">
      {compare.options.map((o, i) => (
        <section key={i} className="ui-compare-card" data-pick={i === pick || undefined} aria-label={i === pick ? `${o}, recommended` : o}>
          {i === pick && <span className="ui-compare-pick">Recommended</span>}
          <div className="ui-compare-option">{o}</div>
          <dl>
            {compare.rows.map((r, ri) => (
              <div key={ri} className="ui-compare-pair">
                <dt>{r.label}</dt>
                <dd>{r.values[i] ?? <span className="ui-none" aria-label="nothing to say">—</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * The drawing at its own size, shrunk to fit a narrower column down to two thirds of it, and
 * scrolled sideways past that rather than shrunk into illegibility.
 */
function DiagramBody({ diagram }: { diagram: DrawnDiagram }) {
  const markup = useMemo(() => placeDiagram(diagram.svg), [diagram.svg]);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller, "x");
  return (
    <div className="ui-diagram" ref={scroller} style={{ "--diagram-w": `${Math.ceil(diagram.width)}px` } as React.CSSProperties}
      dangerouslySetInnerHTML={{ __html: markup }} />
  );
}
