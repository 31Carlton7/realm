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

/** Where a session's goal stands, in the desktop's words (`GoalStatusSchema`): `active` is the only one
 *  that starts its own next turn; `paused`, `blocked` and `budget_limited` are stops a resume lifts. */
export const GoalStatusSchema = z.enum(["active", "paused", "blocked", "budget_limited", "complete", "abandoned"]);

/** The objective a session works towards across turns, as the desktop's goal strip draws it. */
export const GoalSchema = z.object({
  objective: z.string(),
  status: GoalStatusSchema,
  /** Turns run under it, the first one included. */
  turns: z.number().int(),
  tokensUsed: z.number().int(),
  /** Its ceiling in tokens, or null for none. */
  tokenBudget: z.number().int().nullable(),
  /** Why it stopped, in the agent's words or Realm's, or null. */
  note: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** One item of the agent's to-do list (TodoWrite), in the order the agent wrote them. `activeForm` is
 *  what an item in progress says it is doing ("Running the suite"), or null where the agent gave none. */
export const TodoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().nullable(),
});
export type Todo = z.infer<typeof TodoSchema>;

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
  /** The session that started it, where it is a sub-agent (`isChild`). Absent from an older Mac, and
   *  then the row stands on its own. */
  leadId: Id.optional(),
  /** On a listed lead: how many sub-agents are its, and so not rows of their own (`nestChildren`). */
  subagents: z.number().int().optional(),
  /** On a listed lead: how many of its sub-agents wait on a request, which the sidebar says on its row. */
  subagentsWaiting: z.number().int().optional(),
  /** On a listed lead: the sub-agent that has waited longest, which its row opens on. */
  subagentWaiting: Id.optional(),
  /** Being moved to another checkout. `status` says `running` meanwhile, which is all a phone from
   *  before moves knows to wait on. */
  moving: z.boolean().optional(),
  /** The goal it pursues, as the desktop's strip names it: its status and its objective. Absent for
   *  a session with none, and from a Mac before goals reached the phone. */
  goal: z.object({ status: GoalStatusSchema, objective: z.string() }).optional(),
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

/** What an `@[label]` in a message's words names, as the desktop's prompter keeps it beside its draft:
 *  a teammate, which is handed the message in its own chat, or a file in the session's folder. A label
 *  is at most the desktop's chip's 56 characters. */
const MentionRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), label: z.string().min(1).max(56), roleId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("file"), label: z.string().min(1).max(56), path: z.string().min(2).max(4096) }),
]);
export type MentionRef = z.infer<typeof MentionRefSchema>;

/** One of the person's own `/` commands, from `<space>/commands`, `~/Realm/commands` or `~/.claude/commands`. */
export const UserCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** What it takes after its name (`<file> [--fix]`): one that names none runs on nothing. */
  argumentHint: z.string().nullable(),
});
export type UserCommand = z.infer<typeof UserCommandSchema>;

/** A skill the session's agent can be handed by `@id`. */
export const MentionSkillSchema = z.object({ id: z.string(), name: z.string(), description: z.string() });
export type MentionSkill = z.infer<typeof MentionSkillSchema>;

/** A file in the session's folder an `@` can name: `path` is where it is, `rel` where it is in the folder. */
export const MentionFileSchema = z.object({ path: z.string(), rel: z.string() });
export type MentionFile = z.infer<typeof MentionFileSchema>;

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
    /** Another teammate wrote it, with `team_message`: its words stand under that teammate, not in the
     *  person's bubble. */
    teammateId: Id.optional(),
  }),
  z.object({ ...rowBase, kind: z.literal("assistant"), text: z.string(), streaming: z.boolean() }),
  z.object({ ...rowBase, kind: z.literal("thinking"), text: z.string() }),
  z.object({
    ...rowBase, kind: z.literal("tool"), name: z.string(), summary: z.string(), state: z.enum(["running", "done", "error"]), detail: z.string().nullable(),
    /** A message to a teammate (`team_message`): the teammate it went to, by its id where the space has
     *  it, and the words, without the "From @handle: " put in front of them for the agent. */
    teammate: z.object({ id: Id.nullable(), handle: z.string(), message: z.string() }).optional(),
  }),
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
    /** A notice about moving the session: `moving` while it goes (the same row then says how it
     *  ended), `moved` once it runs in the new place, `failed` when it stayed where it was. */
    move: z.enum(["moving", "moved", "failed"]).optional(),
    /** Shown on a tap: a move's paths, from and to, or why a failed move stopped, in the Mac's own words;
     *  for a goal's turn, the prompt Realm sent. */
    detail: z.string().optional(),
    /** A turn the session's goal started rather than anyone typing it: `continuation`, or `budget` for
     *  the handover a spent budget asks for. `text` says so in the desktop's words; `detail` is the prompt. */
    goal: z.enum(["continuation", "budget"]).optional(),
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

/** A teammate's mark: a shape and a colour, each by the desktop's name for it. */
const TeammateIconSchema = z.object({ shape: z.string().min(1).max(40), color: z.string().min(1).max(40) });

/** A space's teammate, as its Team list names it. */
export const TeammateSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  handle: z.string(),
  /** What it does, in the person's words. */
  brief: z.string(),
  /** The space's Lead, listed first. */
  lead: z.boolean(),
  /** Its chat, when it has one; `teammate.chat` makes one for a teammate that has none. */
  chatId: Id.nullable(),
  /** Its mark, by the desktop's names: one of its eight shapes in one of its twelve colours. */
  icon: TeammateIconSchema.optional(),
  /** As its sidebar row's dot says it: idle, working, or waiting on the person. */
  state: z.enum(["idle", "working", "needs-you"]).optional(),
  /** When that state began. Null while idle. */
  stateSince: z.number().nullable().optional(),
  /** Its chat has something the person has not read. */
  unread: z.boolean().optional(),
  /** What it is doing: the title of its live task session, else of the newest one it started. Null
   *  for a teammate that has started none. */
  activity: z.string().nullable().optional(),
  /** When that session last moved. */
  activityAt: z.number().nullable().optional(),
  /** What it runs on and how freely, as its Edit sheet chooses them. */
  agentKind: z.string().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  /** The section of the Mac's Team list it sits in, or null for the top of it. */
  group: z.string().nullable().optional(),
  /** Put away: off the Team list, its sessions where they were. Only `teammates.list` with
   *  `archived` names one. */
  archived: z.boolean().optional(),
});
export type Teammate = z.infer<typeof TeammateSchema>;

/** The three rungs the Mac's teammate sheet offers for how freely a teammate acts. */
const TeammatePermissionSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
/** What a session's info sheet says beyond its row. Every part is optional: a Mac leaves out what it
 *  does not know, and a phone draws only what came. */
export const SessionInfoSchema = z.object({
  /** Where the session runs: the Mac, and the checkout on it. */
  runsOn: z.object({
    machine: z.string(),
    /** The space's own folder, another checkout of it, or a git worktree Realm made. */
    checkout: z.enum(["primary", "checkout", "worktree"]),
    /** The checkout's folder, under `~` where it is in the person's home. */
    folder: z.string(),
    /** Null until something on the Mac has asked git. */
    branch: z.string().nullable(),
  }).optional(),
  /** What its turns have cost, for an engine that reports usage; absent for one that does not, and
   *  before its first turn. Input counts cached input too. */
  usage: z.object({
    costUsd: z.number(),
    /** Some of the cost is the catalog's list price for tokens the agent reported, not dollars it stated. */
    estimated: z.boolean(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    turns: z.number().int(),
  }).optional(),
  /** The files its turns made and the ones sent to it, newest first: each one `session.file` previews. */
  files: z.array(z.object({
    path: z.string(),
    name: z.string(),
    /** Bytes, where the turn that made it said. */
    size: z.number().nullable(),
    sent: z.boolean(),
    at: z.number(),
  })).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

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

/** One piece of a file's own bytes, for a phone that opens the whole file: `data` is bytes `from` on,
 *  base64; `next` is where the next piece starts, null at the end. */
export const FileDataSchema = z.object({
  path: z.string(), name: z.string(), size: z.number().int(), mime: z.string(),
  from: z.number().int(), data: z.string(), next: z.number().int().nullable(),
});

/** A checkout of the session's space, as the Move sheet names it: its path (`~` for the Mac's home),
 *  its branch, and whether it is the space's own folder, another checkout or a worktree. */
const CheckoutSchema = z.object({ environmentId: Id, path: z.string(), branch: z.string().nullable(), kind: z.enum(["primary", "checkout", "worktree"]) });

/** Where a move sends the session: another checkout of its space, or a new worktree. */
const MoveToSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("checkout"), environmentId: Id }), z.object({ kind: z.literal("worktree") })]);

/** A move of the session that is not over: queued behind the turn while `step` is null, otherwise
 *  under way at `step`, the step its progress row names. */
export const PendingMoveSchema = z.object({
  moveId: z.string(),
  to: MoveToSchema,
  step: z.enum(["preflight", "freeze", "snapshot", "place", "boot", "commit"]).nullable(),
});
export type PendingMove = z.infer<typeof PendingMoveSchema>;

/** Where a session can be moved to, and what would go with it (`session.moveOptions`). */
export const MoveOptionsSchema = z.object({
  /** The Mac it runs on. */
  mac: z.string(),
  /** The checkout it runs in now. */
  from: CheckoutSchema,
  /** A turn is under way: the sheet offers Move after this turn, or Stop and move. */
  busy: z.boolean(),
  /** Why this session cannot move at all, in the Mac's words, or null. */
  blocked: z.string().nullable(),
  /** A move is queued behind the turn, or under way. */
  pending: z.boolean(),
  /** How the conversation would travel: the agent resumes it there, or is handed it as notes. */
  conversation: z.enum(["native", "notes"]),
  /** Uncommitted files in its checkout, which go with it. */
  changedFiles: z.number().int(),
  /** What stays behind, by name: the terminal, ignored files that look like secrets. */
  leftBehind: z.array(z.string()),
  /** What the agent runs beyond its turn — a background task, a command — which only Stop and move
   *  stops; any other move is refused while it runs. Absent from a Mac before it said. */
  stops: z.array(z.string()).optional(),
  /** The space's other checkouts it can move to. */
  checkouts: z.array(CheckoutSchema),
  /** Whether a new worktree can be made for it, and why not when it cannot. */
  worktree: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type MoveOptions = z.infer<typeof MoveOptionsSchema>;

/** A simulator or a machine the session's space has open on the Mac: a pane with a screen in it. */
export const ScreenSchema = z.object({
  id: Id,
  kind: z.enum(["simulator", "machine"]),
  /** What its pane is called ("iPhone 17 Pro"). */
  name: z.string(),
  /** A second line in words: "iOS Simulator", "Your iPhone", "Mac app", "Remote screen", "Virtual machine". */
  detail: z.string().optional(),
  /** There is a picture to fetch right now: the device is running, the machine connected. */
  live: z.boolean(),
});
export type Screen = z.infer<typeof ScreenSchema>;

/** How long a frame's longer side may be asked to be, in pixels, and how long it is when none is asked
 *  for. A side outside these is brought inside them, not refused. */
export const SCREEN_SIDE = { min: 320, max: 1280, default: 1000 } as const;

/** One picture of a screen, made small for a phone. */
export const ScreenFrameSchema = z.object({
  mime: z.literal("image/jpeg"),
  /** The JPEG's bytes, base64. */
  data: z.string(),
  /** The JPEG's own size, in pixels: its longer side at most the side asked for. */
  width: z.number().int(),
  height: z.number().int(),
  /** When the picture was taken, on the Mac's clock. */
  capturedAt: z.number(),
});
export type ScreenFrame = z.infer<typeof ScreenFrameSchema>;

/** One login a session's agent can run on, as the desktop picker's Account list names it. */
export const SessionAccountSchema = z.object({
  id: z.string(),
  /** The person's name for it. */
  label: z.string(),
  /** The email the CLI says it is signed in as, or null before it has said. */
  email: z.string().nullable(),
  /** The CLI's own folder, which the desktop calls "CLI sign-in" until it names an email. */
  cliDefault: z.boolean(),
  /** False once the CLI says it is signed out; null when it has not been asked. */
  signedIn: z.boolean().nullable(),
});
export type SessionAccount = z.infer<typeof SessionAccountSchema>;

/** A turn saved from a session, as the desktop's Library ▸ Saved lists it: the prompt, the start of
 *  its answer, and whose session it was. */
export const SavedTurnEntrySchema = z.object({
  sessionId: Id,
  /** The prompt's row's `seq`. */
  seq: z.number().int(),
  savedAt: z.number(),
  /** When the prompt was sent. */
  at: z.number(),
  /** The prompt's words; empty for one that only carried files, which `attachments` names. */
  text: z.string(),
  attachments: z.array(z.string()),
  /** The first stretch of its answer, or null before anything answered it. */
  reply: z.string().nullable(),
  sessionTitle: z.string(),
  spaceId: Id,
  spaceName: z.string(),
});
export type SavedTurnEntry = z.infer<typeof SavedTurnEntrySchema>;

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
      /** The move queued behind the turn or under way when the session opened, or null. */
      move: PendingMoveSchema.nullable().optional(),
      /** The session's goal, or null for none. */
      goal: GoalSchema.nullable().optional(),
      /** The agent's to-do list as it stands: its newest TodoWrite, empty for none. */
      todos: z.array(TodoSchema).optional(),
    }),
  },
  "session.close": { params: z.object({ id: Id }), result: Ok },
  /** Renames, pins or archives a session's row, as the desktop's sidebar does. Archived, it leaves every list. */
  "session.update": {
    params: z.object({ id: Id, title: z.string().min(1).max(200).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }),
    result: z.object({ session: SessionRowSchema.nullable() }),
  },
  /** The messages waiting in the Mac's queue; `session.queue` (the event) says when they change. */
  "session.queue": { params: z.object({ id: Id }), result: z.object({ queued: z.array(QueuedMessageSchema), move: PendingMoveSchema.nullable().optional() }) },
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
  /** Every space's teammates, in each space's Team order, archived ones left out. */
  /** `archived`: the teammates put away instead, which the Team list shows folded at its end. */
  "teammates.list": { params: z.object({ archived: z.boolean().optional() }), result: z.object({ teammates: z.array(TeammateSchema) }) },
  /** A teammate's chat, made for one that has none yet: the session a phone sends it messages in. */
  "teammate.chat": { params: z.object({ id: Id }), result: z.object({ id: Id }) },
  /** Where a session runs, what it has cost, and its files: what its info sheet says beyond its row. */
  "session.info": { params: z.object({ id: Id }), result: SessionInfoSchema },
  /** A change to a teammate from its Edit sheet; anything left out keeps its value. */
  "teammate.update": {
    params: z.object({
      id: Id,
      name: z.string().trim().min(1).max(60).optional(),
      brief: z.string().trim().max(20_000).optional(),
      icon: TeammateIconSchema.optional(),
      agentKind: z.string().min(1).max(64).optional(),
      /** Null for the agent's own default. */
      model: z.string().min(1).max(200).nullable().optional(),
      effort: z.string().min(1).max(64).nullable().optional(),
      permissionMode: TeammatePermissionSchema.optional(),
      lead: z.boolean().optional(),
    }),
    result: z.object({ teammate: TeammateSchema }),
  },
  /** A new teammate in a space, as the Mac's New teammate sheet makes one. A handle left out is made
   *  from the name; an icon left out is rolled for it. */
  "teammate.create": {
    params: z.object({
      spaceId: Id,
      name: z.string().trim().min(1).max(60),
      handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a handle is lowercase letters, digits and dashes").optional(),
      brief: z.string().trim().max(20_000).default(""),
      icon: TeammateIconSchema.optional(),
      agentKind: z.string().min(1).max(64),
      model: z.string().min(1).max(200).nullable().default(null),
      effort: z.string().min(1).max(64).nullable().default(null),
      permissionMode: TeammatePermissionSchema,
      lead: z.boolean().default(false),
    }),
    result: z.object({ teammate: TeammateSchema }),
  },
  /** Puts a teammate away, or brings one back with `archived: false`. */
  "teammate.archive": { params: z.object({ id: Id, archived: z.boolean().default(true) }), result: z.object({ teammate: TeammateSchema }) },
  /** Makes a teammate its space's Lead, or leaves the space with none; answers the space's teammates. */
  "teammates.setLead": { params: z.object({ spaceId: Id, id: Id.nullable() }), result: z.object({ teammates: z.array(TeammateSchema) }) },
  /** A space's Team list in a new order: every teammate in it, top to bottom, each with its section. */
  "teammates.reorder": {
    params: z.object({ spaceId: Id, order: z.array(z.object({ id: Id, group: z.string().trim().min(1).max(60).nullable() })).max(500) }),
    result: z.object({ teammates: z.array(TeammateSchema) }),
  },
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
      /** What each `@[label]` in `text` names. One whose token is no longer in the words is dropped. */
      mentionRefs: z.array(MentionRefSchema).max(12).optional(),
    }),
    result: Ok,
  },
  /** What the composer's `/` and `@` lists offer that the phone does not already hold: the person's
   *  own commands and the skills the session's agent can be handed. */
  "session.composer": {
    params: z.object({ id: Id }),
    result: z.object({ commands: z.array(UserCommandSchema), skills: z.array(MentionSkillSchema) }),
  },
  /** The files in the session's folder that best match `query`, as the desktop's `@` list ranks them. */
  "session.mentionFiles": {
    params: z.object({ id: Id, query: z.string().max(200).default("") }),
    result: z.object({ files: z.array(MentionFileSchema) }),
  },
  /** One of the person's own commands, filled in with `args`: the words the composer then holds. A
   *  `$2` the args did not reach stays in `text`, and is named in `missing`. */
  "session.expandCommand": {
    params: z.object({ id: Id, name: z.string().min(1).max(64), args: z.string().max(8_000).default("") }),
    result: z.object({ text: z.string(), missing: z.array(z.string()) }),
  },
  /** Starts a goal: the session works towards `objective` across turns, as the desktop's `/goal` does. */
  "session.goal": { params: z.object({ id: Id, objective: z.string().trim().min(1).max(8_000) }), result: Ok },
  /** The goal strip's controls: pause an active goal, resume a stopped one, mark one done, or drop it.
   *  Answers with the goal as it now stands, or null once dropped. */
  "session.goalControl": {
    params: z.object({ id: Id, action: z.enum(["pause", "resume", "done", "drop"]) }),
    result: z.object({ goal: GoalSchema.nullable() }),
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
    result: z.object({
      agents: z.array(AgentOptionsSchema), defaultAgent: z.string().nullable(), midTurn: MidTurnSchema, attachments: SendLimitsSchema,
      /** The model each agent's last message was sent on, which a new teammate starts on; null for the agent's default. */
      lastModels: z.record(z.string(), z.string().nullable()).optional(),
      /** How freely a new teammate acts until the person chooses: the Mac's default for new sessions, as one of the three rungs. */
      teammatePermission: TeammatePermissionSchema.optional(),
    }),
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
  /** The file itself, a piece at a time, for a phone that plays, shares or saves it: the same files
   *  `session.file` previews, and only those. */
  "session.fileData": {
    params: z.object({ id: Id, path: z.string().min(1).max(4096), from: z.number().int().min(0).default(0) }),
    result: FileDataSchema,
  },
  /** A space's own picture, for an icon `home.get` calls a picture. */
  "space.icon": {
    params: z.object({ id: Id }),
    result: z.object({ mime: z.string(), data: z.string() }),
  },
  /** The simulators and machines the session's space has open on the Mac, the live ones first, then by name. */
  "session.screens": { params: z.object({ id: Id }), result: z.object({ screens: z.array(ScreenSchema) }) },
  /** A picture of one of them as it is now, for a phone watching it: only a screen of the session's own
   *  space, and only while it is live. `maxSide` is brought inside `SCREEN_SIDE`. */
  "session.screen": {
    params: z.object({ id: Id, screenId: Id, kind: ScreenSchema.shape.kind, maxSide: z.number().optional() }),
    result: ScreenFrameSchema,
  },
  /** Where the session can be moved to on its Mac, and what would go with it and stay. A Mac before
   *  moves answers METHOD_NOT_FOUND, and the phone offers none. */
  "session.moveOptions": { params: z.object({ id: Id }), result: MoveOptionsSchema },
  /**
   * Moves the session to another checkout of its space, or to a new worktree. Mid-turn, `now` is
   * refused; `after-turn` waits for the turn to end; `stop` stops it and moves. Answers once the move
   * is done — or queued, for `after-turn` — with the session's row; its progress and how it ended come
   * as notice rows. A refusal is FORBIDDEN, in the Mac's words.
   */
  "session.move": {
    params: z.object({
      id: Id,
      to: MoveToSchema,
      when: z.enum(["now", "after-turn", "stop"]).default("now"),
    }),
    result: z.object({ session: SessionRowSchema }),
  },
  /** Drops a move queued behind the turn, or stops one under way; `cancelled` is false when there was
   *  nothing left to stop. */
  "session.cancelMove": { params: z.object({ id: Id }), result: z.object({ cancelled: z.boolean() }) },
  /** Deletes the session, as the desktop's Delete does: its agent is stopped, and its transcript and its
   *  row go. Nothing is archived; it cannot be brought back. */
  "session.delete": { params: z.object({ id: Id }), result: Ok },
  /**
   * A new session forked from this one's newest turn, as the desktop's Checkpoints ▸ Fork… makes one: a
   * new worktree restored to that turn's checkpoint, a session in it named "Fork: <title>", and the
   * conversation carried into it as text. `agent` forks onto another agent; left out, it keeps this
   * one's. Refused (FORBIDDEN), in the Mac's words, for a session with no turn to fork from.
   */
  "session.fork": { params: z.object({ id: Id, agent: z.string().min(1).max(64).optional() }), result: z.object({ session: SessionRowSchema }) },
  /** Moves the session to another space, as the sidebar's Move to space… does. One that has run takes
   *  its checkout along, so its transcript still names the folder it ran in. */
  "session.moveToSpace": { params: z.object({ id: Id, spaceId: Id }), result: z.object({ session: SessionRowSchema }) },
  /** Moves the session onto another agent, as the desktop's model picker does: the new agent starts
   *  fresh with a summary of the conversation. Refused (FORBIDDEN) while a turn runs, in the Mac's words.
   *  `model: null` is the new agent's own default. */
  "session.switchAgent": {
    params: z.object({ id: Id, agent: z.string().min(1).max(64), model: z.string().max(200).nullable().optional() }),
    result: z.object({ session: SessionRowSchema }),
  },
  /** The logins the session's agent can run on and the one it runs on now; none for an agent with no
   *  accounts. */
  "session.accounts": { params: z.object({ id: Id }), result: z.object({ accounts: z.array(SessionAccountSchema), current: z.string().nullable() }) },
  /** Runs the session on another of its agent's logins. The conversation picks up where it left off,
   *  or from notes where it cannot. Refused (FORBIDDEN) while a turn runs, in the Mac's words. */
  "session.setAccount": { params: z.object({ id: Id, accountId: z.string().min(1).max(200) }), result: z.object({ session: SessionRowSchema }) },
  /** The turns saved in a session, as their prompts' rows' `seq`s, in order. */
  "session.saved": { params: z.object({ id: Id }), result: z.object({ seqs: z.array(z.number().int()) }) },
  /** Saves or unsaves one turn by its prompt's row; answers with the session's saved turns. */
  "session.setSaved": { params: z.object({ id: Id, seq: z.number().int().min(1), saved: z.boolean() }), result: z.object({ seqs: z.array(z.number().int()) }) },
  /** Every turn saved in a profile's sessions, the newest saved first, as Library ▸ Saved lists them. */
  "saved.list": { params: z.object({ profileId: Id }), result: z.object({ entries: z.array(SavedTurnEntrySchema), total: z.number().int() }) },
  "debug.report": { params: z.object({ name: z.string().regex(/^[\w.-]{1,80}$/), data: z.unknown() }), result: Ok },
} as const;
export type MobileMethod = keyof typeof MobileCalls;
export type MobileParams<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["params"]>;
export type MobileResult<M extends MobileMethod> = z.infer<(typeof MobileCalls)[M]["result"]>;

export const MobileEvents = {
  "session.rows": z.object({ id: Id, rows: z.array(RowSchema) }),
  /** `moving` as `SessionRow.moving` says it. */
  "session.status": z.object({ id: Id, status: SessionStatusSchema, moving: z.boolean().optional() }),
  /** The suggested next message changed: a new one after a turn, or none once something was sent. */
  "session.hint": z.object({ id: Id, text: z.string().nullable() }),
  "home.changed": z.object({}),
  /** An open session's queue changed: the whole list, as the desktop's own event carries it. */
  "session.queue": z.object({ id: Id, queued: z.array(QueuedMessageSchema), move: PendingMoveSchema.nullable().optional() }),
  /** An open session's sub-agents changed: one started, settled or was stopped. `session.subagents` reads them. */
  "session.subagents": z.object({ id: Id }),
  /** An open session's saved turns changed, here or on the Mac: the whole set. */
  "session.saved": z.object({ id: Id, seqs: z.array(z.number().int()) }),
  /** Reviews or scheduled tasks changed somewhere: `reviews.list` and `schedules.list` read them again. */
  "work.changed": z.object({}),
  /** An open session's goal changed: started, stopped, resumed, counted a turn, or dropped (null). */
  "session.goal": z.object({ id: Id, goal: GoalSchema.nullable() }),
  /** An open session's to-do list changed: the whole list, as the agent's newest TodoWrite has it. */
  "session.todos": z.object({ id: Id, todos: z.array(TodoSchema) }),
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
