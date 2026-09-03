import { describe, expect, it } from "vitest";
import {
  diffLines, fileDiff, fileDiffsFor, hunkEmphasis, isUnifiedDiff, pairEmphasis,
  parseUnifiedDiff, splitLines, toHunks,
} from "./diff";

/** A diff as a compact string, one line per row: `+`/`-`/` ` then the text. Comparing these rather
 *  than object literals keeps the expectations readable as the diffs they describe. */
const shape = (lines: { kind: string; text: string }[]) =>
  lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n");

describe("splitLines", () => {
  it("counts lines the way a diff does: empty is nothing, a trailing newline invents nothing", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("\n")).toEqual([""]);
  });
});

describe("diffLines", () => {
  it("keeps unchanged lines as context and marks only what moved", () => {
    expect(shape(diffLines("one\ntwo\nthree", "one\nTWO\nthree"))).toBe(" one\n-two\n+TWO\n three");
  });

  it("numbers each side independently — a deletion advances the old side only", () => {
    const lines = diffLines("a\nb\nc", "a\nc");
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1], ["del", 2, null], ["ctx", 3, 2],
    ]);
  });

  it("an empty side is a pure insertion or a pure deletion", () => {
    expect(shape(diffLines("", "x\ny"))).toBe("+x\n+y");
    expect(shape(diffLines("x\ny", ""))).toBe("-x\n-y");
    expect(diffLines("same", "same")).toEqual([{ kind: "ctx", text: "same", oldNo: 1, newNo: 1 }]);
  });

  it("finds the common subsequence rather than replacing wholesale", () => {
    // The shared `keep` lines must survive as context; a naive prefix/suffix diff would delete and
    // re-add them, and the card would claim a five-line change where one line moved.
    expect(shape(diffLines("keep1\nold\nkeep2", "keep1\nnew\nkeep2"))).toBe(" keep1\n-old\n+new\n keep2");
    expect(shape(diffLines("a\nb\nc\nd", "a\nc"))).toBe(" a\n-b\n c\n-d");
  });
});

describe("toHunks", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");

  it("keeps three lines of context either side and elides the rest, counting what it elided", () => {
    const hunks = toHunks(diffLines(lines(30), lines(30).replace("l15", "CHANGED")));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.skipped).toBe(11); // lines 1..11 before the l12 context line
    expect(shape(hunks[0]!.lines)).toBe(" l12\n l13\n l14\n-l15\n+CHANGED\n l16\n l17\n l18");
  });

  it("changes closer together than two context spans stay ONE hunk", () => {
    const after = lines(30).replace("l10", "X").replace("l14", "Y");
    expect(toHunks(diffLines(lines(30), after))).toHaveLength(1);
  });

  it("changes further apart split, and the second hunk reports the gap", () => {
    const after = lines(40).replace("l5", "X").replace("l30", "Y");
    const hunks = toHunks(diffLines(lines(40), after));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.skipped).toBe(1);
    expect(hunks[1]!.skipped).toBe(18); // l9..l26 between the two context windows
  });

  it("a diff with no changes has no hunks at all", () => {
    expect(toHunks(diffLines("a\nb", "a\nb"))).toEqual([]);
  });
});

describe("parseUnifiedDiff", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 111..222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ export function app() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
  ].join("\n");

  it("takes the line numbers from the @@ header rather than recomputing them", () => {
    const [file] = parseUnifiedDiff(patch);
    expect(file!.path).toBe("src/app.ts");
    expect(file!.numbered).toBe(true);
    expect(file!.add).toBe(2);
    expect(file!.del).toBe(1);
    expect(file!.hunks[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 10, 10], ["del", 11, null], ["add", null, 11], ["add", null, 12], ["ctx", 12, 13],
    ]);
  });

  it("the first hunk's gap is measured from the top of the file", () => {
    expect(parseUnifiedDiff(patch)[0]!.hunks[0]!.skipped).toBe(9);
  });

  it("splits a multi-file patch on its file markers", () => {
    const two = `${patch}\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y`;
    expect(parseUnifiedDiff(two).map((f) => f.path)).toEqual(["src/app.ts", "b.ts"]);
  });

  it("names a created file from the +++ side, since --- is /dev/null", () => {
    const created = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two";
    const [file] = parseUnifiedDiff(created);
    expect(file!.path).toBe("new.ts");
    expect([file!.add, file!.del]).toEqual([2, 0]);
  });

  it("carries a binary change as a note rather than dropping the file", () => {
    const [file] = parseUnifiedDiff("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ");
    expect(file!.path).toBe("logo.png");
    expect(file!.note).toBe("Binary file");
  });

  it("ignores the no-newline marker instead of reading it as a deletion", () => {
    const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b");
    expect(shape(file!.hunks[0]!.lines)).toBe("-a\n+b");
  });

  it("returns nothing for text that only looks diff-ish", () => {
    expect(parseUnifiedDiff("nothing to see")).toEqual([]);
  });
});

describe("isUnifiedDiff", () => {
  it("needs both a hunk header and a file marker", () => {
    expect(isUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(isUnifiedDiff("@@ -1 +1 @@\n-a\n+b")).toBe(false);            // a log full of @@ is not a diff
    expect(isUnifiedDiff("--- separator ---\n+++ another")).toBe(false); // prose punctuation is not a diff
    expect(isUnifiedDiff("ls -la\ntotal 8")).toBe(false);
  });
});

describe("fileDiffsFor", () => {
  it("an Edit diffs its own two fragments and refuses file line numbers for them", () => {
    const [file] = fileDiffsFor("Edit", { file_path: "/a.ts", old_string: "one\ntwo", new_string: "one\nTWO" })!;
    expect(file!.numbered).toBe(false);
    expect(file!.path).toBe("/a.ts");
    expect(shape(file!.hunks[0]!.lines)).toBe(" one\n-two\n+TWO");
  });

  it("a MultiEdit becomes one card per file, one hunk per edit", () => {
    const [file] = fileDiffsFor("MultiEdit", {
      file_path: "/a.ts",
      edits: [{ old_string: "a", new_string: "A" }, { old_string: "b", new_string: "B" }],
    })!;
    expect(file!.hunks).toHaveLength(2);
    expect([file!.add, file!.del]).toEqual([2, 2]);
  });

  it("a Write is all additions, numbered from 1 — the file's own numbering, and no invented deletions", () => {
    const [file] = fileDiffsFor("Write", { file_path: "/new.ts", content: "l1\nl2" })!;
    expect(file!.numbered).toBe(true);
    expect([file!.add, file!.del]).toEqual([2, 0]);
    expect(file!.hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it("an apply_patch parses the patch it was given rather than re-diffing it", () => {
    const files = fileDiffsFor("apply_patch", {
      changes: [{ path: "/a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,2 @@\n-old\n+new\n ctx" }],
    })!;
    expect(files[0]!.numbered).toBe(true);
    expect(files[0]!.hunks[0]!.lines[0]!.oldNo).toBe(3);
  });

  it("an apply_patch change with no patch body is still listed, as a note", () => {
    const files = fileDiffsFor("apply_patch", { changes: [{ path: "/a.ts" }] })!;
    expect(files[0]).toMatchObject({ path: "/a.ts", note: "No diff provided", hunks: [] });
  });

  it("returns null wherever the payload cannot support a diff", () => {
    expect(fileDiffsFor("Edit", { file_path: "/a.ts" })).toBeNull();  // a permission preview
    expect(fileDiffsFor("Read", { file_path: "/a.ts" })).toBeNull();
    expect(fileDiffsFor("Bash", { command: "ls" })).toBeNull();
    expect(fileDiffsFor("MultiEdit", { edits: "nope" })).toBeNull();
  });

  it("draws the change even when the payload never named the file", () => {
    // The path is the card's title, not its evidence. Dropping the whole diff over a missing title
    // would hide the change a permission prompt exists to show.
    const [file] = fileDiffsFor("Edit", { old_string: "a", new_string: "b" })!;
    expect(file!.path).toBe("");
    expect(shape(file!.hunks[0]!.lines)).toBe("-a\n+b");
  });
});

describe("intra-line emphasis", () => {
  it("marks the middle that changed, keeping the shared prefix and suffix out of it", () => {
    const e = pairEmphasis("const timeout = 30;", "const timeout = 60;")!;
    expect("const timeout = 30;".slice(e.del.start, e.del.end)).toBe("3");
    expect("const timeout = 60;".slice(e.add.start, e.add.end)).toBe("6");
  });

  it("declines when the two lines share too little to be one line edited", () => {
    expect(pairEmphasis("completely different", "nothing alike here")).toBeNull();
    expect(pairEmphasis("same", "same")).toBeNull();
  });

  it("only pairs a lone deletion with the lone insertion that follows it", () => {
    const paired = hunkEmphasis(diffLines("const a = 1;", "const a = 2;"));
    expect([...paired.keys()]).toEqual([0, 1]);
    // Two-for-two has no line-to-line correspondence to draw, so nothing is marked.
    expect(hunkEmphasis(diffLines("aaa\nbbb", "xxx\nyyy")).size).toBe(0);
  });
});

describe("fileDiff", () => {
  it("counts add and del off the hunks it kept, so the header and the body cannot disagree", () => {
    const f = fileDiff("/x", "a\nb\nc", "a\nB\nc\nd", false);
    expect([f.add, f.del]).toEqual([2, 1]);
    expect(f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0)).toBe(f.add);
  });
});
