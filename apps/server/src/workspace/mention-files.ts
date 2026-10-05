import { isSecretPath, rankPaths, type ProjectFileList, type ProjectFilesResult } from "@realm/contracts";
import type { ProjectSearchService } from "./grep";

/**
 * How long one listing of a checkout answers the `@` list. A word typed after the `@` is a burst of
 * keystrokes, and each is a ranking of the same list — so the list is read once per burst, and a new
 * `@` a little later reads it again, by which time a file the agent just wrote is in it.
 */
export const MENTION_FILES_TTL_MS = 5_000;
/** Checkouts kept at once. A window of split sessions in a few worktrees, not every folder ever seen. */
const KEPT = 8;

/**
 * The prompter's Files group: a session's checkout, ranked against what follows the `@`.
 *
 * The listing is `project.files`'s own — `git ls-files` with `.gitignore` honoured, or the bounded
 * walk outside a repository — so the two lists can never disagree about what a checkout holds. What
 * differs is what is left out: a file that exists to hold a secret (`isSecretPath`) is dropped at the
 * source, because a pick here hands the file to an agent, and the renderer never holds its name.
 */
export class MentionFiles {
  private readonly kept = new Map<string, { at: number; list: Promise<ProjectFileList> }>();

  constructor(private readonly d: { search: Pick<ProjectSearchService, "listFiles">; now?: () => number }) {}

  async files(cwd: string, query: string, limit: number): Promise<ProjectFilesResult> {
    const list = await this.list(cwd);
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
}
