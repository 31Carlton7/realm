import { z } from "zod";

/**
 * mobile.v1 — the phone's own API (PROTOCOL.md §8). It is deliberately not the desktop's RPC: a call the
 * phone has no reason to make does not exist here, so the allowlist is the API itself rather than a
 * filter over a list of 200 methods that keeps growing. Phase 1 carried the subset the spike needed;
 * what came after carries what the desktop shows.
 *
 * Readers ignore fields they do not know (zod strips them), so the Mac can add a field without breaking
 * an older phone, and a newer phone's extra param reaches an older Mac harmlessly. Every field added
 * after Phase 1 is optional here for the same reason: a row from an older Mac still parses.
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
  /** The agent's name, as the desktop writes it ("Claude", "GitHub Copilot"). */
  agentName: z.string().optional(),
  /** Which mark the desktop draws for the agent: a vendor's mark ("claude", "openai") or a glyph ("bot"). */
  agentMark: z.string().optional(),
  /** The model as the desktop's chip names it ("Opus 5.5"), or its default's name while none is pinned. */
  modelLabel: z.string().optional(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

/** An answer to one question: an option's value or words of the person's own, several as a list. */
const AnswerValue = z.union([z.string().max(20_000), z.array(z.string().max(20_000)).max(100)]);
/** Question id → its answer, as the desktop's question card hands them back. */
const AnswersSchema = z.record(z.string(), AnswerValue);

const QuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  /** `value` is what the answer carries, where it is not the label itself. */
  options: z.array(z.object({ label: z.string(), description: z.string().optional(), value: z.string().optional() })),
  /** The key its answer goes under. Absent from an older Mac, where it was the question's text. */
  id: z.string().optional(),
  /** choice, multi, text, confirm, model, file, branch, time or link (the desktop's ask card). */
  kind: z.string().optional(),
  /** An answer of the person's own is taken beside the options. */
  allowOther: z.boolean().optional(),
  /** Typed into a masked field; the Mac keeps only a mark of it. */
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
  detail: z.string().optional(),
  placeholder: z.string().optional(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
});

const PlanStepSchema = z.object({ text: z.string(), status: z.string() });

const rowBase = { key: z.string(), seq: z.number().int() };

export const RowSchema = z.discriminatedUnion("kind", [
  z.object({ ...rowBase, kind: z.literal("user"), text: z.string() }),
  z.object({ ...rowBase, kind: z.literal("assistant"), text: z.string(), streaming: z.boolean() }),
  z.object({ ...rowBase, kind: z.literal("thinking"), text: z.string() }),
  z.object({ ...rowBase, kind: z.literal("tool"), name: z.string(), summary: z.string(), state: z.enum(["running", "done", "error"]), detail: z.string().nullable() }),
  z.object({
    ...rowBase, kind: z.literal("request"), requestId: z.string(), tool: z.string(), title: z.string(), summary: z.string(),
    state: z.enum(["pending", "allowed", "denied"]), questions: z.array(QuestionSchema).nullable(),
    /** Who asks a question: the agent, or an MCP server by the name the person gave it. */
    asker: z.string().optional(),
    /** What the asker said the questions are for. */
    message: z.string().optional(),
    /** The answers given, once there are some — a secret one only as its mark. */
    answers: AnswersSchema.optional(),
    /** A plan waiting to be approved (`ExitPlanMode`): its text, and its steps where the agent kept them. */
    plan: z.object({ text: z.string().nullable(), steps: z.array(PlanStepSchema).nullable() }).optional(),
  }),
  z.object({ ...rowBase, kind: z.literal("plan"), text: z.string().nullable(), steps: z.array(PlanStepSchema).nullable() }),
  z.object({
    ...rowBase, kind: z.literal("notice"), text: z.string(),
    /** A turn's changes: `session.changes` opens them by this. */
    checkpointId: z.string().optional(),
    /** A turn's files made, which `session.file` previews: each by its path on the Mac. */
    files: z.array(z.object({ path: z.string(), size: z.number() })).optional(),
  }),
  z.object({ ...rowBase, kind: z.literal("error"), text: z.string(), hint: z.string().nullable() }),
  z.object({ ...rowBase, kind: z.literal("unknown"), type: z.string() }),
]);
export type Row = z.infer<typeof RowSchema>;
export type RowKind = Row["kind"];

const Ok = z.object({ ok: z.literal(true) });

export const HomeSchema = z.object({
  mac: z.object({ name: z.string() }),
  needsYou: z.array(SessionRowSchema),
  spaces: z.array(z.object({
    id: Id, name: z.string(), icon: z.string(), color: z.string(), sessions: z.array(SessionRowSchema), more: z.number().int(),
    /** `icon` read: a glyph by its name, an emoji, or a picture of the person's own (`space.icon`). */
    iconKind: z.enum(["glyph", "emoji", "picture"]).optional(),
    glyph: z.string().optional(),
    emoji: z.string().optional(),
  })),
});
export type Home = z.infer<typeof HomeSchema>;

/** One file a turn changed, as git counted it. Lines are null for a binary file. */
const ChangedFileSchema = z.object({
  path: z.string(), oldPath: z.string().nullable(), status: z.enum(["added", "modified", "deleted", "renamed", "type-changed"]),
  additions: z.number().int().nullable(), deletions: z.number().int().nullable(),
});

export const TurnChangesSchema = z.object({ checkpointId: z.string(), files: z.array(ChangedFileSchema), totalFiles: z.number().int() });

/** A page of one file's unified diff: `lines[i]` is line `from + i`; `next` is the next page's `from`. */
export const DiffPageSchema = z.object({
  path: z.string(), oldPath: z.string().nullable(), status: ChangedFileSchema.shape.status,
  binary: z.boolean(), additions: z.number().int(), deletions: z.number().int(),
  lines: z.array(z.string()), from: z.number().int(), next: z.number().int().nullable(), total: z.number().int(),
  /** The Mac stopped reading the patch at its own ceiling (`truncatedReason` says which). */
  truncated: z.boolean(), truncatedReason: z.string().nullable(),
});

/** A file a turn made, as the phone may see it: a picture made smaller, the head of a text, or neither. */
export const FilePreviewSchema = z.object({
  path: z.string(), name: z.string(), size: z.number(), mime: z.string(),
  preview: z.discriminatedUnion("kind", [
    /** A JPEG no wider or taller than 1024 points, base64. */
    z.object({ kind: z.literal("image"), mime: z.string(), data: z.string() }),
    z.object({ kind: z.literal("text"), text: z.string(), truncated: z.boolean() }),
    z.object({ kind: z.literal("none"), reason: z.string() }),
  ]),
});

export const MobileCalls = {
  ping: { params: z.object({}), result: z.object({ at: z.number() }) },
  "home.get": { params: z.object({}), result: HomeSchema },
  "session.open": {
    params: z.object({ id: Id, limit: z.number().int().min(1).max(1000).default(200) }),
    result: z.object({
      session: SessionRowSchema, rows: z.array(RowSchema), hasMore: z.boolean(),
      /** The suggested next message (`prompt_hint`), until something is sent. */
      hint: z.string().nullable().optional(),
    }),
  },
  "session.close": { params: z.object({ id: Id }), result: Ok },
  "session.send": {
    params: z.object({ id: Id, text: z.string().min(1).max(100_000), delivery: z.enum(["auto", "queue", "steer"]).default("auto") }),
    result: Ok,
  },
  "session.answer": {
    params: z.object({ id: Id, requestId: z.string().min(1), decision: z.enum(["allow", "allow_always", "deny"]), answers: AnswersSchema.optional() }),
    result: Ok,
  },
  "session.stop": { params: z.object({ id: Id }), result: Ok },
  /** Marks the session read up to a row's seq, as opening it on the Mac does; never moves backwards. */
  "session.seen": { params: z.object({ id: Id, seq: z.number().int().min(0) }), result: Ok },
  "session.create": { params: z.object({ spaceId: Id, agent: z.string().min(1), text: z.string().min(1).max(100_000) }), result: z.object({ id: Id }) },
  /** The files one of the session's turns changed, by the checkpoint in front of it. */
  "session.changes": { params: z.object({ id: Id, checkpointId: Id }), result: TurnChangesSchema },
  /** One page of a file's diff across that turn: only a file the turn's changes list. */
  "session.diff": {
    params: z.object({ id: Id, checkpointId: Id, path: z.string().min(1).max(4096), from: z.number().int().min(0).default(0) }),
    result: DiffPageSchema,
  },
  /** A bounded preview of a file the session's turns made: only a file their `files_made` listed. */
  "session.file": { params: z.object({ id: Id, path: z.string().min(1).max(4096) }), result: FilePreviewSchema },
  /** A space's own picture, for an icon `home.get` calls a picture. */
  "space.icon": {
    params: z.object({ id: Id }),
    result: z.object({ mime: z.string(), data: z.string() }),
  },
  "debug.report": { params: z.object({ name: z.string().regex(/^[\w.-]{1,80}$/), data: z.unknown() }), result: Ok },
} as const;
export type MobileMethod = keyof typeof MobileCalls;
export type MobileParams<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["params"]>;
export type MobileResult<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["result"]>;

export const MobileEvents = {
  "session.rows": z.object({ id: Id, rows: z.array(RowSchema) }),
  "session.status": z.object({ id: Id, status: SessionStatusSchema }),
  /** The suggested next message changed: a new one after a turn, or none once something was sent. */
  "session.hint": z.object({ id: Id, text: z.string().nullable() }),
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
