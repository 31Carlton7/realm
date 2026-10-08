import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";
import { parseMemoryEntry } from "./memory";
import { RunStateSchema } from "./runs";
import { SkillIdSchema } from "./skills";

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
 *  a message from the role's page. */
export const WOKE_ON = ["schedule", "review", "manual"] as const;
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
  /** A person's words, for a run woken by "Request changes" or a message. */
  wokeNote: z.string().nullable(),
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
  /** A line for the role's card: its job, in plain words. */
  blurb: string;
  brief: string;
  model: string;
  cron: string | null;
  skills: string[];
  /** Its share of the team's $60 week (decision 5), so its meter has something to fill. */
  weekBudgetUsd: number;
  /** The seed its Realmite is rolled from, so both starters look the same the first time everywhere. */
  realmiteSeed: string;
};

/** The two starter roles. Sonnet for routine work (decision 5); the model alias resolves to the
 *  current Sonnet in the Claude harness, so a template never pins a version that will age out. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "creator-manager",
    name: "Creator Manager",
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

/* ────────────────────────────── review ────────────────────────────── */

export const REVIEW_KINDS = ["slideshows", "message", "document", "report"] as const;
export const ReviewKindSchema = z.enum(REVIEW_KINDS);
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
  /** A file changed after it was approved, so the yes no longer covers it. */
  changedSinceApproval: z.boolean(),
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
});
export type TeamReviewDetail = z.infer<typeof TeamReviewDetailSchema>;

/* ────────────────────────────── activity ────────────────────────────── */

export const TEAM_VERBS = ["made_team", "made_role", "edited_role", "archived_role", "woke", "queued", "finished", "failed", "stopped_at_cap",
  "paused", "submitted", "revised", "approved", "asked_changes", "marked_done", "dismissed", "read_record", "updated_record", "refused"] as const;
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
  recordCount: z.number().int(),
  /** Sessions role runs made. Work a clock or a role starts is not work the person started, so the
   *  sidebar leaves these to the role's page (design.md, "Work a clock starts"). */
  runSessionIds: z.array(z.string()),
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
