import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";
import { SessionOutcomeSchema } from "./session-outcome";

/**
 * A teammate is a permanent agent in a space that you message.
 *
 * Each teammate owns one HOME session — an ordinary Realm session whose transcript is the chat with it,
 * flagged `teammateHome` so the sidebar draws it as the teammate rather than as a loose session. Real
 * work happens in TASK sessions the teammate starts with `agent_start` ("<handle> - <task>"); those are
 * ordinary delegated children carrying the teammate's id, run in its permission mode, and listed under
 * it — never hidden. Teammates talk to each other with `team_list` and `team_message`.
 *
 * Stored in the `team_roles` table the first Teams used, so the roles a person already made come
 * through as teammates with their names, briefs and models.
 */

export const TEAMMATES_PROVIDER_NAME = "realm-team";
export const TEAM_LIST_TOOL = "team_list";
export const TEAM_MESSAGE_TOOL = "team_message";

/** The eight shapes and twelve colours an icon is made of: one flat shape, two eye strokes. */
export const TEAMMATE_SHAPES = ["circle", "flower", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"] as const;
export const TeammateShapeSchema = z.enum(TEAMMATE_SHAPES);
export type TeammateShape = z.infer<typeof TeammateShapeSchema>;

export const TEAMMATE_COLORS = ["red", "orange", "amber", "yellow", "lime", "green", "teal", "sky", "blue", "violet", "pink", "graphite"] as const;
export const TeammateColorSchema = z.enum(TEAMMATE_COLORS);
export type TeammateColor = z.infer<typeof TeammateColorSchema>;

export const TeammateIconSchema = z.object({ shape: TeammateShapeSchema, color: TeammateColorSchema });
export type TeammateIcon = z.infer<typeof TeammateIconSchema>;

/** The modes a session can run in, Full access included. A teammate's task sessions run in its mode. */
export const TEAMMATE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "ask"] as const;
export const TeammatePermissionModeSchema = z.enum(TEAMMATE_PERMISSION_MODES);
export type TeammatePermissionMode = z.infer<typeof TeammatePermissionModeSchema>;

/**
 * A space's Team access: one mode every teammate in the space is put on, now and when made later.
 * The three a person sets by hand on a teammate; the read-only modes are not a team-wide setting.
 */
export const TEAM_ACCESS_MODES = ["default", "acceptEdits", "bypassPermissions"] as const;
export const TeamAccessModeSchema = z.enum(TEAM_ACCESS_MODES);
export type TeamAccessMode = z.infer<typeof TeamAccessModeSchema>;

/**
 * What `teams.access.get` answers. `mode` is the space's setting, null when its teammates are set one
 * by one. `mixed` is true when the teammates are not all on one mode, or not on the space's: a
 * teammate edited on its own after the space was set keeps the setting and makes the space mixed.
 * Archived teammates are left out.
 */
export const TeamAccessSchema = z.object({
  mode: TeamAccessModeSchema.nullable(),
  mixed: z.boolean(),
  teammates: z.array(z.object({ handle: z.string(), mode: TeammatePermissionModeSchema })),
});
export type TeamAccess = z.infer<typeof TeamAccessSchema>;

/** `needs-you`: its home session or a task session is waiting on a permission or a question. */
export const TEAMMATE_STATES = ["idle", "working", "needs-you"] as const;
export const TeammateStateSchema = z.enum(TEAMMATE_STATES);
export type TeammateState = z.infer<typeof TeammateStateSchema>;

/** How a teammate is addressed: `cto`, `design-engineer`. Unique in its space. */
export const TeammateHandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a handle is lowercase letters, digits and dashes");

/** A handle from a name: `Design Engineer` → `design-engineer`. Never empty. */
export function teammateHandle(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "teammate";
}

/** A handle as an agent or a person writes it — `@cto`, `CTO`, `lead` — reduced to the stored form. */
export function normalizeHandle(raw: string): string {
  return teammateHandle(raw.trim().replace(/^@/, ""));
}

/** The teammate a `team_message` names, as the server resolves `to`: its handle, `@handle`, or `lead`. */
export function teammateByHandle<T extends { handle: string; lead: boolean }>(teammates: readonly T[], to: string): T | null {
  const handle = normalizeHandle(to);
  return teammates.find((t) => t.handle === handle) ?? (handle === "lead" ? teammates.find((t) => t.lead) ?? null : null);
}

/** A teammate's words without the "From @handle: " the server puts in front of them for the agent —
 *  every one of them, since an agent that has read a few writes its own as well. */
export const teammateWords = (text: string): string => text.replace(/^(?:From @[^\s:]+: )+/, "");

/** An icon nobody chose, the same every time for the same seed: a role's old Realmite seed or its id. */
export function teammateIconFromSeed(seed: string): TeammateIcon {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return { shape: TEAMMATE_SHAPES[h % TEAMMATE_SHAPES.length]!, color: TEAMMATE_COLORS[Math.floor(h / TEAMMATE_SHAPES.length) % TEAMMATE_COLORS.length]! };
}

/** What a teammate's clock says when it fires, unless the person wrote something else. */
export const TEAMMATE_CLOCK_PROMPT = "Do your scheduled work.";

/** How long a turn a teammate's clock started may run in its chat before Realm stops it. Only that turn
 *  is stopped: task sessions it started go on, under their own limits. */
export const TEAMMATE_CLOCK_TURN_MS = 60 * 60_000;

/**
 * A teammate's clock: an ordinary row in `schedules`, tagged with the teammate (`roleId`) and kept out
 * of the Scheduled page's list. When it fires, `prompt` is a turn in the teammate's home session,
 * marked as the clock's (`user_message.scheduled.scheduleId`), queued behind a turn the chat is on, in
 * the teammate's mode. It opens no pane and lands unread. An occurrence is skipped (`lastSkippedAt`)
 * when the clock's previous turn has not ended, or when the Mac woke too late for it.
 */
export const TeammateScheduleSchema = z.object({
  /** The `schedules` row: `schedules.runNow` takes it, and the clock's turns in the chat name it. */
  id: IdSchema,
  cron: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  /** Null while it is paused, or while its teammate is archived. */
  nextRunAt: z.number().int().nullable(),
  /** When it last put a turn in the chat. */
  lastRunAt: z.number().int().nullable(),
  /** When it last came due and did not. */
  lastSkippedAt: z.number().int().nullable(),
});
export type TeammateSchedule = z.infer<typeof TeammateScheduleSchema>;

/** Set or change a teammate's clock. `cron` is needed when it has none; anything left out keeps its
 *  value, and a new clock is enabled and says `TEAMMATE_CLOCK_PROMPT`. */
export const TeammateScheduleInputSchema = z.object({
  cron: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
});
export type TeammateScheduleInput = z.infer<typeof TeammateScheduleInputSchema>;

/** A session a teammate started, as its sidebar row and its page's Sessions list draw it. */
export const TeammateTaskSessionSchema = z.object({
  id: IdSchema,
  title: z.string(),
  /** The teammate that owns it — another teammate's, for work this one handed over. */
  teammateId: IdSchema,
  /** The session it nests under: the session that handed the work over, or that started it. Null at
   *  the top of the list. */
  parentId: IdSchema.nullable(),
  state: TeammateStateSchema,
  updatedAt: z.number().int(),
  unread: z.boolean(),
  /** What it produced, once it has stopped: read for its computer's list only (`teammates.sessions`),
   *  absent on the sidebar's rows. */
  outcome: SessionOutcomeSchema.nullable().optional(),
});
export type TeammateTaskSession = z.infer<typeof TeammateTaskSessionSchema>;

export const TeammateSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  handle: TeammateHandleSchema,
  name: z.string(),
  /** What it does, in the person's words. Its home session's preamble carries it. */
  brief: z.string(),
  icon: TeammateIconSchema,
  agentKind: AgentKindSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: TeammatePermissionModeSchema,
  /** Where it works, absolute. The space's folder unless the person chose another. */
  folder: z.string(),
  /** The space's Lead: at most one per space, first in the list. */
  lead: z.boolean(),
  /** The person's sidebar section it sits in ("Strat"), or null for the top of the Team list. */
  group: z.string().nullable(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
  /** Its chat. Null until the first message, or for a teammate carried over from the first Teams. */
  homeSessionId: IdSchema.nullable(),
  /** Its clock, or null when it has none. */
  schedule: TeammateScheduleSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /* ── derived, never stored ── */
  state: TeammateStateSchema,
  /** When the state began, for "Working · 4m". Null while idle. */
  stateSince: z.number().int().nullable(),
  /** Its home session has something the person has not read. */
  unread: z.boolean(),
  /** The title of its newest live task session, when one is running. */
  liveTask: z.string().nullable(),
  /** Its newest task sessions (and the ones handed on from them), newest first, capped. */
  taskSessions: z.array(TeammateTaskSessionSchema),
});
export type Teammate = z.infer<typeof TeammateSchema>;

const TeammateFieldsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  brief: z.string().trim().max(20_000),
  /** From the name when omitted; made unique in the space with a number. */
  handle: TeammateHandleSchema.optional(),
  /** Rolled from the id when omitted. */
  icon: TeammateIconSchema.optional(),
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  effort: z.string().min(1).max(64).nullable().optional(),
  /** The space's default for new sessions when omitted. */
  permissionMode: TeammatePermissionModeSchema.optional(),
  /** An absolute folder, or null for the space's own. */
  folder: z.string().min(1).max(4_096).nullable().optional(),
  lead: z.boolean().optional(),
  group: z.string().trim().min(1).max(60).nullable().optional(),
  /** Its clock: set or changed, or null to remove it. */
  schedule: TeammateScheduleInputSchema.nullable().optional(),
});

export const CreateTeammateSchema = TeammateFieldsSchema.extend({ spaceId: IdSchema });
export type CreateTeammateInput = z.infer<typeof CreateTeammateSchema>;

export const UpdateTeammateSchema = TeammateFieldsSchema.partial().extend({ id: IdSchema });
export type UpdateTeammateInput = z.infer<typeof UpdateTeammateSchema>;

/** The Team list's order: every teammate in the space, top to bottom, with the section it sits in. */
export const ReorderTeammatesSchema = z.object({
  spaceId: IdSchema,
  order: z.array(z.object({ id: IdSchema, group: z.string().trim().min(1).max(60).nullable() })).max(500),
});
export type ReorderTeammatesInput = z.infer<typeof ReorderTeammatesSchema>;

/** `team_message`'s arguments. `to` is a handle, `@handle`, or `lead`. */
export const TeamMessageArgsSchema = z.object({
  to: z.string().trim().min(1).max(60),
  message: z.string().trim().min(1).max(20_000),
  /** Wait for the reply: the target's next turn's final text. */
  wait: z.boolean().optional(),
});
export type TeamMessageArgs = z.infer<typeof TeamMessageArgsSchema>;

/** A link to a session, as a teammate writes it in its report: `[cto - sqlite search](realm://session/<id>)`.
 *  The transcript opens the session it names. */
export const SESSION_LINK_PREFIX = "realm://session/";
export const sessionLink = (sessionId: string): string => `${SESSION_LINK_PREFIX}${sessionId}`;
/** The session a link names, or null for any other link. */
export function sessionIdFromLink(href: string): string | null {
  if (!href.startsWith(SESSION_LINK_PREFIX)) return null;
  const id = href.slice(SESSION_LINK_PREFIX.length).replace(/[/?#].*$/, "");
  return IdSchema.safeParse(id).success ? id : null;
}

/** How long `team_message` with `wait` holds before it gives up on a reply. */
export const TEAM_MESSAGE_WAIT_MS = 20 * 60_000;
