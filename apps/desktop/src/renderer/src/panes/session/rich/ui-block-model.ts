import type { ChartBlock, CompareBlock, UiBlockKind } from "@realm/contracts";

/**
 * The arithmetic and the words behind a drawn block, with no React in sight: how a value is written,
 * what a chart says to someone who cannot see it, and the forms a block is copied in.
 */

/** Written before the figure rather than after it. */
const PREFIX_UNITS = new Set(["$", "€", "£", "¥"]);

/**
 * A value in the chart's unit: `exact` for the tooltip and the table, `short` for an axis or a label
 * over a column, where "1.2K" fits and "1,210 KB" does not. A word of a unit is left off the short
 * form — the block's head names it once, and nine repeats of "KB" up an axis are noise — while a
 * symbol that is part of how the figure reads ("$1.2K", "40%") stays.
 */
export function unitFormat(unit: string | undefined): { exact: (n: number) => string; short: (n: number) => string } {
  const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const short = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const u = unit?.trim() ?? "";
  const withUnit = (text: string, n: number, word: boolean): string => {
    if (!u) return text;
    if (PREFIX_UNITS.has(u)) return n < 0 ? `-${u}${text.replace(/^-/, "")}` : `${u}${text}`;
    if (u === "%") return `${text}%`;
    return word ? `${text} ${u}` : text;
  };
  return { exact: (n) => withUnit(exact.format(n), n, true), short: (n) => withUnit(short.format(n), n, false) };
}

const KIND_WORD: Record<ChartBlock["kind"], string> = { columns: "Columns", bars: "Bars", lines: "Lines", sparkline: "Sparklines" };

/** The labels a chart is read against: its x labels, or the points counted for a sparkline that has none. */
export const chartLabels = (c: ChartBlock): string[] =>
  c.x ?? Array.from({ length: c.series[0]?.values.length ?? 0 }, (_, i) => String(i + 1));

/**
 * The chart in a sentence: what is drawn, over what, and where each series starts, ends and peaks.
 *
 * The text alternative a screen reader is handed with the picture. It is a summary, not the data —
 * the table one click away is the data, and reading sixty values aloud is not a description.
 */
export function describeChart(c: ChartBlock): string {
  const { exact } = unitFormat(c.unit);
  const xs = chartLabels(c);
  const span = xs.length > 1 ? `, ${xs.length} ${c.x ? "labels" : "points"} from ${xs[0]} to ${xs.at(-1)}` : "";
  const parts = c.series.map((s) => {
    const seen = s.values.flatMap((v, i) => (v === null ? [] : [{ v, i }]));
    if (seen.length === 0) return `${s.label}: nothing reported`;
    const top = seen.reduce((a, b) => (b.v > a.v ? b : a));
    if (c.kind === "bars") return `${s.label}: ${seen.map(({ v, i }) => `${xs[i]} ${exact(v)}`).join(", ")}`;
    const first = seen[0]!, last = seen.at(-1)!;
    return `${s.label}: ${exact(first.v)} at ${xs[first.i]} to ${exact(last.v)} at ${xs[last.i]}, highest ${exact(top.v)} at ${xs[top.i]}`;
  });
  return `${KIND_WORD[c.kind]}: ${c.title}${span}. ${parts.join("; ")}.`;
}

/** A comparison's name when it was given none: the question it answers. */
export function compareTitle(c: CompareBlock): string {
  if (c.title) return c.title;
  const o = c.options;
  return o.length === 2 ? `${o[0]} or ${o[1]}` : `${o.slice(0, -1).join(", ")} or ${o.at(-1)}`;
}

/** A cell as Markdown table text: one line, its own pipes escaped. */
const mdCell = (v: string | null): string => (v ?? "—").replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|");

/** The comparison as a Markdown table, for pasting where Markdown is read. The pick says so in words. */
export function compareMarkdown(c: CompareBlock): string {
  const head = c.options.map((o) => (o === c.pick ? `${o} (recommended)` : o));
  const lines = [
    `| ${mdCell(c.title ?? "")} | ${head.map(mdCell).join(" | ")} |`,
    `| --- | ${c.options.map(() => "---").join(" | ")} |`,
    ...c.rows.map((r) => `| ${mdCell(r.label)} | ${r.values.map(mdCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The comparison as an HTML table, for pasting into a document or a message that reads tables. */
export function compareHtml(c: CompareBlock): string {
  const th = (o: string) => `<th>${esc(o)}${o === c.pick ? " (recommended)" : ""}</th>`;
  const rows = c.rows.map((r) => `<tr><th>${esc(r.label)}</th>${r.values.map((v) => `<td>${esc(v ?? "—")}</td>`).join("")}</tr>`);
  return `<table><thead><tr><th>${esc(c.title ?? "")}</th>${c.options.map(th).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/** FNV-1a, 32-bit: a block's identity across the remounts streaming causes. Not a security boundary. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export const blockKey = (kind: UiBlockKind, source: string): string => `${kind}:${source.length}:${hash(source)}`;
