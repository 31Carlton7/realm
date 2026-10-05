import type { DiffHunk } from "@realm/contracts";

/** One side of one row: a line of the old file (left) or the new one (right). */
export type SideCell = { line: number; text: string; kind: "context" | "add" | "del" };

/**
 * A row of a side-by-side diff.
 *
 * - `pair`: the two files side by side. A removed line with no added line to stand against is a
 *   pair with an empty right (`null`), drawn hatched, and the other way round — so the two columns
 *   stay in step and a reader can see what a line became.
 * - `band`: lines neither side changed, folded. `count` is how many; null for the run after the
 *   last hunk, whose length the patch does not say. `index` names the band so it can be opened.
 * - `note`: git's `\ No newline at end of file`, said once across both sides.
 */
export type SplitRow =
  | { kind: "pair"; key: string; left: SideCell | null; right: SideCell | null }
  | { kind: "band"; key: string; index: number; count: number | null; oldFrom: number; newFrom: number; at: "start" | "between" | "end" }
  | { kind: "note"; key: string; text: string };

/** The first line a hunk covers on one side. A side with no lines (`-5,0`, an insertion after line 5)
 *  names the line BEFORE it, which is the unified format's own convention. */
const first = (start: number, lines: number) => (lines === 0 ? start + 1 : start);
const after = (start: number, lines: number) => (lines === 0 ? start + 1 : start + lines);

/**
 * A file's hunks as side-by-side rows, with what lies between them folded into bands.
 *
 * Within a hunk the changed lines are paired in order: a run of removals against the run of additions
 * that replaced it, the longer run's tail against nothing. A context line ends the run, so pairs never
 * reach across an unchanged line.
 *
 * `open` names the bands to unfold and `headLines` is the new file's text to unfold them with — an
 * unchanged line reads the same on both sides, so the head alone fills both columns. A band opened
 * before the text has arrived stays a band until it has.
 *
 * `trailing` says whether the file goes on after its last hunk: an added or deleted file is all hunk,
 * and a band promising more of it would be a lie.
 */
export function splitRows(hunks: readonly DiffHunk[], opts: { open?: ReadonlySet<number>; headLines?: readonly string[] | null; trailing?: boolean } = {}): SplitRow[] {
  const rows: SplitRow[] = [];
  const open = opts.open ?? new Set<number>();
  const head = opts.headLines ?? null;
  let oldNext = 1, newNext = 1;

  const band = (index: number, count: number | null, at: "start" | "between" | "end") => {
    const fill = open.has(index) && head !== null;
    if (!fill) { rows.push({ kind: "band", key: `b${index}`, index, count, oldFrom: oldNext, newFrom: newNext, at }); return; }
    const n = count ?? Math.max(0, head.length - (newNext - 1));
    for (let i = 0; i < n; i++) {
      const text = head[newNext - 1 + i];
      if (text === undefined) break;
      const left = { line: oldNext + i, text, kind: "context" as const };
      rows.push({ kind: "pair", key: `b${index}.${i}`, left, right: { ...left, line: newNext + i } });
    }
  };

  hunks.forEach((h, hi) => {
    const gap = first(h.oldStart, h.oldLines) - oldNext;
    if (gap > 0) band(hi, gap, hi === 0 ? "start" : "between");
    let dels: SideCell[] = [], adds: SideCell[] = [];
    let n = 0;
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({ kind: "pair", key: `h${hi}.${n++}`, left: dels[i] ?? null, right: adds[i] ?? null });
      }
      dels = []; adds = [];
    };
    for (const l of h.lines) {
      if (l.kind === "del" && l.oldLine !== null) dels.push({ line: l.oldLine, text: l.text, kind: "del" });
      else if (l.kind === "add" && l.newLine !== null) adds.push({ line: l.newLine, text: l.text, kind: "add" });
      else if (l.kind === "context" && l.oldLine !== null && l.newLine !== null) {
        flush();
        rows.push({ kind: "pair", key: `h${hi}.${n++}`, left: { line: l.oldLine, text: l.text, kind: "context" }, right: { line: l.newLine, text: l.text, kind: "context" } });
      } else if (l.kind === "meta") { flush(); rows.push({ kind: "note", key: `h${hi}.${n++}`, text: l.text }); }
    }
    flush();
    oldNext = after(h.oldStart, h.oldLines);
    newNext = after(h.newStart, h.newLines);
  });

  if (hunks.length > 0 && opts.trailing !== false) {
    // With the head in hand, the trailing run has a length — and none at all means no band.
    const rest = head ? head.length - (newNext - 1) : null;
    if (rest === null || rest > 0) band(hunks.length, rest, "end");
  }
  return rows;
}

/** Where a line comment on `side:line` hangs: after the row that shows that line on that side. */
export const rowLineKey = (side: "LEFT" | "RIGHT", line: number): string => `${side}:${line}`;
export function rowKeys(row: SplitRow): string[] {
  if (row.kind !== "pair") return [];
  return [...(row.left ? [rowLineKey("LEFT", row.left.line)] : []), ...(row.right ? [rowLineKey("RIGHT", row.right.line)] : [])];
}
