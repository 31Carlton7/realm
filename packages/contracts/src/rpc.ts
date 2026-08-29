import { z } from "zod";
import { ProfileSchema, SpaceSchema, ProjectSchema, ItemSchema, ItemKindSchema, IdSchema, HexColorSchema, SessionSchema, AgentKindSchema, SessionStatusSchema, EnvironmentSchema } from "./entities";
import { LayoutSchema } from "./layout";
import { StoredSessionEventSchema } from "./session-events";

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

  "settings.get": { params: z.object({ key: z.string() }), result: z.object({ value: z.unknown() }) },
  "settings.set": { params: z.object({ key: z.string(), value: z.unknown() }), result: z.object({ ok: z.literal(true) }) },

  "system.info": { params: z.object({}), result: z.object({ realmHome: z.string(), version: z.string() }) },

  "workspace.gitInfo": { params: z.object({ cwd: z.string() }), result: GitInfoSchema.nullable() },

  /** `force` skips the server's TTL cache — what the install card's "Check again" and its window-focus
   *  refresh send, because a cached "not installed" is exactly what the user just fixed. */
  "agents.probe": { params: z.object({ force: z.boolean().default(false) }), result: z.array(z.object({ kind: AgentKindSchema, available: z.boolean(), version: z.string().nullable(), loggedIn: z.boolean().nullable(), reason: z.string().nullable() })) },
  "sessions.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(SessionSchema) },
  /** Every session across every space — the client's sessionId→spaceId map for cross-space badges. */
  "sessions.listAll": { params: z.object({}), result: z.array(SessionSchema) },
  "sessions.get":    { params: z.object({ id: IdSchema }), result: SessionSchema },
  /** `environmentId` pins the session to an existing checkout (the seam W2 uses to open one in a
   *  worktree). Omitted, the session lands in the project's checkout, or the space's primary. */
  "sessions.create": { params: z.object({ spaceId: IdSchema, agentKind: AgentKindSchema, projectId: IdSchema.nullable().default(null), environmentId: IdSchema.nullable().default(null), model: z.string().nullable().default(null), effort: z.string().nullable().default(null), permissionMode: z.string().default("default"), title: z.string().optional() }), result: z.object({ session: SessionSchema, itemId: IdSchema }) },
  "sessions.send":   { params: z.object({ id: IdSchema, text: z.string().min(1), attachments: z.array(z.object({ path: z.string(), mime: z.string() })).default([]) }), result: z.object({ ok: z.literal(true) }) },
  "sessions.interrupt": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },
  "sessions.respondPermission": { params: z.object({ id: IdSchema, requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]) }), result: z.object({ ok: z.literal(true) }) },
  "sessions.setOptions": { params: z.object({ id: IdSchema, model: z.string().optional(), effort: z.string().optional(), permissionMode: z.string().optional() }), result: SessionSchema },
  /** Re-point an untouched session at another agent. Server-guarded: rejected (SESSION_STARTED) once the
   *  session has any event — a transcript belongs to the agent that produced it. Clears `model`, since a
   *  model id from the old kind means nothing to the new one. */
  "sessions.setAgent": { params: z.object({ id: IdSchema, agentKind: AgentKindSchema }), result: SessionSchema },
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
  "terminal.data":    z.object({ terminalId: IdSchema, data: z.string() }),
  "terminal.exit":    z.object({ terminalId: IdSchema, exitCode: z.number().int() }),
  /** ephemeral = not persisted (seq = -1), e.g. assistant_delta */
  "session.event":    StoredSessionEventSchema.extend({ ephemeral: z.boolean() }),
  "session.status":   z.object({ sessionId: IdSchema, status: SessionStatusSchema }),
} as const;
export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = z.infer<(typeof Events)[E]>;
