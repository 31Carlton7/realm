import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown, renderMarkdown } from "./Markdown";
import { BLOCK_MARK, fenceClosed } from "./rich/ui-block-md";

/**
 * Chart, diagram and comparison blocks in assistant prose (`rich/UiBlock.tsx`): what draws, when it
 * draws, and what stays code. Mermaid itself cannot run here — jsdom lays nothing out, and Mermaid
 * measures text by laying it out — so it is stood in for, and what is tested is everything Realm does
 * around it: the config it is handed, the gate its drawing goes through, the fallback and the timeout.
 */

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

const fence = (lang: string, body: string, close = true) => `Here it is:\n\n\`\`\`${lang}\n${body}\n${close ? "```\n" : ""}`;
const BUNDLE = JSON.stringify({
  kind: "columns", title: "Renderer bundle by release", unit: "KB", x: ["1.0", "1.1", "1.2"],
  series: [{ label: "App code", values: [612, 640, 655] }, { label: "Libraries", values: [1210, 1214, null] }],
}, null, 2);
const DB = JSON.stringify({
  title: "Where the session store lives", options: ["Postgres", "SQLite"], pick: "SQLite",
  rows: [{ label: "Setup", values: ["A server to run", "A file"] }, { label: "Local", values: [false, true] }],
});

const writes: unknown[] = [];
/** jsdom's Blob has no `text()`; its FileReader does the same job. */
const textOf = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
beforeEach(() => {
  writes.length = 0;
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async (t: string) => { writes.push(t); }), write: vi.fn(async (items: unknown[]) => { writes.push(...items); }) } });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class { constructor(readonly items: Record<string, unknown>) {} };
});
afterEach(cleanup);

describe("the fence-closed rule", () => {
  it("parks a block fence only once its closing fence is there", () => {
    // THE MUTANT: stop checking the close, and a chart draws from the first half of its JSON while
    // the message is still streaming — a picture that changes under the reader, from data still arriving.
    expect(renderMarkdown(fence("realm-chart", BUNDLE))).toContain('class="md-block" data-ui-block="chart"');
    expect(renderMarkdown(fence("realm-chart", BUNDLE, false))).not.toContain("md-block");
    expect(renderMarkdown(fence("mermaid", "graph TD\n  A-->B"))).toContain('data-ui-block="diagram"');
    expect(renderMarkdown(fence("json", "{}"))).not.toContain("md-block");
  });

  it("reads a close that is a delta short as still open", () => {
    expect(fenceClosed("```mermaid\ngraph TD\n``")).toBe(false);
    expect(fenceClosed("````mermaid\nx\n```\n")).toBe(false);
    expect(fenceClosed("~~~mermaid\nx\n~~~")).toBe(true);
    expect(fenceClosed("```mermaid\nx\n```  \n\n")).toBe(true);
    expect(fenceClosed("```mermaid")).toBe(false);
  });

  it("parks a fence inside a list or a quote, where agents also put them", () => {
    expect(renderMarkdown(`- The flow:\n\n  \`\`\`mermaid\n  graph TD\n    A-->B\n  \`\`\`\n`)).toContain('data-ui-block="diagram"');
    expect(renderMarkdown("> ```realm-chart\n> {}\n> ```")).toContain('data-ui-block="chart"');
  });

  it("never parks markup an agent wrote by hand to look like a parked fence", () => {
    const forged = `<pre data-ui-block="chart" data-ui-mark="${BLOCK_MARK.replace(/./g, "x")}"><code>${BUNDLE}</code></pre>`;
    expect(renderMarkdown(forged)).not.toContain("md-block");
  });

  it("draws nothing while the fence streams in, and the block once it closes", () => {
    const { container, rerender } = render(<Markdown text={fence("realm-chart", BUNDLE.slice(0, 60), false)} arrive />);
    expect(container.querySelector(".ui-block")).toBeNull();
    expect(container.querySelector(".md-code pre")?.textContent).toContain('"kind": "columns"');
    rerender(<Markdown text={fence("realm-chart", BUNDLE, false)} arrive />);
    expect(container.querySelector(".ui-block")).toBeNull();
    rerender(<Markdown text={fence("realm-chart", BUNDLE)} arrive />);
    expect(container.querySelector('.ui-block[data-kind="chart"]')).not.toBeNull();
  });
});

describe("a chart", () => {
  it("draws its series on the palette's slots in order, with each column's total over it", () => {
    const { container } = render(<Markdown text={fence("realm-chart", BUNDLE)} />);
    const fills = new Set([...container.querySelectorAll("rect.chart-bar")].map((r) => r.getAttribute("fill")));
    expect(fills).toEqual(new Set(["var(--series-1)", "var(--series-2)"]));
    // Direct labels: a total over every column, in the short form the axis uses.
    expect([...container.querySelectorAll(".chart-value")].map((t) => t.textContent)).toEqual(["1.8K KB", "1.9K KB", "655 KB"]);
    expect(within(container.querySelector(".ui-block-head")!).getByText("Renderer bundle by release")).toBeInTheDocument();
    expect(container.querySelector(".chart-legend")?.textContent).toBe("App codeLibraries");
  });

  it("says what it shows to a reader who cannot see it", () => {
    const { container } = render(<Markdown text={fence("realm-chart", BUNDLE)} />);
    const svg = container.querySelector("svg.chart")!;
    const desc = container.querySelector(`#${CSS.escape(svg.getAttribute("aria-describedby")!)}`);
    expect(desc?.textContent).toBe("Columns: Renderer bundle by release, 3 labels from 1.0 to 1.2. "
      + "App code: 612 KB at 1.0 to 655 KB at 1.2, highest 655 KB at 1.2; Libraries: 1,210 KB at 1.0 to 1,214 KB at 1.1, highest 1,214 KB at 1.1.");
  });

  it("shows every exact value as a table one click away, a gap as a gap", () => {
    const { container } = render(<Markdown text={fence("realm-chart", BUNDLE)} />);
    const toggle = screen.getByRole("button", { name: "Values as a table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "Renderer bundle by release, as a table" });
    const rows = within(table).getAllByRole("row").map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent));
    expect(rows).toEqual([["", "App code", "Libraries", "Total"], ["1.0", "612 KB", "1,210 KB", "1,822 KB"], ["1.1", "640 KB", "1,214 KB", "1,854 KB"], ["1.2", "655 KB", "—", "655 KB"]]);
    expect(container.querySelector("svg.chart")).toBeNull();
  });

  it("breaks a line where a value was not reported, and names the lines", () => {
    const body = JSON.stringify({ kind: "lines", title: "Startup", unit: "ms", x: ["1.4", "1.5", "1.6", "1.7"],
      series: [{ label: "Cold", values: [820, null, 790, 760] }, { label: "Warm", values: [300, 290, 280, 270] }] });
    const { container } = render(<Markdown text={fence("realm-chart", body)} />);
    const cold = container.querySelectorAll('svg.chart g polyline[stroke="var(--series-1)"], svg.chart g circle[fill="var(--series-1)"]');
    // Two runs for Cold: a lone first point (a dot) and the line after the gap.
    expect(cold).toHaveLength(2);
    expect(container.querySelectorAll('polyline[stroke="var(--series-2)"]')).toHaveLength(1);
    expect([...container.querySelectorAll(".chart-end-label")].map((t) => t.textContent).sort()).toEqual(["Cold", "Warm"]);
  });

  it("draws bars and sparklines with the value beside each", () => {
    const bars = JSON.stringify({ kind: "bars", title: "Suite time", unit: "s", x: ["unit", "e2e"], series: [{ label: "Time", values: [12.5, null] }] });
    const { container, unmount } = render(<Markdown text={fence("realm-chart", bars)} />);
    expect([...container.querySelectorAll(".bd-bar-row")].map((r) => r.textContent)).toEqual(["unit12.5 s", "e2e—"]);
    unmount();
    const sparks = JSON.stringify({ kind: "sparkline", title: "Health", series: [{ label: "p95", unit: "ms", values: [3, 4, 2] }, { label: "Errors", values: [1, 0, 0] }] });
    const r2 = render(<Markdown text={fence("realm-chart", sparks)} />);
    expect([...r2.container.querySelectorAll(".ui-spark")].map((r) => r.textContent)).toEqual(["p952", "Errors0"]);
  });
});

describe("a body that is not a block", () => {
  it("stays the highlighted code it was, with the one-line reason in its head", () => {
    const broken = JSON.stringify({ kind: "lines", title: "Startup time", x: ["1.4", "1.5", "1.6"], series: [{ label: "Cold", values: [820, 790] }] });
    const { container } = render(<Markdown text={fence("realm-chart", broken)} />);
    expect(container.querySelector(".ui-block")).toBeNull();
    expect(container.querySelector(".md-block .md-code pre")?.textContent).toContain('"Cold"');
    expect(container.querySelector(".md-block-reason")?.textContent).toBe('Not drawn — "Cold" has 2 values for 3 x labels');
    // Still code you can copy: the panel's own button, untouched.
    expect(container.querySelector(".md-block .md-copy")).not.toBeNull();
    expect(container.querySelector(".hljs-attr")).not.toBeNull();
  });

  it("names a JSON mistake rather than drawing half of it", () => {
    const { container } = render(<Markdown text={fence("realm-compare", '{"options": ["A", "B"],}')} />);
    expect(container.querySelector(".md-block-reason")?.textContent).toMatch(/^Not drawn — not JSON: /);
  });
});

describe("a comparison", () => {
  it("sets the recommended column apart, and says so in words", () => {
    const { container } = render(<Markdown text={fence("realm-compare", DB)} />);
    const table = screen.getByRole("table", { name: "Where the session store lives, recommended: SQLite" });
    const head = within(table).getByRole("columnheader", { name: /SQLite/ });
    expect(head).toHaveAttribute("data-pick");
    expect(head.textContent).toBe("RecommendedSQLite");
    expect(within(table).getByRole("columnheader", { name: "Postgres" })).not.toHaveAttribute("data-pick");
    // The band runs down the whole column, every cell of it, and only that column.
    expect([...container.querySelectorAll("td[data-pick]")].map((c) => c.textContent)).toEqual(["A file", "Yes"]);
  });

  it("copies as a table that pastes as one, and as its source", async () => {
    render(<Markdown text={fence("realm-compare", DB)} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy, and more" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy table" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const item = writes[0] as { items: Record<string, Blob> };
    expect(await textOf(item.items["text/plain"]!)).toBe("| Where the session store lives | Postgres | SQLite (recommended) |\n| --- | --- | --- |\n| Setup | A server to run | A file |\n| Local | No | Yes |");
    expect(await textOf(item.items["text/html"]!)).toContain("<th>SQLite (recommended)</th>");
    // The menu leaves on its fade before the button can open it again.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Copy, and more" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy source" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toBe(DB);
  });

  it("shows its source under it on request, and keeps that choice through a re-render", async () => {
    const { container, rerender } = render(<Markdown text={fence("realm-compare", DB)} arrive />);
    fireEvent.click(screen.getByRole("button", { name: "Copy, and more" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show source" }));
    expect(container.querySelector(".ui-block")).toHaveAttribute("data-source");
    // A streamed delta rewrites the prose and remounts the block; the reader's choice survives it.
    rerender(<Markdown text={`${fence("realm-compare", DB)}\nMore prose.`} arrive />);
    expect(container.querySelector(".ui-block")).toHaveAttribute("data-source");
  });
});

describe("a diagram", () => {
  const HOSTILE = '<svg id="rlmmdsvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" style="max-width: 320px;" width="100%">'
    + '<title>Sign-in flow</title><style>#rlmmdsvg .actor{fill:#333} @import url(https://example.com/x.css);</style>'
    + '<script>alert(1)</script><a href="https://example.com"><g class="actor" onclick="alert(2)"><rect width="60" height="30"/><text>User</text></g></a>'
    + '<image href="https://example.com/x.png"/><foreignObject><div>html</div></foreignObject></svg>';

  it("asks Mermaid for strict mode, text labels and Realm's colours, none of which a diagram can change", async () => {
    mermaid.render.mockResolvedValue({ svg: HOSTILE, diagramType: "sequence" });
    render(<Markdown text={fence("mermaid", "sequenceDiagram\n  User->>Realm: Sign in")} />);
    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
    const config = mermaid.initialize.mock.calls[0]![0];
    expect(config).toMatchObject({ securityLevel: "strict", htmlLabels: false, theme: "base", look: "classic", startOnLoad: false, suppressErrorRendering: true });
    expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "theme", "themeVariables", "themeCSS", "look"]));
    // The palette is Realm's, slot by slot — never a hue Mermaid turned the wheel to.
    expect(config.themeVariables.pie1).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("puts Mermaid's drawing on screen only after the gate: no script, no link, no picture, no import", async () => {
    // THE MUTANT: insert `out.svg` as Mermaid returned it, and the script tag, the link and the
    // remote picture all reach the transcript.
    mermaid.render.mockResolvedValue({ svg: HOSTILE, diagramType: "sequence" });
    const { container } = render(<Markdown text={fence("mermaid", "sequenceDiagram\n  User->>Realm: Sign in, gated")} />);
    const svg = await waitFor(() => { const s = container.querySelector(".ui-diagram svg"); expect(s).not.toBeNull(); return s!; });
    expect(svg.outerHTML).not.toMatch(/<script|<a\b|onclick|example\.com|<image|foreignobject|@import/i);
    expect(svg.textContent).toContain("User");
    // A fresh id per copy on screen, so two copies never share a marker; the block takes the size.
    expect(svg.id).toMatch(/^rlmmd-\d+$/);
    expect(svg.getAttribute("style")).toBeNull();
    expect(container.querySelector(".ui-block-title")?.textContent).toBe("Sign-in flow");
    expect((container.querySelector(".ui-diagram") as HTMLElement).style.getPropertyValue("--diagram-w")).toBe("320px");
  });

  it("stays its source with Mermaid's reason when the syntax is wrong", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error on line 3:\n...A-->\n-----^\nExpecting 'NODE_STRING'"));
    const { container } = render(<Markdown text={fence("mermaid", "graph TD\n  A-->B\n  A-->")} />);
    await waitFor(() => expect(container.querySelector(".md-block-reason")?.textContent).toBe("Not drawn — Parse error on line 3"));
    expect(container.querySelector(".ui-block")).toBeNull();
  });

  it("gives up on a diagram that takes too long to lay out, and leaves the source", async () => {
    vi.useFakeTimers();
    try {
      mermaid.render.mockReturnValue(new Promise(() => {}));
      const { container } = render(<Markdown text={fence("mermaid", "graph TD\n  Slow-->Slower")} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(8_100); });
      expect(container.querySelector(".md-block-reason")?.textContent).toBe("Not drawn — took longer than 8 seconds to lay out");
      expect(container.querySelector(".ui-block")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
