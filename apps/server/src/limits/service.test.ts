import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { PLAN_LIMIT_REPORTING, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
import { PLAN_LIMITS_KEY, PlanLimitsService } from "./service";
import { latestCodexRateLimits } from "./codex-rollout";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { waitFor } from "../test-utils";

/** A reading as an adapter reports one. Defaults are the quiet case: quota known, nothing wrong. */
const reading = (over: Partial<SessionEventPayload<"rate_limit">> = {}): SessionEventPayload<"rate_limit"> => ({
  subscriptionType: "max", organization: null, windows: [], alert: "none", alertWindow: null,
  unavailable: null, detail: null, ...over,
});

const win = (id: string, utilization: number | null, resetsAt: number | null = null) =>
  ({ id, label: id, utilization, resetsAt });

function serviceWithBroadcasts() {
  const broadcasts: PlanLimits[][] = [];
  const rpc = { broadcast: (_m: string, p: { limits: PlanLimits[] }) => { broadcasts.push(p.limits); } };
  return { limits: new PlanLimitsService({ rpc: rpc as never }), broadcasts };
}

const rowFor = (rows: PlanLimits[], kind: AgentKind) => rows.find((r) => r.agentKind === kind)!;

describe("PlanLimitsService", () => {
  it("answers for every agent kind, saying why the silent ones are silent", () => {
    const { limits } = serviceWithBroadcasts();
    const rows = limits.list();

    expect(rows).toHaveLength(Object.keys(PLAN_LIMIT_REPORTING).length);
    // The distinction the panel hangs on: a kind that CANNOT report reads differently from one that
    // simply has not run yet. Neither may read as "you have used nothing".
    expect(rowFor(rows, "acp:cursor").unavailable).toBe("unsupported");
    // Both providers that were captured off a live wire are waiting, not refusing.
    expect(rowFor(rows, "claude").unavailable).toBe("not-yet-known");
    expect(rowFor(rows, "codex").unavailable).toBe("not-yet-known");
    for (const row of rows) expect(row.windows).toEqual([]);
  });

  it("merges windows rather than replacing them, so one moving window does not blank the rest", () => {
    const { limits } = serviceWithBroadcasts();
    // The full control-request answer, then a stream event naming only the window that moved.
    limits.apply("claude", reading({ windows: [win("five_hour", 10), win("seven_day", 40), win("model:Fable", 12)] }));
    limits.apply("claude", reading({ windows: [win("seven_day", 91)], alert: "approaching", alertWindow: "seven_day" }));

    const row = rowFor(limits.list(), "claude");
    expect(row.windows).toEqual([win("five_hour", 10), win("seven_day", 91), win("model:Fable", 12)]);
    expect(row.alert).toBe("approaching");
    expect(row.alertWindow).toBe("seven_day");
  });

  it("appends a window it has never seen rather than dropping it", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ windows: [win("five_hour", 10)] }));
    limits.apply("claude", reading({ windows: [win("some_future_window", 70)] }));

    expect(rowFor(limits.list(), "claude").windows.map((w) => w.id)).toEqual(["five_hour", "some_future_window"]);
  });

  /* An alert has to be able to go DOWN. A provider that stops warning is the normal end of a warning,
   * and a rule that only ever accumulated would leave the chip up until the app restarted. */
  it("lets the alert clear when the provider stops warning", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ alert: "exceeded", alertWindow: "seven_day" }));
    limits.apply("claude", reading({ alert: "none", alertWindow: null }));

    expect(rowFor(limits.list(), "claude").alert).toBe("none");
  });

  it("keeps a plan tier a later reading did not restate", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ subscriptionType: "max" }));
    // A stream event carries status and one window; it never restates the tier.
    limits.apply("claude", reading({ subscriptionType: null, windows: [win("five_hour", 20)] }));

    expect(rowFor(limits.list(), "claude").subscriptionType).toBe("max");
  });

  it("records an account with no plan quota as exactly that, not as an empty one", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ subscriptionType: null, unavailable: "not-on-a-plan" }));

    const row = rowFor(limits.list(), "claude");
    expect(row.unavailable).toBe("not-on-a-plan");
    expect(row.windows).toEqual([]);
  });

  it("broadcasts the whole table on every reading", () => {
    const { limits, broadcasts } = serviceWithBroadcasts();
    limits.apply("claude", reading({ windows: [win("five_hour", 10)] }));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toHaveLength(Object.keys(PLAN_LIMIT_REPORTING).length);
    expect(rowFor(broadcasts[0]!, "claude").windows).toEqual([win("five_hour", 10)]);
  });

  it("stamps when the reading was taken, so a stale panel can say how stale", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading(), 1_700_000_000_000);

    expect(rowFor(limits.list(), "claude").ts).toBe(1_700_000_000_000);
  });

  it("keeps the last reading across a restart, with the time it was taken", () => {
    // After every launch the page's one question — how much is left — had no answer until a session
    // happened to run. The reading survives, stamped, so the panel can say how old it is.
    const db = openDatabase(join(tempDir("realm-limits-"), "realm.db"));
    const settings = new SettingsStore(db);
    const rpc = { broadcast: () => {} } as never;
    new PlanLimitsService({ rpc, settings }).apply("claude", reading({ windows: [win("five_hour", 62, 1_700_000_900_000)] }), 1_700_000_000_000);
    const row = rowFor(new PlanLimitsService({ rpc, settings }).list(), "claude");
    expect(row.windows).toEqual([win("five_hour", 62, 1_700_000_900_000)]);
    expect(row.ts).toBe(1_700_000_000_000);
    expect(row.subscriptionType).toBe("max");
  });

  it("drops a stored row it cannot read rather than the whole table", () => {
    const db = openDatabase(join(tempDir("realm-limits-"), "realm.db"));
    const settings = new SettingsStore(db);
    settings.set(PLAN_LIMITS_KEY, [{ agentKind: "codex", nonsense: true }, { ...rowFor(serviceWithBroadcasts().limits.list(), "claude"), windows: [win("five_hour", 5)], unavailable: null, ts: 9 }]);
    const rows = new PlanLimitsService({ rpc: { broadcast: () => {} } as never, settings }).list();
    expect(rowFor(rows, "claude").windows).toEqual([win("five_hour", 5)]);
    expect(rowFor(rows, "codex").unavailable).toBe("not-yet-known");
  });
});

describe("Codex's plan reading from its own rollouts", () => {
  /** A rollout as codex-cli writes one: session_meta, then a token_count per round trip. */
  function rollout(home: string, day: string, name: string, lines: unknown[]) {
    const [y, m, d] = day.split("-");
    const dir = join(home, "sessions", y!, m!, d!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  const tokenCount = (timestamp: string, limits: Record<string, unknown>) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } });
  const CAPTURED = { limit_id: "codex", primary: { used_percent: 17.0, window_minutes: 300, resets_at: 1788601591 }, secondary: { used_percent: 59.0, window_minutes: 10080, resets_at: 1788773217 }, plan_type: "plus", rate_limit_reached_type: null };

  it("reads the newest snapshot off the newest rollout, in the panel's units", async () => {
    const home = tempDir("realm-codex-");
    rollout(home, "2026-09-03", "rollout-2026-09-03T10-00-00-a.jsonl", [tokenCount("2026-09-03T10:00:00Z", { ...CAPTURED, primary: { used_percent: 2, window_minutes: 300, resets_at: 1 } })]);
    rollout(home, "2026-09-04", "rollout-2026-09-04T11-58-25-b.jsonl", [
      { timestamp: "2026-09-04T11:58:25Z", type: "session_meta", payload: { id: "b" } },
      tokenCount("2026-09-05T04:40:00Z", { ...CAPTURED, primary: { used_percent: 9, window_minutes: 300, resets_at: 1 } }),
      tokenCount("2026-09-05T04:48:59.217Z", CAPTURED),
    ]);
    const found = await latestCodexRateLimits(home);
    expect(found?.ts).toBe(Date.parse("2026-09-05T04:48:59.217Z"));
    const svc = new PlanLimitsService({ rpc: { broadcast: () => {} } as never, codexHome: home });
    await svc.readLocal();
    const row = rowFor(svc.list(), "codex");
    expect(row.windows).toEqual([
      { id: "primary", label: "5-hour", utilization: 17, resetsAt: 1788601591 * 1000 },
      { id: "secondary", label: "Weekly", utilization: 59, resetsAt: 1788773217 * 1000 },
    ]);
    expect(row.subscriptionType).toBe("plus");
    expect(row.ts).toBe(Date.parse("2026-09-05T04:48:59.217Z"));
  });

  it("never rolls a fresher reading back to an older file's", async () => {
    const home = tempDir("realm-codex-");
    rollout(home, "2026-09-04", "rollout-2026-09-04T11-58-25-b.jsonl", [tokenCount("2026-09-05T04:48:59Z", CAPTURED)]);
    const svc = new PlanLimitsService({ rpc: { broadcast: () => {} } as never, codexHome: home });
    svc.apply("codex", reading({ subscriptionType: "plus", windows: [win("primary", 80)] }), Date.parse("2026-09-06T00:00:00Z"));
    await svc.readLocal();
    expect(rowFor(svc.list(), "codex").windows[0]!.utilization).toBe(80);
  });

  it("finds nothing, quietly, in a home with no rollouts", async () => {
    expect(await latestCodexRateLimits(tempDir("realm-codex-"))).toBeNull();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let app: App;
afterEach(async () => { await app?.close(); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

describe("plan limits over rpc", () => {
  it("folds an adapter's reading into per-kind state and broadcasts it, without touching the transcript", async () => {
    const fake = new FakeAdapter({
      script: [{ on: "go", emit: [
        { kind: "rateLimit", payload: reading({ subscriptionType: "max", windows: [win("seven_day", 88, 1_700_000_000_000)], alert: "approaching", alertWindow: "seven_day" }) },
        { kind: "text", text: "ok" },
      ] }],
    });
    const home = tempDir("realm-");
    app = await createApp({ home, port: 0, adapters: { fake } });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;

    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => c.events.some((e) => e.event === "limits.changed"));

    const rows: PlanLimits[] = (await c.call("limits.get", {})).result.limits;
    const row = rowFor(rows, "fake");
    expect(row.subscriptionType).toBe("max");
    expect(row.alert).toBe("approaching");
    expect(row.windows).toEqual([win("seven_day", 88, 1_700_000_000_000)]);

    // The reading is not conversation. A persisted `rate_limit` row would put a number nobody said
    // into the middle of the transcript, and it would still be there — wrong — a week later.
    const stored: Any[] = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 100 })).result;
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((row) => row.event.type === "rate_limit")).toBe(false);
  });
});
