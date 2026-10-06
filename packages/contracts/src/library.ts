import { z } from "zod";
import { basenameOf } from "./attachments";
import { documentKindFor, WRITE_TOOL_NAMES, writtenPathOf } from "./documents";
import { IdSchema } from "./ids";

/**
 * Everything a session ever made or was given, as one browsable list.
 *
 * The session summary already answers this for ONE session, by folding that session's whole event
 * log in the renderer. That does not scale to "every session in this profile": the fold needs every
 * block of every transcript in memory, and a home with two hundred sessions would load a few hundred
 * megabytes of tool output to draw a file list.
 *
 * So the artifacts are INDEXED — a row per artifact, written as the event that produced it is
 * appended, and backfilled once for history (the resumable-cursor pattern the search index already
 * uses; see `search.backfill`). The extraction below is the one implementation both writers share,
 * so an index built by the backfill and an index built at append time cannot disagree.
 */

/**
 * What a row is.
 *
 * `output` — a file the agent WROTE. `upload` — a file the user attached to a message. Those are
 * genuinely different provenance and a browser that merged them would answer "where did this come
 * from" wrong; they are one table because they are both "a file this session has", which is the
 * question the page exists to answer.
 *
 * `added` — a file the user put in the Library itself, with its Add or a drop on the page. Realm keeps
 * a COPY of it under the profile, and no session holds it, so it is not a row of the `artifacts` index
 * at all: it is kept in `library_files` (migration v40) and read beside the index as one list.
 *
 * A URL the agent linked is deliberately NOT here, though the per-session summary lists them: a link
 * is not a file, it has no size, no kind and no place on disk, and a Drive-shaped browser listing
 * bare URLs among documents would be a list of two unrelated things.
 */
export const ARTIFACT_KINDS = ["output", "upload", "added"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactSchema = z.object({
  /** `<sessionId>:<seq>:<path>` — deterministic, so re-indexing the same event is a no-op upsert
   *  rather than a duplicate. That is what lets the backfill and the append-time writer overlap
   *  safely on the events either side of the cursor. */
  id: z.string(),
  sessionId: z.string(),
  spaceId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string(),
  name: z.string(),
  /** Lowercased, no dot; empty for a file with no extension. Stored rather than derived at read time
   *  so the type filter is an indexed equality instead of a scan with a string split in it. */
  ext: z.string(),
  ts: z.number(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** An artifact plus the two things the browser shows about where it came from. Joined at read time
 *  from `sessions`, never copied into the artifact row — a session renamed after the fact would
 *  otherwise leave every file it produced labelled with the old title.
 *
 *  A file the user `added` has no session, and so no space and no title either: those four are null
 *  for it, and every list that shows one says "Added" where the others name a session. */
export const LibraryEntrySchema = ArtifactSchema.extend({
  sessionId: z.string().nullable(),
  spaceId: z.string().nullable(),
  sessionTitle: z.string().nullable(),
  agentKind: z.string().nullable(),
});
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

/** One page. Large enough that a first screen of a Drive-style grid is one round trip at any
 *  reasonable window size, small enough that the query stays an index range scan. */
export const LIBRARY_PAGE_SIZE = 60;

export const LibraryQuerySchema = z.object({
  /** Null spans every space in the profile, which is what "across all sessions" means. */
  spaceId: z.string().nullable().default(null),
  /** The profile whose spaces "every space" means — the window's. Without it a null `spaceId` read
   *  every profile's files, so a Work window's Library listed what Personal's sessions made. Null is
   *  every profile, for a caller that genuinely wants the whole home. */
  profileId: z.string().nullable().default(null),
  /** One session's files — what the documents pane lists under "This session". Null is every
   *  session the other two scope fields allow. */
  sessionId: z.string().nullable().default(null),
  /** One row per FILE, at the moment it was last touched, rather than one per event that touched it.
   *  The Library's grid is a record of moments (a file made, a file handed over); a list of files to
   *  open is not, and a file edited nine times there was nine rows of the same name. Keyset paging
   *  runs over the collapsed list, so a page boundary never surfaces an older row of a file already
   *  shown. */
  perFile: z.boolean().default(false),
  kind: z.enum(ARTIFACT_KINDS).nullable().default(null),
  /** The broad type a file reads as (`artifactTypeOf`), answered from the stored extension — so a type
   *  narrows the whole index, never only the page already in the renderer. Null is every type. */
  type: z.lazy(() => z.enum(ARTIFACT_TYPES)).nullable().default(null),
  /** Matched against the file's NAME, not its path: a user looking for `report.md` should not have
   *  to also match the eleven directories above it. */
  query: z.string().default(""),
  /** Newest first by default — the same order every other list of session output takes. */
  limit: z.number().int().positive().max(200).default(LIBRARY_PAGE_SIZE),
  /** Keyset, not offset: `(ts, id)` strictly below this. An OFFSET page over a table that grows at
   *  the head silently repeats and skips rows while the user is scrolling it. */
  before: z.object({ ts: z.number(), id: z.string() }).nullable().default(null),
});
export type LibraryQuery = z.input<typeof LibraryQuerySchema>;

/**
 * Adding files to the Library (`library.add`): the Files toolbar's Add, or files dropped on the page.
 *
 * What is chosen is COPIED into Realm's own storage under the profile and listed from there, so the
 * Library keeps the file whatever happens to the one it came from. Paths are what crosses, because the
 * native picker and a drop both name files on this Mac, and the server is what reads them.
 */
/** Files one add may bring in, a folder's included. Past this a drop is far more likely a mistake — a
 *  whole project, a home folder — than a choice, and saying so beats a copy that runs for a minute. */
export const LIBRARY_ADD_MAX = 200;

export const LibraryAddSchema = z.object({
  profileId: IdSchema,
  /** Absolute paths, as the picker or the drop named them. */
  paths: z.array(z.string().min(1)).min(1).max(LIBRARY_ADD_MAX),
  /** Add the files a folder among `paths` holds. Off, a folder is only described (`folders` in the
   *  result), so the person is asked before a folder's worth of files is copied. Its own files only:
   *  the folders inside it are left where they are, and so is anything hidden. */
  folders: z.boolean().default(false),
});
export type LibraryAddInput = z.input<typeof LibraryAddSchema>;

/**
 * Why a chosen file was not added. `duplicate` is a file the Library already has — the same path, or
 * the same bytes added before (`existing` names it). `too-large` is past the attachment ceiling, the
 * one size the rest of the app holds a file to. `link` is a symbolic link, which is never followed: it
 * could point anywhere, and only what was chosen is copied. `unreadable` is everything else the disk
 * said no to — gone since it was chosen, not a file, not permitted.
 */
export const LIBRARY_SKIP_REASONS = ["duplicate", "too-large", "link", "unreadable"] as const;
export type LibrarySkipReason = (typeof LIBRARY_SKIP_REASONS)[number];

export const LibraryAddResultSchema = z.object({
  /** What was copied in, as the Library lists it. */
  added: z.array(LibraryEntrySchema),
  /** Copies kept under another name — `report 2.pdf` — because a different file already has theirs. */
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
  skipped: z.array(z.object({
    name: z.string(),
    reason: z.enum(LIBRARY_SKIP_REASONS),
    /** The file's size, where the size is the reason. */
    size: z.number().nullable(),
    /** The Library's name for the file this one duplicates. */
    existing: z.string().nullable(),
  })),
  /** The folders among the chosen items, left alone because `folders` was off: what adding their files
   *  would add. `files` and `bytes` count what would be copied; `more` is a folder holding more than
   *  one add takes; `subfolders` are the folders inside it, which adding it leaves out. */
  folders: z.array(z.object({
    path: z.string(), name: z.string(), files: z.number(), bytes: z.number(), subfolders: z.number(), more: z.boolean(),
  })),
});
export type LibraryAddResult = z.infer<typeof LibraryAddResultSchema>;

/**
 * Taking files back out of the Library (`library.remove`): a file's menu, its ⋯, the viewer's menu, or
 * Delete on the file in focus.
 *
 * Only a file the person ADDED can be removed, because only that is the Library's own: Realm's copy is
 * deleted, and the file it was copied from is never touched — it never was the Library's. A file a
 * session made or was given is the session's work and its transcript's, and stays. Named by path,
 * which every surface that shows a file knows; a path that is not one of the profile's added files is
 * left alone, so a request can never reach anything else.
 */
export const LibraryRemoveSchema = z.object({
  profileId: IdSchema,
  paths: z.array(z.string().min(1)).min(1).max(LIBRARY_ADD_MAX),
});
export type LibraryRemoveInput = z.input<typeof LibraryRemoveSchema>;

export const LibraryRemoveResultSchema = z.object({
  /** What left the Library, as it listed them. */
  removed: z.array(LibraryEntrySchema),
  /** The sent messages that carried one of the removed copies. Each keeps its words and the file's
   *  name, and loses the file; the Library's listing of it as attached goes with the copy. */
  messages: z.number().int(),
  /** The removal, for its undo (`library.restore`); null when nothing was removed. */
  removal: z.string().nullable(),
});
export type LibraryRemoveResult = z.infer<typeof LibraryRemoveResultSchema>;

/** Undoing a removal (`library.restore`): the toast's Undo, while the server still holds the copies. */
export const LibraryRestoreSchema = z.object({ removal: z.string().min(1) });
export type LibraryRestoreInput = z.input<typeof LibraryRestoreSchema>;

export const LibraryRestoreResultSchema = z.object({
  /** Back in the Library, each where it was in the list. */
  restored: z.array(LibraryEntrySchema),
  /** Copies put back under another name, because a file added since took theirs — never over it. */
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
});
export type LibraryRestoreResult = z.infer<typeof LibraryRestoreResultSchema>;

/** The extension a name ends in, lowercased and dotless. `""` for a name with none — never null, so
 *  the column has one type and the filter has one comparison. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The broad type a file reads as, for the browser's own grouping.
 *
 * Deliberately coarser than `documentKindFor`, which answers "can the documents pane render this"
 * — a different question with a different answer for the same file (`.png` is `unsupported` to the
 * editor and obviously an image to a file browser).
 */
export const ARTIFACT_TYPES = ["document", "image", "video", "audio", "data", "code", "other"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

const TYPE_BY_EXT: Record<string, ArtifactType> = {
  md: "document", markdown: "document", txt: "document", rtf: "document", pdf: "document", doc: "document", docx: "document",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image", avif: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", aac: "audio",
  csv: "data", tsv: "data", json: "data", yaml: "data", yml: "data", xlsx: "data", parquet: "data", sqlite: "data", db: "data",
  ts: "code", tsx: "code", js: "code", jsx: "code", py: "code", rb: "code", go: "code", rs: "code", java: "code",
  c: "code", h: "code", cpp: "code", hpp: "code", cs: "code", swift: "code", kt: "code", php: "code", sh: "code",
  css: "code", scss: "code", html: "code", sql: "code", toml: "code", ini: "code", xml: "code",
};

export const artifactTypeOf = (ext: string): ArtifactType => TYPE_BY_EXT[ext] ?? "other";

/** Every extension that reads as `type`, for a query that narrows by type: the stored `ext` column is
 *  an indexed equality, so a type is an `IN` over these. `other` has no list of its own — it is every
 *  extension NOT in any list, which is `extsOfType`'s answer for the other six put together. */
export function extsOfType(type: Exclude<ArtifactType, "other">): string[] {
  return Object.keys(TYPE_BY_EXT).filter((ext) => TYPE_BY_EXT[ext] === type);
}
export const KNOWN_EXTS: readonly string[] = Object.keys(TYPE_BY_EXT);

/**
 * The artifacts one persisted event produced, if any.
 *
 * Pure and total: every event type that carries none returns `[]`, so the writer can call it on
 * every append without a type switch of its own and the backfill can call it on every row it walks.
 *
 * Two provenances, and only two:
 *
 *  - a `tool_call` naming a WRITE. Written on the CALL, not on the result, even though the summary's
 *    renderer-side version waits for a non-error result. The result is a separate event with only a
 *    `toolUseId` on it, so pairing them here would mean holding every in-flight call in memory in
 *    the writer and re-joining them in the backfill — and the failure it would prevent is a file
 *    listed that a failed Write never created, which the browser discovers the moment it tries to
 *    open it. A row that might not be on disk is a better trade than a stateful indexer.
 *  - a `user_message`'s attachments, which are files already on disk by the time the event exists.
 */
export function artifactsFromEvent(
  { sessionId, spaceId, seq, ts, type, payload }:
  { sessionId: string; spaceId: string; seq: number; ts: number; type: string; payload: unknown },
): Artifact[] {
  const make = (kind: ArtifactKind, path: string): Artifact => {
    const name = basenameOf(path);
    return { id: `${sessionId}:${seq}:${path}`, sessionId, spaceId, kind, path, name, ext: extOf(name), ts };
  };

  if (type === "tool_call") {
    const p = payload as { name?: unknown; input?: unknown };
    if (typeof p?.name !== "string" || !WRITE_TOOL_NAMES.has(bareToolName(p.name))) return [];
    const input = (p.input ?? {}) as Record<string, unknown>;
    const path = writtenPathOf(input);
    return path === null ? [] : [make("output", path)];
  }

  if (type === "user_message") {
    const p = payload as { attachments?: unknown };
    if (!Array.isArray(p?.attachments)) return [];
    const out: Artifact[] = [];
    for (const a of p.attachments as { path?: unknown }[]) {
      if (typeof a?.path === "string" && a.path.trim() !== "") out.push(make("upload", a.path));
    }
    return out;
  }

  return [];
}

/** `mcp__server__Write` → `Write`. The same unwrapping the transcript's summary does, so a tool
 *  reached through MCP is indexed as the write it is rather than skipped for its prefix. */
export function bareToolName(name: string): string {
  const parts = name.split("__");
  return parts.length > 1 ? parts[parts.length - 1]! : name;
}

/** Whether the documents pane can open this artifact in place. The browser uses it to decide between
 *  opening a document and revealing a file — never to decide whether to LIST it. */
export const isOpenableArtifact = (path: string): boolean => documentKindFor(path) !== "unsupported";
