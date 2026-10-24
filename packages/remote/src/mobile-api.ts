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
  /** When the session was made. */
  createdAt: z.number().optional(),
  /** The reasoning level pinned on the session, or null for the model's own. */
  effort: z.string().nullable().optional(),
  /** As the desktop stores it: how freely the agent acts ("default", "acceptEdits", "bypassPermissions"),
   *  or the mode it is in instead ("plan", "ask"). */
  permissionMode: z.string().nullable().optional(),
  /** When the conversation last moved: a prompt went out, or the agent answered or finished a turn. What
   *  every list of sessions is ordered by — not `updatedAt`, which a change of settings or a rename moves too. */
  activityAt: z.number().optional(),
  /** Pinned in the desktop's sidebar, so Home lists it in Pinned. */
  pinned: z.boolean().optional(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

/** A space's or a profile's icon, read: a glyph by its name, an emoji, or a picture of the person's own. */
const IconKindSchema = z.enum(["glyph", "emoji", "picture"]);

/** A profile, as the desktop's sidebar switches between them: a set of spaces. */
export const ProfileSchema = z.object({
  id: Id, name: z.string(), icon: z.string(), color: z.string(),
  iconKind: IconKindSchema.optional(),
  glyph: z.string().optional(),
  emoji: z.string().optional(),
  /** How many sessions in its spaces Needs you lists. */
  needsYou: z.number().int(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** One choice a picker offers: what is sent, and what is shown. */
const ChoiceSchema = z.object({ id: z.string(), label: z.string() });

/** A model an agent offers, as the desktop's picker names it. `id: null` is the agent's own default. */
const ModelChoiceSchema = z.object({
  id: z.string().nullable(),
  label: z.string(),
  /** The reasoning levels this model takes, where it takes any. */
  efforts: z.array(ChoiceSchema).optional(),
  defaultEffort: z.string().nullable().optional(),
});

/** What can be chosen for one agent: its models, reasoning levels, modes and permission rungs. */
export const AgentOptionsSchema = z.object({
  kind: z.string(),
  name: z.string(),
  /** Which mark the desktop draws for it, as `SessionRow.agentMark`. */
  mark: z.string(),
  /** Installed and signed in, as far as the Mac's last look found; `note` says why not. */
  available: z.boolean(),
  note: z.string().nullable(),
  models: z.array(ModelChoiceSchema),
  /** Reasoning levels that are the agent's own setting rather than a model's. */
  efforts: z.array(ChoiceSchema),
  /** Which of those it runs when none is chosen, where it names one. */
  defaultEffort: z.string().nullable().optional(),
  /** Build, then Plan and Ask where the agent has them. */
  modes: z.array(ChoiceSchema),
  /** How freely the agent may act, least to most; empty where Realm cannot set it for this agent. */
  permissions: z.array(ChoiceSchema),
  /** What Steer does to this agent's running turn, in words. */
  steerNote: z.string(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

/** What the Mac takes with one message (`session.send`, `session.create`). */
export const SendLimitsSchema = z.object({ maxCount: z.number().int(), maxBytes: z.number().int(), maxTotalBytes: z.number().int() });
export const SEND_LIMITS = { maxCount: 6, maxBytes: 8 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 } as const;

/** A file sent with a message: a photo taken or picked on the phone, or a file from its Files. */
const AttachmentUploadSchema = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  /** The file's bytes, base64. */
  data: z.string().min(1),
});

const MidTurnSchema = z.enum(["queue", "steer"]);

/** A session's settings as the composer shows them, and what each could be changed to. */
export const SessionOptionsSchema = z.object({
  agent: AgentOptionsSchema,
  model: z.string().nullable(),
  /** The model it runs on now as the chip names it: its default's name while none is pinned. */
  modelLabel: z.string(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  /** What a message typed while a turn runs does on this Mac, unless the phone says otherwise. */
  midTurn: MidTurnSchema,
  attachments: SendLimitsSchema,
});
export type SessionOptions = z.infer<typeof SessionOptionsSchema>;

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
  z.object({
    ...rowBase, kind: z.literal("user"), text: z.string(),
    /** What was sent with it, each file by its path on the Mac, which `session.file` previews. */
    attachments: z.array(z.object({ path: z.string(), name: z.string(), mime: z.string() })).optional(),
  }),
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

/** A message waiting in the Mac's queue for the turn it came during to end (`session.queue`). */
export const QueuedMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  /** Its files, by their paths on the Mac, which `session.file` previews. */
  attachments: z.array(z.object({ path: z.string(), name: z.string(), mime: z.string() })),
  /** When it was queued. */
  at: z.number(),
  /** Someone is editing it, on the Mac or a phone: nothing in the queue goes until the edit is saved or let go. */
  held: z.boolean(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/** A sub-agent a session started: its own session, and how its work went. */
export const SubagentSchema = z.object({
  session: SessionRowSchema,
  /** What it was asked to do. */
  goal: z.string().nullable(),
  startedAt: z.number(),
  /** When it finished; null while it works. */
  settledAt: z.number().nullable(),
  /** "done", "failed", "stopped" and the like, as the desktop's Agents tab says it; null while it works. */
  outcome: z.string().nullable(),
  /** Its last answer, the report its lead read. */
  report: z.string().nullable(),
  /** Why Realm stopped it itself, where it did. */
  note: z.string().nullable(),
});
export type Subagent = z.infer<typeof SubagentSchema>;

/** One window of a plan's quota: how much of it is used, and when it starts again. */
const PlanWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Percent used, 0 to 100; null when the provider named the window but not how full it is. */
  usedPercent: z.number().nullable(),
  resetsAt: z.number().nullable(),
});

/** One agent's plan, as the desktop's Usage page shows it. */
export const PlanLimitsSchema = z.object({
  agent: z.string(),
  agentName: z.string(),
  agentMark: z.string(),
  /** The provider's name for the tier ("max", "pro"), or null. */
  plan: z.string().nullable(),
  windows: z.array(PlanWindowSchema),
  /** The provider's warning, in the desktop's words, or null. */
  alert: z.string().nullable(),
  /** How far the warning goes, and the window it is about where the provider named one: the window the
   *  page draws in the warning's tone. Absent from a Mac older than them. */
  alertLevel: z.enum(["approaching", "exceeded"]).nullable().optional(),
  alertWindow: z.string().nullable().optional(),
  /** Why there are no windows to show ("not signed in", "not reported by this agent"), or null. */
  unavailable: z.string().nullable(),
  /** When this was last heard from the provider. */
  at: z.number(),
});

/** What is spent this calendar month, and the budget set for it on the Mac, in US dollars. */
export const SpendSchema = z.object({
  monthToDate: z.number(),
  budget: z.number().nullable(),
  /** The heaviest sessions this month, most expensive first. */
  topSessions: z.array(z.object({ id: Id, title: z.string(), spaceName: z.string(), cost: z.number() })),
});

/** Something a team's role handed back for the person to approve (Teams ▸ Review). */
export const ReviewSummarySchema = z.object({
  id: Id,
  spaceId: Id,
  spaceName: z.string(),
  roleName: z.string().nullable(),
  title: z.string(),
  /** The desktop's kind ("message", "post", "document", …) and state ("open", "approved", …). */
  kind: z.string(),
  state: z.string(),
  itemCount: z.number().int(),
  /** Who the first item goes to, where it names someone. */
  to: z.string().nullable(),
  channels: z.array(z.string()),
  /** The person's last note, from asking for changes. */
  note: z.string().nullable(),
  /** The role's session, which opens like any other. */
  sessionId: z.string().nullable(),
  updatedAt: z.number(),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

/** One thing a review asks to send or publish, as its draft reads. */
const ReviewItemSchema = z.object({
  id: Id,
  title: z.string().nullable(),
  /** The draft itself, as text (Markdown where the desktop draws Markdown). */
  body: z.string(),
  channel: z.string().nullable(),
  to: z.string().nullable(),
  /** Pictures that go with it, by their paths, which `review.file` previews. */
  files: z.array(z.object({ path: z.string(), name: z.string(), mime: z.string() })),
});

export const ReviewDetailSchema = z.object({ review: ReviewSummarySchema, items: z.array(ReviewItemSchema) });

/** A scheduled task (the desktop's Scheduled page), with how its last run went. */
export const ScheduledTaskSchema = z.object({
  id: Id,
  spaceId: Id,
  spaceName: z.string(),
  title: z.string(),
  /** When it runs, in words ("Every weekday at 9:00"), as the desktop says it. */
  when: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  /** The last run: its state in the desktop's words, the session it ran in, and whether it is unread. */
  lastRun: z.object({ state: z.string(), sessionId: z.string().nullable(), unread: z.boolean() }).nullable(),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/** The most sessions `home.get`'s `recent` holds. */
export const RECENT_LIMIT = 40;

export const HomeSchema = z.object({
  mac: z.object({ name: z.string() }),
  needsYou: z.array(SessionRowSchema),
  spaces: z.array(z.object({
    id: Id, name: z.string(), icon: z.string(), color: z.string(), sessions: z.array(SessionRowSchema), more: z.number().int(),
    /** `icon` read: a glyph by its name, an emoji, or a picture of the person's own (`space.icon`). */
    iconKind: IconKindSchema.optional(),
    glyph: z.string().optional(),
    emoji: z.string().optional(),
    /** The profile the space belongs to. */
    profileId: Id.optional(),
  })),
  /** Every profile, in the desktop's order. Spaces are listed under them. */
  profiles: z.array(ProfileSchema).optional(),
  /** The profile `recent` was gathered for, or null for every profile. */
  profileId: Id.nullable().optional(),
  /** The listed sessions active most recently in that profile, newest first, at most `RECENT_LIMIT`. */
  recent: z.array(SessionRowSchema).optional(),
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

/** What a session runs on, as `session.configure` changes it and `session.create` starts it. */
const sessionChoices = {
  /** A model by its id, or null for the agent's own default. */
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  mode: z.enum(["build", "plan", "ask"]).optional(),
  /** A permission rung by its id (`AgentOptions.permissions`). */
  permission: z.string().max(40).optional(),
};

export const MobileCalls = {
  ping: { params: z.object({}), result: z.object({ at: z.number() }) },
  /** `profileId` scopes `recent` to one profile; everything else is every profile's. */
  "home.get": { params: z.object({ profileId: Id.optional() }), result: HomeSchema },
  /** One page of a space's listed sessions, most recently active first: what Home's few leave out. */
  "space.sessions": {
    params: z.object({ id: Id, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }),
    result: z.object({ sessions: z.array(SessionRowSchema), more: z.boolean() }),
  },
  "session.open": {
    params: z.object({ id: Id, limit: z.number().int().min(1).max(1000).default(200) }),
    result: z.object({
      session: SessionRowSchema, rows: z.array(RowSchema), hasMore: z.boolean(),
      /** The suggested next message (`prompt_hint`), until something is sent. */
      hint: z.string().nullable().optional(),
      /** The messages waiting in the Mac's queue when the session opened. */
      queued: z.array(QueuedMessageSchema).optional(),
    }),
  },
  "session.close": { params: z.object({ id: Id }), result: Ok },
  /** Renames, pins or archives a session's row, as the desktop's sidebar does. Archived, it leaves every list. */
  "session.update": {
    params: z.object({ id: Id, title: z.string().min(1).max(200).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }),
    result: z.object({ session: SessionRowSchema.nullable() }),
  },
  /** The messages waiting in the Mac's queue; `session.queue` (the event) says when they change. */
  "session.queue": { params: z.object({ id: Id }), result: z.object({ queued: z.array(QueuedMessageSchema) }) },
  /** Sends one queued message now, ahead of the turn it was waiting for. */
  "session.sendQueuedNow": { params: z.object({ id: Id, queuedId: z.string().min(1) }), result: Ok },
  /** Takes a queued message out of the queue; it is not sent. */
  "session.removeQueued": { params: z.object({ id: Id, queuedId: z.string().min(1) }), result: Ok },
  /** Holds a queued message while it is edited here, or lets it go; nothing behind it goes meanwhile. */
  "session.holdQueued": { params: z.object({ id: Id, queuedId: z.string().min(1), held: z.boolean() }), result: Ok },
  /** Replaces a queued message's words, keeping its files, and lets it go. */
  "session.editQueued": { params: z.object({ id: Id, queuedId: z.string().min(1), text: z.string().max(100_000) }), result: Ok },
  /** The sub-agents a session started, newest first, as its Agents tab lists them. */
  "session.subagents": { params: z.object({ id: Id }), result: z.object({ subagents: z.array(SubagentSchema) }) },
  /** Every agent's plan limits, and this month's spend. */
  "usage.get": { params: z.object({}), result: z.object({ limits: z.array(PlanLimitsSchema), spend: SpendSchema }) },
  /** What teams have handed back for review and is still open, across every space, newest first. */
  "reviews.list": { params: z.object({}), result: z.object({ reviews: z.array(ReviewSummarySchema) }) },
  "review.get": { params: z.object({ id: Id }), result: ReviewDetailSchema },
  /** Approve, ask for changes (with a note), or reject (with a reason). Approving posts nothing: each
   *  outward act is still pressed on the Mac. */
  "review.decide": {
    params: z.object({ id: Id, decision: z.enum(["approve", "changes", "reject"]), note: z.string().max(5_000).optional() }),
    result: z.object({ review: ReviewSummarySchema }),
  },
  /** A preview of a picture a review's item carries: only one its items list. */
  "review.file": { params: z.object({ id: Id, path: z.string().min(1).max(4096) }), result: FilePreviewSchema },
  /** Every space's scheduled tasks, next to run first. */
  "schedules.list": { params: z.object({}), result: z.object({ tasks: z.array(ScheduledTaskSchema) }) },
  /** Runs a scheduled task now, as the desktop's Run now does. */
  "schedules.runNow": { params: z.object({ id: Id }), result: z.object({ task: ScheduledTaskSchema }) },
  /** `text` may be empty when files go with it; a message must carry one or the other. A phone offers
   *  files only to a Mac that answers `session.options`, since an older one would drop them. */
  "session.send": {
    params: z.object({
      id: Id, text: z.string().max(100_000), delivery: z.enum(["auto", "queue", "steer"]).default("auto"),
      attachments: z.array(AttachmentUploadSchema).max(SEND_LIMITS.maxCount).default([]),
    }),
    result: Ok,
  },
  /** The session's model, reasoning, mode and permissions, and what each could be changed to. */
  "session.options": { params: z.object({ id: Id }), result: SessionOptionsSchema },
  /** Changes what the composer's chips show; a field left out stays as it is. Leaving Plan or Ask for
   *  Build puts `permission` back, or the Mac's default for new sessions when none is given. */
  "session.configure": { params: z.object({ id: Id, ...sessionChoices }), result: SessionOptionsSchema },
  "session.answer": {
    params: z.object({ id: Id, requestId: z.string().min(1), decision: z.enum(["allow", "allow_always", "deny"]), answers: AnswersSchema.optional() }),
    result: Ok,
  },
  "session.stop": { params: z.object({ id: Id }), result: Ok },
  /** Marks the session read up to a row's seq, as opening it on the Mac does; never moves backwards. */
  "session.seen": { params: z.object({ id: Id, seq: z.number().int().min(0) }), result: Ok },
  /** A new session in a space, sent its first message. What is left out is the Mac's default. */
  "session.create": {
    params: z.object({
      spaceId: Id, agent: z.string().min(1), text: z.string().max(100_000), ...sessionChoices,
      attachments: z.array(AttachmentUploadSchema).max(SEND_LIMITS.maxCount).default([]),
    }),
    result: z.object({ id: Id }),
  },
  /** The agents a new session could be given, the one the Mac starts with, and what one message takes. */
  "agents.list": {
    params: z.object({}),
    result: z.object({ agents: z.array(AgentOptionsSchema), defaultAgent: z.string().nullable(), midTurn: MidTurnSchema, attachments: SendLimitsSchema }),
  },
  /** The files one of the session's turns changed, by the checkpoint in front of it. */
  "session.changes": { params: z.object({ id: Id, checkpointId: Id }), result: TurnChangesSchema },
  /** One page of a file's diff across that turn: only a file the turn's changes list. */
  "session.diff": {
    params: z.object({ id: Id, checkpointId: Id, path: z.string().min(1).max(4096), from: z.number().int().min(0).default(0) }),
    result: DiffPageSchema,
  },
  /** A bounded preview of a file the session's turns made, or of one sent with a message: only a file a
   *  `files_made` or a `user_message` of this session listed. */
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
  /** An open session's queue changed: the whole list, as the desktop's own event carries it. */
  "session.queue": z.object({ id: Id, queued: z.array(QueuedMessageSchema) }),
  /** An open session's sub-agents changed: one started, settled or was stopped. `session.subagents` reads them. */
  "session.subagents": z.object({ id: Id }),
  /** Reviews or scheduled tasks changed somewhere: `reviews.list` and `schedules.list` read them again. */
  "work.changed": z.object({}),
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
