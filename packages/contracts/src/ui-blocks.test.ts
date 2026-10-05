import { describe, expect, it } from "vitest";
import {
  CHART_POINTS_MAX, CHART_SERIES_MAX, DIAGRAM_LINES_MAX, UI_BLOCK_SOURCE_MAX, parseUiBlock, uiBlockKind,
  type ChartBlock, type CompareBlock,
} from "./ui-blocks";

const chart = (body: unknown) => parseUiBlock("chart", JSON.stringify(body));
const compare = (body: unknown) => parseUiBlock("compare", JSON.stringify(body));
const reason = (r: ReturnType<typeof parseUiBlock>) => (r.ok ? null : r.reason);

const BUNDLE = {
  kind: "columns", title: "Renderer bundle by release", unit: "KB",
  x: ["1.0", "1.1", "1.2"],
  series: [{ label: "App code", values: [612, 640, 655] }, { label: "Libraries", values: [1210, 1214, null] }],
};

describe("uiBlockKind — which fences are blocks", () => {
  it("names the three fences, by their first word and in any case", () => {
    expect(uiBlockKind("mermaid")).toBe("diagram");
    expect(uiBlockKind("realm-chart")).toBe("chart");
    expect(uiBlockKind("realm-compare")).toBe("compare");
    expect(uiBlockKind("  Mermaid title=Auth ")).toBe("diagram");
  });

  it("leaves every other fence to be code", () => {
    for (const info of ["", "json", "ts", "realm", "chart", "mermaid-js", "realm-charts", undefined, null]) expect(uiBlockKind(info)).toBeNull();
  });
});

describe("parseUiBlock — a chart", () => {
  it("parses columns with labelled series, a unit, and a gap where a value was not reported", () => {
    const r = chart(BUNDLE);
    expect(r.ok).toBe(true);
    const c = (r as { ok: true; block: { kind: "chart"; chart: ChartBlock } }).block.chart;
    expect(c.kind).toBe("columns");
    expect(c.series[1]!.values).toEqual([1210, 1214, null]);
  });

  it("trims what it draws, and reads a year written as a number as its label", () => {
    const r = chart({ ...BUNDLE, title: "  Bundle  ", x: [2024, 2025, "2026"] });
    const c = (r as { ok: true; block: { kind: "chart"; chart: ChartBlock } }).block.chart;
    expect(c.title).toBe("Bundle");
    expect(c.x).toEqual(["2024", "2025", "2026"]);
  });

  it("lets a sparkline go without x labels, and nothing else", () => {
    expect(chart({ kind: "sparkline", title: "Trend", series: [{ label: "p95", values: [3, 4, 2] }] }).ok).toBe(true);
    expect(reason(chart({ kind: "lines", title: "Trend", series: [{ label: "p95", values: [3, 4, 2] }] }))).toBe("lines need x labels");
  });

  it("says which series has the wrong number of values", () => {
    // THE MUTANT: drop the length check, and a series one short draws its last column against the
    // wrong label — a chart that is silently wrong rather than visibly code.
    expect(reason(chart({ ...BUNDLE, series: [{ label: "Cold", values: [820, 790] }] }))).toBe('"Cold" has 2 values for 3 x labels');
  });

  it("refuses what the palette and the plot cannot draw honestly", () => {
    const many = Array.from({ length: CHART_SERIES_MAX + 1 }, (_, i) => ({ label: `S${i}`, values: [1, 2, 3] }));
    expect(reason(chart({ ...BUNDLE, series: many }))).toBe(`series: more than ${CHART_SERIES_MAX} series`);
    const long = Array.from({ length: CHART_POINTS_MAX + 1 }, (_, i) => `${i}`);
    expect(reason(chart({ ...BUNDLE, x: long }))).toBe(`x: more than ${CHART_POINTS_MAX} labels`);
    expect(reason(chart({ ...BUNDLE, kind: "bars", series: BUNDLE.series }))).toBe("bars take one series — columns or lines take several");
    expect(reason(chart({ ...BUNDLE, series: [{ label: "Delta", values: [3, -2, 1] }] })))
      .toBe('"Delta" has a negative value, and columns start at zero — lines can go below it');
    expect(chart({ ...BUNDLE, kind: "lines", series: [{ label: "Delta", values: [3, -2, 1] }] }).ok).toBe(true);
    expect(reason(chart({ ...BUNDLE, series: [{ label: "A", values: [1, 2, 3] }, { label: "A", values: [3, 2, 1] }] })))
      .toBe('two series are both called "A"');
    expect(reason(chart({ ...BUNDLE, series: [{ label: "None", values: [null, null, null] }] }))).toBe("every value is null, so there is nothing to draw");
  });

  it("says where a value of the wrong kind is, in a reader's terms", () => {
    expect(reason(chart({ ...BUNDLE, kind: "pie" }))).toBe("kind: not columns, bars, lines or sparkline");
    expect(reason(chart({ ...BUNDLE, series: [{ label: "App", values: [1, "2", 3] }] }))).toBe("series 1, value 2: expected number, received string");
    expect(reason(chart({ ...BUNDLE, title: undefined }))).toBe("title: missing");
    expect(reason(chart({ ...BUNDLE, series: [{ label: " ", values: [1, 2, 3] }] }))).toBe("series 1, label: empty");
    expect(reason(chart([1, 2, 3]))).toBe("the block: expected object, received array");
  });

  it("keeps a colour, a size or a link an agent adds out of what it hands on", () => {
    const r = chart({ ...BUNDLE, color: "#f00", href: "https://example.com", series: [{ label: "A", values: [1, 2, 3], color: "red" }] });
    const c = (r as { ok: true; block: { kind: "chart"; chart: ChartBlock } }).block.chart;
    expect(JSON.stringify(c)).not.toMatch(/color|href|example/);
  });
});

describe("parseUiBlock — a comparison", () => {
  const DB = {
    title: "Where the session store lives", options: ["Postgres", "SQLite"], pick: "SQLite",
    rows: [{ label: "Setup", values: ["A server to run", "A file"] }, { label: "Local", values: [false, true] }, { label: "Writers", values: [100, null] }],
  };

  it("parses options and rows, reading a yes/no and a number as text and null as nothing to say", () => {
    const r = compare(DB);
    const c = (r as { ok: true; block: { kind: "compare"; compare: CompareBlock } }).block.compare;
    expect(c.pick).toBe("SQLite");
    expect(c.rows.map((row) => row.values)).toEqual([["A server to run", "A file"], ["No", "Yes"], ["100", null]]);
  });

  it("holds a row to the options and the pick to one of them", () => {
    expect(reason(compare({ ...DB, rows: [{ label: "Setup", values: ["A server"] }] }))).toBe('"Setup" has 1 values for 2 options');
    // THE MUTANT: let the pick through unchecked, and a column is set apart that the table never shows.
    expect(reason(compare({ ...DB, pick: "MySQL" }))).toBe('the pick, "MySQL", is not one of the options');
    expect(reason(compare({ ...DB, options: ["Postgres"] }))).toBe("options: fewer than two options");
    expect(reason(compare({ ...DB, options: ["A", "A"] }))).toBe("two options have the same name");
    expect(reason(compare({ ...DB, rows: [{ label: "Setup", values: [{ text: "x" }, "y"] }] }))).toBe("row 1, value 1: not text");
  });

  it("takes a comparison without a title or a pick", () => {
    expect(compare({ options: DB.options, rows: DB.rows }).ok).toBe(true);
  });
});

describe("parseUiBlock — a diagram, and what every block shares", () => {
  it("passes a diagram through as its source, trimmed — Mermaid judges the syntax", () => {
    expect(parseUiBlock("diagram", "\nsequenceDiagram\n  A->>B: hi\n")).toEqual({ ok: true, block: { kind: "diagram", source: "sequenceDiagram\n  A->>B: hi" } });
  });

  it("refuses a diagram too long to lay out in the window's own thread", () => {
    const lines = Array.from({ length: DIAGRAM_LINES_MAX + 1 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n");
    expect(reason(parseUiBlock("diagram", `flowchart TD\n${lines}`))).toBe(`${DIAGRAM_LINES_MAX + 2} lines, past the ${DIAGRAM_LINES_MAX} Realm draws`);
  });

  it("refuses an empty body, a body past the limit, and a body that is not JSON", () => {
    expect(reason(parseUiBlock("chart", "  \n "))).toBe("the block is empty");
    expect(reason(parseUiBlock("diagram", `graph TD\n${"A-->B\n".repeat(UI_BLOCK_SOURCE_MAX / 6)}`))).toBe("longer than the 20,000 characters Realm draws");
    expect(reason(parseUiBlock("chart", '{"kind": "columns",}'))).toMatch(/^not JSON: /);
  });
});
