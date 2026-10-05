import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine } from "@realm/contracts";
import { rowKeys, splitRows, type SplitRow } from "./split-rows";

/** A hunk from unified-diff body lines (" ", "-", "+", "\\"), numbered the way git numbers them. */
function hunk(oldStart: number, newStart: number, body: string[]): DiffHunk {
  let o = oldStart, n = newStart;
  const lines: DiffLine[] = body.map((raw) => {
    const text = raw.slice(1);
    if (raw[0] === "-") return { kind: "del", text, oldLine: o++, newLine: null };
    if (raw[0] === "+") return { kind: "add", text, oldLine: null, newLine: n++ };
    if (raw[0] === "\\") return { kind: "meta", text: text.trim(), oldLine: null, newLine: null };
    return { kind: "context", text, oldLine: o++, newLine: n++ };
  });
  const oldLines = body.filter((l) => l[0] === " " || l[0] === "-").length;
  const newLines = body.filter((l) => l[0] === " " || l[0] === "+").length;
  return { header: "", oldStart, oldLines, newStart, newLines, lines };
}

/** A row as a short string: `L|R`, each side `line:kind` or `·` for nothing; a band as `[count]`. */
const show = (rows: SplitRow[]) => rows.map((r) => r.kind === "band" ? `[${r.count ?? "?"}@${r.oldFrom}/${r.newFrom}]`
  : r.kind === "note" ? `(${r.text})`
    : `${r.left ? `${r.left.line}${r.left.kind[0]}` : "·"}|${r.right ? `${r.right.line}${r.right.kind[0]}` : "·"}`);

describe("side-by-side rows", () => {
  it("pairs a run of removals against the run that replaced it, the longer tail against nothing", () => {
    const rows = splitRows([hunk(10, 10, [" a", "-b", "-c", "-d", "+B", "+C", " e"])], { trailing: false });
    // THE MUTANT: pair by index across the whole hunk, so `e` lands beside `d`.
    expect(show(rows)).toEqual(["[9@1/1]", "10c|10c", "11d|11a", "12d|12a", "13d|·", "14c|13c"]);
  });

  it("never pairs across an unchanged line", () => {
    const rows = splitRows([hunk(1, 1, ["-a", " b", "+c"])], { trailing: false });
    expect(show(rows)).toEqual(["1d|·", "2c|1c", "·|2a"]);
  });

  it("folds what lies between hunks into a band that counts it, on both sides' numbering", () => {
    const rows = splitRows([hunk(1, 1, [" a", "-b", "+B"]), hunk(20, 20, [" t", "+u", " v"])], { trailing: false });
    // Lines 3–19 are untouched: seventeen of them, starting at line 3 on either side.
    expect(show(rows)).toEqual(["1c|1c", "2d|2a", "[17@3/3]", "20c|20c", "·|21a", "21c|22c"]);
  });

  it("numbers an insertion hunk by the line before it, as the unified format does", () => {
    // `@@ -5,0 +6,2 @@`: two lines added after line 5. Lines 1–5 are the leading band.
    const rows = splitRows([{ header: "", oldStart: 5, oldLines: 0, newStart: 6, newLines: 2, lines: [
      { kind: "add", text: "x", oldLine: null, newLine: 6 }, { kind: "add", text: "y", oldLine: null, newLine: 7 }] }], { trailing: false });
    expect(show(rows)).toEqual(["[5@1/1]", "·|6a", "·|7a"]);
  });

  it("promises more after the last hunk only where the file goes on", () => {
    const h = [hunk(1, 1, [" a", "+b"])];
    expect(show(splitRows(h)).at(-1)).toBe("[?@2/3]");
    expect(show(splitRows(h, { trailing: false })).some((r) => r.startsWith("["))).toBe(false);
    // An added file is all hunk: nothing leads it and nothing follows.
    const added = splitRows([{ header: "", oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [
      { kind: "add", text: "x", oldLine: null, newLine: 1 }, { kind: "add", text: "y", oldLine: null, newLine: 2 }] }], { trailing: false });
    expect(show(added)).toEqual(["·|1a", "·|2a"]);
  });

  it("opens a band from the head's lines, numbering each side where it stood", () => {
    const head = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const hunks = [hunk(4, 4, [" d", "-e", "+E", " f"]), hunk(20, 20, [" t"])];
    const rows = splitRows(hunks, { open: new Set([1]), headLines: head });
    const opened = rows.filter((r) => r.kind === "pair" && r.key.startsWith("b1."));
    expect(opened).toHaveLength(13); // lines 7–19
    expect(opened[0]).toMatchObject({ left: { line: 7, text: "line 7", kind: "context" }, right: { line: 7, text: "line 7" } });
    // The leading band (index 0) stays folded; the trailing one now knows its length: 21–30.
    expect(show(rows)[0]).toBe("[3@1/1]");
    expect(show(rows).at(-1)).toBe("[10@21/21]");
  });

  it("keeps an opened band folded until the head's text arrives, and drops a trailing band the head ends at", () => {
    const hunks = [hunk(4, 4, [" d"])];
    expect(show(splitRows(hunks, { open: new Set([0]) }))[0]).toBe("[3@1/1]");
    expect(show(splitRows(hunks, { headLines: ["a", "b", "c", "d"] }))).toEqual(["[3@1/1]", "4c|4c"]);
  });

  it("says git's missing-newline mark once, across both sides", () => {
    const rows = splitRows([hunk(1, 1, ["-a", "\\ No newline at end of file", "+a"])], { trailing: false });
    expect(show(rows)).toEqual(["1d|·", "(No newline at end of file)", "·|1a"]);
  });

  it("names the lines a row shows, per side, for the comments hung off it", () => {
    const [row] = splitRows([hunk(3, 3, ["-a", "+b"])], { trailing: false }).filter((r) => r.kind === "pair");
    expect(rowKeys(row!)).toEqual(["LEFT:3", "RIGHT:3"]);
  });
});
