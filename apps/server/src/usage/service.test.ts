import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { USAGE_BUDGET_KEY, sessionEvent, type AgentKind, type ModelInfo, type Session, type SessionEventPayload } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SettingsStore } from "../store/settings";
import { UsageService, environmentLabel, monthKeyOf, startOfMonth } from "./service";

let db: Db; let settings: SettingsStore; let spaceA: string; let spaceB: string; let profileId: string;
let budgetAlerts: { threshold: number; spendUsd: number; monthKey: string }[];

const day = (d: number, hour = 12) => new Date(2026, 8, d, hour).getTime();
const NOW = day(15, 10);

/** $3/M in, $15/M out under the key `canonicalModelKey("gpt-5.6")` folds to. */
const catalog: ModelInfo[] = [
  { key: "5.6-gpt", label: "GPT-5.6", vendor: "OpenAI", priceIn: 3, priceOut: 15, context: null, efforts: [], blurb: null },
];

function service(rows: ModelInfo[] = catalog) {
  budgetAlerts = [];
  return new UsageService({
    db, settings,
    catalog: { list: async () => rows },
    notifications: { budgetCrossed: (i) => budgetAlerts.push({ threshold: i.threshold, spendUsd: i.spendUsd, monthKey: i.monthKey }) },
    now: () => NOW,
  });
}

let seq = 0;
function makeSession(id: string, extra: { spaceId?: string; agentKind?: AgentKind; model?: string | null; effort?: string | null; createdAt?: number } = {}): Session {
  const spaceId = extra.spaceId ?? spaceA;
  const agentKind = extra.agentKind ?? "claude";
  const model = extra.model === undefined ? "claude-opus-5" : extra.model;
  const effort = extra.effort ?? null;
  const createdAt = extra.createdAt ?? day(1);
  const envId = `env-${spaceId}`;
  db.prepare("INSERT OR IGNORE INTO environments (id, space_id, path, branch, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'checkout', ?, ?)")
    .run(envId, spaceId, `/tmp/${spaceId}`, "main", createdAt, createdAt);
  db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, status, provider_session_id, title, last_event_seq, environment_id, created_at, updated_at)
              VALUES (?, ?, NULL, ?, ?, ?, 'default', 'idle', NULL, ?, 0, ?, ?, ?)`)
    .run(id, spaceId, agentKind, model, effort, `Session ${id}`, envId, createdAt, createdAt);
  return { id, spaceId, projectId: null, agentKind, model, effort, permissionMode: "default",
    environmentId: envId, cwd: `/tmp/${spaceId}`, status: "idle", providerSessionId: null, title: `Session ${id}`,
    lastEventSeq: 0, dispatchedBy: null, createdAt, updatedAt: createdAt } as unknown as Session;
}

const appendUsage = (sessionId: string, ts: number, p: SessionEventPayload<"usage">) => {
  db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, 'usage', ?)")
    .run(sessionId, ts, JSON.stringify(p));
  seq++;
};
const appendEvent = (sessionId: string, ts: number, type: string, payload: unknown) =>
  db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)").run(sessionId, ts, type, JSON.stringify(payload));

beforeEach(() => {
  const home = tempDir("realm-usage-");
  db = openDatabase(join(home, "realm.db"));
  settings = new SettingsStore(db);
  profileId = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" }).id;
  const spaces = new SpacesStore(db, home);
  spaceA = spaces.create({ profileId, name: "Alpha", icon: "folder" }).id;
  spaceB = spaces.create({ profileId, name: "Beta", icon: "folder" }).id;
  seq = 0;
});

const range = { from: day(1, 0), to: day(30, 23), bucket: "day" as const, spaceId: null, profileId: null };

describe("UsageService.activeDays", () => {
  const window = { from: day(1, 0), to: day(30, 23) };

  it("counts sent messages per LOCAL day, and the distinct sessions behind them", () => {
    makeSession("s1");
    makeSession("s2");
    appendEvent("s1", day(2, 9), "user_message", { text: "one", attachments: [] });
    appendEvent("s1", day(2, 17), "user_message", { text: "two", attachments: [] });
    appendEvent("s2", day(2, 20), "user_message", { text: "three", attachments: [] });
    appendEvent("s1", day(5, 11), "user_message", { text: "four", attachments: [] });
    expect(service().activeDays(window)).toEqual([
      { day: "2026-09-02", messages: 3, sessions: 2 },
      { day: "2026-09-05", messages: 1, sessions: 1 },
    ]);
  });

  it("measures messages, not tokens — so an engine that reports no usage still shows up", () => {
    // Nine of the eleven engines report no usage at all. A spend- or token-coloured calendar would
    // go blank for every Cursor session and quietly become a graph of which engine reports usage.
    makeSession("s1", { agentKind: "acp:cursor", model: null });
    appendEvent("s1", day(4, 9), "user_message", { text: "hi", attachments: [] });
    expect(service().activeDays(window)).toEqual([{ day: "2026-09-04", messages: 1, sessions: 1 }]);
  });

  it("counts only what the USER sent — a day of tool rounds and answers is not a day of its own", () => {
    // The mutant: dropping the `type` predicate. A single turn writes dozens of tool and text rows,
    // so counting every event would make the intensity a measure of how chatty the agent was.
    makeSession("s1");
    appendEvent("s1", day(6, 9), "assistant_text", { messageId: "m1", text: "hello" });
    appendEvent("s1", day(6, 9), "tool_call", { toolUseId: "t1", name: "Read", input: {}, parentToolUseId: null });
    appendUsage("s1", day(6, 9), { costUsd: 1, inputTokens: 10, outputTokens: 5, numTurns: 1 });
    expect(service().activeDays(window)).toEqual([]);
  });

  it("omits a day with nothing rather than sending a zero for it", () => {
    // A year of zeroes on the wire says exactly what their absence says; the client builds the grid
    // from the range, so an empty week is a visible gap either way.
    makeSession("s1");
    appendEvent("s1", day(2, 9), "user_message", { text: "one", attachments: [] });
    const out = service().activeDays(window);
    expect(out).toHaveLength(1);
    expect(out.every((d) => d.messages > 0)).toBe(true);
  });

  it("holds to its window at both ends", () => {
    makeSession("s1");
    appendEvent("s1", day(1, 0) - 1, "user_message", { text: "before", attachments: [] });
    appendEvent("s1", day(10, 9), "user_message", { text: "inside", attachments: [] });
    appendEvent("s1", day(30, 23) + 1, "user_message", { text: "after", attachments: [] });
    expect(service().activeDays(window).map((d) => d.day)).toEqual(["2026-09-10"]);
  });
});

describe("UsageService.records — the page about you", () => {
  const MIN = 60_000;
  const send = (sessionId: string, ts: number) => appendEvent(sessionId, ts, "user_message", { text: "go", attachments: [] });
  const status = (sessionId: string, ts: number, s: string) => appendEvent(sessionId, ts, "status", { status: s });
  const skill = (sessionId: string, input: Record<string, unknown>) =>
    appendEvent(sessionId, day(3), "tool_call", { toolUseId: `t${Math.random()}`, name: "Skill", input, parentToolUseId: null });

  it("adds up what was reported — differences of a running total, never the totals themselves", () => {
    // Claude's payloads are running totals: this session spent 3000 in, not 1000 + 3000. The fake
    // engine is per-turn, so its one event is its own increment.
    makeSession("s1");
    makeSession("s2", { agentKind: "fake", model: null });
    appendUsage("s1", day(2), { costUsd: 0.1, inputTokens: 1000, outputTokens: 500, numTurns: 1 });
    appendUsage("s1", day(3), { costUsd: 0.3, inputTokens: 3000, outputTokens: 1500, numTurns: 2 });
    appendUsage("s2", day(3), { costUsd: 0.001, inputTokens: 100, outputTokens: 50, numTurns: 1 });
    const out = service().records();
    expect(out.tokens).toEqual({ input: 3100, output: 1550 });
    // The 3rd: 3000 of Claude's increment plus the fake's 150. The 2nd had 1500.
    expect(out.peakDay).toEqual({ day: "2026-09-03", tokens: 3150 });
  });

  it("has no peak day when nothing ever reported a token, and counts the sessions it cannot see", () => {
    // An unknown is not a zero: Cursor's sessions are named rather than drawn as an empty day.
    makeSession("c1", { agentKind: "acp:cursor", model: null });
    makeSession("c2", { agentKind: "acp:cursor", model: null });
    makeSession("s1"); // a Claude session that has not reported yet is not one Realm cannot see
    send("c1", day(2));
    const out = service().records();
    expect(out.tokens).toEqual({ input: 0, output: 0 });
    expect(out.peakDay).toBeNull();
    expect(out.unmeasuredSessions).toBe(2);
  });

  it("finds the longest finished turn across every session, with the wait on a permission taken out", () => {
    makeSession("s1");
    makeSession("s2");
    // s1: 70 minutes on the clock, 60 of them waiting on a prompt — 10 minutes of work.
    status("s1", day(2, 9), "running");
    status("s1", day(2, 9) + 5 * MIN, "waiting_permission");
    status("s1", day(2, 9) + 65 * MIN, "running");
    status("s1", day(2, 9) + 70 * MIN, "idle");
    // s2: 20 straight minutes.
    status("s2", day(3, 9), "running");
    status("s2", day(3, 9) + 20 * MIN, "idle");
    // s2 again, still running — not finished, so not a record however long it has been going.
    status("s2", day(4, 9), "running");
    expect(service().records().longestTurn).toEqual({
      ms: 20 * MIN, endedAt: day(3, 9) + 20 * MIN, sessionId: "s2", title: "Session s2", spaceId: spaceA,
    });
  });

  it("has no longest turn before any turn has finished", () => {
    makeSession("s1");
    status("s1", day(2, 9), "running");
    expect(service().records().longestTurn).toBeNull();
  });

  it("breaks a streak on a single day with nothing sent", () => {
    makeSession("s1");
    // The 9th to the 12th, a gap on the 13th, then the 14th and today (the 15th).
    for (const d of [9, 10, 11, 12, 14, 15]) send("s1", day(d, 11));
    const { streak } = service().records();
    expect(streak.current).toEqual({ days: 2, from: "2026-09-14", to: "2026-09-15" });
    expect(streak.longest).toEqual({ days: 4, from: "2026-09-09", to: "2026-09-12" });
  });

  it("keeps the streak alive on a today that has nothing in it yet", () => {
    // NOW is 10am on the 15th, nothing sent yet today. The run through yesterday is still current.
    makeSession("s1");
    for (const d of [12, 13, 14]) send("s1", day(d, 16));
    expect(service().records().streak.current).toEqual({ days: 3, from: "2026-09-12", to: "2026-09-14" });
  });

  it("counts days the way the calendar does — only what was sent, so a day of agent work alone is not a day", () => {
    makeSession("s1");
    send("s1", day(14, 9));
    appendEvent("s1", day(15, 9), "assistant_text", { messageId: "m", text: "still going" });
    status("s1", day(15, 9), "running");
    const { streak } = service().records();
    expect(streak.current).toEqual({ days: 1, from: "2026-09-14", to: "2026-09-14" });
  });

  it("files a message under the LOCAL day it was sent on, as the calendar does, in any zone", () => {
    // 11:30pm on the 13th and 12:30am on the 14th are two days on the wall clock and one in UTC,
    // either side of the date line. The streak through today is three days long only if the days
    // are local — and the calendar has to show the same three.
    const zone = process.env.TZ;
    try {
      for (const [tz, offsetHours] of [["Asia/Tokyo", 9], ["America/Los_Angeles", -7]] as const) {
        process.env.TZ = tz;
        const local = (d: number, h: number, m = 0) => Date.UTC(2026, 8, d, h, m) - offsetHours * 3_600_000;
        db.exec("DELETE FROM session_events; DELETE FROM sessions;");
        makeSession("s1");
        send("s1", local(13, 23, 30));
        send("s1", local(14, 0, 30));
        send("s1", local(15, 9));
        const svc = new UsageService({ db, settings, catalog: { list: async () => catalog }, now: () => local(15, 10) });
        expect(svc.records().streak.current, tz).toEqual({ days: 3, from: "2026-09-13", to: "2026-09-15" });
        expect(svc.activeDays({ from: local(1, 0), to: local(15, 23) }).map((r) => r.day), tz)
          .toEqual(["2026-09-13", "2026-09-14", "2026-09-15"]);
      }
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });

  it("ranks models and efforts by messages sent, names an engine's default per engine, and skips unchosen efforts", () => {
    makeSession("a", { model: "claude-opus-5", effort: "high" });
    makeSession("b", { model: null });
    makeSession("c", { agentKind: "codex", model: null, effort: "high" });
    makeSession("d", { model: "claude-opus-5", effort: "max" });
    makeSession("e", { model: "claude-sonnet-5", effort: "low" }); // opened, never written to
    for (let i = 0; i < 3; i++) send("a", day(2, 9 + i));
    for (let i = 0; i < 5; i++) send("b", day(3, 9 + i));
    send("c", day(4));
    send("d", day(5));
    const out = service().records();
    expect(out.models).toEqual([
      { key: "default:claude", label: "Claude default (Fable 5.1)", messages: 5, sessions: 1 },
      { key: "claude-opus-5", label: "claude-opus-5", messages: 4, sessions: 2 },
      { key: "default:codex", label: "Codex default (GPT-5.6)", messages: 1, sessions: 1 },
    ]);
    expect(out.efforts).toEqual([
      { effort: "high", messages: 4, sessions: 2 },
      { effort: "max", messages: 1, sessions: 1 },
    ]);
  });

  it("counts the skills agents loaded, once each whichever route loaded them", () => {
    makeSession("s1");
    skill("s1", { skill: "realm:browsing" });
    skill("s1", { skill: "realm:browsing" });
    skill("s1", { skill: "browsing", args: "the docs" });
    skill("s1", { skill: "superpowers:brainstorming" });
    skill("s1", { command: "/run" }); // the field older CLIs sent
    appendEvent("s1", day(3), "tool_call", { toolUseId: "r", name: "Read", input: { file_path: "/x" }, parentToolUseId: null });
    expect(service().records().skills).toEqual([
      { name: "browsing", uses: 3 },
      { name: "run", uses: 1 },
      { name: "superpowers:brainstorming", uses: 1 },
    ]);
  });

  it("ranks tools over all of time, not over the Usage tab's range", () => {
    makeSession("s1", { createdAt: new Date(2025, 0, 1).getTime() });
    const call = (ts: number, name: string) =>
      appendEvent("s1", ts, "tool_call", { toolUseId: `t${ts}${name}`, name, input: {}, parentToolUseId: null });
    call(new Date(2025, 0, 2).getTime(), "Read");
    call(new Date(2025, 0, 2, 1).getTime(), "Read");
    call(new Date(2025, 0, 2, 2).getTime(), "Read");
    call(day(2), "Bash");
    expect(service().records().tools).toEqual([{ name: "Read", calls: 3 }, { name: "Bash", calls: 1 }]);
  });
});

describe("UsageService.summary", () => {
  it("reads a Claude session's own dollars off its running totals", () => {
    makeSession("s1");
    appendUsage("s1", day(2), { costUsd: 0.5, inputTokens: 1000, outputTokens: 500, numTurns: 1 });
    appendUsage("s1", day(3), { costUsd: 1.25, inputTokens: 3000, outputTokens: 1500, numTurns: 3 });
    return service().summary(range).then((out) => {
      expect(out.totals.reportedUsd).toBeCloseTo(1.25, 6);
      expect(out.totals.inputTokens).toBe(3000);
      expect(out.totals.turns).toBe(3);
    });
  });

  it("prices a Codex session from the catalog, and marks it estimated rather than reported", async () => {
    makeSession("s1", { agentKind: "codex", model: "gpt-5.6" });
    appendUsage("s1", day(2), { costUsd: 0, inputTokens: 1_000_000, outputTokens: 200_000, numTurns: 2 });
    const out = await service().summary(range);
    expect(out.totals.reportedUsd).toBe(0);
    expect(out.totals.estimatedUsd).toBeCloseTo(3 + 3, 6); // 1M × $3 + 0.2M × $15
  });

  it("keeps an ACP session in the counts and out of the spend", async () => {
    makeSession("s1", { agentKind: "acp:cursor", model: null });
    appendEvent("s1", day(2), "user_message", { text: "hi", attachments: [] });
    const out = await service().summary(range);
    expect(out.totals.sessions).toBe(1);
    expect(out.totals.unmeasuredSessions).toBe(1);
    expect(out.totals.costUsd).toBe(0);
    expect(out.unmeasuredKinds).toEqual(["acp:cursor"]);
    expect(out.activity.userMessages).toBe(1);
  });

  it("scopes to a space, and refuses to leak another space's spend into it", async () => {
    makeSession("a", { spaceId: spaceA });
    makeSession("b", { spaceId: spaceB });
    appendUsage("a", day(2), { costUsd: 1, inputTokens: 10, outputTokens: 10, numTurns: 1 });
    appendUsage("b", day(2), { costUsd: 9, inputTokens: 10, outputTokens: 10, numTurns: 1 });
    const svc = service();
    expect((await svc.summary({ ...range, spaceId: spaceA })).totals.costUsd).toBeCloseTo(1, 6);
    expect((await svc.summary(range)).totals.costUsd).toBeCloseTo(10, 6);
  });

  it("counts activity for every engine, which is the only footing they share", async () => {
    makeSession("s1", { agentKind: "acp:goose", model: null });
    appendEvent("s1", day(2), "tool_call", { toolUseId: "t1", name: "Bash", input: {}, parentToolUseId: null });
    appendEvent("s1", day(2), "tool_call", { toolUseId: "t2", name: "Bash", input: {}, parentToolUseId: null });
    appendEvent("s1", day(2), "tool_call", { toolUseId: "t3", name: "Read", input: {}, parentToolUseId: null });
    appendEvent("s1", day(2), "error", { message: "boom" });
    const out = await service().summary(range);
    expect(out.activity.toolCalls).toBe(3);
    expect(out.activity.errors).toBe(1);
    expect(out.activity.topTools).toEqual([{ name: "Bash", calls: 2 }, { name: "Read", calls: 1 }]);
  });

  it("summarises proxied MCP traffic, failures and median duration included", async () => {
    makeSession("s1");
    const call = (id: string, name: string, ok: number, ms: number) =>
      db.prepare("INSERT INTO mcp_call_log (id, session_id, server_id, server_name, tool, args_json, result_summary, ok, duration_ms, ts) VALUES (?, 's1', NULL, ?, 't', '{}', '', ?, ?, ?)")
        .run(id, name, ok, ms, day(2));
    call("c1", "realm-browser", 1, 10); call("c2", "realm-browser", 0, 50); call("c3", "linear", 1, 30);
    const out = await service().summary(range);
    expect(out.activity.mcpCalls).toBe(3);
    expect(out.activity.mcpFailures).toBe(1);
    expect(out.activity.mcpMedianMs).toBe(30);
    expect(out.activity.topMcpServers[0]).toEqual({ name: "realm-browser", calls: 2, failures: 1 });
  });

  it("does not re-bill a session's pre-range spend when the window moves", async () => {
    // The named mutant: filtering the EVENTS by the window instead of the deltas would make
    // September's first event look like the whole session's running total.
    makeSession("s1", { createdAt: new Date(2026, 7, 1).getTime() });
    appendUsage("s1", new Date(2026, 7, 20, 12).getTime(), { costUsd: 5, inputTokens: 500_000, outputTokens: 0, numTurns: 4 });
    appendUsage("s1", day(2), { costUsd: 6, inputTokens: 600_000, outputTokens: 0, numTurns: 5 });
    const out = await service().summary(range);
    expect(out.totals.costUsd).toBeCloseTo(1, 6);
    expect(out.totals.inputTokens).toBe(100_000);
  });

  it("survives a catalog that is unreachable — a page with no estimates beats no page", async () => {
    makeSession("s1", { agentKind: "codex", model: "gpt-5.6" });
    appendUsage("s1", day(2), { costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, numTurns: 1 });
    const svc = new UsageService({
      db, settings, catalog: { list: async () => { throw new Error("offline"); } }, now: () => NOW,
    });
    const out = await svc.summary(range);
    expect(out.totals.costUsd).toBe(0);
    expect(out.totals.inputTokens).toBe(1_000_000);
    expect(out.unpricedModels).toEqual(["gpt-5.6"]);
  });

  it("keeps the budget meter on the CALENDAR month however narrow the chart's range is", async () => {
    settings.set(USAGE_BUDGET_KEY, { monthlyUsd: 100, thresholds: [0.8], includeEstimated: true });
    makeSession("s1");
    appendUsage("s1", day(2), { costUsd: 30, inputTokens: 10, outputTokens: 10, numTurns: 1 });
    // A one-day chart range that excludes the spend entirely.
    const out = await service().summary({ ...range, from: day(14, 0), to: day(14, 23) });
    expect(out.totals.costUsd).toBe(0);
    // …but the month is still the month. Narrowing the chart has not un-spent anything.
    expect(out.budget.monthSpendUsd).toBeCloseTo(30, 6);
    expect(out.budget.monthStart).toBe(startOfMonth(NOW));
  });

  it("projects a month-end total from elapsed time", async () => {
    makeSession("s1");
    appendUsage("s1", day(2), { costUsd: 30, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    const out = await service().summary(range);
    // 14 days and 10 hours in on a 30-day month: comfortably more than double.
    expect(out.budget.projectedUsd).not.toBeNull();
    expect(out.budget.projectedUsd!).toBeGreaterThan(55);
    expect(out.budget.projectedUsd!).toBeLessThan(70);
  });

  it("shows no projection on the first day, rather than one divided by nearly nothing", async () => {
    const svc = new UsageService({ db, settings, catalog: { list: async () => catalog }, now: () => day(1, 2) });
    makeSession("s1");
    appendUsage("s1", day(1, 1), { costUsd: 5, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    expect((await svc.summary(range)).budget.projectedUsd).toBeNull();
  });
});

describe("UsageService — the budget", () => {
  it("normalizes what it stores, so a threshold the server dropped never lingers on screen", () => {
    const svc = service();
    const saved = svc.setBudget({ monthlyUsd: 50, thresholds: [1, 0.5, 0.5, 99], includeEstimated: true });
    expect(saved.thresholds).toEqual([0.5, 1]);
    expect(svc.budget()).toEqual(saved);
  });

  it("reads a hand-mangled settings row as the default instead of throwing", () => {
    settings.set(USAGE_BUDGET_KEY, "nonsense");
    expect(service().budget().monthlyUsd).toBeNull();
  });
});

describe("UsageService.handleSessionEvent — threshold alerts", () => {
  const usageEv = (costUsd: number, ts: number) =>
    sessionEvent("usage", { costUsd, inputTokens: 0, outputTokens: 0, numTurns: 1 }, ts);

  it("fires once as spend crosses a threshold, and stays quiet on every turn after", () => {
    settings.set(USAGE_BUDGET_KEY, { monthlyUsd: 100, thresholds: [0.5], includeEstimated: true });
    const svc = service();
    const session = makeSession("s1");

    appendUsage("s1", day(2), { costUsd: 40, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    svc.handleSessionEvent(session, usageEv(40, day(2)));
    expect(budgetAlerts).toEqual([]);

    appendUsage("s1", day(3), { costUsd: 60, inputTokens: 0, outputTokens: 0, numTurns: 2 });
    svc.handleSessionEvent(session, usageEv(60, day(3)));
    expect(budgetAlerts.map((a) => a.threshold)).toEqual([0.5]);

    // The named mutant: deriving the alert from the total rather than the crossing re-fires here.
    appendUsage("s1", day(4), { costUsd: 65, inputTokens: 0, outputTokens: 0, numTurns: 3 });
    svc.handleSessionEvent(session, usageEv(65, day(4)));
    expect(budgetAlerts).toHaveLength(1);
  });

  it("reports every threshold one expensive turn vaults", () => {
    settings.set(USAGE_BUDGET_KEY, { monthlyUsd: 100, thresholds: [0.5, 0.8, 1], includeEstimated: true });
    const svc = service();
    const session = makeSession("s1");
    appendUsage("s1", day(2), { costUsd: 120, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    svc.handleSessionEvent(session, usageEv(120, day(2)));
    expect(budgetAlerts.map((a) => a.threshold)).toEqual([0.5, 0.8, 1]);
    expect(budgetAlerts[0]!.monthKey).toBe("2026-09");
  });

  it("says nothing at all when no budget is set", () => {
    const svc = service();
    const session = makeSession("s1");
    appendUsage("s1", day(2), { costUsd: 9999, inputTokens: 0, outputTokens: 0, numTurns: 1 });
    svc.handleSessionEvent(session, usageEv(9999, day(2)));
    expect(budgetAlerts).toEqual([]);
  });

  it("ignores every event that is not a usage event — it runs on the hot append path", () => {
    settings.set(USAGE_BUDGET_KEY, { monthlyUsd: 1, thresholds: [0.5], includeEstimated: true });
    const svc = service();
    const session = makeSession("s1");
    const spy = vi.spyOn(db, "prepare");
    svc.handleSessionEvent(session, sessionEvent("assistant_text", { messageId: "m", text: "hi" }, day(2)));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("small helpers", () => {
  it("labels a checkout by directory and branch, never by an unreadable full path", () => {
    expect(environmentLabel("/Users/x/Realm/work/realm", "feature/pane-groups")).toBe("realm (feature/pane-groups)");
    expect(environmentLabel("/Users/x/repo", null)).toBe("repo");
    expect(environmentLabel(null, null)).toBe("No checkout");
  });

  it("keys a month so each threshold announces itself once, and next month starts clean", () => {
    expect(monthKeyOf(startOfMonth(day(15)))).toBe("2026-09");
    expect(monthKeyOf(startOfMonth(new Date(2026, 11, 3).getTime()))).toBe("2026-12");
  });
});
