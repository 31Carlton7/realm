import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";

/**
 * Teams v2: a teammate is a permanent agent in a space that you message.
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

/** An icon nobody chose, the same every time for the same seed: a role's old Realmite seed or its id. */
export function teammateIconFromSeed(seed: string): TeammateIcon {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return { shape: TEAMMATE_SHAPES[h % TEAMMATE_SHAPES.length]!, color: TEAMMATE_COLORS[Math.floor(h / TEAMMATE_SHAPES.length) % TEAMMATE_COLORS.length]! };
}

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
