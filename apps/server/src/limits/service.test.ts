import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { PLAN_LIMIT_REPORTING, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
import { PlanLimitsService } from "./service";
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
    expect(rowFor(rows, "codex").unavailable).toBe("unsupported");
    expect(rowFor(rows, "claude").unavailable).toBe("not-yet-known");
    for (const row of rows) expect(row.windows).toEqual([]);
  });

  it("keys state by agent kind, so two sessions on one account report one number", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ windows: [win("seven_day", 40)] }));
    limits.apply("claude", reading({ windows: [win("seven_day", 55)] }));

    expect(rowFor(limits.list(), "claude").windows).toEqual([win("seven_day", 55)]);
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
