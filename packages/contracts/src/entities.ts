import { z } from "zod";
import { LayoutSchema } from "./layout";
import { IdSchema } from "./ids";
export { IdSchema } from "./ids";

const Timestamps = { createdAt: z.number().int(), updatedAt: z.number().int() };
export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "expected #rrggbb");

export const ProfileSchema = z.object({
  id: IdSchema, name: z.string().min(1), icon: z.string(), color: z.string(),
  sortOrder: z.number().int(), ...Timestamps,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const SpaceSchema = z.object({
  id: IdSchema, profileId: IdSchema, name: z.string().min(1), icon: z.string(), color: HexColorSchema,
  sortOrder: z.number().int(), folderPath: z.string(),
  layout: LayoutSchema.nullable(), activeItemId: IdSchema.nullable(), ...Timestamps,
});
export type Space = z.infer<typeof SpaceSchema>;

export const ProjectSchema = z.object({
  id: IdSchema, spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(),
  defaultBranch: z.string().default("main"), ...Timestamps,
});
export type Project = z.infer<typeof ProjectSchema>;

/** `diff` (Plan 7 W3) is the one kind whose `refId` is an ENVIRONMENT id, not a session or terminal:
 *  a diff is a view of a checkout, and several sessions may share one. */
export const ItemKindSchema = z.enum(["session", "terminal", "browser", "simulator", "artifact", "context", "diff"]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemSchema = z.object({
  id: IdSchema, spaceId: IdSchema, kind: ItemKindSchema, title: z.string(),
  sortOrder: z.number().int(), pinned: z.boolean(), refId: IdSchema, ...Timestamps,
});
export type Item = z.infer<typeof ItemSchema>;

/**
 * A browser pane's persisted half (Plan 11 W1). The row carries only what a restart needs — the last
 * committed `url` and page `title`; the live `WebContentsView` (history, session state beyond the
 * `persist:browser` partition's own disk cache) belongs to Electron main and dies with the pane.
 * `url: ""` = never navigated (the pane opens on its empty state, not about:blank).
 */
export const BrowserSchema = z.object({
  id: IdSchema, spaceId: IdSchema, url: z.string(), title: z.string(), ...Timestamps,
});
export type Browser = z.infer<typeof BrowserSchema>;

/**
 * Where work happens, split out of Session (Plan 7 W1) so that several sessions can share one checkout
 * and W2 has somewhere to hang a worktree, a branch and a port block.
 *
 * - `primary`  — the space's own folder. Exactly one per space; Realm never removes it.
 * - `checkout` — an existing working copy Realm did not create (a project root). The record can be
 *                forgotten; the directory is the user's and is never touched.
 * - `worktree` — a `git worktree` Realm created and may remove, with W2's dirty/unpushed prompts.
 */
export const EnvironmentKindSchema = z.enum(["primary", "checkout", "worktree"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>;

export const EnvironmentSchema = z.object({
  id: IdSchema, spaceId: IdSchema,
  /** Absolute checkout path. Authoritative: `Session.cwd` is read off this. */
  path: z.string(),
  /** Null until something has actually asked git — W1 never populates it. */
  branch: z.string().nullable(),
  kind: EnvironmentKindSchema,
  /** First port of the environment's reserved block (W2). Always null in W1. */
  portBlockStart: z.number().int().nullable(),
  ...Timestamps,
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Why a checkpoint exists (Plan 7 W4).
 *
 * - `turn`        — taken automatically just BEFORE a message reaches the agent. Restoring it undoes
 *                   that turn and everything after it, which is what "go back to before I asked for
 *                   this" means.
 * - `pre-restore` — the state a restore was about to overwrite, captured by the restore itself. This
 *                   is what makes an accidental restore undoable, and it is the one kind retention
 *                   protects from pruning.
 * - `manual`      — the user asked for one.
 */
export const CheckpointKindSchema = z.enum(["turn", "pre-restore", "manual"]);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

/**
 * One captured workspace state. The `ref` is the only thing keeping the objects alive; the row is
 * the index over them. Delete the row without the ref and the objects leak; delete the ref without
 * the row and `restore` finds nothing — which is why `CheckpointService` only ever does both.
 */
export const CheckpointSchema = z.object({
  id: IdSchema,
  environmentId: IdSchema,
  /** The session whose turn produced it, or null for a checkpoint taken outside any session. */
  sessionId: IdSchema.nullable(),
  kind: CheckpointKindSchema,
  /** One line naming the turn — the first line of the user's message, or why the checkpoint was taken. */
  label: z.string(),
  /** `refs/realm/checkpoints/<environmentId>/<id>`. Invisible to `git branch`, `git log` and `git status`. */
  ref: z.string(),
  /** The checkpoint commit. `restore` refuses if the ref no longer resolves to exactly this. */
  commitSha: z.string(),
  /** Commit HEAD was on; null in a repository with no commits yet. */
  headSha: z.string().nullable(),
  /** The branch ref HEAD was on, or null when detached. Restore will not move a HEAD that has left it. */
  headRef: z.string().nullable(),
  createdAt: z.number().int(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const AgentKindSchema = z.enum(["claude", "codex", "acp:gemini", "acp:cursor", "fake"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;
export const SessionStatusSchema = z.enum(["idle", "running", "waiting_permission", "error", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const SessionSchema = z.object({
  id: IdSchema, spaceId: IdSchema, projectId: IdSchema.nullable(), agentKind: AgentKindSchema,
  model: z.string().nullable(), effort: z.string().nullable(), permissionMode: z.string(),
  /** The environment this session runs in. Several sessions may share one. */
  environmentId: IdSchema,
  /** Derived from the environment's `path`, not stored on the session — read-only for every consumer. */
  cwd: z.string(), status: SessionStatusSchema, providerSessionId: z.string().nullable(),
  title: z.string(), lastEventSeq: z.number().int(),
  /** The item of the session's own terminal side panel, once it has been opened at least once (W4).
   *  That item is hidden from every item listing — the terminal belongs to the session, not the space. */
  terminalItemId: IdSchema.nullable(),
  ...Timestamps,
});
export type Session = z.infer<typeof SessionSchema>;
