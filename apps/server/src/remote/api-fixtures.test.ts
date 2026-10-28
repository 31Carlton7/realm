import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import {
  normalizeAnswers, sessionEvent, type AskCard, type DelegatedChild, type FileDiff, type Item, type PlanLimits, type QueuedPrompt, type Run, type Schedule,
  type Session, type SessionEvent, type Space, type StoredSessionEvent, type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary, type UsageSessionRow,
} from "@realm/contracts";
import { tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import { MobileCalls, MobileEvents, RowSchema, type MobileEvent } from "@realm/remote";
import { MobileApi } from "./api";
import { channel, fakeRpc, jpegHeader, machine, machineState, pngHeader, profile, simulator, simulatorState } from "./api.test-fakes";

/**
 * mobile.v1's answers as the Mac writes them, for RealmKit to decode (PROTOCOL.md §9): `home.get` for
 * every profile and for one, with a pinned row, a space's pages, `session.open` over a session that
 * holds every row kind (its first message with files sent with it) and two messages waiting in its
 * queue, the turn's changes and a page of its diff, each preview `session.file` makes, a space's
 * picture, three agents' session options and a change to them, every agent a new session can have;
 * the queue, the lead's sub-agents (one working, two ended), the plans and the month's spend, the
 * reviews still open and one read, a decision and a picture of it, the scheduled tasks and one run
 * now, the screens the theme column's space has open and a frame of one, a rename with a pin and an
 * archive; and every event but `session.rows` and `session.status` —
 * every one made by the real projector and the real `MobileApi`, over a fake of the desktop's RPC.
 * Generated, not hand-written, so this test also proves the committed file is what the code produces
 * today: `REALM_WRITE_FIXTURES=1 pnpm vitest run apps/server/src/remote/api-fixtures.test.ts` rewrites it.
 */

const file = new URL("../../../../packages/remote/test/fixtures/ts-api.json", import.meta.url);
const WRITE = process.env.REALM_WRITE_FIXTURES === "1";
/** Where the made files are said to live in the fixture, whatever scratch folder made them. */
const DECK = "/Users/me/Desktop/Deck";
/** Where the Realm home that took the files sent from a phone is said to be. */
const HOME = "/Users/me/Realm";

const S = "01JSESSION00000000000000000";
const CODEX = "01JCODEX000000000000000000";
const QUIET = "01JQUIET000000000000000000";
/** The Realm space's older sessions, more than Home lists, five hours apart. */
const OLDER = Array.from({ length: 6 }, (_, i) => `01JREALM00000000000000000${i + 1}`);
/** The theme column's sub-agents: one still working, one that finished, one stopped with its lead. */
const WORKER = "01JWORKER00000000000000000";
const MIGRATOR = "01JMIGRATOR000000000000000";
const PROFILER = "01JPROFILER000000000000000";
/** The Deck team's reviews: one waiting with a post and an email, one sent back, one done. */
const REVIEW = "01JREVIEW00000000000000001";
const SENT_BACK = "01JREVIEW00000000000000002";
const DONE = "01JREVIEW00000000000000003";
/** Scheduled tasks: a brief whose run finished unread, a weekly review never run, and a paused one whose run failed. */
const BRIEF = "01JSCHEDULE000000000000001";
const WEEKLY = "01JSCHEDULE000000000000002";
const CI = "01JSCHEDULE000000000000003";
const BRIEF_RUN = "01JRUN00000000000000000001";
const CI_RUN = "01JRUN00000000000000000002";
const NOW_RUN = "01JRUN00000000000000000003";
const BRIEF_SESSION = "01JBRIEF000000000000000000";
/** The Realm space's screens: two simulators, a Mac at an address, a guest that is off, and this Mac's
 *  TextEdit, which a phone is not shown. */
const SIM = "01JSIMULATOR00000000000001";
const PHONE = "01JSIMULATOR00000000000002";
const TEXTEDIT = "01JMACHINE0000000000000001";
const GUEST = "01JMACHINE0000000000000002";
const STUDIO = "01JMACHINE0000000000000003";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Far enough ahead that no window has reset whenever this runs, and far enough back that one has. */
const LATER = 4_102_444_800_000;
const LONG_AGO = 1_600_000_000_000;
const space = (id: string, name: string, icon: string, profileId = "p1"): Space =>
  ({ id, profileId, name, icon, color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "claude", model: "claude-opus-5-5", effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: "Session", lastEventSeq: 40, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 1_790_000_000_000, ...extra });
const item = (refId: string, spaceId: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0, ...extra });
const usageRow = (id: string, title: string, spaceName: string, costUsd: number): UsageSessionRow => ({
  id, title, spaceId: "sp1", spaceName, agentKind: "claude", model: "claude-opus-5-5", createdAt: 0, updatedAt: 0,
  totals: { costUsd, reportedUsd: costUsd, estimatedUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, sessions: 1, unmeasuredSessions: 0 },
});
const limits = (agentKind: string, extra: Partial<PlanLimits> = {}): PlanLimits =>
  ({ agentKind, subscriptionType: null, organization: null, windows: [], alert: "none", alertWindow: null, unavailable: null, detail: null, ts: 0, ...extra });
const summary = (id: string, extra: Partial<TeamReviewSummary> = {}): TeamReviewSummary => ({
  id, spaceId: "sp2", roleId: "01JROLE0000000000000000000", roleName: "Content Producer", runId: null, sessionId: CODEX, recordPath: null,
  kind: "launch", title: "Dark mode launch", state: "waiting", note: null, version: 1, itemCount: 2, thumb: "renders/toggle.png",
  channels: ["instagram"], account: "@realm", to: null, format: "images", verb: "post", changedSinceApproval: false, actsTotal: 0, actsDone: 0,
  createdAt: 1_790_000_000_000, decidedAt: null, updatedAt: 1_790_000_000_000, ...extra,
});
const reviewItem = (id: string, ord: number, extra: Partial<TeamReviewItem>): TeamReviewItem =>
  ({ id, reviewId: REVIEW, version: 1, ord, files: [], body: null, target: null, contentHash: `h${ord}`, approvedHash: null, actState: "none", ...extra });
const schedule = (id: string, spaceId: string, title: string, cron: string, extra: Partial<Schedule> = {}): Schedule => ({
  id, spaceId, title, goal: `${title}, as the task says.`, cron, enabled: true, constraints: null, nextRunAt: null, lastRunAt: null, lastRunId: null,
  lastSkippedAt: null, newSessionPerRun: true, archiveSucceeded: false, roleId: null, createdAt: 1_789_000_000_000, updatedAt: 1_789_000_000_000, ...extra,
});
const run = (id: string, scheduleId: string, state: Run["state"], sessionId: string | null): Run => ({
  id, spaceId: "sp1", title: "Run", goal: "Run", agentKind: "claude", environmentId: null, constraints: null, dedupeKey: null, state, attempt: 1, maxAttempts: 1,
  sessionId, scheduleId, roleId: null, wokeOn: null, costUsd: null, deadlineAt: null, result: null, error: state === "failed" ? "gh is not signed in" : null,
  createdAt: 1_789_990_000_000, startedAt: 1_789_990_000_000, settledAt: state === "queued" ? null : 1_789_990_600_000, updatedAt: 1_789_990_600_000,
});

/** The question card the fixture's request carries: an MCP form with every field a phone answers. */
const card: AskCard = {
  asker: { kind: "server", name: "Linear" }, mode: "form", message: "To file the issue",
  questions: [
    { id: "team", prompt: "Which team?", kind: "choice", options: [{ value: "eng", label: "Engineering", description: "Builds it" }, { value: "ops", label: "Operations" }], allowOther: true },
    { id: "labels", prompt: "Which labels?", header: "Labels", kind: "multi", options: [{ value: "bug", label: "Bug" }, { value: "p1", label: "Urgent" }], allowOther: true },
    { id: "token", prompt: "Paste the deploy token", kind: "text", secret: true, required: true },
    { id: "ship", prompt: "Ship it now?", kind: "confirm" },
  ],
};

async function generate(): Promise<Record<string, unknown>> {
  const dir = tempDir("realm-api-fixture-");
  writeFileSync(join(dir, "notes.md"), "# Deck notes\n\nThree slides.\n");
  writeFileSync(join(dir, "slide.png"), "png");
  writeFileSync(join(dir, "walkthrough.mp4"), "mp4");
  const made = ["slide.png", "notes.md", "walkthrough.mp4"].map((name) => ({ path: join(dir, name), size: 1024 }));
  // What a phone sent with the first message, where the Mac wrote it.
  const home = tempDir("realm-api-fixture-home-");
  const attachments = tempAttachmentDir(home);
  mkdirSync(attachments, { recursive: true });
  const sent = [{ name: "3f9a1c2b4d5e-IMG_0042.jpg", mime: "image/jpeg" }, { name: "8c1d2e3f4a5b-brief.pdf", mime: "application/pdf" }]
    .map(({ name, mime }) => ({ path: join(attachments, name), mime }));
  writeFileSync(sent[0]!.path, "jpeg");
  writeFileSync(sent[1]!.path, "%PDF-1.7");
  // What waits in the theme column's queue: a message being edited, and one a phone sent a sketch with.
  const sketch = join(attachments, "5e6f7a8b9c0d-sketch.png");
  writeFileSync(sketch, "png");
  const queued: QueuedPrompt[] = [
    { id: "01JQUEUED00000000000000001", text: "Then rename the column to theme_mode", attachments: [], ts: 1_790_000_060_000, held: true },
    { id: "01JQUEUED00000000000000002", text: "Use this sketch for the toggle", attachments: [{ path: sketch, mime: "image/png" }], ts: 1_790_000_070_000, held: false },
  ];
  // The picture the Deck team's post goes out with, in the space's folder.
  mkdirSync(join(dir, "renders"), { recursive: true });
  const picture = join(dir, "renders/toggle.png");
  writeFileSync(picture, "png");

  const evs: SessionEvent[] = [
    sessionEvent("user_message", { text: "File the issue, then plan the column", attachments: sent }),
    sessionEvent("thinking", { messageId: "k1", text: "Linear first." }),
    sessionEvent("assistant_text", { messageId: "m1", text: "Filing it in **Linear**." }),
    sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "pnpm test --silent" }, parentToolUseId: null }),
    sessionEvent("tool_result", { toolUseId: "t1", content: "Tests  12 passed", isError: false }),
    sessionEvent("permission_request", { requestId: "q-open", toolName: "mcp__linear__create_issue", input: {}, title: "Linear asks", suggestions: [], ask: card }),
    sessionEvent("permission_request", { requestId: "q-done", toolName: "mcp__linear__create_issue", input: {}, title: "Linear asks", suggestions: [], ask: card }),
    sessionEvent("permission_response", { requestId: "q-done", decision: "allow", answers: { team: "eng", labels: ["bug", "Regression"], token: "••••••", ship: "yes" } }),
    sessionEvent("plan", { planId: "p1", steps: [{ text: "Add the column", status: "completed" }, { text: "Backfill it", status: "in_progress" }] }),
    sessionEvent("permission_request", { requestId: "x1", toolName: "ExitPlanMode", input: { plan: "## Theme column\n\nAdd it, then backfill it." }, title: "Approve the plan?", suggestions: [] }),
    sessionEvent("compacted", { trigger: "auto", preTokens: 180_000, postTokens: 20_000 }),
    sessionEvent("turn_changes", { checkpointId: "01JCHECKPOINT0000000000000", settledAt: 5, root: "/repo", afterTree: "a".repeat(40), totalFiles: 2, files: [
      { path: "src/theme.ts", oldPath: null, status: "modified", additions: 2, deletions: 1 },
      { path: "src/new-name.ts", oldPath: "src/old-name.ts", status: "renamed", additions: 0, deletions: 0 },
    ] }),
    sessionEvent("files_made", { settledAt: 7, files: made, totalFiles: 3 }),
    sessionEvent("error", { message: "Claude hit its usage limit", failure: "usage_limit", fix: { title: "Switch agent", hint: "Continue on Codex", command: null } }),
    sessionEvent("prompt_hint", { text: "Approve the plan and run the migration", throughSeq: 14 }),
  ];
  const log: StoredSessionEvent[] = [
    ...evs.map((event, i) => ({ seq: i + 1, sessionId: S, event })),
    // Cursor named its own modes when the session started, which is what offers Plan and Ask on it.
    { seq: 1, sessionId: QUIET, event: sessionEvent("init", {
      providerSessionId: "cursor-1", model: "composer-2", tools: [], cwd: "/tmp",
      availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }, { id: "ask", name: "Ask" }],
    }) },
  ];
  const patch: FileDiff = {
    path: "src/theme.ts", oldPath: null, staged: false, binary: false, truncated: false, truncatedReason: null, additions: 2, deletions: 1,
    hunks: [{ header: "export function theme()", oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [
      { kind: "context", text: "  const mode = read();", oldLine: 3, newLine: 3 },
      { kind: "del", text: "  return mode;", oldLine: 4, newLine: null },
      { kind: "add", text: "  const column = mode ?? \"system\";", oldLine: null, newLine: 4 },
      { kind: "add", text: "  return column;", oldLine: null, newLine: 5 },
      { kind: "meta", text: "No newline at end of file", oldLine: null, newLine: null },
    ] }],
  };

  const sessions: Session[] = [
    session(S, "sp1", { status: "waiting_permission", title: "Theme column", effort: "high", permissionMode: "acceptEdits", createdAt: 1_789_990_000_000, activityAt: 1_790_000_000_000 }),
    session(CODEX, "sp2", { agentKind: "codex", model: null, status: "error", lastEventSeq: 9, seenSeq: 4, createdAt: 1_789_900_000_000, updatedAt: 1_790_000_100_000, activityAt: 1_790_000_100_000 }),
    session(QUIET, "sp3", { agentKind: "acp:cursor", model: "composer-2", createdAt: 1_789_800_000_000, updatedAt: 1_790_000_200_000, activityAt: 1_790_000_200_000 }),
    ...OLDER.map((id, i) => {
      const at = 1_790_000_000_000 - (i + 1) * 5 * HOUR;
      return session(id, "sp1", {
        lastEventSeq: 3, seenSeq: 3, createdAt: 1_789_000_000_000 + i, updatedAt: at, activityAt: at,
        // Set up again since its conversation last moved: its row was written last of all, and it keeps its place.
        ...(i === 1 ? { model: "claude-sonnet-5", effort: "max", permissionMode: "plan", updatedAt: 1_790_000_300_000 } : {}),
      });
    }),
    // The morning brief's last run, finished while nobody was looking: unread. A run's session is no row of Home's.
    session(BRIEF_SESSION, "sp1", { title: "Morning brief", lastEventSeq: 12, seenSeq: 0, createdAt: 1_789_990_000_000, updatedAt: 1_789_990_600_000, activityAt: 1_789_990_600_000 }),
  ];
  const lead = { sessionId: S, kind: "agent_run" } as const;
  const children: DelegatedChild[] = [
    { session: session(MIGRATOR, "sp1", { model: "claude-sonnet-5", title: "Write the migration", lastEventSeq: 12, seenSeq: 12, dispatchedBy: lead,
        createdAt: 1_789_999_000_000, updatedAt: 1_789_999_400_000, activityAt: 1_789_999_400_000 }),
      goal: "Write the migration that adds the theme column, with a down step.", startedAt: 1_789_999_000_000, settledAt: 1_789_999_400_000, outcome: "done",
      report: "Added `migrations/0042_theme.sql` with an up and a down step. The suite passes.", activity: null },
    { session: session(WORKER, "sp1", { agentKind: "codex", model: "gpt-6-luna", title: "Backfill the theme column", status: "running", lastEventSeq: 30, seenSeq: 0,
        dispatchedBy: lead, createdAt: 1_789_999_500_000, updatedAt: 1_789_999_900_000, activityAt: 1_789_999_900_000 }),
      goal: "Backfill the theme column for every existing row, 500 at a time.", startedAt: 1_789_999_500_000, settledAt: null, outcome: null, report: null, activity: null },
    { session: session(PROFILER, "sp1", { title: "Profile the theme switch", lastEventSeq: 8, seenSeq: 8, dispatchedBy: lead,
        createdAt: 1_789_998_000_000, updatedAt: 1_789_998_300_000, activityAt: 1_789_998_300_000 }),
      goal: "Profile how long the theme switch takes on a cold start.", startedAt: 1_789_998_000_000, settledAt: 1_789_998_300_000, outcome: "interrupted",
      report: null, activity: null, note: "Stopped when the session that started it was stopped." },
  ];
  const plans: PlanLimits[] = [
    limits("claude", { subscriptionType: "max", alert: "approaching", alertWindow: "seven_day", ts: 1_790_000_000_000, windows: [
      { id: "five_hour", label: "5-hour", utilization: 34, resetsAt: LATER },
      { id: "seven_day", label: "Weekly", utilization: 91, resetsAt: LATER + 3 * DAY },
      // Named by the provider, with no figure; and one whose reading is from before it reset.
      { id: "model:Fable", label: "Fable weekly", utilization: null, resetsAt: null },
      { id: "seven_day_opus", label: "Opus weekly", utilization: 64, resetsAt: LONG_AGO },
    ] }),
    limits("codex", { unavailable: "not-yet-known" }),
    limits("acp:gemini", { unavailable: "unsupported" }),
    limits("acp:cursor", { unavailable: "unsupported" }),
    // The scripted agent the suite drives, which no person runs.
    limits("fake", { unavailable: "not-yet-known" }),
  ];
  const month = {
    // The session's own title where its row has another, and one with no row at all.
    sessions: [usageRow(S, "Session", "Realm", 18.42), usageRow(CODEX, "Session", "Deck", 9.1), usageRow(OLDER[0]!, "Session", "Realm", 4.25),
      usageRow(MIGRATOR, "Write the migration", "Realm", 3.75), usageRow(QUIET, "Session", "School", 2.5), usageRow(OLDER[1]!, "Session", "Realm", 0.8),
      usageRow(OLDER[2]!, "Session", "Realm", 0)],
    budget: { budget: { monthlyUsd: 150, thresholds: [0.5, 0.8, 1], includeEstimated: true }, monthSpendUsd: 61.38, monthStart: 0, projectedUsd: 95.4 },
  };
  const open = summary(REVIEW, { title: "Dark mode launch: the post, and a note to Dana", channels: ["instagram", "email"] });
  const reviews = [
    open,
    summary(SENT_BACK, { title: "Reply to Dana about the beta", kind: "message", format: "email", verb: "email", itemCount: 1, thumb: null, channels: ["email"],
      account: "carlton@realm.computer", to: "dana@acme.com", state: "changes", note: "Shorter, and say when it ships", decidedAt: 1_790_000_200_000, updatedAt: 1_790_000_200_000 }),
    summary(DONE, { title: "Last week's posts", state: "done", decidedAt: 1_789_900_000_000, updatedAt: 1_789_900_000_000 }),
  ];
  const detail: TeamReviewDetail = {
    ...open, previous: [], costUsd: 0.84, durationMs: 120_000, runCapUsd: 3, model: null, recordName: null, checks: [], ledger: [], root: dir, tickets: [],
    fileTexts: {}, why: "The toggle shipped today; this says so where people will see it.",
    items: [
      reviewItem("01JITEM0000000000000000001", 0, { files: ["renders/toggle.png"], body: "Dark mode is here: Settings ▸ App ▸ Theme.",
        target: { channel: "instagram", account: "@realm" }, format: "images", action: { connector: "channel:instagram", verb: "post", account: "@realm" } }),
      reviewItem("01JITEM0000000000000000002", 1, { body: "Hi Dana,\n\nDark mode ships on Friday. The beta has it now.\n\nCarlton",
        meta: { Subject: "Dark mode ships Friday" }, format: "email", action: { connector: "mcp:gmail", verb: "email", account: "carlton@realm.computer", to: "dana@acme.com" } }),
    ],
  };
  const tasks: Record<string, Schedule[]> = {
    sp1: [
      schedule(WEEKLY, "sp1", "Weekly review", "0 16 * * 5", { nextRunAt: 1_790_100_000_000 }),
      schedule(BRIEF, "sp1", "Morning brief", "0 8 * * 1-5", { nextRunAt: 1_790_050_000_000, lastRunAt: 1_789_990_000_000, lastRunId: BRIEF_RUN }),
    ],
    sp3: [schedule(CI, "sp3", "Watch CI", "30 9 * * *", { enabled: false, lastRunAt: 1_789_800_000_000, lastRunId: CI_RUN, createdAt: 1_789_100_000_000 })],
  };
  const runs: Record<string, Run> = {
    [BRIEF_RUN]: run(BRIEF_RUN, BRIEF, "succeeded", BRIEF_SESSION),
    [CI_RUN]: run(CI_RUN, CI, "failed", null),
    [NOW_RUN]: run(NOW_RUN, WEEKLY, "queued", null),
  };
  const items = [item(S, "sp1", "Theme column"), item(CODEX, "sp2", "The deck"), item(QUIET, "sp3", "Lecture notes"),
    // Pinned in the sidebar, so Home lists it in Pinned.
    ...["Tidy the settings page", "Plan the release", "Fix the flaky upload test", "Audit the sign-in sheet", "Ship 2.0.3", "Write the changelog"]
      .map((title, i) => item(OLDER[i]!, "sp1", title, { pinned: i === 4 }))];
  const rpc = fakeRpc({
    profiles: [profile("p1", "Work", "briefcase-01"), profile("p2", "School", "emoji:🎓")],
    spaces: [space("sp1", "Realm", "code"), space("sp2", "Deck", "emoji:🌊"), space("sp3", "School", "asset:01JASSET", "p2")],
    sessions,
    items,
    queued: { [S]: queued },
    settings: {
      "ui.lastAgentKind": "codex", "sessions.midTurnMode": "steer", "sessions.defaultPermissionMode": "acceptEdits",
      // What Claude Code said its models take: Haiku takes no level.
      "models.efforts": { "claude:claude-haiku-4-5": [], "claude:claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"] },
    },
  }, {
    "sessions.events": ((p: { id: string; afterSeq?: number; limit?: number; types?: string[] }) =>
      log.filter((e) => e.sessionId === p.id && e.seq > (p.afterSeq ?? 0) && (!p.types || p.types.includes(e.event.type))).slice(0, p.limit ?? 2_000)) as never,
    "checkpoints.turnDiff": (() => patch) as never,
    "iconAssets.list": (() => [{ id: "01JASSET", profileId: "p2", kind: "upload", mime: "image/png", dataText: `data:image/png;base64,${Buffer.from("a picture").toString("base64")}`, prompt: null, createdAt: 0 }]) as never,
    "agents.probe": (() => [
      { kind: "claude", available: true, version: "2.1.300", loggedIn: null, reason: null, models: null },
      { kind: "codex", available: true, version: "0.200.0", loggedIn: true, reason: null, models: [
        { id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
        { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium"], defaultEffort: "low" },
      ] },
      { kind: "acp:cursor", available: true, version: "2026.10.01", loggedIn: null, reason: null, models: [{ id: "composer-2", label: "Composer 2" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }] },
      { kind: "acp:copilot", available: true, version: "1.0.0", loggedIn: false, reason: null, models: null },
      // An ACP agent whose reasoning is its own setting, named in its own words.
      { kind: "acp:opencode", available: true, version: "1.4.0", loggedIn: null, reason: null, models: null,
        efforts: [{ id: "low", label: "low" }, { id: "high", label: "Think hard" }], defaultEffort: "low" },
      { kind: "acp:gemini", available: false, version: null, loggedIn: null, reason: "not on PATH", models: null },
    ]) as never,
    // What the Mac would make of each change: the session's row with it applied.
    "sessions.setOptions": ((p: { id: string; model?: string; effort?: string | null; permissionMode?: string }) => {
      const { id, ...changes } = p;
      return { ...sessions.find((x) => x.id === id)!, ...changes };
    }) as never,
    // A space's own list, archived rows and all; and a change to one, which the lists then carry.
    "items.list": ((p: { spaceId: string }) => items.filter((it) => it.spaceId === p.spaceId)) as never,
    "items.update": ((p: { id: string; title?: string; pinned?: boolean; archived?: boolean }) => {
      const at = items.findIndex((it) => it.id === p.id);
      const { id: _id, ...changes } = p;
      items[at] = { ...items[at]!, ...changes };
      return items[at];
    }) as never,
    "delegation.children": ((p: { sessionId: string }) => ({ children: p.sessionId === S ? children : [], dismissed: [] })) as never,
    "delegation.running": ((p: { sessionId: string }) => ({ running: p.sessionId === S ? [{ sessionId: WORKER, startedAt: 1_789_999_500_000, detached: true, owned: true }] : [] })) as never,
    "limits.get": (() => ({ limits: plans })) as never,
    "usage.summary": (() => month) as never,
    "team.overview": (() => [{ spaceId: "sp2", reviews }]) as never,
    "team.review": ((p: { id: string }) => { if (p.id !== REVIEW) throw new Error(`no review ${p.id}`); return detail; }) as never,
    "team.reviewApprove": (() => ({ ...open, state: "approved", decidedAt: 1_790_000_300_000, updatedAt: 1_790_000_300_000 })) as never,
    "team.reviewRequestChanges": ((p: { note: string }) => ({ ...open, state: "changes", note: p.note, decidedAt: 1_790_000_300_000, updatedAt: 1_790_000_300_000 })) as never,
    "schedules.list": ((p: { spaceId: string }) => tasks[p.spaceId] ?? []) as never,
    "schedules.runNow": ((p: { id: string }) => ({ ...tasks.sp1!.find((t) => t.id === p.id)!, lastRunAt: 1_790_000_400_000, lastRunId: NOW_RUN })) as never,
    "runs.get": ((p: { id: string }) => (runs[p.id] ? { run: runs[p.id], attempts: [] } : null)) as never,
    "simulators.list": ((p: { spaceId: string }) => (p.spaceId !== "sp1" ? { simulators: [], states: [] } : {
      simulators: [simulator(SIM, "sp1", "iPhone 17 Pro"), simulator(PHONE, "sp1", "Carlton's iPhone", { physical: true })],
      states: [simulatorState(SIM, "running"), simulatorState(PHONE, "off")],
    })) as never,
    "machines.list": ((p: { spaceId: string }) => (p.spaceId !== "sp1" ? { machines: [], states: [] } : {
      machines: [machine(TEXTEDIT, "sp1", "TextEdit", "mac"), machine(STUDIO, "sp1", "Studio", "vnc"), machine(GUEST, "sp1", "Ubuntu", "qemu")],
      states: [machineState(TEXTEDIT, "running"), machineState(STUDIO, "running"), machineState(GUEST, "off")],
    })) as never,
    "simulators.capture": (() => ({ data: pngHeader(1206, 2622).toString("base64"), mimeType: "image/png", width: 1206, height: 2622 })) as never,
  });
  const api = new MobileApi({ macName: () => "MacBook Pro", reportsDir: "/nonexistent", realmHome: home, dev: false, downscale: async () => Buffer.from("jpeg") });
  const call = (method: string, params: unknown) => api.handle(channel(rpc), method, params);
  // A frame is the JPEG `sips` makes at the side asked for — here its header alone, which keeps the file
  // small — taken at a clock held still, so the file is the same each time it is made.
  const frames = new MobileApi({ macName: () => "MacBook Pro", reportsDir: "/nonexistent", realmHome: home, dev: false,
    downscale: async (_path, side) => jpegHeader(Math.round(side * 1206 / 2622), side) });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_790_000_500_000);
  const frame = await frames.handle(channel(rpc), "session.screen", { id: S, screenId: SIM, kind: "simulator", maxSide: 1000 }).finally(() => clock.mockRestore());

  // What a phone answering the open question sends, as the Mac's own card keeps it.
  const answers = { team: "ops", labels: ["bug", "Regression"], token: "tok_live_123", ship: "no" };
  const fixture = {
    note: "Written by apps/server/src/remote/api-fixtures.test.ts from the real projector and MobileApi. RealmKit must decode every one.",
    calls: {
      "home.get": await call("home.get", {}),
      "home.get:profile": await call("home.get", { profileId: "p1" }),
      "space.sessions": await call("space.sessions", { id: "sp1", offset: 0, limit: 4 }),
      "space.sessions:last": await call("space.sessions", { id: "sp1", offset: 4, limit: 4 }),
      "session.open": await call("session.open", { id: S, limit: 200 }),
      "session.changes": await call("session.changes", { id: S, checkpointId: "01JCHECKPOINT0000000000000" }),
      "session.diff": await call("session.diff", { id: S, checkpointId: "01JCHECKPOINT0000000000000", path: "src/theme.ts" }),
      "session.file:image": await call("session.file", { id: S, path: made[0]!.path }),
      "session.file:text": await call("session.file", { id: S, path: made[1]!.path }),
      "session.file:none": await call("session.file", { id: S, path: made[2]!.path }),
      "session.file:attachment": await call("session.file", { id: S, path: sent[0]!.path }),
      "space.icon": await call("space.icon", { id: "sp3" }),
      "session.options": await call("session.options", { id: S }),
      "session.options:codex": await call("session.options", { id: CODEX }),
      "session.options:cursor": await call("session.options", { id: QUIET }),
      "session.configure": await call("session.configure", { id: S, model: "claude-sonnet-5", effort: "medium", permission: "bypassPermissions" }),
      "session.configure:plan": await call("session.configure", { id: CODEX, mode: "plan" }),
      "agents.list": await call("agents.list", {}),
      "session.queue": await call("session.queue", { id: S }),
      "session.file:queued": await call("session.file", { id: S, path: sketch }),
      "session.subagents": await call("session.subagents", { id: S }),
      "usage.get": await call("usage.get", {}),
      "reviews.list": await call("reviews.list", {}),
      "review.get": await call("review.get", { id: REVIEW }),
      "review.file": await call("review.file", { id: REVIEW, path: picture }),
      "review.decide": await call("review.decide", { id: REVIEW, decision: "approve" }),
      "review.decide:changes": await call("review.decide", { id: REVIEW, decision: "changes", note: "Say it ships Friday in the caption too" }),
      "schedules.list": await call("schedules.list", {}),
      "schedules.runNow": await call("schedules.runNow", { id: WEEKLY }),
      "session.screens": await call("session.screens", { id: S }),
      "session.screen": frame,
      // Last, because they change the lists every call above reads.
      "session.update": await call("session.update", { id: OLDER[5]!, title: "Write the 2.0.3 changelog", pinned: true }),
      "session.update:archived": await call("session.update", { id: OLDER[3]!, archived: true }),
    },
    events: {
      "session.hint": [{ id: S, text: "Approve the plan and run the migration" }, { id: S, text: null }],
      // The queue as the gateway sends it: the whole list each time, then empty once both have gone out.
      "session.queue": [{ id: S, queued: api.queuedMessages(queued) }, { id: S, queued: [] }],
      "session.subagents": [{ id: S }],
      "work.changed": [{}],
    },
    answer: {
      /** The open question's picks, by label, and words of the person's own, as the phone's card holds them. */
      picks: { team: ["Operations"], labels: ["Bug"], ship: ["No"] },
      own: { labels: "Regression", token: "tok_live_123" },
      /** What `session.answer` carries for them: exactly what the Mac's own card keeps (`normalizeAnswers`). */
      values: normalizeAnswers(card, answers),
    },
  };
  return JSON.parse(JSON.stringify(fixture).replaceAll(dir, DECK).replaceAll(home, HOME)) as Record<string, unknown>;
}

describe("mobile.v1 fixtures for RealmKit (PROTOCOL.md §9)", () => {
  it("are what the code produces today, and every one parses as mobile.v1", async () => {
    const fixture = await generate();
    const calls = fixture.calls as Record<string, unknown>;
    for (const [name, result] of Object.entries(calls)) {
      const method = name.split(":")[0] as keyof typeof MobileCalls;
      expect(MobileCalls[method].result.safeParse(result).success, name).toBe(true);
    }
    for (const [name, payloads] of Object.entries(fixture.events as Record<string, unknown[]>)) {
      for (const payload of payloads) expect(MobileEvents[name as MobileEvent].safeParse(payload).success, name).toBe(true);
    }
    // The answer a phone sends is one the Mac keeps whole.
    expect((fixture.answer as { values: unknown }).values).toEqual({ team: "ops", labels: ["bug", "Regression"], token: "tok_live_123", ship: "no" });
    if (WRITE || !existsSync(file)) writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(fixture);
  });

  it("hold every row kind the projector makes, and a message sent with files", async () => {
    const opened = MobileCalls["session.open"].result.parse(((await generate()).calls as Record<string, unknown>)["session.open"]);
    const kinds = new Set(opened.rows.map((r) => r.kind));
    // `unknown` is the one kind no event of today's makes: a phone draws it for a kind it does not know.
    const every = RowSchema.options.map((o) => o.shape.kind.value).filter((k) => k !== "unknown");
    expect(every.filter((k) => !kinds.has(k))).toEqual([]);
    expect(opened.rows.find((r) => r.kind === "user" && r.attachments?.length)).toBeDefined();
  });

  it("hold every event a phone is sent but the rows and the status, which every session's open already makes", async () => {
    const events = new Set(Object.keys((await generate()).events as Record<string, unknown>));
    // `pair.result` is the pairing channel's, which RealmKit's own pairing tests hold.
    expect(Object.keys(MobileEvents).filter((e) => !["session.rows", "session.status", "home.changed", "pair.result"].includes(e) && !events.has(e))).toEqual([]);
  });

  it("hold an answer of every call that answers more than ok", async () => {
    const calls = new Set(Object.keys((await generate()).calls as Record<string, unknown>).map((k) => k.split(":")[0]));
    // These answer `{ok: true}`, `{at}` or `{id}`: there is nothing in them for a phone to decode wrongly.
    const plain = ["ping", "session.close", "session.send", "session.answer", "session.stop", "session.seen", "session.create", "debug.report",
      "session.sendQueuedNow", "session.removeQueued", "session.holdQueued", "session.editQueued"];
    expect(Object.keys(MobileCalls).filter((m) => !plain.includes(m) && !calls.has(m))).toEqual([]);
  });
});
