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
function makeSession(id: string, extra: { spaceId?: string; agentKind?: AgentKind; model?: string | null; createdAt?: number } = {}): Session {
  const spaceId = extra.spaceId ?? spaceA;
  const agentKind = extra.agentKind ?? "claude";
  const model = extra.model === undefined ? "claude-opus-5" : extra.model;
  const createdAt = extra.createdAt ?? day(1);
  const envId = `env-${spaceId}`;
  db.prepare("INSERT OR IGNORE INTO environments (id, space_id, path, branch, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'checkout', ?, ?)")
    .run(envId, spaceId, `/tmp/${spaceId}`, "main", createdAt, createdAt);
  db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, status, provider_session_id, title, last_event_seq, environment_id, created_at, updated_at)
              VALUES (?, ?, NULL, ?, ?, NULL, 'default', 'idle', NULL, ?, 0, ?, ?, ?)`)
    .run(id, spaceId, agentKind, model, `Session ${id}`, envId, createdAt, createdAt);
  return { id, spaceId, projectId: null, agentKind, model, effort: null, permissionMode: "default",
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
