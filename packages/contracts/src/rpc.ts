import { z } from "zod";
import { ProfileSchema, SpaceSchema, ProjectSchema, ItemSchema, ItemKindSchema, IdSchema, HexColorSchema, SessionSchema, AgentKindSchema, SessionStatusSchema, EnvironmentSchema, CheckpointSchema, BrowserSchema } from "./entities";

import { LayoutSchema } from "./layout";
import { StoredSessionEventSchema } from "./session-events";
import { SkillSchema, SkillIdSchema } from "./skills";
import { McpCallSchema, McpSecretsSchema, McpServerNameSchema, McpServerSchema, McpServerStatusSchema, McpToolSchema, McpTransportSchema, McpOauthStatusSchema } from "./mcp";
import { MEMORY_DOC_MAX, MemorySourcesSchema, MemoryStateSchema } from "./memory";
import { NotificationSchema } from "./notifications";

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
  "spaces.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

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

  "items.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ItemSchema) },
  /** Every item across every space (command palette search); newest-updated first. */
  "items.listAll": { params: z.object({}), result: z.array(ItemSchema) },
  "items.create": { params: z.object({ spaceId: IdSchema, kind: ItemKindSchema, title: z.string(), refId: IdSchema }), result: ItemSchema },
  "items.update": { params: z.object({ id: IdSchema, title: z.string().optional(), pinned: z.boolean().optional(), sortOrder: z.number().int().optional() }), result: ItemSchema },
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
  "system.info": { params: z.object({}), result: z.object({ realmHome: z.string(), version: z.string(), machineName: z.string() }) },

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
  /** `force` skips the server's TTL cache — what the install card's "Check again" and its window-focus
   *  refresh send, because a cached "not installed" is exactly what the user just fixed. */
  "agents.probe": { params: z.object({ force: z.boolean().default(false) }), result: z.array(z.object({ kind: AgentKindSchema, available: z.boolean(), version: z.string().nullable(), loggedIn: z.boolean().nullable(), reason: z.string().nullable(), models: z.array(z.object({ id: z.string(), label: z.string() })).nullable().optional() })) },
  "sessions.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(SessionSchema) },
  /** Every session across every space — the client's sessionId→spaceId map for cross-space badges. */
  "sessions.listAll": { params: z.object({}), result: z.array(SessionSchema) },
  "sessions.get":    { params: z.object({ id: IdSchema }), result: SessionSchema },
  /** `environmentId` pins the session to an existing checkout (the seam W2 uses to open one in a
   *  worktree). Omitted, the session lands in the project's checkout, or the space's primary.
   *  `permissionMode: null` (the instant-create paths, which never ask) means "the user's configured
   *  default" — resolved server-side from `DEFAULT_PERMISSION_MODE_KEY`, in ONE place, so the palette,
   *  ⌘N and "+" can never disagree about what a new session is allowed to do. */
  "sessions.create": { params: z.object({ spaceId: IdSchema, agentKind: AgentKindSchema, projectId: IdSchema.nullable().default(null), environmentId: IdSchema.nullable().default(null), model: z.string().nullable().default(null), effort: z.string().nullable().default(null), permissionMode: z.string().nullable().default(null), title: z.string().optional() }), result: z.object({ session: SessionSchema, itemId: IdSchema }) },
  /** `mentions`: the skill ids the prompter recognised as `@`-mentions in `text` (Plan 8 W4). The
   *  server re-validates each against the live library before anything resolves — a raw `@name` never
   *  reaches an agent wire, and a stale id degrades to plain text (see `mentions.ts`). */
  /** `text` may be empty ONLY when attachments carry the message (Plan 14 W5 — attachment-only
   *  sends). A message with neither is nothing at all and is refused here, not by an adapter. */
  "sessions.send":   { params: z.object({ id: IdSchema, text: z.string(), attachments: z.array(z.object({ path: z.string(), mime: z.string() })).default([]), mentions: z.array(SkillIdSchema).max(32).default([]) })
    .refine((p) => p.text.length > 0 || p.attachments.length > 0, { message: "a message needs text or at least one attachment" }), result: z.object({ ok: z.literal(true) }) },
  "sessions.interrupt": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  "sessions.respondPermission": { params: z.object({ id: IdSchema, requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]) }), result: z.object({ ok: z.literal(true) }) },
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
  "sessions.events":  { params: z.object({ id: IdSchema, afterSeq: z.number().int().default(0), limit: z.number().int().default(2000) }), result: z.array(StoredSessionEventSchema) },
  /** Get-or-create the session's terminal side panel (W4), at the session's cwd. Idempotent: the pty is
   *  spawned on the FIRST call and only then — a session whose panel is never opened never has one. */
  "sessions.openTerminal": { params: z.object({ id: IdSchema }), result: z.object({ terminalId: IdSchema, itemId: IdSchema }) },
  "sessions.delete":  { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]["result"]>;

export const Events = {
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
