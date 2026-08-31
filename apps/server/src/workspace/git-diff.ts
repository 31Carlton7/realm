import { isAbsolute } from "node:path";
import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, DiffSummary, FileDiff } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { GIT_DIFF_FLAGS, gitCapture, type GitRun } from "./git-exec";

/**
 * Truncation policy, stated once (Plan 7 W3).
 *
 * The renderer is a single-threaded browser process holding the user's whole workstation. A generated
 * lockfile, a vendored bundle or a 200k-line schema dump must therefore cost a bounded amount of DOM,
 * and the bound is enforced HERE rather than in the pane — a limit the renderer applies has already
 * paid for the string.
 *
 *  - **The file list** is capped at `DIFF_MAX_FILES`. `DiffSummary.totalFiles` still reports the true
 *    count, so the pane can say "1000 of 4213 files" instead of quietly lying.
 *  - **A file's patch** is never fetched with the list: the pane asks per file, on expansion. That is
 *    the load-bearing half of the policy — a 4000-file diff costs one `status` and one `numstat`, not
 *    4000 patches.
 *  - **One patch** is capped twice: `FILE_DIFF_MAX_BYTES` of git output (execFile's maxBuffer, so the
 *    bytes past it are never even read into this process) and `FILE_DIFF_MAX_LINES` of parsed lines.
 *    Whichever hits first sets `truncated` and names itself in `truncatedReason`.
 *  - **Binary files** never carry content at all: `binary: true`, zero hunks. Detected from numstat's
 *    `-\t-` and from git's own "Binary files … differ", so a file that becomes binary between the
 *    list and the expansion is still caught.
 *
 * Nothing here streams. A cap that the user can hit is a worse experience than a spinner, but a
 * renderer that stops answering the keyboard is not an experience at all.
 */
export const DIFF_MAX_FILES = 1000;
export const FILE_DIFF_MAX_BYTES = 512 * 1024;
export const FILE_DIFF_MAX_LINES = 4000;

/** Split NUL-terminated output into fields, dropping the empty tail after the final NUL. */
function nulFields(out: string): string[] {
  const parts = out.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * Refuse anything that is not a plain repo-relative path.
 *
 * Every path this service accepts came from `git status` originally, but it arrives back over RPC,
 * where it is user input again. An absolute path or one containing `..` would let `stage`/`fileDiff`
 * name a file outside the checkout — `git add -- ../../etc/x` is a real command. `--` stops option
 * injection; this stops path escape. Shared with the write path, which needs it more.
 */
export function assertRepoRelative(path: string): void {
  if (path === "" || isAbsolute(path) || path.startsWith("/")) {
    throw new RpcError("INVALID_PARAMS", `${path || "(empty)"} is not a path inside the checkout`);
  }
  if (path.split("/").some((seg) => seg === "..")) {
    throw new RpcError("INVALID_PARAMS", `${path} leaves the checkout`);
  }
}

/** Porcelain's two status letters → the one word the pane shows. Worktree state wins when both sides
 *  changed: it is the newer of the two and the one the user is looking at. */
export function statusOf(x: string, y: string): DiffFileStatus {
  if (x === "?" || y === "?") return "untracked";
  // DD/AU/UD/UA/DU/AA/UU — every unmerged combination git defines.
  if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) return "conflicted";
  const letter = y !== " " && y !== "" ? y : x;
  switch (letter) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    default: return "modified";
  }
}

type Counts = { additions: number; deletions: number; binary: boolean };

/**
 * `workspace.diff` / `workspace.fileDiff` backend: the working tree as a list of changed files, and
 * one file's patch on demand.
 *
 * Read-only, and hardened the way `GitInfoService` is: `--no-optional-locks` before the subcommand so
 * a probe never contends for the index lock with the user's own git, plus `GIT_DIFF_FLAGS` on every
 * diff so a `.gitattributes` textconv driver cannot turn "show me this file" into "run this command".
 */
export class GitDiffService {
  private git: GitRun;
  constructor(opts: { git?: GitRun } = {}) { this.git = opts.git ?? gitCapture; }

  /** The checkout root, so every path in and out of this service means the same thing regardless of
   *  which subdirectory the session's cwd happens to be. Null when cwd is not a repository at all. */
  async repoRoot(cwd: string): Promise<string | null> {
    if (!isAbsolute(cwd)) throw new RpcError("INVALID_PARAMS", "cwd must be an absolute path");
    const r = await this.git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const top = r.stdout.trim();
    return r.code === 0 && top !== "" ? top : null;
  }

  /** Null when cwd is not a git repository — same contract as `workspace.gitInfo`, so the pane has
   *  one "there is nothing to show here" case rather than two. */
  async summary(cwd: string): Promise<DiffSummary | null> {
    const root = await this.repoRoot(cwd);
    if (!root) return null;
    const [status, unstaged, staged, branch] = await Promise.all([
      // -uall: an untracked DIRECTORY would otherwise arrive as one entry ("src/"), which is not a
      // file the pane can open, stage or diff.
      this.git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"]),
      this.git(root, ["--no-optional-locks", "diff", ...GIT_DIFF_FLAGS, "--numstat", "-z"]),
      this.git(root, ["--no-optional-locks", "diff", ...GIT_DIFF_FLAGS, "--numstat", "-z", "--cached"]),
      this.git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    if (status.code !== 0) return null;
    const counts = new Map<string, Counts>();
    for (const r of [unstaged, staged]) {
      if (r.code !== 0) continue;
      for (const [path, c] of parseNumstat(r.stdout)) {
        const prev = counts.get(path);
        counts.set(path, prev
          ? { additions: prev.additions + c.additions, deletions: prev.deletions + c.deletions, binary: prev.binary || c.binary }
          : c);
      }
    }
    const all = parseStatus(status.stdout, counts);
    return {
      root,
      branch: branch.code === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : null,
      files: all.slice(0, DIFF_MAX_FILES),
      totalFiles: all.length,
      truncated: all.length > DIFF_MAX_FILES,
    };
  }

  /**
   * One file's patch. `staged` picks which of the two diffs git keeps for every path: index-vs-HEAD
   * (true) or worktree-vs-index (false). They are genuinely different patches, which is why the pane
   * asks for the side it is showing rather than a merged view that belongs to neither.
   *
   * An untracked file has no index entry to diff against, so it is read with `--no-index` against
   * /dev/null — the whole file as additions, which is what it is.
   */
  async file(cwd: string, path: string, staged: boolean): Promise<FileDiff> {
    assertRepoRelative(path);
    const root = await this.repoRoot(cwd);
    if (!root) throw new RpcError("NOT_A_REPOSITORY", `${cwd} is not a git repository`);
    const untracked = !staged && await this.isUntracked(root, path);
    const args = untracked
      // `--no-index` compares two paths outside git's knowledge; it exits 1 when they differ, which
      // for a file that exists is always.
      ? ["diff", ...GIT_DIFF_FLAGS, "--no-index", "--", "/dev/null", path]
      : ["--no-optional-locks", "diff", ...GIT_DIFF_FLAGS, ...(staged ? ["--cached"] : []), "-M", "--", path];
    const r = await this.git(root, args, { maxBytes: FILE_DIFF_MAX_BYTES });
    // `--no-index` uses exit 1 for "they differ"; a real failure also has stderr. Only treat a
    // non-zero exit as fatal when git actually said something.
    if (r.code > 1 && r.stderr.trim() !== "") throw new RpcError("GIT_DIFF_FAILED", r.stderr.split("\n")[0] ?? "git diff failed");
    return parsePatch(path, staged, r.stdout, r.truncated === true);
  }

  /** `git status` for one path: cheaper and more exact than re-listing the tree to find out whether
   *  this file is tracked at all. */
  private async isUntracked(root: string, path: string): Promise<boolean> {
    const r = await this.git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--", path]);
    if (r.code !== 0) return false;
    return nulFields(r.stdout).some((f) => f.startsWith("??"));
  }
}

/** `--numstat -z`: `adds \t dels \t path \0`, except a rename, which emits an EMPTY path field
 *  followed by `old \0 new \0`. The counts belong to the new path. */
export function parseNumstat(out: string): [string, Counts][] {
  const fields = nulFields(out);
  const result: [string, Counts][] = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(head);
    if (!m) continue;
    const binary = m[1] === "-";
    const counts: Counts = { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary };
    let path = m[3]!;
    if (path === "") { path = fields[i + 2] ?? fields[i + 1] ?? ""; i += 2; } // rename: skip old, take new
    if (path !== "") result.push([path, counts]);
  }
  return result;
}

/** `status --porcelain=v1 -z`: `XY path \0`, with a rename/copy adding `origPath \0` right after. */
export function parseStatus(out: string, counts: Map<string, Counts>): DiffFile[] {
  const fields = nulFields(out);
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue; // "XY p" is the shortest legal record
    const x = entry[0]!, y = entry[1]!;
    const path = entry.slice(3);
    let oldPath: string | null = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") { oldPath = fields[i + 1] ?? null; i += 1; }
    const c = counts.get(path);
    files.push({
      path, oldPath, status: statusOf(x, y),
      // "staged" is "the index differs from HEAD", which is exactly what a non-blank, non-`?` index
      // letter means. `!` is an ignored file, which -uall does not list anyway.
      staged: x !== " " && x !== "?" && x !== "!",
      unstaged: y !== " " && y !== "!",
      binary: c?.binary ?? false,
      additions: c?.additions ?? 0,
      deletions: c?.deletions ?? 0,
    });
  }
  return files;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Unified diff → hunks with per-line old/new numbers.
 *
 * Everything before the first `@@` is header (`diff --git`, mode lines, `---`/`+++`) and is dropped:
 * the pane draws its own header from `DiffFile`, and a rename's `---`/`+++` would otherwise render as
 * a deletion and an addition of the whole file.
 */
export function parsePatch(path: string, staged: boolean, out: string, outputTruncated: boolean): FileDiff {
  const lines = out.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0, newNo = 0, rendered = 0;
  let additions = 0, deletions = 0;
  let binary = false;
  let truncated = outputTruncated;
  let reason: string | null = outputTruncated ? `over ${Math.round(FILE_DIFF_MAX_BYTES / 1024)} KB of diff` : null;
  let oldPath: string | null = null;

  for (const raw of lines) {
    // git says this whether or not numstat did; a file that turned binary since the listing lands here.
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) { binary = true; break; }
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        header: m[5]?.trim() ?? "",
        oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      oldNo = current.oldStart; newNo = current.newStart;
      continue;
    }
    if (!current) {
      const rename = /^rename from (.*)$/.exec(raw);
      if (rename) oldPath = rename[1]!;
      continue; // still in the header
    }
    if (rendered >= FILE_DIFF_MAX_LINES) {
      truncated = true;
      reason ??= `over ${FILE_DIFF_MAX_LINES} lines`;
      break;
    }
    const line = classify(raw, oldNo, newNo);
    if (!line) continue;
    if (line.kind === "add") { additions++; newNo++; }
    else if (line.kind === "del") { deletions++; oldNo++; }
    else if (line.kind === "context") { oldNo++; newNo++; }
    current.lines.push(line);
    rendered++;
  }
  if (binary) return { path, oldPath, staged, binary: true, hunks: [], truncated: false, truncatedReason: null, additions: 0, deletions: 0 };
  return { path, oldPath, staged, binary: false, hunks, truncated, truncatedReason: reason, additions, deletions };
}

/** One patch body line. `\ No newline at end of file` is `meta`: it belongs to the hunk visually but
 *  advances neither line counter, and counting it as context would desynchronise every number after. */
function classify(raw: string, oldNo: number, newNo: number): DiffLine | null {
  if (raw.startsWith("\\")) return { kind: "meta", text: raw.slice(1).trim(), oldLine: null, newLine: null };
  if (raw.startsWith("+")) return { kind: "add", text: raw.slice(1), oldLine: null, newLine: newNo };
  if (raw.startsWith("-")) return { kind: "del", text: raw.slice(1), oldLine: oldNo, newLine: null };
  if (raw.startsWith(" ")) return { kind: "context", text: raw.slice(1), oldLine: oldNo, newLine: newNo };
  // The trailing empty string from the final "\n", or a line git did not produce. Neither is content.
  return null;
}
