import { z } from "zod";
import type { CliJobStart, CliStatus } from "./cli";
import { ProfileSchema, SpaceSchema, ProjectSchema, ItemSchema, ItemKindSchema, IdSchema, HexColorSchema, SessionSchema, AgentKindSchema, SessionStatusSchema, EnvironmentSchema, CheckpointSchema, BrowserSchema, IconAssetSchema, DocumentWorkspaceSchema, DocumentEntrySchema, DocumentKindSchema } from "./entities";

import { ElementChipSchema, MAX_ELEMENT_CHIPS } from "./chips";
import { LayoutSchema } from "./layout";
import { SpaceGroupsSchema } from "./groups";
import { StoredSessionEventSchema } from "./session-events";
import { SkillSchema, SkillIdSchema, SkillSourceSchema } from "./skills";
import { McpCallSchema, McpSecretsSchema, McpServerNameSchema, McpServerSchema, McpServerStatusSchema, McpToolSchema, McpTransportSchema, McpOauthStatusSchema } from "./mcp";
import { MEMORY_DOC_MAX, MemorySourcesSchema, MemoryStateSchema } from "./memory";
import { NotificationSchema } from "./notifications";
import { RunAttemptSchema, RunConstraintsSchema, RunSchema, RunStateSchema } from "./runs";
import { ReviewResultSchema } from "./review";
import { DelegatedRunSchema } from "./delegation";
import { SEARCH_GROUP_LIMIT, SEARCH_GROUP_LIMIT_MAX, SEARCH_QUERY_MAX, SearchResultsSchema } from "./search";
import { ImportResultSchema, ImportScanSchema } from "./import";
import { GuideProgressSchema } from "./documents";
import { UsageBucketSchema, UsageBudgetSchema, UsageSummarySchema } from "./usage";
import { LectureSchema, PlynnImportResultSchema, PlynnMeetingSchema, StartLectureResultSchema } from "./school";

export const RpcRequestSchema = z.object({ id: z.string(), method: z.string(), params: z.unknown() });
export const RpcErrorSchema = z.object({ code: z.string(), message: z.string() });
export const RpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: RpcErrorSchema }),
]);
export const RpcEventSchema = z.object({ event: z.string(), payload: z.unknown() });
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcEvent = z.infer<typeof RpcEventSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;

export type WireMessage =
  | { kind: "request"; msg: RpcRequest } | { kind: "response"; msg: RpcResponse } | { kind: "event"; msg: RpcEvent };

export function parseWireMessage(raw: string): WireMessage {
  const json: unknown = JSON.parse(raw);
  const req = RpcRequestSchema.safeParse(json); if (req.success) return { kind: "request", msg: req.data };
  const res = RpcResponseSchema.safeParse(json); if (res.success) return { kind: "response", msg: res.data };
  const ev = RpcEventSchema.safeParse(json); if (ev.success) return { kind: "event", msg: ev.data };
  throw new Error("Unrecognized wire message");
}

/** Working-tree summary for a session/terminal cwd (composer context row). Null result = not a git
 *  repo, or git itself is missing/failing — the UI simply shows no git chips. */
export const GitInfoSchema = z.object({
  branch: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Entries in `git status --porcelain` (staged + unstaged + untracked). */
  dirty: z.number().int(),
  ahead: z.number().int(),
  behind: z.number().int(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

/** How a path differs from what git last recorded. `untracked` and `conflicted` are not `git diff`
 *  statuses but are what the user is looking at, so the pane needs words for them. */
export const DiffFileStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed", "untracked", "conflicted"]);
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;

/** One changed path. `staged` and `unstaged` are independent: a file edited after being staged is
 *  both, and has two different patches — which is why `workspace.fileDiff` takes a side. */
export const DiffFileSchema = z.object({
  path: z.string(),
  /** Where a rename or copy came from; null otherwise. */
  oldPath: z.string().nullable(),
  status: DiffFileStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
  binary: z.boolean(),
  /** Staged plus unstaged, as `--numstat` counts them. Zero for untracked files: their content is
   *  only read when the pane expands them (see the truncation policy in git-diff.ts). */
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

/** `workspace.diff`: the whole working tree as a file list. Null result = not a git repository. */
export const DiffSummarySchema = z.object({
  /** The checkout root every `path` is relative to — NOT the cwd that was asked about. */
  root: z.string(),
  branch: z.string().nullable(),
  /** At most DIFF_MAX_FILES entries. */
  files: z.array(DiffFileSchema),
  /** The true count, even when `files` was cut short. */
  totalFiles: z.number().int(),
  truncated: z.boolean(),
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

/** `meta` is git's `\ No newline at end of file`: it renders inside the hunk but numbers no line. */
export const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "del", "meta"]),
  text: z.string(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffHunkSchema = z.object({
  /** The text after `@@ … @@` — usually the enclosing function. */
  header: z.string(),
  oldStart: z.number().int(), oldLines: z.number().int(),
  newStart: z.number().int(), newLines: z.number().int(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

/** `workspace.fileDiff`: one file's patch, one side of the index. A binary file carries no hunks. */
export const FileDiffSchema = z.object({
  path: z.string(), oldPath: z.string().nullable(), staged: z.boolean(),
  binary: z.boolean(),
  hunks: z.array(DiffHunkSchema),
  /** True when the patch was cut short by the size or line ceiling; `truncatedReason` says which. */
  truncated: z.boolean(),
  truncatedReason: z.string().nullable(),
  additions: z.number().int(), deletions: z.number().int(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

/**
 * The three steps of `workspace.ship`, each reporting an explained state rather than raw stderr.
 *
 * Every non-happy state here is a thing the UI has words and a next action for. `failed` is the
 * deliberate catch-all, and only it carries git's own message.
 */
export const CommitOutcomeSchema = z.object({
  state: z.enum(["committed", "nothing-to-commit", "skipped", "no-identity", "failed"]),
  sha: z.string().nullable(), subject: z.string().nullable(), reason: z.string().nullable(),
});
export type CommitOutcome = z.infer<typeof CommitOutcomeSchema>;

/** `no-upstream` is the one the UI must offer to fix (`--set-upstream`); `rejected` is the one it must
 *  NOT offer to fix, because the only fix is a force-push and Realm does not have one. */
export const PushOutcomeSchema = z.object({
  state: z.enum(["pushed", "up-to-date", "no-remote", "no-upstream", "rejected", "detached", "skipped", "failed"]),
  remote: z.string().nullable(), branch: z.string().nullable(), reason: z.string().nullable(),
});
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

/** `compare` is the degraded path: no `gh`, not signed in, or not a host we can address — the user
 *  gets a URL to open, never silence. */
export const PrOutcomeSchema = z.object({
  state: z.enum(["created", "existing", "compare", "unavailable", "skipped"]),
  url: z.string().nullable(), reason: z.string().nullable(),
});
export type PrOutcome = z.infer<typeof PrOutcomeSchema>;

export const ShipResultSchema = z.object({ commit: CommitOutcomeSchema, push: PushOutcomeSchema, pr: PrOutcomeSchema });
export type ShipResult = z.infer<typeof ShipResultSchema>;

/**
 * One durable ship-log row (Plan 14 W1): what a `workspace.ship` actually DID to a checkout, written
 * the moment the legs settle — never what was hoped. A row exists when something durable happened (a
 * commit was made, or a push reached the remote); `pushState` then records the push leg verbatim, so
 * a commit whose push was rejected logs `rejected`, not silence and not `pushed`.
 *
 * Like a notification, this is a LOG: plain references, no foreign keys server-side — the record of a
 * ship stays true (and stays worth showing) after its worktree is removed.
 */
export const ShipSchema = z.object({
  id: IdSchema,
  environmentId: IdSchema,
  spaceId: IdSchema,
  /** Null when HEAD was detached at commit time — the commit still happened and still logs. */
  branch: z.string().nullable(),
  sha: z.string(),
  subject: z.string(),
  /** The PR/compare URL when the PR leg produced one; null when it was skipped or had none. */
  prUrl: z.string().nullable(),
  /** The push leg's outcome, verbatim (`PushOutcomeSchema.state`). `skipped` = a commit-only ship. */
  pushState: PushOutcomeSchema.shape.state,
  createdAt: z.number().int(),
});
export type Ship = z.infer<typeof ShipSchema>;

/** What removing a worktree would destroy, asked of git at the moment of asking (Plan 7 W2).
 *  `environments.removeWorktree` re-reads these and refuses unless the acknowledgement matches, so
 *  a confirmation the user gave before the agent wrote another file fails closed. */
export const WorktreeStatusSchema = z.object({
  environmentId: IdSchema,
  path: z.string(),
  branch: z.string().nullable(),
  /** False when the directory has already been removed by hand: removal then only prunes. */
  present: z.boolean(),
  /** Lines of `git status --porcelain` — uncommitted edits plus untracked files. */
  dirtyFiles: z.number().int(),
  /** Commits on the branch that no remote ref contains. */
  unpushedCommits: z.number().int(),
  /** False for `primary` and `checkout`, and while any session still runs here. */
  removable: z.boolean(),
  /** Why not, when `removable` is false — the same code `removeWorktree` would throw. */
  blockedBy: z.string().nullable(),
});
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

/** The caller's informed consent to lose exactly this much work. Both numbers must equal what git
 *  reports at removal time; `null` means "only proceed if there is nothing to lose". */
export const WorktreeAckSchema = z.object({
  dirtyFiles: z.number().int().nonnegative(),
  unpushedCommits: z.number().int().nonnegative(),
});
export type WorktreeAck = z.infer<typeof WorktreeAckSchema>;

/**
 * What restoring a checkpoint would cost, asked of git at the moment of asking (Plan 7 W4).
 *
 * Restoring is the most destructive thing Realm does to a working tree, so this exists to be SHOWN
 * before it happens, and `checkpoints.restore` re-reads it and refuses unless the acknowledgement
 * matches — a confirmation given before the agent wrote another file fails closed.
 *
 * Nothing here is unrecoverable: restore captures the state it is about to overwrite as a
 * `pre-restore` checkpoint first, and `undoCheckpointId` names it afterwards. The counts still matter,
 * because "you can undo this" is not a reason to hide what it does.
 */
export const RestorePreviewSchema = z.object({
  checkpointId: IdSchema,
  environmentId: IdSchema,
  /** The checkout that will be rewritten. */
  path: z.string(),
  label: z.string(),
  createdAt: z.number().int(),
  /** Paths that differ between the checkpoint and the checkout right now. */
  filesChanged: z.number().int(),
  /** Commits that would be rolled off the branch. Zero when HEAD cannot be moved. */
  commitsRolledBack: z.number().int(),
  /** False when the checkout has left the branch the checkpoint was taken on: files restore, HEAD does not. */
  headMovable: z.boolean(),
  headReason: z.string().nullable(),
  /** False when the ref is gone or no longer points at the recorded commit — the checkpoint is unusable. */
  intact: z.boolean(),
  /** True when the session's agent could also be rewound. Always false today; see AGENT_CONVERSATION_REWIND. */
  rewindsConversation: z.boolean(),
});
export type RestorePreview = z.infer<typeof RestorePreviewSchema>;

/** The caller's consent, naming exactly the numbers it was shown. */
export const RestoreAckSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  commitsRolledBack: z.number().int().nonnegative(),
});
export type RestoreAck = z.infer<typeof RestoreAckSchema>;

export const RestoreResultSchema = z.object({
  environmentId: IdSchema,
  /** The checkout that was rewritten — what the client invalidates its diffs and git chips for. */
  path: z.string(),
  /** The `pre-restore` checkpoint holding what was just overwritten — restore it to undo this restore. */
  undoCheckpointId: IdSchema.nullable(),
  headMoved: z.boolean(),
  filesChanged: z.number().int(),
  commitsRolledBack: z.number().int(),
  /** Untracked, non-ignored files deleted because they postdate the checkpoint. */
  filesRemoved: z.number().int(),
  /** False whenever the workspace was restored but the agent still remembers the turns. */
  conversationRewound: z.boolean(),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;

/** Method registry: params + result schemas. Server validates params; client types results. */
/**
 * The wire shapes for the CLI manager. They mirror `CliStatus` and `CliJobStart` in cli.ts, which
 * carry the prose; the `satisfies` is the lock that stops the wire and the type callers program
 * against drifting apart without a typecheck failure.
 */
export const CliActionSchema = z.enum(["install", "update"]);
export const CliStatusSchema = z.object({
  kind: AgentKindSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  binPath: z.string().nullable(),
  provenance: z.enum(["npm", "pnpm", "brew", "unknown"]),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  action: z.enum(["install", "update", "none"]),
  command: z.string().nullable(),
  refusal: z.string().nullable(),
}) satisfies z.ZodType<CliStatus>;
export const CliJobStartSchema = z.object({
  id: z.string(), kind: AgentKindSchema, action: CliActionSchema, command: z.string(),
}) satisfies z.ZodType<CliJobStart>;

export const Methods = {
  "profiles.list":   { params: z.object({}), result: z.array(ProfileSchema) },
  "profiles.create": { params: z.object({ name: z.string().min(1), icon: z.string().default("user"), color: z.string().default("#6b7280") }), result: ProfileSchema },
  "profiles.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: z.string().optional(), sortOrder: z.number().int().optional() }), result: ProfileSchema },
  "profiles.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "spaces.list":   { params: z.object({}), result: z.array(SpaceSchema) },
  "spaces.create": { params: z.object({ profileId: IdSchema, name: z.string().min(1), icon: z.string().default("folder"), color: HexColorSchema.optional() }), result: SpaceSchema },
  "spaces.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: HexColorSchema.optional(), profileId: IdSchema.optional(), sortOrder: z.number().int().optional(), activeItemId: IdSchema.nullable().optional() }), result: SpaceSchema },
  "spaces.reorder": { params: z.object({ ids: z.array(IdSchema) }), result: z.object({ ok: z.literal(true) }) },
  "spaces.setLayout": { params: z.object({ id: IdSchema, layout: LayoutSchema }), result: SpaceSchema },
  /** The whole group set in one write — group membership, names, the active pointer and each group's
   *  zoom all move together, and splitting them into per-field methods would let a reload land between
   *  two halves of one gesture. Supersedes `spaces.setLayout`, which stays for the layout-only path. */
  "spaces.setGroups": { params: z.object({ id: IdSchema, groups: SpaceGroupsSchema }), result: SpaceSchema },
  "spaces.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  // The icon picker's "Generated"/"Uploaded" library (per-profile, reusable across every space —
  // IconAssetsStore). "generate" is a one-shot Claude Agent SDK call server-side (generateSvgIcon),
  // so it can be slow — callers show a spinner, not an optimistic result.
  "iconAssets.list":     { params: z.object({ profileId: IdSchema }), result: z.array(IconAssetSchema) },
  "iconAssets.generate": { params: z.object({ profileId: IdSchema, prompt: z.string().min(1).max(300) }), result: IconAssetSchema },
  "iconAssets.upload":   { params: z.object({ profileId: IdSchema, path: z.string().min(1) }), result: IconAssetSchema },
  "iconAssets.delete":   { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "projects.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ProjectSchema) },
  "projects.create": { params: z.object({ spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(), defaultBranch: z.string().default("main") }), result: ProjectSchema },
  "projects.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  /** Every checkout the space knows about — its primary, plus any project root or worktree (W2). */
  "environments.list": { params: z.object({ spaceId: IdSchema }), result: z.array(EnvironmentSchema) },
  "environments.get":  { params: z.object({ id: IdSchema }), result: EnvironmentSchema },
  /** Forget an environment. Refused while any session still references it (ENVIRONMENT_IN_USE) and for a
   *  space's primary checkout (ENVIRONMENT_PRIMARY) — deleting the last session never removes one by
   *  itself. Removes the row only: taking a worktree off disk is W2's job, with its own safety prompts. */
  "environments.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** Create a `git worktree` AND its environment row as one operation (W2). Deliberately not a bare
   *  `environments.create`: a row pointing at an arbitrary directory could be given `kind:
   *  "worktree"`, and `removeWorktree` would then be reachable for a checkout Realm did not make.
   *  The only way to get a `worktree` row is for Realm to have created the worktree.
   *
   *  `from` names the checkout to branch off (default: the space's primary). Refuses when that is
   *  not a git repository (NOT_A_REPOSITORY — a plain directory is a normal Realm space) or has no
   *  commits yet (WORKTREE_NO_COMMITS). */
  "environments.createWorktree": { params: z.object({ spaceId: IdSchema, title: z.string().nullable().default(null), from: IdSchema.nullable().default(null) }), result: EnvironmentSchema },
  /** What `removeWorktree` would cost, and whether it is allowed at all. Read-only. */
  "environments.worktreeStatus": { params: z.object({ id: IdSchema }), result: WorktreeStatusSchema },
  /** Remove the worktree from disk and delete its branch. Refused outright for `primary`
   *  (ENVIRONMENT_PRIMARY) and `checkout` (ENVIRONMENT_NOT_WORKTREE), and while a session still
   *  runs there (ENVIRONMENT_IN_USE). A dirty tree or unpushed commits require `acknowledge` to
   *  carry the *exact* counts git reports at that moment (WORKTREE_UNSAFE otherwise) — `--force`
   *  and `branch -D` are unreachable without it. */
  "environments.removeWorktree": { params: z.object({ id: IdSchema, acknowledge: WorktreeAckSchema.nullable().default(null) }), result: z.object({ ok: z.literal(true) }) },

  /**
   * Checkpoints for a session, or for a whole environment when `sessionId` is null (Plan 7 W4).
   * Newest first. Read-only, and cheap: the rows are the index, git is not consulted.
   */
  "checkpoints.list": { params: z.object({ environmentId: IdSchema, sessionId: IdSchema.nullable().default(null) }), result: z.array(CheckpointSchema) },
  /** Take one now, because the user asked. The automatic per-turn capture is not an RPC — it happens
   *  inside `sessions.send`, in front of the agent. */
  "checkpoints.capture": { params: z.object({ environmentId: IdSchema, sessionId: IdSchema.nullable().default(null), label: z.string().default("Manual checkpoint") }), result: CheckpointSchema },
  /** What `checkpoints.restore` would cost, and whether the checkpoint is still usable. Read-only. */
  "checkpoints.preview": { params: z.object({ id: IdSchema }), result: RestorePreviewSchema },
  /**
   * Put the checkout back the way this checkpoint found it.
   *
   * `acknowledge` must carry the exact counts `checkpoints.preview` reports at the moment of restoring
   * (RESTORE_UNSAFE otherwise), the same contract `environments.removeWorktree` uses. The state being
   * overwritten is captured as a `pre-restore` checkpoint FIRST, and its id comes back as
   * `undoCheckpointId` — so a restore of the wrong thing is itself undoable.
   *
   * Refused while a session is still running in that environment (CHECKPOINT_ENVIRONMENT_BUSY):
   * rewriting a working tree under a live agent's feet corrupts whatever it is halfway through.
   */
  "checkpoints.restore": { params: z.object({ id: IdSchema, acknowledge: RestoreAckSchema }), result: RestoreResultSchema },

  /**
   * Deep search across ONE profile's world (Plan 16 W1): session transcripts (user + assistant text)
   * and item titles from the FTS index, skills and memory documents read live off disk at query time
   * (they are user-editable files; an index over them would only ever be a way to be wrong).
   *
   * Profile scoping is enforced HERE, by the server's space→profile join — a Work search must not
   * surface a School transcript, and no client-side filter is trusted with that. `limit` caps each
   * GROUP, not the whole answer.
   */
  "search.query": {
    params: z.object({ profileId: IdSchema, query: z.string().min(1).max(SEARCH_QUERY_MAX), limit: z.number().int().min(1).max(SEARCH_GROUP_LIMIT_MAX).default(SEARCH_GROUP_LIMIT) }),
    result: SearchResultsSchema,
  },

  /**
   * Import from the agent CLIs' own stores (`packages/contracts/src/import.ts`).
   *
   * `scan` WRITES NOTHING — it opens the CLIs' files read-only, matches what it finds to spaces, and
   * answers. It takes no parameters on purpose: what to include is the user's decision in the
   * preview, not a filter baked into the call, and a scan that silently omitted rows could not be
   * argued with. Filtering flags (`fromRealm`, `scratch`, `imported`) ride on every candidate so the
   * client can default them off and still show what it hid.
   *
   * `apply` is the only writer, and only for the keys it is handed. A key not produced by a scan
   * resolves to nothing and comes back `skipped` — this is not a "read any path on this machine"
   * call. Space targets are the CLIENT's, taken verbatim: the matcher does not get to overrule what
   * the user re-pointed. `profileId` with a null `spaceId` means "the catch-all space of that
   * profile", created here if it does not exist yet — the one write a scan deliberately would not do.
   */
  "import.scan":  { params: z.object({}), result: ImportScanSchema },
  "import.apply": {
    params: z.object({
      sessions: z.array(z.object({ key: z.string(), spaceId: IdSchema.nullable().default(null), profileId: IdSchema.nullable().default(null) })).default([]),
      memories: z.array(z.object({ key: z.string(), spaceId: IdSchema.nullable().default(null), profileId: IdSchema.nullable().default(null) })).default([]),
      skills: z.array(SkillIdSchema).default([]),
    }),
    result: ImportResultSchema,
  },

  /** The space's items, ARCHIVED ONES INCLUDED — the sidebar's "Archived" section is drawn from this
   *  same list, and a listing that hid them would leave nothing to unarchive from. Every caller that
   *  wants only live rows filters on `archived` itself. */
  "items.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ItemSchema) },
  /** Every item across every space (the command palette's jump list); newest-updated first. Archived
   *  rows are excluded — this list's whole job is "what can I jump to", and an archived row answering
   *  it would defeat the archiving.
   *
   *  `search.query` deliberately does NOT filter them: full-text search is what you reach for when
   *  you are looking for something you put away, so archiving hides rows from the listings and from
   *  nothing else. */
  "items.listAll": { params: z.object({}), result: z.array(ItemSchema) },
  "items.create": { params: z.object({ spaceId: IdSchema, kind: ItemKindSchema, title: z.string(), refId: IdSchema }), result: ItemSchema },
  "items.update": { params: z.object({ id: IdSchema, title: z.string().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), sortOrder: z.number().int().optional() }), result: ItemSchema },
  "items.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "terminals.create": { params: z.object({ spaceId: IdSchema, cwd: z.string().optional(), cols: z.number().int().default(80), rows: z.number().int().default(24) }), result: z.object({ terminalId: IdSchema, itemId: IdSchema }) },
  "terminals.write":  { params: z.object({ terminalId: IdSchema, data: z.string() }), result: z.object({ ok: z.literal(true) }) },
  /** Type a command into a terminal once its shell goes quiet. Never appends a newline: offered, not run. */
  "terminals.prefill": { params: z.object({ terminalId: IdSchema, command: z.string() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.resize": { params: z.object({ terminalId: IdSchema, cols: z.number().int(), rows: z.number().int() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.close":  { params: z.object({ terminalId: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  /** The browser trio is row + item only (Plan 11 W1): the native `WebContentsView` lives in Electron
   *  main and is driven over IPC, never through the server. These methods carry only what must survive
   *  a restart. `url` defaults to "" — a fresh pane opens on its empty state, not a page. */
  "browsers.create": { params: z.object({ spaceId: IdSchema, url: z.string().default("") }), result: z.object({ browserId: IdSchema, itemId: IdSchema, url: z.string() }) },
  "browsers.get":    { params: z.object({ browserId: IdSchema }), result: BrowserSchema },
  /** Last committed navigation state, written back by the renderer (debounced). A `title` also renames
   *  the browser's item — the pane header and sidebar track the page, as in any browser's tab strip. */
  "browsers.update": { params: z.object({ browserId: IdSchema, url: z.string().optional(), title: z.string().optional() }), result: z.object({ ok: z.literal(true) }) },
  "browsers.close":  { params: z.object({ browserId: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Where a download from this space's panes lands (Plan 23): `<project root>/downloads`, or null
   * when the space has no project and therefore no destination any Realm surface would show.
   *
   * The renderer needs this for the pane's blocked-download bar — the user's own downloads go to the
   * same directory the agent's do, resolved by the same server-side rule (`spaceDownloadDir`) rather
   * than by the renderer joining paths of its own.
   */
  "browsers.downloadDir": { params: z.object({ spaceId: IdSchema }), result: z.object({ dir: z.string().nullable() }) },

  /**
   * The document workspace (Plan 17 W1). Unlike the browser trio, the SERVER owns the content here —
   * documents are files on disk, and the server is the only process that reads, writes and watches
   * them. That is deliberate: it is what lets an agent edit a document with its ordinary Write/Edit
   * tools and have the change appear in the open pane, with no agent-facing document API at all.
   *
   * Every `path` on this surface is RELATIVE to the workspace's environment root and is re-validated
   * server-side on arrival (`resolveInRoot`); a client cannot reach outside the checkout by sending
   * an absolute path or a `..` segment.
   */
  /** `environmentId` is optional: omitted, the workspace roots at the space's PRIMARY checkout, created
   *  on demand. That is what lets "Documents" be openable from the sidebar of a space that has never
   *  run a session — the session-scoped gesture passes the session's environment explicitly. */
  "documents.create": { params: z.object({ spaceId: IdSchema, environmentId: IdSchema.optional() }), result: z.object({ documentsId: IdSchema, itemId: IdSchema }) },
  "documents.get":    { params: z.object({ documentsId: IdSchema }), result: DocumentWorkspaceSchema },
  /** The tab strip, persisted on every change. `activePath` outside `openPaths` is corrected, not
   *  rejected — a client racing its own close should not be able to strand the pane on a dead tab. */
  "documents.setTabs": { params: z.object({ documentsId: IdSchema, openPaths: z.array(z.string()), activePath: z.string().nullable() }), result: DocumentWorkspaceSchema },
  "documents.close":  { params: z.object({ documentsId: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** One directory level for the pane's file picker. `dir` is "" for the environment root. */
  "documents.list":   { params: z.object({ documentsId: IdSchema, dir: z.string().default("") }), result: z.object({ entries: z.array(DocumentEntrySchema) }) },
  /** `hash` is the content hash the client must send back with its next write — see `documents.write`. */
  "documents.read":   { params: z.object({ documentsId: IdSchema, path: z.string() }), result: z.object({ text: z.string(), hash: z.string() }) },
  /**
   * Save. `baseHash` is the hash the client last read or wrote, and the server refuses the write when
   * the file on disk no longer matches it — the lost-update guard. `null` means "this file should not
   * exist yet" (first save of a new document), which fails the same way if something created it first.
   *
   * A refusal is `CONFLICT` carrying the current text, so the pane can offer keep-mine / take-theirs /
   * diff without a second round trip. This is the check that stops an agent's edit and a user's
   * unsaved paragraph from silently destroying one another.
   */
  "documents.write":  {
    params: z.object({ documentsId: IdSchema, path: z.string(), text: z.string(), baseHash: z.string().nullable() }),
    // A conflict is a RESULT, not an error: it carries the current text so the pane can render
    // keep-mine / take-theirs / diff without a second round trip, and errors have nowhere to put a
    // payload. `ok: false` is the only shape a caller has to branch on.
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), hash: z.string() }),
      z.object({ ok: z.literal(false), currentText: z.string(), currentHash: z.string() }),
    ]),
  },
  /** Create a new document from its kind's template and open it. Fails if the path already exists. */
  "documents.createFile": { params: z.object({ documentsId: IdSchema, path: z.string(), kind: DocumentKindSchema, title: z.string() }), result: z.object({ path: z.string(), hash: z.string() }) },
  /**
   * Rename a document on disk, carrying its tab with it.
   *
   * This is what lets a document be CREATED before it is named: a new file lands as "Untitled
   * document" and the title is edited afterwards, in place, the way every document app works — rather
   * than the pane demanding a name up front for a file the user has not seen yet.
   *
   * Server-side rather than a write-then-delete in the renderer, for the same reason `write` is: the
   * server owns the watches, and a rename observed as "one file vanished, another appeared" would
   * close the open tab before the new one existed. Refuses to overwrite an existing file.
   */
  "documents.renameFile": { params: z.object({ documentsId: IdSchema, from: z.string(), to: z.string() }), result: z.object({ path: z.string() }) },
  /** Release this workspace's filesystem watches without touching its persisted tabs — what a pane
   *  calls when it unmounts. Closing a pane is layout-only (Plan 4), so the tab strip must survive it;
   *  the watches must not, or every pane ever opened keeps a watcher alive for the whole session. */
  "documents.detach": { params: z.object({ documentsId: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  // ---- Plan 22 (school workflows): previews, guide progress, lectures, the Plynn handoff ----------
  /** Where the document preview server listens. The renderer builds `http://127.0.0.1:<port>/p/<token>/
   *  <documentsId>/<path>` frame URLs from this; the token is minted per server boot and scoped by
   *  path so a guide's relative assets (`img src="fig.png"`) resolve under the same prefix. */
  "documents.previewInfo": { params: z.object({}), result: z.object({ port: z.number().int(), token: z.string() }) },
  /**
   * Surface ONE file in the documents pane: ensure the workspace over `environmentId` (the primary
   * checkout when omitted), add `path` to its tab strip as the active tab, and broadcast
   * `documents.openRequested` so a mounted pane opens the tab and the store brings the item on screen.
   * The agent-facing `docs_open` tool and the store's own "open this lecture" both come through here.
   */
  "documents.openPath": { params: z.object({ spaceId: IdSchema, environmentId: IdSchema.optional(), path: z.string() }), result: z.object({ documentsId: IdSchema, itemId: IdSchema, environmentId: IdSchema }) },
  /** A guide's quiz history from its sidecar; empty when there is none. */
  "documents.progressRead": { params: z.object({ documentsId: IdSchema, path: z.string() }), result: GuideProgressSchema },
  /** Fold one quiz attempt into the sidecar and return the updated history. */
  "documents.progressRecord": { params: z.object({ documentsId: IdSchema, path: z.string(), topic: z.string().min(1).max(200), correct: z.number().int().nonnegative(), total: z.number().int().positive() }), result: GuideProgressSchema },
  /** Create today's lecture file from the template (a numbered suffix if it exists), open it in the
   *  documents pane, and answer with everything the store needs to arrange the panes. */
  "lectures.start": { params: z.object({ spaceId: IdSchema, title: z.string().default("") }), result: StartLectureResultSchema },
  "lectures.list": { params: z.object({ spaceId: IdSchema }), result: z.object({ lectures: z.array(LectureSchema) }) },
  /** Plynn's meetings folder, newest first. `available` is false when the folder does not exist —
   *  Plynn not installed, or no meeting recorded yet — which the sheet says instead of showing an
   *  empty list that looks like a bug. A pure read. */
  "plynn.list": { params: z.object({}), result: z.object({ available: z.boolean(), folder: z.string(), meetings: z.array(PlynnMeetingSchema) }) },
  /** Copy the named recordings under `lectures/` in the space's primary checkout, with a front-matter
   *  header naming the source, and open the first in the documents pane. Plynn's files are untouched. */
  "plynn.import": { params: z.object({ spaceId: IdSchema, files: z.array(z.string()).min(1).max(100) }), result: PlynnImportResultSchema },

  /**
   * The browser agent host's side of the main↔server bridge (Plan 11 W3). Electron main — the process
   * that owns the `WebContentsView`s and their `webContents.debugger` — connects to this same RPC
   * socket as a client and `register`s itself as the ONE executor for browser CDP operations. The
   * server then sends it `browserHost.op` events (targeted at that client only, never broadcast) and
   * main answers each with a `browserHost.result` call. Loopback-only like the whole RPC surface; a
   * renderer could call `register` too, but it would only be volunteering to execute CDP work it has
   * no views for — there is no privilege to gain, every op still runs under main's own guards.
   */
  "browserHost.register": { params: z.object({}), result: z.object({ ok: z.literal(true) }) },
  "browserHost.result": { params: z.object({ callId: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }), result: z.object({ ok: z.literal(true) }) },

  "settings.get": { params: z.object({ key: z.string() }), result: z.object({ value: z.unknown() }) },
  "settings.set": { params: z.object({ key: z.string(), value: z.unknown() }), result: z.object({ ok: z.literal(true) }) },

  /**
   * Realm's skills library as this space sees it: every directory under `<realmHome>/skills`, each
   * carrying that space's own enabled flag. Read off disk every call — the library is a folder the
   * user is expected to edit, so there is nothing to invalidate.
   *
   * Malformed skills are listed with `valid: false` rather than dropped. They are never given to an
   * agent, but a skill that vanished because of a typo in its frontmatter has to be findable.
   */
  "skills.list": { params: z.object({ spaceId: IdSchema }), result: z.object({ root: z.string(), skills: z.array(SkillSchema) }) },
  /** Turn one skill on or off for one space. Unknown ids are accepted: a skill can be removed from
   *  disk and put back, and the preference should survive that. */
  "skills.setEnabled": { params: z.object({ spaceId: IdSchema, id: SkillIdSchema, enabled: z.boolean() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Move a skill's defining scope from space level to `spaceId`'s profile (W2). Effective-set neutral
   * for every space of that profile at the moment it runs: the per-space disabled-set applies to
   * inherited skills exactly as it applied before, so a skill disabled in a space stays disabled there.
   * What changes is reach — spaces of OTHER profiles stop seeing it, and profile spaces created later
   * inherit it ON by default.
   */
  "skills.promote": { params: z.object({ spaceId: IdSchema, id: SkillIdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** The inverse: pin a profile-scoped skill to `spaceId` alone (must be a space of its profile).
   *  This space's enable state is preserved; sibling spaces stop seeing it. */
  "skills.demote": { params: z.object({ spaceId: IdSchema, id: SkillIdSchema }), result: z.object({ ok: z.literal(true) }) },
  /**
   * The directories this space's scan reads, with what each contributed — Realm's library, the agent
   * directories found on this machine, each installed Claude plugin, the space folder's own, and any
   * the user added. `count` is from the same scan that answered `skills.list`, so the panel and the
   * list cannot disagree about where a skill came from.
   */
  "skills.sources": {
    params: z.object({ spaceId: IdSchema }),
    result: z.object({ sources: z.array(SkillSourceSchema) }),
  },
  /** Add a directory to scan for skills. Absolute paths only, and it must exist — a relative path
   *  would resolve against the server's cwd, which is not a directory the user picked. */
  "skills.addScanRoot": { params: z.object({ path: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },
  /** Stop scanning a user-added directory. Nothing on disk is touched, and the enabled entries of the
   *  skills under it are kept, so re-adding it restores exactly what was on. */
  "skills.removeScanRoot": { params: z.object({ path: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },

  /**
   * Every MCP server Realm knows about, each carrying this space's own enabled flag.
   *
   * The server list is global; only the enable flag is per-space. `secretNote` is `MCP_SECRET_STORAGE_NOTE`
   * and is returned on every call rather than left for the UI to remember, because a surface that takes an
   * API key has to say where the key is going.
   *
   * Secret VALUES never appear in the result — see `McpServerSchema`.
   */
  "mcp.list": { params: z.object({ spaceId: IdSchema }), result: z.object({ servers: z.array(McpServerSchema), secretNote: z.string() }) },
  /**
   * Define a server. `spaceId` is the space it was added from and the ONLY space it is enabled in:
   * a server is a process to spawn or a URL to send credentials to, so it is opt-in per space rather
   * than live everywhere the moment it exists. Pass `null` to add it enabled nowhere.
   *
   * `env` (stdio) and `headers` (http/sse) carry secret values in the clear, both on this wire and at
   * rest. `MCP_SECRET_STORAGE_NOTE` says so; do not build a UI for this method that does not.
   */
  "mcp.add": {
    params: z.object({
      spaceId: IdSchema.nullable().default(null),
      /** W2: pass a profile id to define the server at PROFILE scope instead — inherited (default ON,
       *  per-space disableable) by every space of that profile. Mutually exclusive with `spaceId`. */
      profileId: IdSchema.nullable().default(null),
      name: McpServerNameSchema,
      transport: McpTransportSchema,
      command: z.string().default(""), args: z.array(z.string()).default([]), env: McpSecretsSchema.default({}),
      url: z.string().default(""), headers: McpSecretsSchema.default({}),
    }),
    result: McpServerSchema,
  },
  /**
   * Change a server in place. Every field is optional and an omitted one is left alone — including
   * `env` and `headers`, so a UI that never received the secret values (it cannot: `mcp.list` does not
   * return them) can save a rename without wiping the API key it was not shown.
   *
   * Passing `env`/`headers` REPLACES the whole map, which is how a key is removed.
   */
  "mcp.update": {
    params: z.object({
      id: IdSchema,
      /** Only so the result can report `enabled` truthfully for the space the editor is open in.
       *  Editing a server never changes which spaces use it. */
      spaceId: IdSchema.nullable().default(null),
      name: McpServerNameSchema.optional(), transport: McpTransportSchema.optional(),
      command: z.string().optional(), args: z.array(z.string()).optional(), env: McpSecretsSchema.optional(),
      url: z.string().optional(), headers: McpSecretsSchema.optional(),
    }),
    result: McpServerSchema,
  },
  /** Forget a server everywhere, secrets included. Its per-space enable flags go with it. */
  "mcp.remove": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** Turn one server on or off for one space. Sessions already running keep the set they started with. */
  "mcp.setEnabled": { params: z.object({ spaceId: IdSchema, id: IdSchema, enabled: z.boolean() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Move a server's defining scope from space level to `spaceId`'s profile (W2). Effective-set neutral
   * at the moment it runs: every space of the profile where the server was not enabled gets a per-space
   * disable override, so promotion never arms a space that had not opted in. What changes is reach —
   * profile spaces created later inherit it ON, spaces of other profiles stop seeing it, and toggling
   * an inherited server flips the override instead of the space-scope enabled-set.
   */
  "mcp.promote": { params: z.object({ spaceId: IdSchema, id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** The inverse: pin a profile-scoped server to `spaceId` alone (must be a space of its profile).
   *  This space's effective on/off state is preserved; sibling spaces stop seeing it. */
  "mcp.demote": { params: z.object({ spaceId: IdSchema, id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Turn a Realm-native tool provider (`realm-browser` today) on or off for one space. Providers are
   * Realm's own in-process toolsets on the gateway, not server rows — and unlike servers they default
   * ON, because they are Realm's own code operating under Realm's own permission flow, not a process
   * the user configured. Sessions already connected see the change on their next `tools/list`
   * (the gateway re-checks at call time too, like any policy edit).
   */
  "mcp.setProviderEnabled": { params: z.object({ spaceId: IdSchema, name: z.string().min(1), enabled: z.boolean() }), result: z.object({ ok: z.literal(true) }) },
  /** The gateway's registered Realm-native providers with this space's switch state (W4: the
   *  Connections surface renders them as rows). Names come from the gateway registry, never config —
   *  a provider is code compiled into Realm, so this list is the same in every space; only `enabled`
   *  is per-space. */
  "mcp.providers.list": { params: z.object({ spaceId: IdSchema }), result: z.object({ providers: z.array(z.object({ name: z.string(), enabled: z.boolean() })) }) },
  /**
   * Actually try the server, now: spawn the stdio command (with its stored env) and wait for an MCP
   * initialize response, or hit the http/sse URL (with its stored headers) and report the status. Run
   * from the same server process that spawns sessions, so PATH and environment are the session's —
   * this is a LIVE check, not the banned definition-time validation. `detail` is one sentence and
   * never carries a secret value.
   *
   * Dials the UPSTREAM server directly, deliberately bypassing the hub: it answers "is this row's
   * command/URL reachable at all", which is the question a user asks while the hub's own status dot is
   * already saying `error`. The hub's cached status is the steady-state readout; this is the probe.
   */
  "mcp.test": { params: z.object({ id: IdSchema }), result: z.object({ reached: z.boolean(), detail: z.string() }) },
  /** The server's live tool list — triggers the hub's lazy connect (W2+). A connect failure comes back
   *  as `error` naming what went wrong, NOT a thrown RPC error: the list is still a renderable result,
   *  just an empty one with a reason attached. `tools` mirrors `mcp.list`'s cache on success. */
  "mcp.tools.list": { params: z.object({ id: IdSchema }), result: z.object({ tools: z.array(McpToolSchema), error: z.string().nullable() }) },
  /** Narrow this space's tools for one server to exactly `tools`; `null` restores "every cached tool
   *  allowed", the same default a server nobody has touched already has. */
  /** The space's computer-use allowlist: the applications an agent may drive there without a card.
   *  `set` returns the list AS STORED — forbidden bundle ids are dropped rather than accepted, so the
   *  caller renders what is really in effect. */
  "computer.allowedApps.list": { params: z.object({ spaceId: IdSchema }), result: z.object({ apps: z.array(z.string()) }) },
  "computer.allowedApps.set": { params: z.object({ spaceId: IdSchema, apps: z.array(z.string()) }), result: z.object({ apps: z.array(z.string()) }) },
  "mcp.setAllowedTools": { params: z.object({ spaceId: IdSchema, id: IdSchema, tools: z.array(z.string()).nullable() }), result: z.object({ ok: z.literal(true) }) },
  /** Realm's own call log (Activity), newest first — see `McpCallSchema`. `before` pages backward by a
   *  composite `{ ts, id }` cursor — a plain `ts` cursor drops same-millisecond siblings at a page
   *  boundary (W1 review amendment; `McpCallLogStore.list`'s doc comment has the full reasoning). W7's
   *  "Load more" passes the last row's `{ ts, id }` back in. `limit` defaults to 50 and is capped at 200,
   *  the same ceiling `McpCallLogStore.list` enforces. */
  "mcp.calls.list": {
    params: z.object({ sessionId: IdSchema.optional(), serverId: IdSchema.optional(), before: z.object({ ts: z.number().int(), id: IdSchema }).optional(), limit: z.number().int().min(1).max(200).optional() }),
    result: z.object({ calls: z.array(McpCallSchema) }),
  },
  /** Begin the OAuth dance for a remote server: the server prepares PKCE state and returns the
   *  authorization URL for the renderer to open in the system browser. */
  "mcp.oauth.start": { params: z.object({ id: IdSchema }), result: z.object({ authUrl: z.string() }) },
  /** Forget this server's OAuth connection. The server row survives; `oauthStatus` returns to
   *  `unconfigured` and calls fail until it is reconnected. */
  "mcp.oauth.disconnect": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** Close a tripped circuit breaker and let the next call try the upstream server again. */
  "mcp.retry": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  /**
   * This space's Realm memory document plus the state of its opt-in `AGENTS.md`. The document lives at
   * `<realmHome>/memory/<spaceId>.md` — Realm's home, never any agent's config — and is injected per
   * session (Claude `systemPrompt.append`, Codex `developerInstructions`; Cursor has no channel).
   */
  "memory.get": { params: z.object({ spaceId: IdSchema }), result: MemoryStateSchema },
  /** Replace the document. Sessions already running keep the context they started with; the next start
   *  carries the new text. Also rewrites the space's managed `AGENTS.md` when that toggle is on. */
  "memory.set": { params: z.object({ spaceId: IdSchema, doc: z.string().max(MEMORY_DOC_MAX) }), result: MemoryStateSchema },
  /**
   * The plan's one permitted write: turn the managed `AGENTS.md` in this space's own folder on or off.
   * Refused (AGENTS_FILE_NOT_REALM_FOLDER) when the space's primary checkout is a directory Realm did
   * not create, and (AGENTS_FILE_FOREIGN) when an `AGENTS.md` Realm did not write already sits there.
   * Turning it off removes the file only when it still carries Realm's marker.
   */
  "memory.setAgentsFile": { params: z.object({ spaceId: IdSchema, enabled: z.boolean() }), result: MemoryStateSchema },
  /** The PROFILE memory document (W2) — the standing context every space of the profile inherits ahead
   *  of its own doc. Lives at `<realmHome>/memory/profile-<profileId>.md`. */
  "memory.getProfile": { params: z.object({ profileId: IdSchema }), result: z.object({ profileId: IdSchema, path: z.string(), doc: z.string() }) },
  /** Replace the profile document. Same cap as a space doc; the COMBINED injection is additionally
   *  capped at `MEMORY_COMBINED_MAX` where the CLIs meet it (`systemContextFor`). */
  "memory.setProfile": { params: z.object({ profileId: IdSchema, doc: z.string().max(MEMORY_DOC_MAX) }), result: z.object({ profileId: IdSchema, path: z.string(), doc: z.string() }) },
  /** Per-space toggle for the inherited profile doc (W2): the profile doc is an inherited item like any
   *  other — ON by default, disableable per space, never editable from the space. */
  "memory.setProfileDocEnabled": { params: z.object({ spaceId: IdSchema, enabled: z.boolean() }), result: MemoryStateSchema },
  /**
   * Ground truth (or the honest absence of it) about the durable context one session's agent loads:
   * Codex sessions report the exact files (`instructionSources`, captured from THIS session's own
   * `thread/start`), Claude's hierarchy is modeled by reading the same paths the CLI reads, and Cursor
   * is a stated "nothing reaches this agent" row.
   */
  "memory.sources": { params: z.object({ sessionId: IdSchema }), result: MemorySourcesSchema },

  /** `machineName` is the Mac's user-facing ComputerName ("Carlton's M4 MacBook Pro"), falling back to
   *  the hostname stripped of `.local`. Display-only (the prompter's under-strip machine label, Plan 12
   *  W1): Realm runs agents on this machine and no other, so there is nothing to select. */
  "system.info": { params: z.object({}), result: z.object({ realmHome: z.string(), version: z.string(), machineName: z.string(), userName: z.string() }) },

  "workspace.gitInfo": { params: z.object({ cwd: z.string() }), result: GitInfoSchema.nullable() },

  /** Every changed path in the checkout containing `cwd`. Null when it is not a repository. Cheap by
   *  design — one `status` and two `--numstat` — because patches are fetched per file, on expansion. */
  "workspace.diff": { params: z.object({ cwd: z.string() }), result: DiffSummarySchema.nullable() },
  /** One file's patch, on one side of the index. `path` is relative to the checkout ROOT (the `root`
   *  `workspace.diff` reported), and is refused if it is absolute or contains `..`. */
  "workspace.fileDiff": { params: z.object({ cwd: z.string(), path: z.string(), staged: z.boolean().default(false) }), result: FileDiffSchema },
  /** `git add` for exactly these paths — per file, not per hunk. See git-write.ts for why. */
  "workspace.stage": { params: z.object({ cwd: z.string(), paths: z.array(z.string()).min(1) }), result: z.object({ ok: z.literal(true) }) },
  /** Take these paths back out of the index. Never touches the working tree. */
  "workspace.unstage": { params: z.object({ cwd: z.string(), paths: z.array(z.string()).min(1) }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Commit, push and open a pull request as ONE action, each step reporting its own outcome.
   *
   * `commit: false` is the retry path — the flow "no upstream, set one?" leads back here with the
   * commit already made, and a second commit would be wrong. `setUpstream` is only ever true because
   * the user was shown `no-upstream` and said yes. A commit with a blank message is refused outright
   * (COMMIT_EMPTY_MESSAGE) rather than reported as an outcome: it is a mistake, not a state.
   */
  "workspace.ship": {
    params: z.object({
      cwd: z.string(), commit: z.boolean().default(true), message: z.string().default(""),
      push: z.boolean().default(true), setUpstream: z.boolean().default(false), openPr: z.boolean().default(false),
      /** Which checkout row this ship belongs to, for the durable log (Plan 14 W1). The pane names its
       *  environment rather than the server guessing from `cwd` — a path can be registered in two
       *  spaces, and a guess is exactly how a ship row lands in the wrong one. Null (an environment-less
       *  caller) ships exactly as before and logs nothing. */
      environmentId: IdSchema.nullable().default(null),
    }),
    result: ShipResultSchema,
  },
  /** The durable ship log (Plan 14 W1), newest first, one space at a time — the space page's History
   *  tab interleaves these with checkpoints. Cursor pagination exactly as `notifications.list`:
   *  `cursor` is the previous page's `nextCursor`, opaque to clients. */
  "ships.list": {
    params: z.object({ spaceId: IdSchema, cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(200).default(100) }),
    result: z.object({ ships: z.array(ShipSchema), nextCursor: z.string().nullable() }),
  },

  /**
   * Durable runs — a goal that owns a session across attempts and survives restarts. One space at a
   * time, newest first; cursor pagination exactly as `ships.list` / `notifications.list`. `states`
   * narrows to a subset (the Tasks lens asks for the three live states); an empty array means all.
   */
  "runs.list": {
    params: z.object({ spaceId: IdSchema, states: z.array(RunStateSchema).default([]), cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(200).default(100) }),
    result: z.object({ runs: z.array(RunSchema), nextCursor: z.string().nullable() }),
  },
  /** One run plus its full attempt log, oldest attempt first. Null result = no such run (a run the
   *  caller holds can be deleted with its space under the click). */
  "runs.get": {
    params: z.object({ id: IdSchema }),
    result: z.object({ run: RunSchema, attempts: z.array(RunAttemptSchema) }).nullable(),
  },
  /**
   * Create a run and queue it. The call RETURNS as soon as the row exists — dispatch happens in the
   * background and every later transition arrives as `runs.changed`.
   *
   * **`dedupeKey` makes this idempotent, deliberately.** When the key already names a LIVE run of
   * this space, the existing run is returned unchanged rather than throwing: the caller is a poller
   * that cannot know whether it already fired, and making it distinguish "created" from "already
   * there" is exactly the bookkeeping the key exists to remove. `created` says which happened, for
   * callers that do care.
   */
  "runs.create": {
    params: z.object({
      spaceId: IdSchema,
      goal: z.string().min(1).max(8000),
      /** Omitted: derived from the goal's first words, like every other Realm title. */
      title: z.string().min(1).max(80).optional(),
      constraints: RunConstraintsSchema.nullable().default(null),
      dedupeKey: z.string().min(1).max(200).nullable().default(null),
      maxAttempts: z.number().int().min(1).max(10).default(1),
      /** Wall-clock deadline (epoch ms). Absolute, not a duration: a run outlives the process that
       *  started it, and a relative budget does not survive that. */
      deadlineAt: z.number().int().nullable().default(null),
    }),
    result: z.object({ run: RunSchema, created: z.boolean() }),
  },
  /** Cancel a live run: its current session is interrupted, the open attempt is closed `cancelled`,
   *  and the run goes terminal. A run that is ALREADY terminal is returned untouched — cancelling a
   *  finished run is a no-op, not an error (two windows can click it). */
  "runs.cancel": { params: z.object({ id: IdSchema }), result: RunSchema },
  /** Put a terminal run back on the queue for another attempt. The attempt COUNTER is preserved and
   *  `maxAttempts` is raised to fit if needed — an explicit human retry is not what the automatic
   *  attempt budget is there to stop. Refuses a run that is still live. */
  "runs.retry": { params: z.object({ id: IdSchema }), result: RunSchema },
  /**
   * Answer a `blocked` run: `approved: true` queues another attempt carrying `note` to the agent,
   * `approved: false` cancels it. THE HUMAN GATE — the one transition out of `blocked`, and the
   * reason unattended automation stops at a draft. Refuses a run that is not blocked.
   */
  "runs.approve": {
    params: z.object({ id: IdSchema, approved: z.boolean(), note: z.string().max(4000).nullable().default(null) }),
    result: RunSchema,
  },

  /**
   * The durable notifications feed (Plan 12 W5), newest first. GLOBAL — one feed across every space,
   * matching the sidebar row it feeds (the row sits above the space section). `cursor` is the previous
   * page's `nextCursor`, opaque to clients; `unread` is the whole feed's unread count and the ONE
   * source every badge renders — computed server-side, never by counting rows a client happens to hold.
   */
  "notifications.list": {
    params: z.object({ cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(200).default(100) }),
    result: z.object({ notifications: z.array(NotificationSchema), nextCursor: z.string().nullable(), unread: z.number().int() }),
  },
  /** Mark rows read: named `ids`, or `all: true` for the whole feed (global, deliberately — see
   *  `notifications.list`; there is no per-space feed for an "all" to leak across). Unknown ids are
   *  ignored, not errors: a row can be deleted (or already read from another window) under the click. */
  "notifications.markRead": {
    params: z.object({ ids: z.array(IdSchema).default([]), all: z.boolean().default(false) }),
    result: z.object({ ok: z.literal(true), unread: z.number().int() }),
  },
  /**
   * The reviewer recipe (Plan 13 W3): spawn a read-only reviewer session over this environment. The
   * call returns as soon as the reviewer session exists — the review itself takes minutes, and the
   * verdict arrives as a `review.changed` broadcast + a `review_done` notification when it settles.
   * One review per environment at a time (REVIEW_IN_FLIGHT otherwise). The reviewer is hard-capped
   * read-only (`plan` mode) and can never ship: review informs the human's ship click, never a
   * commit — see contracts/review.ts.
   */
  "review.request": { params: z.object({ environmentId: IdSchema }), result: z.object({ sessionId: IdSchema, itemId: IdSchema }) },
  /** The environment's latest persisted review verdict, or null (never reviewed, dismissed, or
   *  cleared by a ship). */
  "review.get": { params: z.object({ environmentId: IdSchema }), result: z.object({ review: ReviewResultSchema.nullable() }) },
  /** Dismiss the environment's persisted verdict (the diff-pane section's ✕). Server-side so every
   *  window's pane hears the `review.changed` that follows. */
  "review.dismiss": { params: z.object({ environmentId: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  /** The delegated runs this session is waiting on right now. The registry is in memory and dies
   *  with the process, so this is a read of live state, not of a table — a pane opened after a run
   *  began has no other way to learn about it, and `delegation.changed` carries it from then on. */
  "delegation.running": { params: z.object({ sessionId: IdSchema }), result: z.object({ running: z.array(DelegatedRunSchema) }) },
  /** `force` skips the server's TTL cache — what the install card's "Check again" and its window-focus
   *  refresh send, because a cached "not installed" is exactly what the user just fixed. */
  /**
   * Everything the Settings -> Usage tab draws, for one time range, in ONE call.
   *
   * One method rather than a family of them because the page's own rule is that the filter row scopes
   * every chart below it: a stat tile fetched separately from the chart under it can disagree with it
   * for a frame, and a reader who spots that stops trusting both. The server reads the range once and
   * every number on the page is a different grouping of that one read.
   *
   * `from`/`to` are absolute epoch ms - the client owns the presets, because "last 7 days" is a fact
   * about the reader's clock and the server has no business guessing their zone. `spaceId` and
   * `profileId` narrow the scope; both null is every space this machine has.
   */
  "usage.summary": {
    params: z.object({
      from: z.number().int(), to: z.number().int(),
      bucket: UsageBucketSchema.default("day"),
      spaceId: IdSchema.nullable().default(null),
      profileId: IdSchema.nullable().default(null),
    }),
    result: UsageSummarySchema,
  },
  /** Write the monthly ceiling and its alert thresholds. Answers the STORED budget (thresholds
   *  normalized), so the client renders what was actually saved rather than what it sent. */
  "usage.setBudget": { params: UsageBudgetSchema, result: UsageBudgetSchema },
  /** Availability of the local Graphify extractor. `force` bypasses the shared probe cache. */
  "graphify.probe": {
    params: z.object({ force: z.boolean().default(false) }),
    result: z.object({ available: z.boolean(), version: z.string().nullable(), reason: z.string().nullable() }),
  },
  /** Rebuild a space's code graph in its primary checkout and report the generated graph. */
  "graphify.update": {
    params: z.object({ spaceId: IdSchema }),
    result: z.object({
      nodes: z.number().int().nonnegative(), links: z.number().int().nonnegative(),
      communities: z.number().int().nonnegative(), graphPath: z.string(),
    }),
  },
  /** Prices, context windows and reasoning efforts for the model picker, from a public catalog
   *  (`ModelCatalogService`). Never fails: an unreachable catalog answers with whatever was cached,
   *  or with `[]`, and the picker simply shows rows without prices. `force` refetches past the TTL —
   *  the same "check again" gesture `agents.probe` has. */
  "models.catalog": { params: z.object({ force: z.boolean().default(false) }), result: z.object({ rows: z.array(z.object({
    key: z.string(), label: z.string(), vendor: z.string(),
    priceIn: z.number().nullable(), priceOut: z.number().nullable(), context: z.number().nullable(),
    efforts: z.array(z.string()), blurb: z.string().nullable(),
  })) }) },
  /**
   * Every agent CLI's install and update situation: what is on this machine, where it came from, what
   * the provider has published, and the one command a click would run. `force` bypasses both caches
   * behind it — the thirty-second probe and the six-hour version sweep — and is what "Check for
   * updates" and the end of an install both use.
   */
  "cli.status": { params: z.object({ force: z.boolean().default(false) }), result: z.object({ rows: z.array(CliStatusSchema) }) },
  /**
   * Start the install or update `cli.status` offered for this kind, and answer with the exact command
   * now running. Output arrives as `cli.output` events and the outcome as `cli.done`.
   *
   * The server re-derives the command from its OWN status rather than taking one from the caller, and
   * refuses when that status does not currently offer this action. The gate lives here for the same
   * reason the app updater's does: a hand-crafted call must not be able to talk Realm into running a
   * package manager it decided not to offer.
   */
  "cli.run": { params: z.object({ kind: AgentKindSchema, action: CliActionSchema }), result: CliJobStartSchema },
  "agents.probe": { params: z.object({ force: z.boolean().default(false) }), result: z.array(z.object({ kind: AgentKindSchema, available: z.boolean(), version: z.string().nullable(), loggedIn: z.boolean().nullable(), reason: z.string().nullable(), models: z.array(z.object({ id: z.string(), label: z.string() })).nullable().optional() })) },
  "sessions.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(SessionSchema) },
  /** Every session across every space — the client's sessionId→spaceId map for cross-space badges. */
  "sessions.listAll": { params: z.object({}), result: z.array(SessionSchema) },
  "sessions.get":    { params: z.object({ id: IdSchema }), result: SessionSchema },
  /** `environmentId` pins the session to an existing checkout (the seam W2 uses to open one in a
   *  worktree). Omitted, the session lands in the project's checkout, or the space's primary.
   *  `permissionMode: null` (the instant-create paths, which never ask) means "the user's configured
   *  default" — resolved server-side from `DEFAULT_PERMISSION_MODE_KEY`, in ONE place, so the palette,
   *  ⌘N and "+" can never disagree about what a new session is allowed to do.
   *  `userDispatched` (Plan 13 W2, the ⌘⇧↩ gesture) records `dispatchedBy: { kind: "user-dispatch",
   *  sessionId: null }` on the row — the Tasks lens's seam. Deliberately a boolean and not a
   *  DispatchedBy: the agent origins (`agent_run`/`browser_agent_run`/`review`) are recorded by the
   *  server-side tools that create those children, and a client must not be able to claim them. */
  "sessions.create": { params: z.object({ spaceId: IdSchema, agentKind: AgentKindSchema, projectId: IdSchema.nullable().default(null), environmentId: IdSchema.nullable().default(null), model: z.string().nullable().default(null), effort: z.string().nullable().default(null), permissionMode: z.string().nullable().default(null), title: z.string().optional(), userDispatched: z.boolean().default(false) }), result: z.object({ session: SessionSchema, itemId: IdSchema }) },
  /** `mentions`: the skill ids the prompter recognised as `@`-mentions in `text` (Plan 8 W4). The
   *  server re-validates each against the live library before anything resolves — a raw `@name` never
   *  reaches an agent wire, and a stale id degrades to plain text (see `mentions.ts`). */
  /** `text` may be empty ONLY when attachments carry the message (Plan 14 W5 — attachment-only
   *  sends). A message with neither is nothing at all and is refused here, not by an adapter.
   *
   *  `elements` is OPTIONAL rather than defaulted, and the prompter omits the key outright when the
   *  draft has no element chips — so a message that never touched a browser pane puts exactly the
   *  bytes on this wire that it always has. */
  "sessions.send":   { params: z.object({ id: IdSchema, text: z.string(), attachments: z.array(z.object({ path: z.string(), mime: z.string() })).default([]), mentions: z.array(SkillIdSchema).max(32).default([]), elements: z.array(ElementChipSchema).max(MAX_ELEMENT_CHIPS).optional() })
    .refine((p) => p.text.length > 0 || p.attachments.length > 0, { message: "a message needs text or at least one attachment" }), result: z.object({ ok: z.literal(true) }) },
  "sessions.interrupt": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  /** `answers` rides along only for question-shaped tools (AskUserQuestion): question text -> chosen
   *  label, multi-select comma-joined. Deliberately a record of strings rather than a free-form input
   *  override — the UI answers a question, it never gets to rewrite the tool's arguments. */
  "sessions.respondPermission": { params: z.object({ id: IdSchema, requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]), answers: z.record(z.string()).optional() }), result: z.object({ ok: z.literal(true) }) },
  "sessions.setOptions": { params: z.object({ id: IdSchema, model: z.string().optional(), effort: z.string().optional(), permissionMode: z.string().optional() }), result: SessionSchema },
  /** Re-point an untouched session at another agent. Server-guarded: rejected (SESSION_STARTED) once the
   *  session has any event — a transcript belongs to the agent that produced it. Clears `model`, since a
   *  model id from the old kind means nothing to the new one. */
  "sessions.setAgent": { params: z.object({ id: IdSchema, agentKind: AgentKindSchema }), result: SessionSchema },
  /** Re-point an untouched session at another of its space's environments (the under-strip's workspace
   *  selector, Plan 12 W1). Server-guarded exactly like `setAgent`: rejected (SESSION_STARTED) once the
   *  session has any event — a transcript's cwds, checkpoints and terminal all belong to the checkout
   *  that produced them. Cross-space environments are refused (ENVIRONMENT_WRONG_SPACE). `cwd` follows,
   *  since it is derived from the environment row on every read. */
  "sessions.setEnvironment": { params: z.object({ id: IdSchema, environmentId: IdSchema }), result: SessionSchema },
  /** Move an untouched session to another space (the sidebar's "Move to space…"). Server-guarded
   *  exactly like setAgent/setEnvironment: rejected (SESSION_STARTED) once the session has any event.
   *  Re-points environment_id at the destination space's primary checkout and clears project_id — a
   *  project is space-scoped and the old one names nothing in the destination. Any open terminal panel
   *  is torn down (its pty was rooted at the OLD cwd). The item is appended to the destination space's
   *  list; the origin space drops it via items.changed the same way sessions.delete does. Moving to the
   *  space a session is already in is a no-op, even once it has run. */
  "sessions.moveToSpace": { params: z.object({ id: IdSchema, spaceId: IdSchema }), result: SessionSchema },
  "sessions.events":  { params: z.object({ id: IdSchema, afterSeq: z.number().int().default(0), limit: z.number().int().default(2000) }), result: z.array(StoredSessionEventSchema) },
  /** Get-or-create the session's terminal side panel (W4), at the session's cwd. Idempotent: the pty is
   *  spawned on the FIRST call and only then — a session whose panel is never opened never has one. */
  "sessions.openTerminal": { params: z.object({ id: IdSchema }), result: z.object({ terminalId: IdSchema, itemId: IdSchema }) },
  /**
   * "Fork from here" (Plan 16 W3): a NEW worktree restored to this checkpoint's captured tree, plus a
   * NEW session pinned to it, `dispatchedBy: { kind: "fork", sessionId: <ancestor> }`. The ancestor
   * session, its environment and its checkpoints are left byte-untouched — the restore machinery runs
   * against the fresh worktree only, never in place. The provider conversation CANNOT be rewound
   * (AGENT_CONVERSATION_REWIND is false for every adapter), so the fork is a WORKSPACE fork: the
   * ancestor transcript up to the checkpoint rides into the new session as fenced text, truncated at
   * a stated cap — and the UI says exactly that.
   *
   * Refused when the checkpoint was not taken by a session turn (FORK_NO_SESSION — there is no
   * transcript or agent setup to fork), when that session has since been deleted (FORK_SESSION_GONE),
   * and when the checkpoint's git objects are gone (CHECKPOINT_GONE).
   */
  "sessions.fork": { params: z.object({ checkpointId: IdSchema }), result: z.object({ session: SessionSchema, itemId: IdSchema, environment: EnvironmentSchema }) },
  "sessions.delete":  { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]["result"]>;

export const Events = {
  /** One chunk of a running install's output. Broadcast rather than sent to the asking client: the
   *  Settings page and a session's install card can both be watching the same install. */
  "cli.output": z.object({ id: z.string(), kind: AgentKindSchema, chunk: z.string() }),
  /** An install or update finished. The probe and the version sweep have already been re-run by the
   *  time this lands, so a client that refetches `cli.status` on it reads the new machine. */
  "cli.done": z.object({ id: z.string(), kind: AgentKindSchema, ok: z.boolean(), code: z.number().nullable(), error: z.string().nullable() }),
  "profiles.changed": z.object({}),
  "spaces.changed":   z.object({}),
  "items.changed":    z.object({ spaceId: IdSchema }),
  /** A worktree was created or removed in this space (W2) — clients re-list environments. */
  "environments.changed": z.object({ spaceId: IdSchema }),
  /** A checkpoint was taken, restored or pruned in this environment (W4). Broadcast on every turn, so
   *  clients holding a checkpoint list re-fetch and everyone else ignores it. */
  "checkpoints.changed": z.object({ environmentId: IdSchema }),
  /** A space's skill set changed — either the library on disk or that space's enabled flags. Clients
   *  holding a skills list re-fetch; a session already running keeps the set it started with. */
  "skills.changed":   z.object({ spaceId: IdSchema }),
  /** An MCP server was added, edited, removed, or toggled for a space. Carries no payload because the
   *  server list is global: add/edit/remove change what EVERY space lists, and a per-space event would
   *  leave the other spaces' open settings panes stale. Clients holding a list re-fetch. */
  "mcp.changed":      z.object({}),
  /** One proxied call just completed — the live feed the Activity view appends to. Same shape as a row
   *  from `mcp.calls.list`, so a client can splice it straight into a held list. */
  "mcp.call":         McpCallSchema,
  /** A server row's hub connection state or OAuth status changed. Carries both together because a
   *  status flip is often the direct result of an OAuth transition (e.g. reconnect_needed → error). */
  "mcp.serverStatus": z.object({ id: IdSchema, status: McpServerStatusSchema, oauthStatus: McpOauthStatusSchema }),
  /** A space's Realm memory document or its managed `AGENTS.md` changed. Clients holding the memory
   *  pane re-fetch; sessions already running keep the context they started with. */
  "memory.changed":   z.object({ spaceId: IdSchema }),
  /** Realm itself changed a working tree (stage, unstage, commit, push). Carries the cwd the write
   *  went through; clients refresh every diff they hold, because two panes on the same repository may
   *  have asked from two different subdirectories and only the server knows they are the same tree. */
  "workspace.changed": z.object({ cwd: z.string() }),
  /** A ship-log row was written for this space (Plan 14 W1) — clients holding the space's ship list
   *  (the space page History tab) re-fetch; everyone else ignores it. */
  "ships.changed":    z.object({ spaceId: IdSchema }),
  /**
   * A document on disk changed underneath the pane (Plan 17 W1) — almost always an agent's Write/Edit,
   * occasionally the user's own editor or a git operation.
   *
   * Keyed by ENVIRONMENT, not by workspace: two panes rooted at the same checkout are both looking at
   * the same file and both must hear. `hash` is null when the file was deleted. Realm's own saves do
   * NOT produce this event — the service suppresses echoes of content it already knows about, or the
   * pane would fight its own autosave.
   */
  "documents.fileChanged": z.object({ environmentId: IdSchema, path: z.string(), hash: z.string().nullable() }),
  /** `documents.openPath` ran (Plan 22): a mounted pane over this workspace opens the tab, and the
   *  store puts the item on screen if the space is active. Carries the item so the store need not
   *  re-list. */
  "documents.openRequested": z.object({ spaceId: IdSchema, environmentId: IdSchema, documentsId: IdSchema, itemId: IdSchema, path: z.string() }),
  "terminal.data":    z.object({ terminalId: IdSchema, data: z.string() }),
  "terminal.exit":    z.object({ terminalId: IdSchema, exitCode: z.number().int() }),
  /** ephemeral = not persisted (seq = -1), e.g. assistant_delta */
  "session.event":    StoredSessionEventSchema.extend({ ephemeral: z.boolean() }),
  "session.status":   z.object({ sessionId: IdSchema, status: SessionStatusSchema }),
  /** One browser CDP operation for the registered browser host (Plan 11 W3). Sent TARGETED to the one
   *  client that called `browserHost.register`, never broadcast — see that method's doc comment. The
   *  host answers with a `browserHost.result` call carrying the same `callId`. */
  "browserHost.op":   z.object({ callId: z.string(), op: z.string(), params: z.record(z.unknown()) }),
  /** A parent session's `browser_agent_run` created a delegated browser-agent session (Plan 11 W5).
   *  The row + item already exist (`items.changed` was broadcast too); this tells the renderer to
   *  bring the child session INTO the layout — the whole point of a delegated agent being a real
   *  session is that the user watches its full trace. */
  "session.agentOpened": z.object({ spaceId: IdSchema, sessionId: IdSchema, itemId: IdSchema }),
  /** An agent opened a browser pane via `browser_open` (Plan 11 W3). The row + item already exist
   *  (`items.changed` was broadcast too); this tells the renderer to bring the pane INTO the layout —
   *  an agent-driven browser the user cannot see defeats the point of the architecture. */
  "browser.agentOpened": z.object({ spaceId: IdSchema, browserId: IdSchema, itemId: IdSchema }),
  /** The notifications feed changed (Plan 12 W5). `unread` is the fresh global unread count — the
   *  sidebar pill applies it directly, so the count has exactly one derivation site (the server's).
   *  `notification` is the row an event just created or re-surfaced, so the renderer can react to it
   *  (auto-reading a `session_done` for the pane the user is looking at) without a refetch race; null
   *  when the change was a markRead or a resolution, where a held list refetches instead. */
  "notifications.changed": z.object({ notification: NotificationSchema.nullable(), unread: z.number().int() }),
  /** A run's row changed (created, dispatched, settled, approved). Carries the fresh row so a Tasks
   *  lens applies it directly — the `notifications.changed` posture, no refetch race. `run` is null
   *  only for a bulk change with no single subject, where a held list refetches instead. */
  "runs.changed": z.object({ spaceId: IdSchema, run: RunSchema.nullable() }),
  /** An environment's persisted review verdict changed (Plan 13 W3): a review settled (`review` is
   *  the fresh result), or was dismissed / cleared by a ship (`review` is null). Diff panes holding
   *  this environment apply the payload directly — no refetch race. */
  "review.changed": z.object({ environmentId: IdSchema, review: ReviewResultSchema.nullable() }),
  /** The set of runs a session is waiting on changed — one began, settled, or was collected. Carries
   *  the WHOLE fresh set rather than a delta: the engine's registry is the only copy of this fact,
   *  and a renderer that had to accumulate deltas would drift out of step with it after one dropped
   *  frame. An empty `running` means the session is waiting on nothing, which is the resting state.
   *  Never sent for a reviewer the user started from the diff pane: that run has no delegating
   *  session, so there is no transcript for it to appear in. */
  "delegation.changed": z.object({ sessionId: IdSchema, running: z.array(DelegatedRunSchema) }),
  /** A mutating browser tool call SETTLED on this browser (Plan 11 W4) — the pane chrome's action
   *  ticker appends it. `text` is the same attributed description the permission card showed (page
   *  text only ever inside the `the page labels "…"` framing — never laundered into Realm's voice);
   *  `ok` is whether the action succeeded. Emitted after the act, never before. */
  "browser.action": z.object({ spaceId: IdSchema, browserId: IdSchema, text: z.string(), ok: z.boolean(), ts: z.number() }),
  /** An agent's act/batch step is in flight (`true`) or has settled/failed/timed out (`false`) on
   *  this browser (Plan 11 W4) — feeds the sidebar row and pane header's "agent is driving" dot.
   *  Every `true` is followed by a `false` on the same browserId, whatever the outcome. */
  "browser.driving": z.object({ spaceId: IdSchema, browserId: IdSchema, driving: z.boolean() }),
} as const;
export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = z.infer<(typeof Events)[E]>;
