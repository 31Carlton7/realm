import Papa from "papaparse";

/**
 * CSV/TSV ⇄ grid for the sheet editor (Plan 17 W3).
 *
 * Same contract as the markdown model, one level down: the FILE is the document, the grid is a view,
 * and an edit's diff must be the size of the edit. The mechanism is W2's proven one at row
 * granularity — every row remembers the exact source line(s) it was parsed from and gives them back
 * verbatim on serialize; only rows the user actually edited are re-serialized canonically. A file
 * whose author quotes every field, or quotes none, keeps its style on every line you didn't touch.
 *
 * Formulas are not special here: `=SUM(A1:A5)` is cell TEXT, stored in the file exactly as written.
 * Computing it is `formulas.ts`'s job, display-time only — the file never contains computed values,
 * which is what keeps the CSV honest under git and agent edits.
 */
export type Sheet = {
  /** Raw cell text, formulas included. Ragged: rows keep their parsed length. */
  rows: string[][];
  /** Per row: the exact source text it came from, or null once edited (serialize canonically). */
  rowSources: (string | null)[];
  delimiter: "," | "\t";
  /** The file's line ending, detected once. A mixed-EOL file is normalized to the dominant one. */
  eol: "\n" | "\r\n";
  /** Whether the file ended with a newline; preserved so a save is not a one-byte diff. */
  trailingNewline: boolean;
};

/**
 * Split raw CSV text into RECORD strings — the row-source half papaparse does not provide (it parses
 * cells but reports no byte ranges). Only quote state matters for record boundaries, so this scanner
 * is small and total: a quoted field may contain newlines and `""` escapes, and a record ends at an
 * unquoted newline. The `\r` of a CRLF ending is stripped from the record — the Sheet's single `eol`
 * re-applies it on serialize, which is also what quietly normalizes a mixed-EOL file.
 */
function scanRecords(text: string): { records: string[]; terminated: boolean } {
  const records: string[] = [];
  let start = 0, inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "\n" && !inQuotes) {
      const end = text[i - 1] === "\r" ? i - 1 : i;
      records.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) records.push(text.slice(start));
  // Terminated = every record ended at an unquoted newline. This is NOT `text.endsWith("\n")`: an
  // unterminated quote can swallow the file's final newline INTO the last record, and counting that
  // newline again as a trailing terminator would grow the file by one byte per save.
  return { records, terminated: text.length > 0 && start >= text.length };
}

export function splitRecords(text: string): string[] {
  return scanRecords(text).records;
}

/** Extension decides the delimiter — `documentKindFor` already routed on it, and auto-detection that
 *  guesses differently from the router would save a comma-ful TSV as something else entirely. */
export function delimiterFor(path: string): "," | "\t" {
  return path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}

export function parseSheet(text: string, delimiter: "," | "\t"): Sheet {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  if (text === "") return { rows: [], rowSources: [], delimiter, eol, trailingNewline: true };
  const parsed = Papa.parse<string[]>(text, { delimiter, newline: eol });
  // papaparse reports a trailing newline as one final empty record; that is file shape, not a row.
  const rows = parsed.data.filter((r, i) => i < parsed.data.length - 1 || !(r.length === 1 && r[0] === ""));
  const { records: sources, terminated } = scanRecords(text);
  // The scanner and papaparse must agree on the record count for per-row preservation to be safe.
  // When they do not (malformed quoting parses differently than it scans), preservation is dropped
  // for the whole file rather than risk attaching row N's bytes to row N+1's cells.
  const aligned = sources.length === rows.length;
  return {
    rows,
    rowSources: rows.map((_r, i) => (aligned ? sources[i] ?? null : null)),
    delimiter,
    eol,
    trailingNewline: terminated,
  };
}

/** Canonical field: quoted only when the content forces it. `""` escapes an embedded quote. */
export function serializeField(value: string, delimiter: string): string {
  const needsQuote = value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r");
  return needsQuote ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeSheet(sheet: Sheet): string {
  const lines = sheet.rows.map((row, i) => {
    const kept = sheet.rowSources[i];
    if (kept !== null && kept !== undefined) return kept;
    return row.map((cell) => serializeField(cell, sheet.delimiter)).join(sheet.delimiter);
  });
  if (lines.length === 0) return "";
  return lines.join(sheet.eol) + (sheet.trailingNewline ? sheet.eol : "");
}

/**
 * Write one cell. Out-of-range coordinates GROW the sheet — typing into the blank row/column below a
 * grid's edge is how spreadsheets add rows, and refusing it would make the grid feel read-only at its
 * borders. New rows serialize canonically (there is no source to preserve); the edited row loses its
 * preserved source, which is the entire mechanism.
 */
export function setCell(sheet: Sheet, r: number, c: number, value: string): Sheet {
  const rows = sheet.rows.map((row) => [...row]);
  const rowSources = [...sheet.rowSources];
  while (rows.length <= r) { rows.push([]); rowSources.push(null); }
  const row = rows[r]!;
  while (row.length <= c) row.push("");
  if (row[c] === value) return sheet;
  row[c] = value;
  rowSources[r] = null;
  return { ...sheet, rows, rowSources };
}

/** The grid's rectangular shape: max row length (min 1), so ragged files render as a full grid. */
export function columnCount(sheet: Sheet): number {
  return Math.max(1, ...sheet.rows.map((r) => r.length));
}

/** 0-based column index → spreadsheet name: 0→A, 25→Z, 26→AA. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}
