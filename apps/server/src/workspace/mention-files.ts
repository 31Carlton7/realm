import { isSecretPath, rankPaths, type ProjectFileList, type ProjectFilesResult } from "@realm/contracts";
import type { GitRun } from "./git-exec";
import type { ProjectSearchService } from "./grep";

/**
 * How long one listing of a checkout answers the `@` list. A word typed after the `@` is a burst of
 * keystrokes, and each is a ranking of the same list — so the list is read once per burst, and a new
 * `@` a little later reads it again, by which time a file the agent just wrote is in it.
 */
export const MENTION_FILES_TTL_MS = 5_000;
/** Checkouts kept at once. A window of split sessions in a few worktrees, not every folder ever seen. */
const KEPT = 8;
/** `git status`'s bounds, for the one question it answers here: which files a bare `@` leads with. */
const STATUS_TIMEOUT_MS = 3_000;
const STATUS_MAX_BYTES = 512 * 1024;

/** The paths `git status --porcelain=v1 -z` names, each once — a rename's new path, never its old one,
 *  which follows it as a field of its own. */
export function porcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    if (rec.length < 4) continue;
    out.push(rec.slice(3));
    if (rec[0] === "R" || rec[0] === "C") i++;
  }
  return [...new Set(out)];
}

/**
 * The order a bare `@` shows a checkout in: what it has CHANGED first — the files being worked on,
 * which are the ones a person points at — then the rest as git lists them, and hidden paths
 * (`.gitignore`, `.github/…`) after everything else, since nobody's first `@` is for those.
 */
export function tourOrder(paths: readonly string[], changed: ReadonlySet<string>): string[] {
  const hidden = (p: string) => p.split("/").some((seg) => seg.startsWith("."));
  const rank = (p: string) => (hidden(p) ? 2 : 0) + (changed.has(p) ? 0 : 1);
  return paths.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}

/**
 * The prompter's Files group: a session's checkout, ranked against what follows the `@`.
 *
 * The listing is `project.files`'s own — `git ls-files` with `.gitignore` honoured, or the bounded
 * walk outside a repository — so the two lists can never disagree about what a checkout holds. What
 * differs is what is left out: a file that exists to hold a secret (`isSecretPath`) is dropped at the
 * source, because a pick here hands the file to an agent, and the renderer never holds its name.
 */
export class MentionFiles {
  private readonly kept = new Map<string, { at: number; list: Promise<ProjectFileList>; changed?: Promise<Set<string>> }>();

  constructor(private readonly d: { search: Pick<ProjectSearchService, "listFiles">;
    /** git, for the changed files a bare `@` leads with. Absent, the tour is the listing's own order. */
    git?: GitRun; now?: () => number }) {}

  async files(cwd: string, query: string, limit: number): Promise<ProjectFilesResult> {
    const list = await this.list(cwd);
    if (query.trim() === "") {
      const ordered = tourOrder(list.paths, await this.changed(cwd));
      return { hits: ordered.slice(0, limit).map((path) => ({ path, score: 0, segments: [{ text: path, match: false }] })), truncated: list.truncated, source: list.source };
    }
    return { hits: rankPaths(list.paths, query, limit), truncated: list.truncated, source: list.source };
  }

  private list(cwd: string): Promise<ProjectFileList> {
    const now = this.d.now?.() ?? Date.now();
    const hit = this.kept.get(cwd);
    if (hit && now - hit.at < MENTION_FILES_TTL_MS) return hit.list;
    // The promise is what is kept, so keystrokes that land while git is still answering share one run.
    const list = this.d.search.listFiles(cwd).then((l) => ({ ...l, paths: l.paths.filter((p) => !isSecretPath(p)) }));
    this.kept.delete(cwd);
    this.kept.set(cwd, { at: now, list });
    while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!);
    // A failed listing is not kept: the next keystroke asks again rather than replaying the failure.
    list.catch(() => { if (this.kept.get(cwd)?.list === list) this.kept.delete(cwd); });
    return list;
  }

  /** What the checkout has changed, asked once per listing and only by a bare `@`. A repository git
   *  cannot answer for — or a folder that is not one — has changed nothing as far as the tour knows. */
  private changed(cwd: string): Promise<Set<string>> {
    const entry = this.kept.get(cwd);
    if (!entry || !this.d.git) return Promise.resolve(new Set());
    entry.changed ??= this.d.git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: STATUS_MAX_BYTES })
      .then((r) => new Set(r.code === 0 ? porcelainPaths(r.stdout) : []), () => new Set<string>());
    return entry.changed;
  }
}
