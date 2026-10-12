/**
 * The pure halves of Review's renderers: a CSV or TSV read into rows, and a list of links read into
 * what each one points at. Kept apart from the drawing so a test reads them without a DOM.
 */

/** Rows of a delimited file, quotes honoured (`"a, b"` is one cell, `""` inside one is a quote). A
 *  trailing blank line is not a row. */
export function parseDelimited(text: string, sep: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") { quoted = true; continue; }
    if (ch === sep) { row.push(cell); cell = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** A column whose every filled cell is a number (money and percentages included) aligns right, with
 *  its head, so the digits line up (design.md: headers align with representative cells). */
export function numericColumns(rows: string[][]): boolean[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const NUM = /^[-+]?[$€£]?\s?\d[\d,]*(\.\d+)?\s?%?$/;
  return Array.from({ length: width }, (_, c) => {
    const cells = rows.slice(1).map((r) => (r[c] ?? "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((v) => NUM.test(v));
  });
}

export type ReviewLink = { url: string; title: string | null; host: string; path: string };

/**
 * The links a body or a `.links.md` file lists, one to a line: `[Title](https://…)`, `<https://…>` or
 * a bare URL, as a list item or not. A link is named by its own title where the line gave one —
 * never by a title Realm made up — and otherwise by its host and path (design.md: a link is shown as
 * what it points at, and a wrong name is worse than the URL).
 */
export function parseLinks(text: string): ReviewLink[] {
  const out: ReviewLink[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    if (!line) continue;
    const md = /^\[([^\]]*)\]\((\S+?)\)/.exec(line);
    const bare = /<?(https?:\/\/[^\s>]+)>?/.exec(line);
    const url = md?.[2] ?? bare?.[1];
    if (!url) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const path = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    out.push({ url: parsed.href, title: md?.[1]?.trim() || null, host: parsed.host.replace(/^www\./, ""), path });
  }
  return out;
}
