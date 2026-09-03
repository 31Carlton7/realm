import FormulaParser from "fast-formula-parser";

/**
 * Formula evaluation for the sheet editor (Plan 17 W3), display-time only.
 *
 * The file stores formulas as literal cell text (`=SUM(A1:A5)`) and never stores computed values —
 * that is what keeps the CSV honest under git and agent edits. This module turns the raw grid into a
 * display grid on demand: raw cells pass through, formula cells evaluate against their neighbours.
 *
 * Shape of the engine: memoized recursion, not an explicit dependency graph. `fast-formula-parser`
 * hands back reference callbacks (`onCell`/`onRange`); resolving a reference recursively evaluates
 * that cell through the same memo. A whole-sheet pass is therefore one traversal, each cell computed
 * once, and the 2 MiB document ceiling keeps "recompute everything per edit" comfortably cheap —
 * an incremental dirty-graph would be real complexity spent on sheets this cap does not allow.
 *
 * Probed against the real library before writing (not assumed): coordinates are 1-based; evaluation
 * errors are RETURNED as FormulaError values (`_error` = "#DIV/0!"); parse failures and unknown
 * functions THROW. Both surfaces land in the same place here: the cell displays the error string.
 */

/** A cycle's display value. Every cell in the cycle shows it, not just the one that closed the loop. */
export const CYCLE_ERROR = "#CYCLE!";
const GENERIC_ERROR = "#ERROR!";

const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Raw cell text → the value a formula referencing it sees. */
export function coerce(raw: string | undefined): string | number | boolean | null {
  if (raw === undefined || raw === "") return null;
  const t = raw.trim();
  if (NUMBER_RE.test(t)) return parseFloat(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return raw;
}

export const isFormula = (raw: string | undefined): boolean => !!raw && raw.startsWith("=");

type Value = string | number | boolean | null;

/**
 * Evaluate every formula in the grid. Returns the DISPLAY grid: raw text for ordinary cells, the
 * computed value (or an error string) for formulas. The input grid is never mutated.
 */
export function evaluateSheet(rows: string[][]): string[][] {
  const memo = new Map<string, Value>();
  /** Cells currently being evaluated — a reference back into this set is a cycle. */
  const stack = new Set<string>();
  const key = (r: number, c: number) => `${r}:${c}`;

  // The parser calls back with 1-based coordinates.
  const cellValue = (row1: number, col1: number): Value => computed(row1 - 1, col1 - 1);

  const parser = new FormulaParser({
      onCell: ({ row, col }) => cellValue(row, col),
      onRange: ({ from, to }) => {
        // Clamped to the used grid: `=SUM(A:A)` style ranges arrive as huge rectangles, and blank
        // cells contribute nothing but the array cells would still have to be materialized.
        const maxRow = Math.min(to.row, rows.length);
        const maxCol = Math.min(to.col, Math.max(1, ...rows.map((r) => r.length)));
        const out: Value[][] = [];
        for (let r = from.row; r <= maxRow; r++) {
          const line: Value[] = [];
          for (let c = from.col; c <= maxCol; c++) line.push(cellValue(r, c));
          out.push(line);
        }
        return out;
      },
    });

  function computed(r: number, c: number): Value {
    const k = key(r, c);
    if (memo.has(k)) return memo.get(k)!;
    const raw = rows[r]?.[c];
    if (!isFormula(raw)) { const v = coerce(raw); memo.set(k, v); return v; }

    if (stack.has(k)) {
      // The loop just closed. Everyone on the stack is part of it (or feeding it mid-evaluation);
      // marking them all NOW is what makes each cell display #CYCLE! instead of only the one that
      // happened to be evaluated first — and it is also the termination proof: every marked cell is
      // memoized, and the memo check above ends the recursion.
      for (const inFlight of stack) memo.set(inFlight, CYCLE_ERROR);
      memo.set(k, CYCLE_ERROR);
      return CYCLE_ERROR;
    }

    stack.add(k);
    let value: Value;
    try {
      const result = parser.parse(raw!.slice(1).trim(), { sheet: "S", row: r + 1, col: c + 1 });
      value = (result as { _error?: string })?._error ?? (result as Value);
    } catch (e) {
      value = (e as { _error?: string })?._error ?? GENERIC_ERROR;
    } finally {
      stack.delete(k);
    }
    // A cycle discovered underneath this cell already fixed its display; the computed value (built
    // from a half-evaluated loop) must not overwrite it.
    if (memo.get(k) === CYCLE_ERROR) return CYCLE_ERROR;
    memo.set(k, value);
    return value;
  }

  return rows.map((row, r) => row.map((raw, c) => {
    if (!isFormula(raw)) return raw;
    return display(computed(r, c));
  }));
}

/** Computed value → cell text. Booleans upper-case like every spreadsheet; null renders empty. */
export function display(v: Value): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  return String(v);
}
