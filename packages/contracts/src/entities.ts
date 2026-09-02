import { z } from "zod";
import { LayoutSchema } from "./layout";
import { SpaceGroupsSchema } from "./groups";
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
  /** The space's pane groups — several named split arrangements, one of them active. Nullable only
   *  for the same reason `layout` is: a space nobody has opened yet has never had one written. */
  groups: SpaceGroupsSchema.nullable(),
  /** DERIVED, never stored independently: the active group's layout. Kept on Space so every reader
   *  that only ever wanted "what is on screen" (the sidebar glyph, the pane host) is unchanged by
   *  groups existing. Writing it (`spaces.setLayout`) replaces the ACTIVE group's layout. */
  layout: LayoutSchema.nullable(), activeItemId: IdSchema.nullable(), ...Timestamps,
});
export type Space = z.infer<typeof SpaceSchema>;

/**
 * A user-generated (AI-prompted) or uploaded icon, saved once per profile and reusable by any space
 * under it (Space icon picker's "Generated"/"Uploaded" sections) — `Space.icon = "asset:" + id`
 * (`parseSpaceIcon`, presets.ts) points at one of these. `dataText` is a base64 data URL for an
 * uploaded raster image, or raw sanitized SVG markup for a generated icon (`mime` disambiguates).
 */
export const IconAssetKindSchema = z.enum(["image", "generated"]);
export type IconAssetKind = z.infer<typeof IconAssetKindSchema>;
export const IconAssetSchema = z.object({
  id: IdSchema, profileId: IdSchema, kind: IconAssetKindSchema, mime: z.string(), dataText: z.string(),
  /** The description that produced it — null for uploads. */
  prompt: z.string().nullable(), createdAt: z.number().int(),
});
export type IconAsset = z.infer<typeof IconAssetSchema>;

export const ProjectSchema = z.object({
  id: IdSchema, spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(),
  defaultBranch: z.string().default("main"), ...Timestamps,
});
export type Project = z.infer<typeof ProjectSchema>;

/** `diff` (Plan 7 W3) is the one kind whose `refId` is not a session or terminal — it is an
 *  ENVIRONMENT id: a diff is a view of a checkout, and several sessions may share one.
 *  `space-page` (Plan 12 W3) follows that precedent: its `refId` is the SPACE id itself — the pane is
 *  the space's own page (General/Memory/Skills/Connections/Sessions/History), one per space.
 *  `documents` (Plan 17 W1) takes the `diff` route for the same reason: a document workspace is a view
 *  of a CHECKOUT, so several sessions sharing an environment share its documents. Its `refId` is a
 *  `document_workspaces` row id, and that row carries the environment. */
export const ItemKindSchema = z.enum(["session", "terminal", "browser", "simulator", "artifact", "context", "diff", "documents", "space-page", "library-page", "connections-page", "notifications-page", "settings-page", "profile-page"]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/**
 * Sentinel refIds for the sidebar's destination pages (Plan 12 W4: `library-page`, `connections-page`).
 *
 * These pages are identified by their KIND — there is no space, session or environment row behind them —
 * but every item must carry a refId and the RPC validates it as an id, so each page kind gets one
 * well-known ULID. They are valid per `IdSchema` yet unmintable by `newId()`: their timestamp component
 * is all zeros (1970), which a ULID generated today can never carry.
 *
 * One page item per SPACE, not per app: an item lives in a space's layout, and that `spaceId` is the
 * vantage the page's scope groups ("This space" / "From <profile>" / "Everywhere") are computed from.
 */
export const PAGE_REF_IDS = {
  "library-page": "00000000000000000000000001",
  "connections-page": "00000000000000000000000002",
  "notifications-page": "00000000000000000000000003",
  "settings-page": "00000000000000000000000004",
  // Plan 14 W2. The page shows the VANTAGE space's profile — the profile is derived live from
  // `item.spaceId`, never stored in the item, so a space moved between profiles moves its page's
  // subject with it (and a page can never keep editing a profile its space has left).
  "profile-page": "00000000000000000000000005",
} as const;
export type DestinationPageKind = keyof typeof PAGE_REF_IDS;

export const ItemSchema = z.object({
  id: IdSchema, spaceId: IdSchema, kind: ItemKindSchema, title: z.string(),
  sortOrder: z.number().int(), pinned: z.boolean(),
  /**
   * Shelved: the row keeps existing but leaves the space list, the pinned grid and the command
   * palette, and shows only in the sidebar's "Archived" section (where unarchiving it is one click).
   *
   * `pinned`'s exact opposite, and deliberately the same shape — a flag on the ITEM, not on the
   * session — because the thing being put away is the sidebar row, and `items.list` is the one query
   * every listing already goes through. Only session rows are offered the gesture today (archiving a
   * destination page or a session-owned terminal means nothing), but nothing in the column is
   * session-specific, so widening it is a UI change alone.
   */
  archived: z.boolean(), refId: IdSchema, ...Timestamps,
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
 * A document workspace's persisted half (Plan 17 W1) — the tab strip, so a restart reopens what was
 * open. Modelled on `BrowserSchema`: the row carries only what a restart needs, and everything live
 * (buffer text, dirty state, undo history, cursor) belongs to the renderer and dies with the pane.
 *
 * `openPaths` are RELATIVE to the environment's root, never absolute. Three reasons, in order of how
 * badly each bites: a worktree that moves on disk keeps its tabs; the DB never accrues absolute paths
 * carrying the user's home directory; and a relative path is the only shape that can be range-checked
 * for containment when it comes back in over RPC (see `resolveInRoot`) — an absolute path arriving
 * from a client is indistinguishable from an escape attempt.
 *
 * `activePath` must be a member of `openPaths` or null, enforced server-side rather than trusted from
 * the client: a stale active tab renders as an empty pane with no obvious way back.
 */
export const DocumentWorkspaceSchema = z.object({
  id: IdSchema, spaceId: IdSchema, environmentId: IdSchema,
  openPaths: z.array(z.string()), activePath: z.string().nullable(), ...Timestamps,
});
export type DocumentWorkspace = z.infer<typeof DocumentWorkspaceSchema>;

/** What `documents.list` returns for the pane's file picker: one entry per child of a directory. */
export const DocumentEntrySchema = z.object({
  /** Relative to the environment root, `/`-separated — the same shape `openPaths` uses. */
  path: z.string(), name: z.string(), isDir: z.boolean(),
  /** Bytes; 0 for directories. The picker greys out files past the editable ceiling. */
  size: z.number().int(),
});
export type DocumentEntry = z.infer<typeof DocumentEntrySchema>;

/**
 * The four editors' file types, decided by extension (Plan 17). `unsupported` is a real member, not an
 * error case: the picker still lists such a file and the pane shows a clear "not editable here" state
 * rather than opening an empty text buffer over a binary.
 */
export const DocumentKindSchema = z.enum(["doc", "sheet", "slides", "latex", "unsupported"]);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

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

/**
 * Every agent Realm can run. `acp:*` members all ride the ONE generic `AcpAdapter` — the prefix is a
 * promise about the protocol, not just a naming habit, and a kind without it needs its own adapter.
 *
 * Widening only: a new member is a compile error in each of the exhaustive `Record<AgentKind, …>`
 * tables (13 of them) and nothing else. `agent_kind TEXT NOT NULL` carries no CHECK constraint and the
 * read path never re-parses, so no persisted row can start failing.
 */
export const AgentKindSchema = z.enum([
  "claude", "codex", "acp:gemini", "acp:cursor",
  // Plan 18: every one of these answered a live ACP `initialize` on 2026-09-01 (see the plan's table).
  "acp:opencode", "acp:copilot", "acp:goose", "acp:qwen", "acp:grok", "acp:fx",
  "fake",
]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * How a session came to exist when something other than the user's own click created it (Plan 13 W1)
 * — the seam W2's Tasks lens filters on. `agent_run`/`browser_agent_run` are the two delegation
 * tools; `user-dispatch` is W2's ⌘⇧↩ composer gesture (the one origin with no parent agent);
 * `review` is W3's reviewer recipe (the diff pane's "Request review" or the `agent_review` tool —
 * `sessionId` is the requesting session for the tool path, null for the user's click); `fork` is
 * Plan 16 W3's "Fork from here" — `sessionId` is the ANCESTOR session the fork carried context from,
 * which that fork leaves byte-untouched; `import` is a transcript carried in from an agent CLI's own
 * store (`ImportService`), whose `sessionId` is null because nothing dispatched it — it already
 * existed. A session the user created normally has no dispatch origin at all (`dispatchedBy: null`), which is why this is
 * nullable rather than having a "user" member: absence IS the ordinary case, and no backfill invents
 * one.
 */
export const DispatchKindSchema = z.enum(["agent_run", "browser_agent_run", "user-dispatch", "review", "fork", "import", "run"]);
export type DispatchKind = z.infer<typeof DispatchKindSchema>;
export const DispatchedBySchema = z.object({
  /** The delegating session, or null for an origin with no parent agent (`user-dispatch`). */
  sessionId: IdSchema.nullable(),
  kind: DispatchKindSchema,
});
export type DispatchedBy = z.infer<typeof DispatchedBySchema>;
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
  /** Set when a delegation tool (or W2's dispatch gesture) created this session; null for every
   *  session the user created themselves. Recorded at creation, never rewritten. */
  dispatchedBy: DispatchedBySchema.nullable(),
  ...Timestamps,
});
export type Session = z.infer<typeof SessionSchema>;
