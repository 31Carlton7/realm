import type { MemoryEditOutcome, MemoryRepoService, RepoOwner } from "./repo";

/** One space's folder in its profile's memory repo: `<repoPath>/spaces/<folder>/`, which is `dir`. */
export type SpaceFolder = { owner: RepoOwner; repoPath: string; folder: string; dir: string };

export type SpaceMemoryType = "user" | "feedback" | "project" | "reference";

/**
 * Everything Realm's own learning writes through: the profile memory repo's helpers for a space's
 * folder (`spaceFolderFor`, `saveSpaceMemory`, `writeBatch`) and the root index's entry edit. Narrow on
 * purpose — the extractor and the tidier never touch a repo any other way, so what they can do to the
 * user's memory is exactly what these four can.
 */
export interface MemorySink {
  /** The space's folder in its profile's repo, or null when the space has no profile repo in use
   *  (memory tools off, inheritance off, no profile). Allocates and records the folder on first use. */
  spaceFolderFor(spaceId: string): SpaceFolder | null;
  /** Several files as one commit: repo-relative path → new content, or null to delete. Given a function,
   *  the store calls it inside the repo's lock with the repo's path, so what it reads there is what the
   *  commit is made on top of; a throw from it writes nothing. */
  writeBatch(owner: RepoOwner, writes: Map<string, string | null> | ((repo: string) => Map<string, string | null>), message: string, author?: string): Promise<MemoryEditOutcome>;
  /** Create or overwrite one fact in the space's folder, keeping its index line current. */
  saveSpaceMemory(spaceId: string, m: { name: string; description: string; type: SpaceMemoryType; body: string; sessionId?: string; author?: string }): Promise<MemoryEditOutcome>;
  /** Add, replace or remove one entry of a Markdown file — the root `MEMORY.md` by default. */
  edit: MemoryRepoService["edit"];
}

/** Where the store records a space's folder once it has chosen one (the batch's design: settings
 *  `memory.spaceFolder:<spaceId>`), as `{ folder, profileId }` — a bare folder name in a record made
 *  before the profile was kept with it. The tidy pass asks `MemoryRepoService.hasSpaceFolder`, which
 *  reads it, to find the folders that exist without asking `spaceFolderFor`, which would allocate one
 *  for every space it was asked about — and a new one for a space moved from another profile. */
export const spaceFolderSettingKey = (spaceId: string): string => `memory.spaceFolder:${spaceId}`;
