import type { PdfTextRun } from "./pdf-source";

/**
 * Find in a PDF, as numbers: where a query falls in a page's runs of text.
 *
 * A page's text is its runs end to end, a space where a run ends a line, so a phrase that wraps is
 * still found. A hit is a list of pieces — a run and a span of its characters — because a phrase can
 * cross from one run into the next, and the text layer draws one span per run.
 */
export type HitPiece = { run: number; start: number; end: number };
export type PdfHit = { page: number; pieces: HitPiece[] };

/** Case is ignored, and so is how many spaces a PDF happened to put between two words. */
const fold = (s: string): string => s.toLowerCase();

export function findInPage(page: number, runs: readonly PdfTextRun[], query: string): PdfHit[] {
  const q = fold(query.trim().replace(/\s+/g, " "));
  if (!q) return [];
  // The page as one string, and for every character of it the run and offset it came from — null for
  // a space put in where a line ended.
  let text = "";
  const from: ({ run: number; at: number } | null)[] = [];
  runs.forEach((r, run) => {
    for (let at = 0; at < r.str.length; at++) {
      // Two spaces in a row are one for matching, as they are in the query.
      const ch = /\s/.test(r.str[at]!) ? " " : r.str[at]!;
      if (ch === " " && text.endsWith(" ")) continue;
      // Folded a character at a time: a lowercase can be longer than its capital, and every character
      // of the folded text has to say which character of the run it came from.
      for (const c of fold(ch)) { text += c; from.push({ run, at }); }
    }
    if (r.eol && !text.endsWith(" ")) { text += " "; from.push(null); }
  });
  const hits: PdfHit[] = [];
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
    const pieces: HitPiece[] = [];
    for (let k = i; k < i + q.length; k++) {
      const c = from[k];
      if (!c) continue;
      const last = pieces[pieces.length - 1];
      if (last && last.run === c.run) last.end = c.at + 1;
      else pieces.push({ run: c.run, start: c.at, end: c.at + 1 });
    }
    if (pieces.length > 0) hits.push({ page, pieces });
  }
  return hits;
}

/** "2 of 17", or what the field says when there is nothing to count yet. */
export function findLabel(current: number, total: number, searching: boolean): string {
  if (total === 0) return searching ? "Searching…" : "No matches";
  return `${current + 1} of ${total}`;
}
