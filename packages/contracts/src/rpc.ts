import { z } from "zod";
import { ProfileSchema, SpaceSchema, ProjectSchema, ItemSchema, ItemKindSchema, IdSchema } from "./entities";
import { LayoutSchema } from "./layout";

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

/** Method registry: params + result schemas. Server validates params; client types results. */
export const Methods = {
  "profiles.list":   { params: z.object({}), result: z.array(ProfileSchema) },
  "profiles.create": { params: z.object({ name: z.string().min(1), icon: z.string().default("user"), color: z.string().default("#6b7280") }), result: ProfileSchema },
  "profiles.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: z.string().optional(), sortOrder: z.number().int().optional() }), result: ProfileSchema },
  "profiles.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "spaces.list":   { params: z.object({}), result: z.array(SpaceSchema) },
  "spaces.create": { params: z.object({ profileId: IdSchema, name: z.string().min(1), icon: z.string().default("folder"), color: z.string().optional() }), result: SpaceSchema },
  "spaces.update": { params: z.object({ id: IdSchema, name: z.string().min(1).optional(), icon: z.string().optional(), color: z.string().optional(), profileId: IdSchema.optional(), sortOrder: z.number().int().optional(), activeItemId: IdSchema.nullable().optional() }), result: SpaceSchema },
  "spaces.reorder": { params: z.object({ ids: z.array(IdSchema) }), result: z.object({ ok: z.literal(true) }) },
  "spaces.setLayout": { params: z.object({ id: IdSchema, layout: LayoutSchema }), result: SpaceSchema },
  "spaces.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "projects.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ProjectSchema) },
  "projects.create": { params: z.object({ spaceId: IdSchema, name: z.string().min(1), rootPath: z.string(), defaultBranch: z.string().default("main") }), result: ProjectSchema },
  "projects.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "items.list":   { params: z.object({ spaceId: IdSchema }), result: z.array(ItemSchema) },
  "items.create": { params: z.object({ spaceId: IdSchema, kind: ItemKindSchema, title: z.string(), refId: IdSchema }), result: ItemSchema },
  "items.update": { params: z.object({ id: IdSchema, title: z.string().optional(), pinned: z.boolean().optional(), sortOrder: z.number().int().optional() }), result: ItemSchema },
  "items.delete": { params: z.object({ id: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "terminals.create": { params: z.object({ spaceId: IdSchema, cwd: z.string().optional(), cols: z.number().int().default(80), rows: z.number().int().default(24) }), result: z.object({ terminalId: IdSchema, itemId: IdSchema }) },
  "terminals.write":  { params: z.object({ terminalId: IdSchema, data: z.string() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.resize": { params: z.object({ terminalId: IdSchema, cols: z.number().int(), rows: z.number().int() }), result: z.object({ ok: z.literal(true) }) },
  "terminals.close":  { params: z.object({ terminalId: IdSchema }), result: z.object({ ok: z.literal(true) }) },

  "settings.get": { params: z.object({ key: z.string() }), result: z.object({ value: z.unknown() }) },
  "settings.set": { params: z.object({ key: z.string(), value: z.unknown() }), result: z.object({ ok: z.literal(true) }) },

  "system.info": { params: z.object({}), result: z.object({ realmHome: z.string(), version: z.string() }) },
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
} as const;
export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = z.infer<(typeof Events)[E]>;
