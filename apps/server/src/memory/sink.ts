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
  /** Several files as one commit: repo-relative path → new content, or null to delete. */
  writeBatch(owner: RepoOwner, writes: Map<string, string | null>, message: string, author?: string): Promise<MemoryEditOutcome>;
  /** Create or overwrite one fact in the space's folder, keeping its index line current. */
  saveSpaceMemory(spaceId: string, m: { name: string; description: string; type: SpaceMemoryType; body: string; sessionId?: string; author?: string }): Promise<MemoryEditOutcome>;
  /** Add, replace or remove one entry of a Markdown file — the root `MEMORY.md` by default. */
  edit: MemoryRepoService["edit"];
}

/** Where the store records a space's folder once it has chosen one (the batch's design: settings
 *  `memory.spaceFolder:<spaceId>`). The tidy pass reads it to find the folders that exist without
 *  asking `spaceFolderFor`, which would allocate one for every space it was asked about. */
export const spaceFolderSettingKey = (spaceId: string): string => `memory.spaceFolder:${spaceId}`;

/**
 * The memory repo service as a sink, or null while it lacks the folder helpers — which leaves
 * learning and tidying off rather than half-working. The helpers belong to the store itself (the
 * profile repo's space folders); once `MemoryRepoService` has them with these signatures it satisfies
 * `MemorySink` as it is, this returns it, and the probe can give way to passing the service directly.
 */
export function memorySinkFrom(repos: MemoryRepoService): MemorySink | null {
  const r = repos as MemoryRepoService & Partial<Omit<MemorySink, "edit">>;
  if (typeof r.spaceFolderFor !== "function" || typeof r.writeBatch !== "function" || typeof r.saveSpaceMemory !== "function") return null;
  return r as MemorySink;
}
