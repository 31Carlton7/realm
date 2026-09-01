import { z } from "zod";
import { AgentKindSchema } from "./entities";
import { IdSchema } from "./ids";
import { SkillIdSchema } from "./skills";

/**
 * Importing what the agent CLIs already have on disk — their transcripts, their memory files, their
 * skills — into Realm.
 *
 * **The ground rule is the one W3 set for memory and W1 set for skills, and it is not relaxed here:
 * the agents' directories are READ-ONLY.** `~/.claude`, `~/.codex`, `~/.cursor`, `~/.agents` and
 * `~/.gemini` are copied FROM and never written to, never moved, never cleaned up. An import that
 * "migrates" by deleting the source is an import that loses the user's history the first time it is
 * wrong about something, and it would also break the CLI the files belong to. Everything this
 * feature produces lands under Realm's own home or in Realm's database.
 *
 * The second rule is that a scan is a pure read. `import.scan` opens files and answers; it creates no
 * space, no session and no environment. Only `import.apply` writes, and only for the keys it is
 * handed — so the preview the user approves is the work that happens.
 */

/** Which agent CLI's on-disk store a candidate was read out of. Distinct from `AgentKind` because
 *  one CLI can produce several kinds (and because `acp:cursor` is a Realm-side name for a wire
 *  protocol, not the name of the directory the transcripts sit in). */
export const ImportSourceSchema = z.enum(["claude", "codex", "cursor"]);
export type ImportSource = z.infer<typeof ImportSourceSchema>;

/**
 * Why a candidate is proposed for the space it is proposed for — shown to the user, because "we think
 * this belongs in Versed" is only actionable if it says *how* it thinks so.
 *
 * Ordered strongest to weakest, and resolved in exactly that order (`matchSpace`):
 *
 * - `environment` — an environment row already points at this cwd. The strongest evidence there is:
 *   Realm has itself run work in that directory for that space.
 * - `project`     — a project's `rootPath` is the cwd or an ancestor of it.
 * - `space-folder`— the space's own folder is the cwd or an ancestor of it.
 * - `basename`    — no path evidence, but the cwd's last meaningful segment matches a space's name
 *                   (`.../Projects/versed` → "Versed"). Deliberately last among the real signals: it
 *                   is a coincidence-shaped match, and it is labelled so the user can distrust it.
 * - `fallback`    — nothing matched; the candidate goes to a profile's catch-all space.
 * - `none`        — not even a profile could be guessed. Nothing is imported without a target.
 */
export const ImportMatchReasonSchema = z.enum(["environment", "project", "space-folder", "basename", "fallback", "none"]);
export type ImportMatchReason = z.infer<typeof ImportMatchReasonSchema>;

/**
 * Where the scan proposes to put one candidate.
 *
 * `spaceId` null with a `fallbackProfileId` set is the "catch-all space does not exist yet" state:
 * the scan will NOT create it (a scan writes nothing), so it names the profile and lets `apply`
 * create the space if the user goes ahead. Both null is `reason: "none"` — a candidate with no home,
 * listed so the user can see it was found and skipped rather than silently dropped.
 */
export const ImportMatchSchema = z.object({
  spaceId: IdSchema.nullable(),
  /** The profile whose catch-all space would receive this, when `spaceId` is null. */
  fallbackProfileId: IdSchema.nullable(),
  reason: ImportMatchReasonSchema,
  /** The evidence in one phrase — the matched environment's path, the project name, the space folder.
   *  Null for `fallback`/`none`, which have no evidence by definition. */
  evidence: z.string().nullable(),
});
export type ImportMatch = z.infer<typeof ImportMatchSchema>;

/** One transcript found on disk. `key` is the source path: stable across scans, unique by
 *  construction, and the handle `apply` takes — so a user selecting rows in a preview and applying
 *  them later cannot address anything the scan did not offer. */
export const ImportSessionCandidateSchema = z.object({
  key: z.string(),
  source: ImportSourceSchema,
  /** The Realm agent this transcript replays as. */
  agentKind: AgentKindSchema,
  /** The CLI's own session id. Carried onto the imported row as `providerSessionId` when the cwd
   *  still exists, which is what makes an imported session resumable rather than an archive. */
  providerSessionId: z.string(),
  /** Absolute path of the transcript file (Claude/Codex) or session directory (Cursor). */
  path: z.string(),
  /** The directory the session ran in, as the transcript itself records it. */
  cwd: z.string(),
  /** Whether that directory is still there. False ⇒ the session imports as history with no provider
   *  link: resuming into a cwd that no longer exists fails inside the CLI, and a session that
   *  advertises "send to continue" and then cannot is worse than one that says it is an archive. */
  cwdExists: z.boolean(),
  title: z.string(),
  /** Spoken turns (user + assistant text). The count the user judges "is this worth keeping" on —
   *  tool chatter would make every session look substantial. */
  messages: z.number().int(),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Realm itself produced this transcript (a session started through Realm, or one of its live
   *  checks). Excluded by default: those conversations are already rows in this database, and
   *  importing them would duplicate every one of them. */
  fromRealm: z.boolean(),
  /** The cwd is a scratch directory — `/tmp`, `/private/var/folders/…`, a Realm live-check tree.
   *  Excluded by default: test noise, and the directory is usually gone already. */
  scratch: z.boolean(),
  /** A session row already carries this `providerSessionId`. Never re-imported; listed as evidence
   *  that the previous run did its job. */
  imported: z.boolean(),
  /**
   * Another candidate is a fuller copy of this same conversation.
   *
   * Codex writes a NEW rollout file every time a thread is resumed or forked, and each one replays
   * the whole conversation so far under the same `session_id`. On this machine 158 files are one
   * Stora thread and 14 are one quant-lab thread — 241 rollout files, 71 actual conversations.
   * Importing them all would produce 158 near-identical sessions; importing an arbitrary one loses
   * turns. So the richest replay of each id wins and the rest are marked here: hidden by default,
   * counted, and never imported (they would be refused by the provider-id dedup anyway).
   */
  duplicate: z.boolean(),
  match: ImportMatchSchema,
});
export type ImportSessionCandidate = z.infer<typeof ImportSessionCandidateSchema>;

/**
 * One project's memory folder (`~/.claude/projects/<slug>/memory`) — an index plus N fact files, which
 * is the shape the Claude memory tool writes and the shape this import preserves.
 *
 * It is NOT flattened into the space's memory document. The largest of these is 712k characters
 * against a `MEMORY_DOC_MAX` of 100k, so inlining would truncate ~85% of it and call that an import.
 * Instead the files are COPIED under Realm's home and the index goes into the doc pointing at them —
 * which is also how the source system works: an index in context, facts read on demand.
 */
export const ImportMemoryCandidateSchema = z.object({
  key: z.string(),
  source: ImportSourceSchema,
  /** Absolute path of the memory directory. */
  path: z.string(),
  /** The project cwd it belongs to — what the space match is computed from. */
  cwd: z.string(),
  /** Fact files, excluding the index itself. */
  files: z.number().int(),
  bytes: z.number().int(),
  /** Already copied into this space by a previous import (the destination folder exists). */
  imported: z.boolean(),
  match: ImportMatchSchema,
});
export type ImportMemoryCandidate = z.infer<typeof ImportMemoryCandidateSchema>;

/**
 * One skill directory found in an agent's user-level skills folder.
 *
 * Skills are global to the CLI they came from, so an imported one is written with NO scope entry —
 * which makes it a pre-scoping library entry, visible in every space (`SkillsService.scopeOf` →
 * `LEGACY_SPACE_SCOPE`). That is the honest translation of "installed for my user": the user can
 * promote or demote it afterwards, and no space's effective set is guessed at on their behalf.
 */
export const ImportSkillCandidateSchema = z.object({
  /** The library directory name it would take — also its identity, per `SkillIdSchema`. */
  key: SkillIdSchema,
  /** Which agent's folder it was found in, for display; several may offer the same id. */
  origins: z.array(z.string()),
  /** Absolute path of the `SKILL.md` that would be copied (the first origin's). */
  path: z.string(),
  name: z.string(),
  description: z.string(),
  /** `~/Realm/skills/<key>` already exists. Never overwritten — the library is the user's folder,
   *  and a skill they have edited must not be silently reverted to the CLI's copy. */
  imported: z.boolean(),
});
export type ImportSkillCandidate = z.infer<typeof ImportSkillCandidateSchema>;

/** What one source directory contributed, and why it contributed nothing when it did. `available`
 *  false means the directory is not there at all — the ordinary state for a CLI the user does not
 *  use, and not an error. */
export const ImportSourceReportSchema = z.object({
  source: ImportSourceSchema,
  root: z.string(),
  available: z.boolean(),
  sessions: z.number().int(),
  /** Transcripts found but unreadable — a truncated file, a store this build cannot decode. Counted
   *  rather than hidden: "we found 200 and could read 180" is the only honest way to report a
   *  best-effort parser. */
  unreadable: z.number().int(),
  note: z.string().nullable(),
});
export type ImportSourceReport = z.infer<typeof ImportSourceReportSchema>;

export const ImportScanSchema = z.object({
  sessions: z.array(ImportSessionCandidateSchema),
  memories: z.array(ImportMemoryCandidateSchema),
  skills: z.array(ImportSkillCandidateSchema),
  sources: z.array(ImportSourceReportSchema),
});
export type ImportScan = z.infer<typeof ImportScanSchema>;

/** The name a profile's catch-all space takes when `apply` has to create one (the user's own words
 *  for it: "a general space … like work or home or school"). One per profile, reused on later runs. */
export const IMPORTED_SPACE_NAME = "Imported";

/**
 * What a client asks `import.apply` to bring in — the wire shape of its params, named so callers can
 * build a selection without reaching into the `Methods` table.
 *
 * The targets are the USER's, not the matcher's: the panel sends back whatever the preview settled
 * on, including re-pointed rows. `spaceId` null with a `profileId` means the profile's catch-all
 * space, created by `apply` if it is not there yet.
 */
export type ImportApplyParams = {
  sessions?: { key: string; spaceId?: string | null; profileId?: string | null }[];
  memories?: { key: string; spaceId?: string | null; profileId?: string | null }[];
  skills?: string[];
};

/** What `apply` did with one candidate. `skipped` carries the reason in `detail` — a candidate the
 *  user selected but that turned out to be already imported, unreadable, or homeless. */
export const ImportOutcomeSchema = z.object({
  key: z.string(),
  state: z.enum(["imported", "skipped", "failed"]),
  /** The row it produced: a session id, or the space id a memory folder landed in. Null otherwise. */
  refId: z.string().nullable(),
  detail: z.string(),
});
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;

export const ImportResultSchema = z.object({
  sessions: z.array(ImportOutcomeSchema),
  memories: z.array(ImportOutcomeSchema),
  skills: z.array(ImportOutcomeSchema),
  /** Spaces `apply` created because a selected candidate had nowhere to go. */
  spacesCreated: z.array(z.object({ id: IdSchema, profileId: IdSchema, name: z.string() })),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

/**
 * The marker fencing an imported memory index inside a space's Realm memory document.
 *
 * Everything between the open and close marker is REPLACED on re-import; everything outside it is the
 * user's own writing and is never touched. Without the fence a second import would append a second
 * copy of the same index, and the only way back would be hand-editing the doc.
 */
export const IMPORT_MEMORY_MARKER_OPEN = "<!-- realm:imported-memory -->";
export const IMPORT_MEMORY_MARKER_CLOSE = "<!-- /realm:imported-memory -->";

/** Replace (or append) the fenced imported-memory block in a memory document. `block` empty removes
 *  the fence entirely, so un-importing leaves the doc as if it had never run. Pure string work, in
 *  contracts so the server writes it and the tests assert it through one implementation. */
export function withImportedMemory(doc: string, block: string): string {
  const open = doc.indexOf(IMPORT_MEMORY_MARKER_OPEN);
  const close = doc.indexOf(IMPORT_MEMORY_MARKER_CLOSE);
  const fenced = block.trim() === "" ? "" : `${IMPORT_MEMORY_MARKER_OPEN}\n${block.trim()}\n${IMPORT_MEMORY_MARKER_CLOSE}`;
  // A close marker before its open one (hand-edited into nonsense) is not a fence, and slicing on it
  // would eat the user's text. Treated as "no fence present": the block appends, nothing is lost.
  if (open === -1 || close < open) {
    const base = doc.trimEnd();
    if (fenced === "") return doc;
    return base === "" ? `${fenced}\n` : `${base}\n\n${fenced}\n`;
  }
  const before = doc.slice(0, open).trimEnd();
  const after = doc.slice(close + IMPORT_MEMORY_MARKER_CLOSE.length).trimStart();
  return [before, fenced, after].filter((p) => p !== "").join("\n\n").trimEnd() + "\n";
}
