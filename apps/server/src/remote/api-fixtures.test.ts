import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import {
  normalizeAnswers, sessionEvent, type AskCard, type FileDiff, type Item, type Session, type SessionEvent, type Space, type StoredSessionEvent,
} from "@realm/contracts";
import { MobileCalls, MobileEvents, RowSchema } from "@realm/remote";
import { MobileApi } from "./api";
import { channel, fakeRpc, profile } from "./api.test-fakes";

/**
 * mobile.v1's answers as the Mac writes them, for RealmKit to decode (PROTOCOL.md §9): `home.get` for
 * every profile and for one, a space's pages, `session.open` over a session that holds every row kind
 * (its first message with files sent with it), the turn's changes and a page of its diff, each preview
 * `session.file` makes, a space's picture, three agents' session options and a change to them, every
 * agent a new session can have, and the hint event — every one made by the real projector and the real
 * `MobileApi`, over a fake of the desktop's RPC. Generated, not hand-written, so this test also proves
 * the committed file is what the code produces today:
 * `REALM_WRITE_FIXTURES=1 pnpm vitest run apps/server/src/remote/api-fixtures.test.ts` rewrites it.
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
/** The Realm space's older sessions, more than Home lists, an hour apart. */
const OLDER = Array.from({ length: 6 }, (_, i) => `01JREALM00000000000000000${i + 1}`);
const HOUR = 3_600_000;
const space = (id: string, name: string, icon: string, profileId = "p1"): Space =>
  ({ id, profileId, name, icon, color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "claude", model: "claude-opus-5-5", effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: "Session", lastEventSeq: 40, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 1_790_000_000_000, ...extra });
const item = (refId: string, spaceId: string, title: string): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0 });

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
  mkdirSync(join(home, "tmp", "attachments"), { recursive: true });
  const sent = [{ name: "3f9a1c2b4d5e-IMG_0042.jpg", mime: "image/jpeg" }, { name: "8c1d2e3f4a5b-brief.pdf", mime: "application/pdf" }]
    .map(({ name, mime }) => ({ path: join(home, "tmp", "attachments", name), mime }));
  writeFileSync(sent[0]!.path, "jpeg");
  writeFileSync(sent[1]!.path, "%PDF-1.7");

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
  ];
  const rpc = fakeRpc({
    profiles: [profile("p1", "Work", "briefcase-01"), profile("p2", "School", "emoji:🎓")],
    spaces: [space("sp1", "Realm", "code"), space("sp2", "Deck", "emoji:🌊"), space("sp3", "School", "asset:01JASSET", "p2")],
    sessions,
    items: [item(S, "sp1", "Theme column"), item(CODEX, "sp2", "The deck"), item(QUIET, "sp3", "Lecture notes"),
      ...["Tidy the settings page", "Plan the release", "Fix the flaky upload test", "Audit the sign-in sheet", "Ship 2.0.3", "Write the changelog"].map((title, i) => item(OLDER[i]!, "sp1", title))],
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
  });
  const api = new MobileApi({ macName: () => "MacBook Pro", reportsDir: "/nonexistent", realmHome: home, dev: false, downscale: async () => Buffer.from("jpeg") });
  const call = (method: string, params: unknown) => api.handle(channel(rpc), method, params);

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
    },
    events: {
      "session.hint": [{ id: S, text: "Approve the plan and run the migration" }, { id: S, text: null }],
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
    for (const payload of (fixture.events as Record<string, unknown[]>)["session.hint"]!) expect(MobileEvents["session.hint"].safeParse(payload).success).toBe(true);
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

  it("hold an answer of every call that answers more than ok", async () => {
    const calls = new Set(Object.keys((await generate()).calls as Record<string, unknown>).map((k) => k.split(":")[0]));
    // These answer `{ok: true}`, `{at}` or `{id}`: there is nothing in them for a phone to decode wrongly.
    const plain = ["ping", "session.close", "session.send", "session.answer", "session.stop", "session.seen", "session.create", "debug.report"];
    expect(Object.keys(MobileCalls).filter((m) => !plain.includes(m) && !calls.has(m))).toEqual([]);
  });
});
