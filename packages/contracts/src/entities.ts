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

export const ItemKindSchema = z.enum(["session", "terminal", "browser", "simulator", "artifact", "context"]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemSchema = z.object({
  id: IdSchema, spaceId: IdSchema, kind: ItemKindSchema, title: z.string(),
  sortOrder: z.number().int(), pinned: z.boolean(), refId: IdSchema, ...Timestamps,
});
export type Item = z.infer<typeof ItemSchema>;

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
