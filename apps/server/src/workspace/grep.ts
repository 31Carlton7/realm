import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PROJECT_FILES_LIMIT, PROJECT_GREP_LIMIT_MAX, rankPaths } from "@realm/contracts";
import type { ProjectFileList, ProjectFilesResult, ProjectGrepHit, ProjectGrepResult } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { gitCapture, type GitRun } from "./git-exec";

/**
 * Search a CHECKOUT: `project.grep` (what text is in these files) and `project.files` (what files
 * are here). The editor's ⌘⇧F and ⌘P, against the working tree an environment points at.
 *
 * **Why git does the work.** `git grep` already knows which files are text, which are ignored and
 * which are in the index, and it reads them with one process instead of one `readFile` per file from
 * an event loop that is also serving every other RPC. Realm shells out to git for status, diffs,
 * worktrees and checkpoints already, so this adds no dependency and inherits `GIT_HARDENING` — which
 * matters more here than elsewhere, because the whole point is to run this against a checkout
 * somebody's agent produced.
 *
 * **The bounds are the design.** Every one of them exists because the caller is a palette that must
 * answer a keystroke, and because the tree may contain a 40 MB single-line bundle an agent generated.
 * Each is named individually below with the specific failure it prevents; none of them is a round
 * number chosen for looking tidy.
 *
 * **The fallback is honest.** A directory that is not a git repository gets a bounded manual walk and
 * says `source: "walk"` in its answer, because the two are genuinely not the same search: the walk
 * has no `.gitignore`, so it approximates with a list of build directories, and it reads files one at
 * a time. A caller that showed both under one label would be claiming a guarantee it does not have.
 */

/**
 * Wall-clock ceiling for one search. Protects the palette from a tree where git itself is slow — a
 * cold page cache, a network filesystem, a repository with a million paths. A search that has not
 * answered in this long has already lost the race with the next keystroke.
 */
export const GREP_TIMEOUT_MS = 5_000;

/**
 * How many bytes of git's output are read at all. This is the one bound that stops a 40 MB minified
 * file from ever entering this process: `--max-count` limits LINES per file, and a generated bundle
 * is one line, so the line cap below can only clip it AFTER it has been read. execFile's maxBuffer
 * kills the child at this point instead, and the prefix already captured is a real partial answer.
 */
export const GREP_MAX_BYTES = 2 * 1024 * 1024;

/** Rows the caller may receive. A DOM bound: the palette renders every row it is handed, and nobody
 *  reads past the first screen of a text search — they add a word to the query instead. Taken from
 *  the wire ceiling rather than restated, so the schema's clamp and this stop cannot drift apart. */
export const GREP_MAX_HITS = PROJECT_GREP_LIMIT_MAX;

/**
 * Matches taken from any ONE file. Without it a lockfile, a generated client or a vendored bundle
 * owns the whole answer for any query that happens to appear in it, and the twenty files that
 * mattered are pushed off the end by one that did not.
 */
export const GREP_MAX_PER_FILE = 5;

/**
 * Characters kept from a matching line. A minified bundle, a base64 blob and a long JSON array are
 * all "one line" to grep, and the palette shows one line per row — so the wire never carries more
 * than a row can hold. The window is centred on the first match rather than taken from the start,
 * because the front of a minified line says nothing.
 */
export const GREP_MAX_LINE = 240;

/** Paths `project.files` will return before it stops enumerating. Past this the ranker's own candidate
 *  ceiling applies anyway, so listing more only costs the transfer. */
export const LS_FILES_MAX = 20_000;

/** The fallback walk's bounds. Deliberately tighter than git's: every one of these is a `readFile`
 *  and a `readdir` on the server's event loop, where the git path is one child process. */
export const WALK_MAX_FILES = 2_000;
export const WALK_MAX_DEPTH = 8;
/** A file the walk will not read. The git path does not need this — `-I` refuses binaries and
 *  `.gitignore` refuses build output — so this is the fallback paying for what it cannot know. */
export const WALK_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Directories the fallback never descends into. This is an APPROXIMATION of `.gitignore`, and calling
 * it that in the comment rather than in the answer is the point: the answer says `source: "walk"`, and
 * a caller that wants gitignore semantics has to be in a git repository to get them.
 */
export const WALK_SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  "dist", "out", "build", "target", "coverage", ".next", ".turbo", ".cache", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "Pods", "DerivedData", ".gradle", ".idea",
]);

/** One raw `git grep -z` record, before clipping or marking. */
export type GrepRecord = { path: string; line: number; text: string };

/**
 * Smart case, the way every editor's search field behaves: an all-lowercase query matches anything, a
 * query with a capital in it means that capital. A palette has no room for a case toggle and this is
 * the rule users already have in their fingers.
 */
export const isCaseSensitive = (query: string): boolean => /[A-Z]/.test(query);

/**
 * Parse `git grep -z -n` output: `path NUL line NUL text LF`, repeated.
 *
 * Scanned rather than split on newlines first, because the PATH is the field that may contain one —
 * `-z` does not quote, so a file called `we\nird.txt` would otherwise arrive as two broken records.
 * A trailing partial record (which is exactly what a maxBuffer kill leaves behind) is dropped.
 */
export function parseGrepOutput(stdout: string): GrepRecord[] {
  const out: GrepRecord[] = [];
  let i = 0;
  while (i < stdout.length) {
    const p = stdout.indexOf("\0", i);
    if (p === -1) break;
    const l = stdout.indexOf("\0", p + 1);
    if (l === -1) break;
    const eol = stdout.indexOf("\n", l + 1);
    if (eol === -1) break; // a record cut in half by the byte cap
    const line = Number(stdout.slice(p + 1, l));
    if (Number.isInteger(line) && line > 0) out.push({ path: stdout.slice(i, p), line, text: stdout.slice(l + 1, eol) });
    i = eol + 1;
  }
  return out;
}

/** Every occurrence of `query` in `text`, as [start, end) ranges. */
function occurrences(text: string, query: string, caseSensitive: boolean): [number, number][] {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: [number, number][] = [];
  if (needle === "") return out;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    out.push([at, at + needle.length]);
    if (out.length >= 64) break; // a row cannot show more marks than this and the loop is on user input
  }
  return out;
}

/**
 * One line as the palette's alternating plain/matched segments, clipped to `GREP_MAX_LINE` around the
 * first match. The ellipsis is a plain segment rather than a flag, so the renderer that already draws
 * `search.query` snippets draws these with no new branch.
 */
export function lineSegments(text: string, query: string, caseSensitive: boolean): ProjectGrepHit["segments"] {
  const found = occurrences(text, query, caseSensitive);
  const first = found[0]?.[0] ?? 0;
  // A third of the window ahead of the match: enough leading context to recognise the statement,
  // without pushing the thing you searched for off the right-hand end.
  const lead = Math.floor(GREP_MAX_LINE / 3);
  const start = Math.max(0, Math.min(first - lead, text.length - GREP_MAX_LINE));
  const end = Math.min(text.length, start + GREP_MAX_LINE);
  const segments: ProjectGrepHit["segments"] = [];
  if (start > 0) segments.push({ text: "…", match: false });
  let i = start;
  for (const [a, b] of found) {
    if (b <= start || a >= end) continue;
    const ca = Math.max(a, start), cb = Math.min(b, end);
    if (ca > i) segments.push({ text: text.slice(i, ca), match: false });
    segments.push({ text: text.slice(ca, cb), match: true });
    i = cb;
  }
  if (i < end) segments.push({ text: text.slice(i, end), match: false });
  if (end < text.length) segments.push({ text: "…", match: false });
  return segments;
}

/** Cheap binary test for the fallback only: a NUL in the head of the file, which is the same rule
 *  git uses. The walk has to make this call itself; the git path gets it from `-I`. */
const hasNul = (bytes: Buffer): boolean => bytes.subarray(0, 8192).includes(0);

export class ProjectSearchService {
  private git: GitRun;
  constructor(opts: { git?: GitRun } = {}) { this.git = opts.git ?? gitCapture; }

  /** Whether `cwd` is inside a git working tree — which of the two searches below runs. */
  async isRepo(cwd: string): Promise<boolean> {
    this.assertAbsolute(cwd);
    const r = await this.git(cwd, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: GREP_TIMEOUT_MS });
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /**
   * Content search under `cwd`, newest-first in git's own path order.
   *
   * `--untracked` is deliberate: a file an agent wrote ten seconds ago and has not committed is
   * exactly the file the user is looking for, and it is the one a plain `git grep` cannot see.
   * Ignored files stay out — `--untracked` still honours `.gitignore`, which is the whole reason to
   * be using git for this rather than a walk.
   *
   * `-F` because a palette query is text, not a regex: a user typing `foo(` wants the call site, not
   * an "unmatched parenthesis" error. `-e` because a query beginning with `-` must be a query.
   */
  async grep(cwd: string, query: string, o: { limit?: number } = {}): Promise<ProjectGrepResult> {
    this.assertAbsolute(cwd);
    const q = query.trim();
    const limit = Math.max(1, Math.min(o.limit ?? GREP_MAX_HITS, GREP_MAX_HITS));
    if (q === "") return { hits: [], truncated: false, source: "git" };
    if (!(await this.isRepo(cwd))) return this.walkGrep(cwd, q, limit);

    const caseSensitive = isCaseSensitive(q);
    const r = await this.git(cwd, [
      "--no-optional-locks", "grep", "--no-color", "-z", "-n", "-I", "-F",
      ...(caseSensitive ? [] : ["-i"]),
      "--untracked", `--max-count=${GREP_MAX_PER_FILE}`, "-e", q, "--",
    ], { timeoutMs: GREP_TIMEOUT_MS, maxBytes: GREP_MAX_BYTES });
    // Exit 1 is "no matches", which is an answer. Anything else (a broken repository, a missing
    // object) is not, and an empty list would claim the file does not mention the word.
    if (r.code !== 0 && r.code !== 1 && !r.truncated) {
      throw new RpcError("SEARCH_FAILED", `git grep exited ${r.code}`);
    }
    const records = parseGrepOutput(r.stdout);
    const perFile = new Map<string, number>();
    const hits: ProjectGrepHit[] = [];
    for (const rec of records) {
      if (hits.length >= limit) break;
      const n = (perFile.get(rec.path) ?? 0) + 1;
      perFile.set(rec.path, n);
      if (n > GREP_MAX_PER_FILE) continue;
      hits.push({ path: rec.path, line: rec.line, segments: lineSegments(rec.text, q, caseSensitive) });
    }
    /* `truncated` claims only "there may be more than this", which is all three of these mean: the
       byte cap cut git off mid-stream, the row cap dropped records we parsed, or some file produced
       exactly its per-file allowance and may have had more. The last over-reports for a file with
       exactly five matches — the alternative is asking git a second time to find out, for a flag
       whose entire job is to stop the palette from implying it showed you everything. */
    const truncated = r.truncated === true
      || records.length > hits.length
      || [...perFile.values()].some((n) => n >= GREP_MAX_PER_FILE);
    return { hits, truncated, source: "git" };
  }

  /**
   * `project.files`: the checkout's file names, ranked against a path fragment.
   *
   * Two halves that are deliberately separable. Enumerating is the part that talks to a process and
   * has to be bounded; ordering is pure, lives in contracts, and is tested against a table of paths
   * rather than against a repository — which is the only way to make an assertion about which file a
   * person meant. A client that already holds a file list can order it by the identical rules.
   */
  async files(cwd: string, query: string, limit: number = PROJECT_FILES_LIMIT): Promise<ProjectFilesResult> {
    const { paths, truncated, source } = await this.listFiles(cwd);
    return { hits: rankPaths(paths, query, limit), truncated, source };
  }

  /**
   * Every file under `cwd`, as repo-relative `/`-separated paths. Tracked plus
   * untracked-but-not-ignored, for the same reason `grep` searches both.
   */
  async listFiles(cwd: string): Promise<ProjectFileList> {
    this.assertAbsolute(cwd);
    if (!(await this.isRepo(cwd))) return this.walkFiles(cwd);
    const r = await this.git(cwd, ["--no-optional-locks", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeoutMs: GREP_TIMEOUT_MS, maxBytes: GREP_MAX_BYTES });
    if (r.code !== 0 && !r.truncated) throw new RpcError("SEARCH_FAILED", `git ls-files exited ${r.code}`);
    const all = r.stdout.split("\0").filter((p) => p !== "");
    // A maxBuffer kill can cut the final path in half, and half a path is a path to nothing.
    if (r.truncated) all.pop();
    return { paths: all.slice(0, LS_FILES_MAX), truncated: r.truncated === true || all.length > LS_FILES_MAX, source: "git" };
  }

  // ---------------------------------------------------------------- the not-a-repository fallback

  private async walkGrep(cwd: string, query: string, limit: number): Promise<ProjectGrepResult> {
    const caseSensitive = isCaseSensitive(query);
    const needle = caseSensitive ? query : query.toLowerCase();
    const { paths, truncated: listTruncated } = await this.walkFiles(cwd);
    const deadline = Date.now() + GREP_TIMEOUT_MS;
    const hits: ProjectGrepHit[] = [];
    let truncated = listTruncated;
    for (const rel of paths) {
      if (hits.length >= limit) { truncated = true; break; }
      if (Date.now() > deadline) { truncated = true; break; }
      let bytes: Buffer;
      try {
        const st = await stat(join(cwd, rel));
        if (!st.isFile() || st.size > WALK_MAX_FILE_BYTES) continue;
        bytes = await readFile(join(cwd, rel));
      } catch { continue; }
      if (hasNul(bytes)) continue;
      const text = bytes.toString("utf8");
      if (!(caseSensitive ? text : text.toLowerCase()).includes(needle)) continue;
      let inFile = 0;
      const lines = text.split("\n");
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n]!;
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
        if (inFile >= GREP_MAX_PER_FILE) { truncated = true; break; }
        inFile++;
        hits.push({ path: rel, line: n + 1, segments: lineSegments(line, query, caseSensitive) });
        if (hits.length >= limit) { truncated = true; break; }
      }
    }
    return { hits, truncated, source: "walk" };
  }

  private async walkFiles(root: string): Promise<ProjectFileList> {
    const paths: string[] = [];
    let truncated = false;
    const deadline = Date.now() + GREP_TIMEOUT_MS;
    const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
      if (paths.length >= WALK_MAX_FILES || Date.now() > deadline) { truncated = true; return; }
      let entries;
      try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (paths.length >= WALK_MAX_FILES) { truncated = true; return; }
        if (e.name.startsWith(".") || WALK_SKIP_DIRS.has(e.name)) continue;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        // A symlinked directory is not descended into: a link back up the tree is an infinite walk,
        // and the depth cap alone would turn that into a slow answer rather than no answer.
        if (e.isDirectory()) { if (depth < WALK_MAX_DEPTH) await visit(join(abs, e.name), childRel, depth + 1); }
        else if (e.isFile()) paths.push(childRel);
      }
    };
    await visit(root, "", 0);
    return { paths, truncated, source: "walk" };
  }

  /** Every path this service takes is a workspace root the server chose, never a client string —
   *  but it arrives over RPC, so it is checked rather than assumed. */
  private assertAbsolute(cwd: string): void {
    if (!isAbsolute(cwd)) throw new RpcError("INVALID_PARAMS", "cwd must be an absolute path");
  }
}
