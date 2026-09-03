/** Diff model behind the transcript's file-change cards (AICSS "File Diff").
 *
 *  Two sources feed it and they carry different amounts of truth, which is the whole reason this
 *  module exists rather than a `<pre>`:
 *
 *  - A unified diff STRING (Codex's `apply_patch` changes, `git diff` in a Bash result) already
 *    knows where in the file it sits — its `@@` headers carry real line numbers.
 *  - An `Edit`'s payload carries both sides of a FRAGMENT and nothing else. The fragment's position
 *    in the file is unknown, so its lines get no numbers at all: a gutter counting 1, 2, 3 from the
 *    top of the fragment would be read as file lines, and inventing those is a lie the reader has
 *    no way to catch.
 *
 *  `numbered` is that distinction, carried to the renderer.
 */

export type LineKind = "add" | "del" | "ctx";
/** `oldNo`/`newNo` are the line's position on each side, or null where the source did not know it. */
export type DiffLine = { kind: LineKind; text: string; oldNo: number | null; newNo: number | null };
/** `skipped` is how many unchanged lines were elided immediately before this hunk (0 for the first
 *  hunk of a file, or when the hunks are adjacent). It is what the "⋯ 42 unchanged lines" rail says. */
export type DiffHunk = { lines: DiffLine[]; skipped: number };
export type FileDiff = {
  path: string;
  hunks: DiffHunk[];
  add: number;
  del: number;
  /** Whether the line numbers are the FILE's own. False for fragment edits; the gutter goes blank. */
  numbered: boolean;
  /** A change with no renderable text: `Binary files … differ`, a rename with no content change. */
  note?: string;
};

/** Context lines kept either side of a change. Three is `git diff`'s default and the number every
 *  reader's eye is already calibrated to. */
export const CONTEXT = 3;

/** Above this many cells the LCS table is not worth building (a 2000×2000 diff is 4M cells and
 *  ~32MB of backpointers). Past it the middle section degrades to a straight replace, which is what
 *  a whole-file rewrite looks like anyway. */
const LCS_CELL_LIMIT = 4_000_000;

/** Lines the way a diff counts them: "" is zero lines, and a trailing newline does not invent one. */
export function splitLines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n");
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Longest-common-subsequence line diff, prefix/suffix-trimmed first.
 *
 *  Trimming is not just an optimisation: an Edit usually changes one line inside a fragment that is
 *  otherwise identical on both sides, and the trim alone reduces that to a table small enough that
 *  the cell limit never comes near. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before), b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  let oldNo = 1, newNo = 1;
  const ctx = (text: string) => out.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  const del = (text: string) => out.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
  const add = (text: string) => out.push({ kind: "add", text, oldNo: null, newNo: newNo++ });

  for (let i = 0; i < head; i++) ctx(a[i]!);
  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    for (const l of midA) del(l);
    for (const l of midB) add(l);
  } else {
    // Standard LCS length table; walked forward from (0,0) so deletions precede insertions at every
    // divergence — the order every diff tool prints and the order the paired-line emphasis below
    // depends on.
    const n = midA.length, m = midB.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ctx(midA[i]!); i++; j++; }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) { del(midA[i]!); i++; }
      else { add(midB[j]!); j++; }
    }
    while (i < n) del(midA[i++]!);
    while (j < m) add(midB[j++]!);
  }
  for (let i = 0; i < tail; i++) ctx(a[a.length - tail + i]!);
  return out;
}

/** Changed lines plus `context` either side, with the unchanged stretches between them elided.
 *  A file whose changes are all within 2×context of each other stays one hunk — splitting it would
 *  put a "⋯ 2 unchanged lines" rail through the middle of something the reader reads as one edit. */
export function toHunks(lines: readonly DiffLine[], context = CONTEXT): DiffHunk[] {
  const changed = lines.map((l) => l.kind !== "ctx");
  if (!changed.some(Boolean)) return [];
  const keep = lines.map((_, i) => {
    for (let d = -context; d <= context; d++) if (changed[i + d]) return true;
    return false;
  });
  const hunks: DiffHunk[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) { skipped++; continue; }
    let end = i;
    while (end < lines.length && keep[end]) end++;
    hunks.push({ lines: lines.slice(i, end), skipped });
    skipped = 0;
    i = end - 1;
  }
  return hunks;
}

const counts = (hunks: readonly DiffHunk[]) => {
  let add = 0, del = 0;
  for (const h of hunks) for (const l of h.lines) { if (l.kind === "add") add++; else if (l.kind === "del") del++; }
  return { add, del };
};

/** A FileDiff from two whole strings (or two fragments — see `numbered`). */
export function fileDiff(path: string, before: string, after: string, numbered: boolean): FileDiff {
  const hunks = toHunks(diffLines(before, after));
  return { path, hunks, ...counts(hunks), numbered };
}

/* ── Unified diff parsing ────────────────────────────────────────────────────
 * `apply_patch` hands Realm a real unified diff per changed file, and agents print `git diff` into
 * Bash results constantly. Both already contain the line numbers, so they are parsed rather than
 * recomputed — re-diffing text we were handed a diff of could disagree with the tool that made it. */

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** True when `text` looks like a unified diff rather than ordinary command output. Deliberately
 *  strict: one `@@ -a,b +c,d @@` header AND a file marker, because a stray "@@" in a log must not
 *  turn a Bash result into a diff card. */
export function isUnifiedDiff(text: string): boolean {
  let header = false, marker = false;
  for (const line of text.split("\n", 400)) {
    if (HUNK_HEADER.test(line)) header = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) marker = true;
    if (header && marker) return true;
  }
  return false;
}

/** Strips git's `a/` / `b/` prefixes; `/dev/null` (an add or a delete) yields "". */
const cleanPath = (p: string): string => {
  const path = p.replace(/\t.*$/, "").trim();
  if (path === "/dev/null") return "";
  return /^[ab]\//.test(path) ? path.slice(2) : path;
};

/** Every file in a unified diff, hunks and line numbers as the diff itself states them.
 *  Unparseable input yields [] rather than a half-diff — the caller then shows the raw text, which
 *  is always better than a diff card missing lines the reader cannot know are missing. */
export function parseUnifiedDiff(text: string, fallbackPath = ""): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0, newNo = 0, prevEnd = 0;
  const open = (path: string): FileDiff => {
    file = { path, hunks: [], add: 0, del: 0, numbered: true };
    files.push(file);
    hunk = undefined;
    prevEnd = 0;
    return file;
  };

  for (const line of text.split("\n")) {
    const h = HUNK_HEADER.exec(line);
    if (h) {
      const f = file ?? open(fallbackPath);
      oldNo = Number(h[1]); newNo = Number(h[3]);
      // The elision rail counts from where the previous hunk stopped: a first hunk starting at line
      // 1 skipped nothing, one starting at 40 skipped 39.
      hunk = { lines: [], skipped: Math.max(0, newNo - prevEnd - 1) };
      f.hunks.push(hunk);
      prevEnd = newNo + (h[4] === undefined ? 1 : Number(h[4])) - 1;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (\S+) (\S+)/.exec(line);
      open(cleanPath(m?.[2] ?? "") || cleanPath(m?.[1] ?? "") || fallbackPath);
      continue;
    }
    // `--- ` opens a file only when one is not already open on its `diff --git` line; a second
    // `--- ` after hunks have landed is the next file in a multi-file patch. `/dev/null` on either
    // marker (an add or a delete) yields "", and the other marker supplies the name.
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const path = cleanPath(line.slice(4));
      if (!file || (line.startsWith("--- ") && file.hunks.length > 0)) open(path || fallbackPath);
      else if (path && !file.path) file.path = path;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      (file ?? open(fallbackPath)).note = "Binary file";
      continue;
    }
    if (!file || !hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file" annotates, it is not a line
    const body = line.slice(1);
    if (line.startsWith("+")) { hunk.lines.push({ kind: "add", text: body, oldNo: null, newNo: newNo++ }); file.add++; }
    else if (line.startsWith("-")) { hunk.lines.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null }); file.del++; }
    else if (line.startsWith(" ") || line === "") hunk.lines.push({ kind: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
    else hunk = undefined; // a trailer (git's "-- ", a summary line): the hunk is over, the file is not
  }
  return files.filter((f) => f.hunks.length > 0 || f.note);
}

/* ── Tool payloads → diffs ───────────────────────────────────────────────── */

const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);

/** The file changes a tool call is about to make, or null when the tool is not a file edit or its
 *  payload does not carry enough to draw one. Null means "fall back to the raw input well" — never
 *  an empty diff, which would read as "this changed nothing".
 *
 *  Every branch is derived from the call's OWN input, so the card shows what the agent asked for,
 *  which is exactly what a permission prompt needs to be about. */
export function fileDiffsFor(name: string, input: Record<string, unknown>): FileDiff[] | null {
  switch (name) {
    case "Edit": {
      const before = str(input, "old_string"), after = str(input, "new_string");
      if (before === null || after === null) return null;
      // The path is the card's title, not its evidence: a permission preview sometimes carries the
      // strings without one, and a diff of a file we cannot name still shows the change exactly.
      return [fileDiff(str(input, "file_path") ?? "", before, after, false)];
    }
    case "MultiEdit": {
      const edits = input["edits"];
      if (!Array.isArray(edits)) return null;
      const path = str(input, "file_path") ?? "";
      // The edits apply in sequence to one file, and we have no file to apply them to — so each is
      // its own hunk of one FileDiff rather than one diff per edit. The reader sees one card per
      // file, which is the unit they think in.
      const hunks: DiffHunk[] = [];
      for (const e of edits) {
        if (!e || typeof e !== "object") continue;
        const before = str(e as Record<string, unknown>, "old_string"), after = str(e as Record<string, unknown>, "new_string");
        if (before === null || after === null) continue;
        for (const h of toHunks(diffLines(before, after))) hunks.push({ ...h, skipped: 0 });
      }
      if (hunks.length === 0) return null;
      return [{ path, hunks, ...counts(hunks), numbered: false }];
    }
    case "Write": {
      const content = str(input, "content");
      if (content === null) return null;
      const path = str(input, "file_path") ?? "";
      // A Write states the file's whole new contents, so its numbering IS the file's — but it says
      // nothing about what was there before, so every line is an add and the card never claims a
      // deletion count it cannot know.
      const lines: DiffLine[] = splitLines(content).map((text, i) => ({ kind: "add" as const, text, oldNo: null, newNo: i + 1 }));
      return [{ path, hunks: lines.length ? [{ lines, skipped: 0 }] : [], add: lines.length, del: 0, numbered: true, ...(lines.length ? {} : { note: "Empty file" }) }];
    }
    case "NotebookEdit": {
      const source = str(input, "new_source");
      if (source === null) return null;
      const path = str(input, "notebook_path") ?? "";
      const old = str(input, "old_source");
      // A cell's position in the notebook is not a file line number, so these are never numbered.
      const cell = str(input, "cell_id");
      const d = fileDiff(path, old ?? "", source, false);
      return [{ ...d, ...(cell ? { path: `${path} · cell ${cell}` } : {}) }];
    }
    case "apply_patch": {
      const changes = input["changes"];
      if (!Array.isArray(changes)) return null;
      const out: FileDiff[] = [];
      for (const c of changes) {
        if (!c || typeof c !== "object") continue;
        const bag = c as Record<string, unknown>;
        const path = str(bag, "path") ?? "";
        const diff = str(bag, "diff");
        if (diff) out.push(...parseUnifiedDiff(diff, path));
        // A fileChange with no diff body (Codex sends these for adds it summarises elsewhere) is
        // still worth a row: the file was touched, and saying nothing about it would hide that.
        else out.push({ path, hunks: [], add: 0, del: 0, numbered: true, note: "No diff provided" });
      }
      return out.length ? out : null;
    }
    default: return null;
  }
}

/* ── Intra-line emphasis ─────────────────────────────────────────────────── */

/** The part of one line that differs from its counterpart: `[start, end)` in character offsets. */
export type Span = { start: number; end: number };

/** For a del/add pair that are variations of one line, the spans that actually differ: the common
 *  prefix and suffix are trimmed off and the middles are what get tinted.
 *
 *  Returns null when the pair share too little to be "the same line, edited" (under a quarter of the
 *  shorter line in common) — highlighting nearly the whole line is the same as highlighting none of
 *  it, and it makes a wholly replaced line look like a fiddled one. */
export function pairEmphasis(del: string, add: string): { del: Span; add: Span } | null {
  if (del === add) return null;
  const max = Math.min(del.length, add.length);
  let start = 0;
  while (start < max && del[start] === add[start]) start++;
  let end = 0;
  while (end < max - start && del[del.length - 1 - end] === add[add.length - 1 - end]) end++;
  const common = start + end;
  if (common === 0 || common * 4 < max) return null;
  return { del: { start, end: del.length - end }, add: { start, end: add.length - end } };
}

/** Emphasis spans by line index, for the lines of one hunk. Only where exactly one deletion is
 *  immediately followed by exactly one insertion: a 3-for-2 replacement has no line-to-line
 *  correspondence to draw, and guessing one puts tint on lines that were never edited that way. */
export function hunkEmphasis(lines: readonly DiffLine[]): Map<number, Span> {
  const out = new Map<number, Span>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "del" || lines[i + 1]?.kind !== "add") continue;
    if (lines[i - 1]?.kind === "del" || lines[i + 2]?.kind === "add") { i++; continue; }
    const e = pairEmphasis(lines[i]!.text, lines[i + 1]!.text);
    if (e) { out.set(i, e.del); out.set(i + 1, e.add); }
    i++;
  }
  return out;
}
