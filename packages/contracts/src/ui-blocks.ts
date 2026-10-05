import { z } from "zod";

/**
 * Blocks an agent writes and Realm draws: a diagram, a chart and a comparison.
 *
 * They are fenced code in the Markdown every agent already writes — ```mermaid, ```realm-chart and
 * ```realm-compare — rather than a tool, so a block sits where the sentence put it, costs no round
 * trip, and works for every agent and in a `.md` document alike. The price is that nobody tells the
 * agent its block failed: a body that does not parse here stays the code it was, with the reason
 * beside it, and the preamble (`apps/server/src/mcp/capabilities.ts`) is what keeps that rare.
 *
 * **Data only.** Every string is drawn as text, and nothing in a body names a URL, a colour or a size:
 * a series takes the palette slot of its place in the list, and a diagram is Mermaid's own syntax,
 * drawn in its strict mode with links and scripts taken out of what it draws.
 */

/** The fence labels, and the kind of block each one draws. */
export const UI_BLOCK_FENCES = { mermaid: "diagram", "realm-chart": "chart", "realm-compare": "compare" } as const;
export type UiBlockFence = keyof typeof UI_BLOCK_FENCES;
export type UiBlockKind = (typeof UI_BLOCK_FENCES)[UiBlockFence];

/** The block a fence's info string asks for, or null for every other fence. Its first word, in any
 *  case: "```mermaid" and "```Mermaid title" both draw. */
export function uiBlockKind(info: string | null | undefined): UiBlockKind | null {
  const word = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Object.hasOwn(UI_BLOCK_FENCES, word) ? UI_BLOCK_FENCES[word as UiBlockFence] : null;
}

/** Past this a body is not drawn at all. Well over what any honest chart or diagram needs, and well
 *  under what would make parsing it a cost: the limit is a guard, not a budget. */
export const UI_BLOCK_SOURCE_MAX = 20_000;
/** A diagram's lines and Mermaid's own edge cap. Layout is synchronous in the renderer, so these are
 *  what keep a huge graph from holding the window; the renderer's timeout is the backstop. */
export const DIAGRAM_LINES_MAX = 300;
export const DIAGRAM_EDGES_MAX = 200;
/** The categorical palette has eight slots and no ninth (`tokens.css`). */
export const CHART_SERIES_MAX = 8;
export const CHART_POINTS_MAX = 60;
export const COMPARE_OPTIONS_MAX = 6;
export const COMPARE_ROWS_MAX = 30;

/* Messages are written to follow the place `describeIssue` puts in front of them — "title: empty",
   "series 2, label: longer than 60 characters" — except a refinement's, which is a sentence of its own. */
const text = (max: number) => z.string({ invalid_type_error: "not text" }).trim().min(1, "empty").max(max, `longer than ${max} characters`);

export const ChartKindSchema = z.enum(["columns", "bars", "lines", "sparkline"], {
  errorMap: () => ({ message: "not columns, bars, lines or sparkline" }),
});
export type ChartKind = z.infer<typeof ChartKindSchema>;

const ChartSeriesSchema = z.object({
  label: text(60),
  /** One value per x label. Null is a value nobody reported, drawn as a gap rather than as a zero. */
  values: z.array(z.number().finite().nullable()).min(1, "no values").max(CHART_POINTS_MAX, `more than ${CHART_POINTS_MAX} values`),
});

export const ChartBlockSchema = z.object({
  kind: ChartKindSchema,
  title: text(120),
  /** Said after each value: "412 KB", "18%". */
  unit: z.string().trim().max(16, "longer than 16 characters").optional(),
  /** The categories, or the points in order — a year may be written as a number. A sparkline may go
   *  without; everything else is read against them. */
  x: z.array(z.preprocess((v) => (typeof v === "number" ? String(v) : v), text(40))).min(1, "no labels").max(CHART_POINTS_MAX, `more than ${CHART_POINTS_MAX} labels`).optional(),
  series: z.array(ChartSeriesSchema).min(1, "no series").max(CHART_SERIES_MAX, `more than ${CHART_SERIES_MAX} series`),
}).superRefine((c, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (!c.x && c.kind !== "sparkline") issue(["x"], `${c.kind} need x labels`);
  const n = c.x?.length ?? c.series[0]?.values.length ?? 0;
  const seen = new Set<string>();
  c.series.forEach((s, i) => {
    if (s.values.length !== n) issue(["series", i, "values"], `"${s.label}" has ${s.values.length} values for ${n} ${c.x ? "x labels" : "points"}`);
    if (seen.has(s.label)) issue(["series", i, "label"], `two series are both called "${s.label}"`);
    seen.add(s.label);
    // Columns and bars are lengths from zero; a negative one has nowhere to go but through the axis.
    if ((c.kind === "columns" || c.kind === "bars") && s.values.some((v) => v !== null && v < 0))
      issue(["series", i, "values"], `"${s.label}" has a negative value, and ${c.kind} start at zero — lines can go below it`);
  });
  if (c.kind === "bars" && c.series.length > 1) issue(["series"], "bars take one series — columns or lines take several");
  if (c.series.every((s) => s.values.every((v) => v === null))) issue(["series"], "every value is null, so there is nothing to draw");
});
export type ChartBlock = z.output<typeof ChartBlockSchema>;

/** A cell is text. A number or a yes/no reads as one, and null is a cell with nothing to say. */
const CompareCellSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()], {
  errorMap: (issue, ctx) => ({ message: issue.code === "invalid_union" ? "not text" : ctx.defaultError }),
}).refine((v) => typeof v !== "string" || v.length <= 280, "longer than 280 characters")
  .transform((v): string | null => (v === null ? null : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v).trim() || null));

export const CompareBlockSchema = z.object({
  title: text(120).optional(),
  options: z.array(text(60)).min(2, "fewer than two options").max(COMPARE_OPTIONS_MAX, `more than ${COMPARE_OPTIONS_MAX} options`),
  rows: z.array(z.object({ label: text(80), values: z.array(CompareCellSchema) }))
    .min(1, "no rows").max(COMPARE_ROWS_MAX, `more than ${COMPARE_ROWS_MAX} rows`),
  /** The option recommended, by its name. Set apart, never the only place the recommendation is said. */
  pick: z.string().trim().min(1, "empty").optional(),
}).superRefine((c, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (new Set(c.options).size !== c.options.length) issue(["options"], "two options have the same name");
  c.rows.forEach((r, i) => {
    if (r.values.length !== c.options.length) issue(["rows", i, "values"], `"${r.label}" has ${r.values.length} values for ${c.options.length} options`);
  });
  if (c.pick !== undefined && !c.options.includes(c.pick)) issue(["pick"], `the pick, "${c.pick}", is not one of the options`);
});
export type CompareBlock = z.output<typeof CompareBlockSchema>;

export type UiBlock =
  | { kind: "diagram"; source: string }
  | { kind: "chart"; chart: ChartBlock }
  | { kind: "compare"; compare: CompareBlock };
/** Parse-or-null, with the reason a reader is shown beside the code when it is null. */
export type UiBlockParse = { ok: true; block: UiBlock } | { ok: false; reason: string };

const fail = (reason: string): UiBlockParse => ({ ok: false, reason });

/**
 * A fence's body as the block it asks for, or the one-line reason it is not one.
 *
 * A diagram is only measured here — its syntax is Mermaid's to judge, in the renderer, and so is its
 * edge count. A chart or a comparison is JSON held to its schema, and the first problem found is the
 * reason: one is enough to explain why a block stayed code, and a list of five would be a log.
 */
export function parseUiBlock(kind: UiBlockKind, source: string): UiBlockParse {
  const body = source.trim();
  if (body === "") return fail("the block is empty");
  if (source.length > UI_BLOCK_SOURCE_MAX) return fail(`longer than the ${UI_BLOCK_SOURCE_MAX.toLocaleString("en-US")} characters Realm draws`);
  if (kind === "diagram") {
    const lines = body.split("\n").length;
    return lines > DIAGRAM_LINES_MAX ? fail(`${lines} lines, past the ${DIAGRAM_LINES_MAX} Realm draws`) : { ok: true, block: { kind, source: body } };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return fail(`not JSON: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  if (kind === "chart") {
    const r = ChartBlockSchema.safeParse(json);
    return r.success ? { ok: true, block: { kind, chart: r.data } } : fail(describeIssue(r.error.issues[0]));
  }
  const r = CompareBlockSchema.safeParse(json);
  return r.success ? { ok: true, block: { kind, compare: r.data } } : fail(describeIssue(r.error.issues[0]));
}

/** What a list's member is called once it is counted: "series 2", "value 4", "row 3". */
const MEMBER: Record<string, string> = { series: "series", values: "value", rows: "row", options: "option", x: "x label" };

/** One zod issue as a reader's line: where, then what. A refinement wrote its own sentence. */
function describeIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) return "not a block Realm draws";
  if (issue.code === "custom") return issue.message;
  const where: string[] = [];
  issue.path.forEach((p, i) => {
    if (typeof p === "number") where.push(`${MEMBER[String(issue.path[i - 1])] ?? String(issue.path[i - 1])} ${p + 1}`);
    else if (typeof issue.path[i + 1] !== "number") where.push(p);
  });
  const place = where.length > 0 ? where.join(", ") : "the block";
  const what = issue.code === "invalid_type" && issue.received === "undefined" ? "missing" : issue.message;
  return `${place}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
}
