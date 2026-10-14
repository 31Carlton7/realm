import { z } from "zod";

/**
 * mobile.v1 — the phone's own API (PROTOCOL.md §8). It is deliberately not the desktop's RPC: a call the
 * phone has no reason to make does not exist here, so the allowlist is the API itself rather than a
 * filter over a list of 200 methods that keeps growing. Phase 1 carries the subset the spike needs.
 *
 * Readers ignore fields they do not know (zod strips them), so the Mac can add a field without breaking
 * an older phone, and a newer phone's extra param reaches an older Mac harmlessly.
 */

const Id = z.string().min(1).max(64);

export const SessionStatusSchema = z.enum(["idle", "running", "waiting", "error", "ended"]);

export const SessionRowSchema = z.object({
  id: Id,
  title: z.string(),
  spaceId: Id,
  spaceName: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  status: SessionStatusSchema,
  needsYou: z.boolean(),
  unread: z.boolean(),
  updatedAt: z.number(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

const QuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
});

const rowBase = { key: z.string(), seq: z.number().int() };

export const RowSchema = z.discriminatedUnion("kind", [
  z.object({ ...rowBase, kind: z.literal("user"), text: z.string() }),
  z.object({ ...rowBase, kind: z.literal("assistant"), text: z.string(), streaming: z.boolean() }),
  z.object({ ...rowBase, kind: z.literal("thinking"), text: z.string() }),
  z.object({ ...rowBase, kind: z.literal("tool"), name: z.string(), summary: z.string(), state: z.enum(["running", "done", "error"]), detail: z.string().nullable() }),
  z.object({
    ...rowBase, kind: z.literal("request"), requestId: z.string(), tool: z.string(), title: z.string(), summary: z.string(),
    state: z.enum(["pending", "allowed", "denied"]), questions: z.array(QuestionSchema).nullable(),
  }),
  z.object({ ...rowBase, kind: z.literal("plan"), text: z.string().nullable(), steps: z.array(z.object({ text: z.string(), status: z.string() })).nullable() }),
  z.object({ ...rowBase, kind: z.literal("notice"), text: z.string() }),
  z.object({ ...rowBase, kind: z.literal("error"), text: z.string(), hint: z.string().nullable() }),
  z.object({ ...rowBase, kind: z.literal("unknown"), type: z.string() }),
]);
export type Row = z.infer<typeof RowSchema>;
export type RowKind = Row["kind"];

const Ok = z.object({ ok: z.literal(true) });

export const HomeSchema = z.object({
  mac: z.object({ name: z.string() }),
  needsYou: z.array(SessionRowSchema),
  spaces: z.array(z.object({ id: Id, name: z.string(), icon: z.string(), color: z.string(), sessions: z.array(SessionRowSchema), more: z.number().int() })),
});
export type Home = z.infer<typeof HomeSchema>;

export const MobileCalls = {
  ping: { params: z.object({}), result: z.object({ at: z.number() }) },
  "home.get": { params: z.object({}), result: HomeSchema },
  "session.open": {
    params: z.object({ id: Id, limit: z.number().int().min(1).max(1000).default(200) }),
    result: z.object({ session: SessionRowSchema, rows: z.array(RowSchema), hasMore: z.boolean() }),
  },
  "session.close": { params: z.object({ id: Id }), result: Ok },
  "session.send": {
    params: z.object({ id: Id, text: z.string().min(1).max(100_000), delivery: z.enum(["auto", "queue", "steer"]).default("auto") }),
    result: Ok,
  },
  "session.answer": {
    params: z.object({ id: Id, requestId: z.string().min(1), decision: z.enum(["allow", "allow_always", "deny"]), answers: z.record(z.string()).optional() }),
    result: Ok,
  },
  "session.stop": { params: z.object({ id: Id }), result: Ok },
  /** Marks the session read up to a row's seq, as opening it on the Mac does; never moves backwards. */
  "session.seen": { params: z.object({ id: Id, seq: z.number().int().min(0) }), result: Ok },
  "session.create": { params: z.object({ spaceId: Id, agent: z.string().min(1), text: z.string().min(1).max(100_000) }), result: z.object({ id: Id }) },
  "debug.report": { params: z.object({ name: z.string().regex(/^[\w.-]{1,80}$/), data: z.unknown() }), result: Ok },
} as const;
export type MobileMethod = keyof typeof MobileCalls;
export type MobileParams<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["params"]>;
export type MobileResult<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["result"]>;

export const MobileEvents = {
  "session.rows": z.object({ id: Id, rows: z.array(RowSchema) }),
  "session.status": z.object({ id: Id, status: SessionStatusSchema }),
  "home.changed": z.object({}),
  "pair.result": z.union([
    z.object({ ok: z.literal(true), phoneId: z.string() }),
    z.object({ ok: z.literal(false), reason: z.enum(["declined", "expired"]) }),
  ]),
} as const;
export type MobileEvent = keyof typeof MobileEvents;
export type MobileEventPayload<E extends MobileEvent> = z.infer<(typeof MobileEvents)[E]>;

export const MOBILE_ERROR = ["METHOD_NOT_FOUND", "INVALID_PARAMS", "NOT_FOUND", "FORBIDDEN", "SESSION_NOT_LIVE", "INTERNAL"] as const;
export type MobileErrorCode = (typeof MOBILE_ERROR)[number];

/** The envelope (§6), the same shape as the desktop's RPC. */
export type MobileRequest = { id: number; method: string; params: unknown };
export type MobileResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: MobileErrorCode; message: string } };
export type MobileEventMessage = { event: string; payload: unknown };
