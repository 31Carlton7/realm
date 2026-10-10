import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";
import { parseMemoryEntry } from "./memory";
import { RunStateSchema } from "./runs";
import { SkillIdSchema } from "./skills";
import { RoleGoalSchema, TeamHandoffSchema, TeamLimitsSchema } from "./team-handoffs";
import { ActTicketSchema } from "./team-acts";
import { TeamRecordTypeSchema } from "./team-record-types";
import { DeliverableFormatSchema, ReviewActionSchema, ReviewLabelSchema } from "./team-deliverables";

/**
 * Teams (Phase 1): a space with standing roles.
 *
 * A team is not a new kind of space — it is a space whose first role has been made. A ROLE is a saved
 * agent definition (brief, model, mode, skills, a clock, a budget, and a Realmite to be seen by); its
 * work is ordinary durable runs, so a role adds no scheduler of its own. What a role makes goes to the
 * space's REVIEW, where nothing leaves Realm without a person's yes. Facts about the people the team
 * works with are RECORDS: Markdown files in the space's memory repo, one per person, which every role
 * reads.
 *
 * Phase 1 has no posting and no vault: Approve marks the batch, and the person posts it by hand.
 */

export const TEAM_PROVIDER_NAME = "realm-team";

/** The owner's chosen defaults (the Teams plan, decision 5). A run stops at $3 or 20 minutes; a team
 *  spends $60 a week; at most two of a team's runs and three unattended runs Realm-wide go at once,
 *  and the rest queue. */
export const TEAM_DEFAULTS = {
  runCapUsd: 3,
  runCapMs: 20 * 60_000,
  teamWeekBudgetUsd: 60,
  teamMaxLive: 2,
  realmMaxUnattended: 3,
} as const;

/** What woke a run. `schedule`: its clock. `review`: a person asked for changes. `manual`: Run now, or
 *  a message from the role's page. `handoff`: another role passed it work. `mention`: a session named
 *  it (that one is a sub-agent, not a run). `goal`: a person gave it a goal to work toward. */
export const WOKE_ON = ["schedule", "review", "manual", "handoff", "mention", "goal"] as const;
export const WokeOnSchema = z.enum(WOKE_ON);
export type WokeOn = z.infer<typeof WokeOnSchema>;

export const RolePermissionModeSchema = z.enum(["plan", "default", "acceptEdits"]);

/* ────────────────────────────── roles ────────────────────────────── */

/** What a role is doing, which is all its row ever reports. `waiting`: a run is parked on a person (a
 *  permission, a NEEDS-HUMAN). `queued`: woken, waiting for a slot. `paused`: its week's budget, or
 *  the team's, is spent. */
export const ROLE_STATES = ["working", "waiting", "queued", "idle", "paused"] as const;
export type RoleState = (typeof ROLE_STATES)[number];

export const TeamRoleSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  name: z.string(),
  brief: z.string(),
  /** The role's Realmite as the maker left it (`RealmiteSpec` in @realm/ui). Opaque here: contracts
   *  sit under the UI package, and `parseRealmiteSpec` is what reads it, falling back to the role's id. */
  realmite: z.unknown(),
  /** The starter it was made from, if any ("creator-manager"). */
  template: z.string().nullable(),
  agentKind: AgentKindSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: RolePermissionModeSchema,
  skills: z.array(SkillIdSchema),
  /** Its clock: an ordinary schedule row with this role's id. Null when the role only wakes by hand. */
  scheduleId: z.string().nullable(),
  cron: z.string().nullable(),
  scheduleEnabled: z.boolean(),
  nextRunAt: z.number().int().nullable(),
  /** "Request changes" wakes the run that made the batch, with the note. */
  wakeOnReview: z.boolean(),
  weekBudgetUsd: z.number().nullable(),
  runCapUsd: z.number(),
  runCapMs: z.number().int(),
  maxConcurrent: z.number().int(),
  archived: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /* ── derived, never stored ── */
  state: z.enum(ROLE_STATES),
  /** When the state began — the live run's start, for "Working · 4m". */
  stateSince: z.number().int().nullable(),
  /** Why it is paused, in words, when it is. */
  pausedWhy: z.string().nullable(),
  weekSpendUsd: z.number(),
  lastRunAt: z.number().int().nullable(),
  /** The newest run's session — what ⌘-click on the role row opens beside the focused pane. */
  latestSessionId: z.string().nullable(),
  /** The newest run finished and its session has not been read. */
  unread: z.boolean(),
  /** The roles it may hand work to, by id (Phase 4). */
  handsOffTo: z.array(z.string()),
  /** A mention in a session wakes it as that session's sub-agent. */
  wakeOnMention: z.boolean(),
  /** The goal it is working toward, while one is live or was the newest. */
  goal: RoleGoalSchema.nullable(),
});
export type TeamRole = z.infer<typeof TeamRoleSchema>;

const RoleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  brief: z.string().trim().min(1).max(20_000),
  realmite: z.record(z.string(), z.unknown()),
  template: z.string().max(60).nullable().optional(),
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  effort: z.string().min(1).max(64).nullable().optional(),
  permissionMode: RolePermissionModeSchema.optional(),
  skills: z.array(SkillIdSchema).max(50).optional(),
  cron: z.string().min(1).max(200).nullable().optional(),
  wakeOnReview: z.boolean().optional(),
  weekBudgetUsd: z.number().positive().max(10_000).nullable().optional(),
  runCapUsd: z.number().positive().max(1_000).optional(),
  runCapMs: z.number().int().min(60_000).max(24 * 60 * 60_000).optional(),
});

export const CreateRoleSchema = RoleFieldsSchema.extend({ spaceId: IdSchema });
export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

export const UpdateRoleSchema = RoleFieldsSchema.partial().extend({
  id: IdSchema,
  scheduleEnabled: z.boolean().optional(),
});
export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;

/** One run of a role, as its page lists it. */
export const RoleRunSchema = z.object({
  id: IdSchema,
  roleId: z.string(),
  state: RunStateSchema,
  wokeOn: WokeOnSchema.nullable(),
  /** A person's words, for a run woken by "Request changes" or a message — or the note a handoff carried. */
  wokeNote: z.string().nullable(),
  /** Who woke it, when it was another role or a session: "Content Producer". */
  wokeBy: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  settledAt: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  /** The run's report, first line — "what it did". */
  summary: z.string().nullable(),
  error: z.string().nullable(),
  /** Stopped at its $ or minutes cap. */
  stoppedAtCap: z.enum(["usd", "time"]).nullable(),
  /** The review this run submitted, if it did, and where that review stands. */
  reviewId: z.string().nullable(),
  reviewState: z.string().nullable(),
});
export type RoleRun = z.infer<typeof RoleRunSchema>;

/* ────────────────────────────── templates ────────────────────────────── */

export type RoleTemplate = {
  id: string;
  name: string;
  /** Which shelf of the gallery it stands on: roles any team can use, or the ones that work with the
   *  creators a team keeps records of. A space that is not about creators is not handed those first. */
  group: "any" | "creators";
  /** A line for the role's card: its job, in plain words. */
  blurb: string;
  brief: string;
  model: string;
  cron: string | null;
  /** Skill ids as the library names them, unprefixed. A space that lacks one simply does not get it. */
  skills: string[];
  /** Its share of the team's week (decision 5), so its meter has something to fill. */
  weekBudgetUsd: number;
  /** The seed its Realmite is rolled from, so each starter looks the same the first time everywhere. */
  realmiteSeed: string;
};

const REVIEW_RULE = "Deliver what you make with review_submit; nothing leaves Realm until a person approves it, and you never send, post, sign or pay yourself.";

/** The starter roles. Sonnet for routine work (decision 5); the model alias resolves to the current
 *  Sonnet in the Claude harness, so a template never pins a version that will age out. Every brief
 *  speaks of "this team" and "the space", never of one business: these are offered to any space. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "researcher",
    name: "Researcher",
    group: "any",
    blurb: "Looks things up when you ask, and sends back a short brief with its sources.",
    brief: [
      "You research for this team. When a person asks a question, find the answer from primary sources, read them, and write a short brief: the answer first, then what it rests on, with a link for every claim and a note of anything you could not confirm.",
      "",
      `Save the brief as a Markdown file in the space's folder and send it to Review as a report. ${REVIEW_RULE}`,
    ].join("\n"),
    model: "sonnet",
    cron: null,
    skills: ["browsing"],
    weekBudgetUsd: 10,
    realmiteSeed: "researcher-208",
  },
  {
    id: "editor",
    name: "Editor",
    group: "any",
    blurb: "Reads drafts before they reach you and sends back what to fix. Rewrites nothing on its own.",
    brief: [
      "You are this team's editor and checker. Read what the other roles have sent to Review and what is waiting in the space's drafts. For each, check facts against the space's records and files, spelling, tone, and anything a reader would trip on.",
      "",
      `Send your notes to Review as one report per draft: what is wrong, where, and the fix you suggest. ${REVIEW_RULE}`,
    ].join("\n"),
    model: "sonnet",
    cron: "0 9 * * 1-5",
    skills: ["humanizer"],
    weekBudgetUsd: 5,
    realmiteSeed: "editor-77",
  },
  {
    id: "growth-analyst",
    name: "Growth Analyst",
    group: "any",
    blurb: "Reads the numbers the team watches and reports each Monday. Changes nothing.",
    brief: [
      "You read this team's numbers: sign-ups, revenue, retention, and how each piece of published work did, from the dashboards and files the space can reach. You only read; you never change a setting, a price or a campaign.",
      "",
      `Each Monday, send one report to Review: what moved since last week, what probably moved it, and one thing worth trying. ${REVIEW_RULE}`,
    ].join("\n"),
    model: "sonnet",
    cron: "0 8 * * 1",
    skills: [],
    weekBudgetUsd: 10,
    realmiteSeed: "growth-analyst-372",
  },
  {
    id: "community-manager",
    name: "Community Manager",
    group: "any",
    blurb: "Reads comments and messages, and drafts the replies for your yes.",
    brief: [
      "You look after the people who talk to this team: comments, replies and messages on the accounts the space names. Read what came in since your last run, sort it into what needs an answer, what to thank, and what to ignore.",
      "",
      `Draft each reply and send them to Review as one batch of messages, each naming where it would be posted. ${REVIEW_RULE}`,
    ].join("\n"),
    model: "sonnet",
    cron: "0 9 * * 1-5",
    skills: ["social-content"],
    weekBudgetUsd: 10,
    realmiteSeed: "community-manager-5",
  },
  {
    id: "ops",
    name: "Ops",
    group: "any",
    blurb: "Keeps the team's to-dos, deadlines and paperwork in order, and drafts what is due.",
    brief: [
      "You keep this team's admin in order: deadlines, renewals, invoices, forms and follow-ups that are in the space's files and records. Each Monday, list what is due in the next two weeks and what is late.",
      "",
      `Draft anything that has to go out — an email, a form, a reminder — and send it to Review. ${REVIEW_RULE}`,
    ].join("\n"),
    model: "sonnet",
    cron: "0 8 * * 1",
    skills: [],
    weekBudgetUsd: 5,
    realmiteSeed: "ops-914",
  },
  {
    id: "creator-manager",
    name: "Creator Manager",
    group: "creators",
    blurb: "Keeps each creator's record, contract and deadlines. Drafts every message; sends none.",
    brief: [
      "You manage this team's creators. Every creator has a record under creators/ in the team's memory: keep it true — the deal, accounts, deadlines, what was posted and how it did. Read a record with record_read and change it with record_update; never paste a password or key into one.",
      "",
      "Each weekday, check every record's deadlines and draft what is due. Draft every message to a creator and send it to Review with review_submit (kind message). Never send, sign, pay or post yourself.",
    ].join("\n"),
    model: "sonnet",
    cron: "0 9 * * 1-5",
    skills: [],
    weekBudgetUsd: 20,
    realmiteSeed: "creator-manager-1586",
  },
  {
    id: "content-producer",
    name: "Content Producer",
    group: "creators",
    blurb: "Makes slideshows for each signed creator, and sends each batch to Review.",
    brief: [
      "You make short-form slideshows for this team's signed creators. Read each creator's record (record_list, record_read) for their formats and audience, then make one batch per creator per run, saving the slides under the space folder.",
      "",
      "Send each batch to Review with review_submit (kind slideshows): one item per slideshow, its slides as files in order and its caption as the body, naming the creator's record and the account it is for. Nothing posts until a person approves it, and you never post.",
    ].join("\n"),
    model: "sonnet",
    cron: "0 9 * * 1,4",
    skills: ["aurafarm"],
    weekBudgetUsd: 25,
    realmiteSeed: "content-producer-32",
  },
];

/**
 * What the shares of a team's week come to with a change made: the roles kept, a role's share
 * replaced, and the ones added. A role with no week of its own takes no share. Pure, so the picker
 * shows exactly the sum the server will check.
 */
export function teamShares(roles: readonly { id?: string; weekBudgetUsd: number | null }[], o: { replace?: { id: string; weekBudgetUsd: number | null }; add?: readonly (number | null)[] } = {}): number {
  let sum = 0;
  for (const r of roles) sum += (o.replace && r.id === o.replace.id ? o.replace.weekBudgetUsd : r.weekBudgetUsd) ?? 0;
  for (const a of o.add ?? []) sum += a ?? 0;
  return Math.round(sum * 100) / 100;
}

/** A role a person wrote, made with the team — every field a role takes but the space. */
export const CustomRoleSchema = RoleFieldsSchema;
export type CustomRoleInput = z.infer<typeof CustomRoleSchema>;

/* ────────────────────────────── review ────────────────────────────── */

export const REVIEW_KINDS = ["slideshows", "message", "document", "report"] as const;
/** A review's label: free words since dynamic Teams (team-deliverables.ts); the four above still read. */
export const ReviewKindSchema = ReviewLabelSchema;
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

/** `waiting`: for you. `changes`: you asked for changes; the role is on it. `approved`: yes, not yet
 *  posted (Phase 1: you post it by hand). `done`: posted, sent, or read. `dismissed`: put away. */
export const REVIEW_STATES = ["waiting", "changes", "approved", "done", "dismissed"] as const;
export const ReviewStateSchema = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewTargetSchema = z.object({
  /** "tiktok", "instagram", "email"… — free text, shown as written. */
  channel: z.string().min(1).max(40).optional(),
  /** The account it would go out as: "@versed.nathan", or an address for a message. */
  account: z.string().min(1).max(200).optional(),
  /** Who a DM or an email goes to: "@reader", "nathan@example.com". A post has none. */
  to: z.string().min(1).max(200).optional(),
}).strict();
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const TeamReviewItemSchema = z.object({
  id: IdSchema,
  reviewId: IdSchema,
  version: z.number().int(),
  ord: z.number().int(),
  /** Paths relative to the space folder, in order. */
  files: z.array(z.string()),
  body: z.string().nullable(),
  target: ReviewTargetSchema.nullable(),
  contentHash: z.string(),
  /** The hash that was approved; differs from `contentHash` once a file changes after the yes. */
  approvedHash: z.string().nullable(),
  actState: z.string(),
  /** Free key/values ("Subject", "Due"); a renderer hint; the proposed outward action; and 'user' when
   *  the person edited this version's text before approving (team-deliverables.ts, v52). */
  meta: z.record(z.string(), z.string()).optional(),
  format: DeliverableFormatSchema.nullable().optional(),
  action: ReviewActionSchema.nullable().optional(),
  editedBy: z.string().nullable().optional(),
});
export type TeamReviewItem = z.infer<typeof TeamReviewItemSchema>;

/** A review as the list shows it. */
export const TeamReviewSummarySchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  roleId: z.string().nullable(),
  roleName: z.string().nullable(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  recordPath: z.string().nullable(),
  kind: ReviewKindSchema,
  title: z.string(),
  state: ReviewStateSchema,
  note: z.string().nullable(),
  version: z.number().int(),
  itemCount: z.number().int(),
  /** The first file of the first item, when it is a picture — the card's thumbnail. Space-relative. */
  thumb: z.string().nullable(),
  /** Channels named by its items, deduplicated, as written. */
  channels: z.array(z.string()),
  /** The first item's account, for a message's "Sends from". */
  account: z.string().nullable(),
  /** How the first item is drawn — the card's glyph and, with no label of the role's, its line. */
  format: DeliverableFormatSchema.nullable().optional(),
  /** What the batch does when it goes out — post, send, or null for nothing (`reviewVerb`). */
  verb: z.string().nullable().optional(),
  /** Items of this version the person edited before approving, by place (1-based). */
  editedItems: z.array(z.number().int()).optional(),
  /** A file changed after it was approved, so the yes no longer covers it. */
  changedSinceApproval: z.boolean(),
  /** Its act tickets (Phase 3): how many outward acts the yes issued, and how many went out. */
  actsTotal: z.number().int().default(0),
  actsDone: z.number().int().default(0),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type TeamReviewSummary = z.infer<typeof TeamReviewSummarySchema>;

/** A fact Realm checked about a batch — not the agent's claim. */
export const ReviewCheckSchema = z.object({
  ok: z.boolean().nullable(),
  title: z.string(),
  detail: z.string(),
});
export type ReviewCheck = z.infer<typeof ReviewCheckSchema>;

export const LedgerLineSchema = z.object({
  ts: z.number().int(),
  glyph: z.string(),
  text: z.string(),
  detail: z.string().nullable(),
});
export type LedgerLine = z.infer<typeof LedgerLineSchema>;

export const TeamReviewDetailSchema = TeamReviewSummarySchema.extend({
  items: z.array(TeamReviewItemSchema),
  /** Earlier versions' items, newest first — one step back. */
  previous: z.array(TeamReviewItemSchema),
  /** The run that made it: dollars and minutes, always shown. */
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  runCapUsd: z.number().nullable(),
  model: z.string().nullable(),
  recordName: z.string().nullable(),
  checks: z.array(ReviewCheckSchema),
  ledger: z.array(LedgerLineSchema),
  /** The space folder, absolute — so the renderer can show a file and reveal it in Finder. */
  root: z.string().nullable(),
  /** One ticket per outward act, in batch order — what the post sheet presses (team-acts.ts). */
  tickets: z.array(ActTicketSchema).default([]),
  /** The text of the items' text files (Markdown, CSV, a diff), by space-relative path, so a table or
   *  a diff draws without the window reading the disk. Capped; a file past the cap is absent. */
  fileTexts: z.record(z.string(), z.string()).optional(),
});
export type TeamReviewDetail = z.infer<typeof TeamReviewDetailSchema>;

/* ────────────────────────────── activity ────────────────────────────── */

export const TEAM_VERBS = ["made_team", "edited_team", "made_role", "edited_role", "archived_role", "woke", "queued", "finished", "failed", "stopped_at_cap",
  "paused", "submitted", "revised", "approved", "asked_changes", "marked_done", "dismissed", "read_record", "updated_record", "refused",
  "handed_off", "mentioned", "goal_set", "goal_stopped", "backed_off", "edited_limits",
  // Phase 3: approve → act.
  "issued_tickets", "pressed", "acted", "act_failed", "cancelled_ticket", "held_acts", "resumed_acts",
  // Dynamic Teams: the kinds of record a team keeps.
  "made_record_type", "edited_record_type", "archived_record_type", "adopted_record_type",
  // Generic deliverables: the person's own edit of an item before the yes.
  "edited_item"] as const;
export type TeamVerb = (typeof TEAM_VERBS)[number];

export const TeamActivitySchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  ts: z.number().int(),
  /** `role:<id>`, `user`, or `realm`. */
  actor: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  verb: z.string(),
  object: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type TeamActivity = z.infer<typeof TeamActivitySchema>;

/* ────────────────────────────── records ────────────────────────────── */

export const RECORD_KINDS = [{ dir: "creators", label: "Creators", one: "creator" }] as const;

export const TeamRecordSummarySchema = z.object({
  path: z.string(),
  kind: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type TeamRecordSummary = z.infer<typeof TeamRecordSummarySchema>;

export const TeamRecordSchema = TeamRecordSummarySchema.extend({
  markdown: z.string(),
  /** Absolute, for "Open in Documents". */
  absPath: z.string(),
  /** Who last changed it, from the repo's log: a role's name, the person, or null. */
  lastAuthor: z.string().nullable(),
});
export type TeamRecord = z.infer<typeof TeamRecordSchema>;

/** The team as one space's pages and sidebar section need it. */
export const TeamSpaceSchema = z.object({
  spaceId: IdSchema,
  /** A team at all: it has (or had) a role. */
  enabled: z.boolean(),
  roles: z.array(TeamRoleSchema),
  reviews: z.array(TeamReviewSummarySchema),
  weekSpendUsd: z.number(),
  weekBudgetUsd: z.number(),
  /** The space has a memory repo of its own, which records need. */
  hasRepo: z.boolean(),
  /** Where it is, and whether it is somewhere other than Realm's own folder — because that folder is
   *  inside a space's, and a memory repo stays apart from projects. */
  repoPath: z.string().nullable(),
  repoMoved: z.boolean(),
  /** The roles' weekly shares added up: kept at or under `weekBudgetUsd`. */
  sharesUsd: z.number(),
  /** Roles removed from the team, so what they did still reads under their name in the log. */
  formerRoles: z.array(z.object({ id: z.string(), name: z.string(), realmite: z.unknown() })),
  recordCount: z.number().int(),
  /** The kinds of record it keeps (team-record-types.ts), each with its count, in order. */
  recordTypes: z.array(TeamRecordTypeSchema).default([]),
  /** Sessions role runs made. Work a clock or a role starts is not work the person started, so the
   *  sidebar leaves these to the role's page (design.md, "Work a clock starts"). */
  runSessionIds: z.array(z.string()),
  /** How many runs may go at once and how many are; any engine back-off in force. */
  limits: TeamLimitsSchema,
  /** The newest handoffs and mentions, newest first. */
  handoffs: z.array(TeamHandoffSchema),
  /** The kill switch: every act of this team is held, and nothing posts or sends until the person
   *  lets it go again (team-acts.ts). */
  actsHeld: z.boolean().default(false),
});
export type TeamSpace = z.infer<typeof TeamSpaceSchema>;

/* ── record markdown ─────────────────────────────────────────────────────────────────────────── */

/** A record's file name from a person's name: `Nathan Beyenhof` → `nathan-beyenhof`. */
export function recordSlug(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "record";
}

export type RecordField = { key: string; value: string; meta: Record<string, string> };
export type RecordLine = { text: string; meta: Record<string, string>; field: RecordField | null };
export type ParsedRecord = {
  title: string;
  /** The bullets above the first `##`: Status, Contact, Sends from. */
  head: RecordLine[];
  sections: { heading: string; lines: RecordLine[] }[];
};

const FIELD = /^([A-Za-z][A-Za-z0-9 '’/&-]{0,39}):\s+(.+)$/;

function recordLine(text: string, meta: Record<string, string>): RecordLine {
  const m = FIELD.exec(text);
  return { text, meta, field: m ? { key: m[1]!.trim(), value: m[2]!.trim(), meta } : null };
}

/**
 * A record file as Realm draws it, or null when the file is not in the record's shape — a title, then
 * bullets, then `##` sections of bullets. Null is an answer, not an error: the page shows the Markdown
 * itself then, never a half-drawn form (the Teams plan, section 8). Blank lines and HTML comments are
 * skipped; anything else that is not a bullet makes the file free-form.
 */
export function parseRecord(markdown: string): ParsedRecord | null {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  let title: string | null = null;
  const head: RecordLine[] = [];
  const sections: ParsedRecord["sections"] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    if (title === null) {
      const t = /^#\s+(.+)$/.exec(line);
      if (!t) return null;
      title = t[1]!.trim();
      continue;
    }
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { sections.push({ heading: h[1]!.trim(), lines: [] }); continue; }
    const entry = parseMemoryEntry(line);
    if (!entry || /^\s/.test(line)) return null;
    const parsed = recordLine(entry.text, entry.meta);
    if (sections.length === 0) head.push(parsed);
    else sections[sections.length - 1]!.lines.push(parsed);
  }
  return title === null ? null : { title, head, sections };
}

/** A field's value from the head or a section, by key, case-insensitively. */
export function recordField(r: ParsedRecord, key: string, section?: string): string | null {
  const pool = section ? r.sections.find((s) => s.heading.toLowerCase() === section.toLowerCase())?.lines ?? [] : r.head;
  const k = key.toLowerCase();
  return pool.find((l) => l.field?.key.toLowerCase() === k)?.field?.value ?? null;
}

export type RecordAccount = {
  /** "TikTok", "Instagram", "YouTube Shorts". */
  channel: string;
  handle: string | null;
  /** `key: value` parts after the first, as written: vault, device, consent… */
  parts: Record<string, string>;
  /** Free words after a colon on a line with no handle ("waiting on Nathan"). */
  note: string | null;
};

/**
 * One line of a record's Accounts section: `TikTok @versed.nathan · vault: tiktok.com/nathan · consent:
 * contract §4`, or `YouTube Shorts: waiting on Nathan`. The handle is the first `@word` of the first
 * part; the rest are `key: value` parts.
 */
export function parseAccount(line: RecordLine): RecordAccount {
  const [first = "", ...rest] = line.text.split(/\s+·\s+/);
  const parts: Record<string, string> = {};
  for (const p of rest) {
    const m = /^([A-Za-z][\w -]*):\s*(.+)$/.exec(p.trim());
    if (m) parts[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }
  const handle = /(@[\w.]+)/.exec(first)?.[1] ?? null;
  if (handle) return { channel: first.replace(handle, "").trim() || first, handle, parts, note: null };
  const colon = /^([^:]+):\s*(.+)$/.exec(first);
  return colon ? { channel: colon[1]!.trim(), handle: null, parts, note: colon[2]!.trim() } : { channel: first.trim(), handle: null, parts, note: null };
}

/** The accounts a record names. */
export function recordAccounts(r: ParsedRecord): RecordAccount[] {
  return (r.sections.find((s) => s.heading.toLowerCase() === "accounts")?.lines ?? []).map(parseAccount);
}

/** The template a new creator record starts from. Accounts name vault entries, never values. */
export function creatorRecordTemplate(name: string): string {
  return [
    `# ${name}`,
    "- Status: prospect",
    "",
    "## Deal",
    "",
    "## Accounts",
    "",
    "## Deadlines",
    "",
    "## Content",
    "",
  ].join("\n");
}

/** Start of the ISO week (Monday 00:00, local) — what "this week" means on every meter. */
export function weekStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}
