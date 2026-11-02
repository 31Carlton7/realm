import { z } from "zod";

/*
 * ─── The memory library ───────────────────────────────────────────────────────────────────────────
 *
 * Every Markdown memory file an agent on this Mac reads, in one place: Realm's own (the memory repos
 * and the memory documents) and each agent's (Claude's CLAUDE.md files and its project memory, Codex's
 * AGENTS.md, Cursor's rules, Gemini's GEMINI.md). A file is named by its source and its path inside
 * that source, never by an absolute path, so nothing outside a discovered source can be asked for.
 */

/** Which agent's files a source holds, as the library groups them. */
export const MemoryLibraryGroupSchema = z.enum(["realm", "claude", "codex", "cursor", "gemini"]);
export type MemoryLibraryGroup = z.infer<typeof MemoryLibraryGroupSchema>;

export const MEMORY_LIBRARY_GROUP_LABEL: Record<MemoryLibraryGroup, string> = {
  realm: "Realm", claude: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini",
};

/** The `type` a new memory is filed under — Claude's own four, which the repo's folders keep. */
export const MemoryLibraryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
export type MemoryLibraryType = z.infer<typeof MemoryLibraryTypeSchema>;

/**
 * One place memory files are kept. `pointed` says whether an agent working in Realm reads it, and
 * `by` says how, in a sentence — "Claude Code loads it in every session". `external` is a file outside
 * Realm's own memory: writing or deleting one asks first (`confirmExternal`), and a deleted one goes to
 * the Trash rather than into a commit.
 */
export const MemoryLibrarySourceSchema = z.object({
  id: z.string(),
  group: MemoryLibraryGroupSchema,
  label: z.string(),
  /** The folder the source's files are under, or its one file. */
  path: z.string(),
  /** The space a per-space source belongs to, or null for one every space shares. */
  spaceId: z.string().nullable(),
  external: z.boolean(),
  /** Whether a new memory can be made here (`memory.library.create`) — the Realm repos. */
  creatable: z.boolean(),
  count: z.number().int(),
  pointed: z.boolean(),
  by: z.string(),
});
export type MemoryLibrarySource = z.infer<typeof MemoryLibrarySourceSchema>;

/** One memory file as the list shows it. `id` is `<sourceId>:<path from the source's root>`. */
export const MemoryLibraryEntrySchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  /** Absolute, for Show in Finder. */
  path: z.string(),
  /** From the source's root. */
  rel: z.string(),
  /** Frontmatter `name`, else the first heading, else the file's name. */
  title: z.string(),
  /** Frontmatter `description`, else the first line of prose; null for an empty file. */
  description: z.string().nullable(),
  /** Frontmatter `type` (or `metadata.type`, where Claude keeps it). */
  type: z.string().nullable(),
  /** Where in its source it sits, when that says something: a space's folder of the repo, a Claude project. */
  folder: z.string().nullable(),
  updatedAt: z.number(),
  size: z.number().int(),
  /** A search's best line in the file, when the list was searched. */
  match: z.string().nullable(),
});
export type MemoryLibraryEntry = z.infer<typeof MemoryLibraryEntrySchema>;

/** Who loads a file — an agent ("Claude", or "Every agent") — where ("every space", "Realm and Stora"),
 *  and how, when that is not simply "it loads it" ("through Realm's memory tools"). */
export const MemoryLibraryReaderSchema = z.object({ who: z.string(), where: z.string(), how: z.string().nullable() });
export type MemoryLibraryReader = z.infer<typeof MemoryLibraryReaderSchema>;

/** One memory file, read whole. */
export const MemoryLibraryFileSchema = MemoryLibraryEntrySchema.extend({
  /** The whole file, frontmatter included — what the editor edits. */
  text: z.string(),
  /** The file after its frontmatter — what the reader renders. */
  body: z.string(),
  /** The frontmatter's fields in file order, a nested one as `metadata.type`. */
  frontmatter: z.array(z.object({ key: z.string(), value: z.string() })),
  /** Each `[[link]]` and relative `.md` link in the body, as written, with the memory it opens (null when
   *  it leads nowhere the library knows). */
  links: z.array(z.object({ target: z.string(), id: z.string().nullable() })),
  readBy: z.array(MemoryLibraryReaderSchema),
  external: z.boolean(),
  writable: z.boolean(),
  deletable: z.boolean(),
  /** Why it cannot be edited or deleted here, or anything else a reader should know before they try. */
  note: z.string().nullable(),
});
export type MemoryLibraryFile = z.infer<typeof MemoryLibraryFileSchema>;

/** Refused because the file is outside Realm and the call did not say the person agreed. */
export const MEMORY_EXTERNAL_UNCONFIRMED = "MEMORY_EXTERNAL_UNCONFIRMED";

/** The memory id of a file: its source and its path from the source's root. */
export const memoryLibraryId = (sourceId: string, rel: string): string => `${sourceId}:${rel}`;

/** A memory id's two halves, or null when it is not one. */
export function parseMemoryLibraryId(id: string): { sourceId: string; rel: string } | null {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  return { sourceId: id.slice(0, at), rel: id.slice(at + 1) };
}
