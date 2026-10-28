import { mkdirSync } from "node:fs";
import { amrRepoSourceLink } from "@realm/contracts";
import type { MemoryRepoService, RepoOwner } from "./repo";

const short = (text: string, n = 60): string => (text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`);

/**
 * The engines' own memory, kept in Realm's. A session in a space with a profile repo in use is handed
 * the space's folder of that repo: Claude writes its auto-memory there instead of under
 * `~/.claude/projects`, and Codex turns its own memories off. What Claude wrote is committed when its
 * turn settles, and anything it wrote while Realm was not committing is swept up at boot — so the
 * folder is a git history like the rest of the repo, never a pile of loose files.
 */
export class AgentMemoryFolders {
  constructor(private d: {
    repos: Pick<MemoryRepoService, "spaceFolderFor" | "commitSpaceFolder" | "commitSpaceFolders">;
    /** After a commit, so the Memory rows on screen show it. */
    onChanged?: (owner: RepoOwner) => void;
  }) {}

  /** The folder a session in this space keeps its memory in, made if it is not there yet; null where
   *  the space keeps no memory in Realm (no profile repo, or the space turned it off). */
  dirFor(spaceId: string): string | null {
    const at = this.d.repos.spaceFolderFor(spaceId);
    if (!at) return null;
    mkdirSync(at.dir, { recursive: true });
    return at.dir;
  }

  /** A Claude turn settled: commit what it wrote in the space's folder, in a commit that names the
   *  session. A file that had to stay out is logged, and the Memory row says so. Never throws. */
  async turnSettled(s: { id: string; spaceId: string; title: string }): Promise<void> {
    try {
      const r = await this.d.repos.commitSpaceFolder(s.spaceId, `Save what Claude remembered in “${short(s.title)}”\n\nSession: ${amrRepoSourceLink(s.id)}`);
      if (!r) return;
      for (const h of r.held) console.error(`[memory] ${h.path} stays uncommitted: ${h.reason}`);
      const owner = r.sha || r.held.length > 0 ? this.d.repos.spaceFolderFor(s.spaceId)?.owner : undefined;
      if (owner) this.d.onChanged?.(owner);
    } catch (e) {
      console.error(`[memory] Claude's memory from session ${s.id} not committed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** At boot: what Claude left uncommitted in any space folder of these profiles' repos. Never throws. */
  async sweep(profileIds: readonly string[]): Promise<void> {
    for (const id of profileIds) {
      const owner: RepoOwner = { scope: "profile", id };
      try {
        const r = await this.d.repos.commitSpaceFolders(owner);
        for (const h of r?.held ?? []) console.error(`[memory] ${h.path} stays uncommitted: ${h.reason}`);
        if (r?.sha) this.d.onChanged?.(owner);
      } catch (e) {
        console.error(`[memory] the space folders of profile ${id} not committed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
