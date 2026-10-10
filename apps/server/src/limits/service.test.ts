import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { PLAN_LIMIT_REPORTING, planRowFor, reportsPlanLimits, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
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

/** Two Claude config folders a profile might name. `ACME` sorts before `WORK`, so a list in path
 *  order reads differently from one in the order the folders reported. */
const WORK = "/Users/mara/.claude-work";
const ACME = "/Users/mara/.claude-acme";

/** Every agent but Claude. Each has one account, so a folder must neither split its row nor mark
 *  it. The scripted agent is among them, though the table gives it Claude's source. */
const OTHER_KINDS = (Object.keys(PLAN_LIMIT_REPORTING) as AgentKind[]).filter((kind) => kind !== "claude");

/** The agent at the foot of the table, the furthest from Claude at its head. A list that moved the
 *  agents that have reported to the front would show this one out of place, and would hide the
 *  move for an agent that sits next to Claude. */
const LAST_KIND = OTHER_KINDS.at(-1)!;

/** Every row the list holds for a kind, in the list's order. `rowFor` answers the first alone. */
const rowsOf = (rows: PlanLimits[], kind: AgentKind) => rows.filter((r) => r.agentKind === kind);

/** The folder each of Claude's rows speaks for, in the list's order. A row that names none counts
 *  as the default folder's, as `planRowFor` counts it, so a test of the order fails for the order
 *  alone. */
const claudeHomes = (rows: PlanLimits[]) => rowsOf(rows, "claude").map((r) => r.home ?? null);

/** The row for a Claude session that runs under `home`, null being the default folder. */
const claudeRow = (rows: PlanLimits[], home: string | null) => planRowFor(rows, "claude", home);

/** The default folder, which is null, and the two named ones. */
const FOLDERS = [null, WORK, ACME];

/** The ways one folder's reading can follow another's, the earlier folder first: a named folder
 *  after the default one, the default one after a named folder, and one named folder after another.
 *  A test that checks a rule one way round can still let a work account's reading write on the
 *  personal account's row. */
const FOLDER_PAIRS = [[null, WORK], [WORK, null], [WORK, ACME]] as const;

/** The clock at a test's nth reading, a minute on from the reading before. Readings filed back to
 *  back share a millisecond, which lets a list ordered by each folder's last reading pass for one
 *  ordered by its first. */
const clock = (n: number) => 1_700_000_000_000 + n * 60_000;

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
    limits.apply("claude", reading(), null, 1_700_000_000_000);

    expect(rowFor(limits.list(), "claude").ts).toBe(1_700_000_000_000);
  });
});

describe("PlanLimitsService, one account per Claude config folder", () => {
  it("keeps each folder's windows apart, since each folder is its own account", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ windows: [win("five_hour", 33), win("seven_day", 91)] }), WORK);
    limits.apply("claude", reading({ windows: [win("seven_day", 40)] }), null);
    limits.apply("claude", reading({ windows: [win("five_hour", 55)] }), ACME);

    const rows = limits.list();
    expect(claudeRow(rows, WORK)?.windows).toEqual([win("five_hour", 33), win("seven_day", 91)]);
    expect(claudeRow(rows, null)?.windows).toEqual([win("seven_day", 40)]);
    expect(claudeRow(rows, ACME)?.windows).toEqual([win("five_hour", 55)]);
  });

  it("doesn't fill in a folder's plan tier or organisation from another folder's", () => {
    for (const [earlier, later] of FOLDER_PAIRS) {
      const { limits } = serviceWithBroadcasts();
      limits.apply("claude", reading({ subscriptionType: "max", organization: "Mara's studio" }), earlier);
      limits.apply("claude", reading({ subscriptionType: null, organization: null }), later);

      expect(claudeRow(limits.list(), later), `${later} after ${earlier}`).toMatchObject({ subscriptionType: null, organization: null });
    }
  });

  it("leaves one folder's alert standing when another folder's reading says none", () => {
    for (const [earlier, later] of FOLDER_PAIRS) {
      const { limits } = serviceWithBroadcasts();
      limits.apply("claude", reading({ alert: "exceeded", alertWindow: "seven_day" }), earlier);
      limits.apply("claude", reading({ alert: "none", alertWindow: null }), later);

      expect(claudeRow(limits.list(), earlier), `${earlier} before ${later}`).toMatchObject({ alert: "exceeded", alertWindow: "seven_day" });
    }
  });

  it("lets a named folder's alert clear when that folder's own reading stops warning", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ alert: "exceeded", alertWindow: "seven_day" }), WORK);
    limits.apply("claude", reading({ alert: "none", alertWindow: null }), WORK);

    expect(claudeRow(limits.list(), WORK)).toMatchObject({ alert: "none", alertWindow: null });
  });

  it("changes the reporting folder's row alone, leaving every other folder's as it was to the last field", () => {
    const quiet = reading({ subscriptionType: null, windows: [win("five_hour", 10)] });
    const loud = reading({
      subscriptionType: "team", organization: "Acme", windows: [win("five_hour", 99), win("seven_day", 80)],
      alert: "exceeded", alertWindow: "seven_day", unavailable: "unreadable", detail: "the usage call timed out",
    });
    for (const reporting of FOLDERS) {
      const { limits } = serviceWithBroadcasts();
      for (const home of FOLDERS) limits.apply("claude", quiet, home, clock(1));
      limits.apply("claude", loud, reporting, clock(2));

      for (const home of FOLDERS) {
        expect(claudeRow(limits.list(), home), `${home} after ${reporting} reported`).toMatchObject(home === reporting ? { ...loud, ts: clock(2) } : { ...quiet, ts: clock(1) });
      }
    }
  });

  it("merges a named folder's later reading into that folder's own row", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ subscriptionType: "team", windows: [win("five_hour", 10), win("seven_day", 40)] }), WORK, clock(1));
    limits.apply("claude", reading({ subscriptionType: "max", windows: [win("five_hour", 77)] }), null, clock(2));
    limits.apply("claude", reading({ subscriptionType: null, windows: [win("seven_day", 91)] }), WORK, clock(3));

    expect(claudeRow(limits.list(), WORK)).toMatchObject({ subscriptionType: "team", windows: [win("five_hour", 10), win("seven_day", 91)], ts: clock(3) });
  });

  it("stamps each Claude row with the folder it speaks for, null where its reading named none", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading());
    limits.apply("claude", reading(), WORK);

    expect(rowsOf(limits.list(), "claude").map((r) => r.home)).toEqual([null, WORK]);
  });

  it("files each spelling of a path under its own row, never deciding for itself that two are one folder", () => {
    const { limits } = serviceWithBroadcasts();
    const spellings = [WORK, "/Users/mara/.Claude-Work", `${WORK}/`, `${WORK} `, "/Users/mara/./.claude-work"];
    spellings.forEach((home, n) => limits.apply("claude", reading({ windows: [win("five_hour", n)] }), home));

    expect(spellings.map((home) => claudeRow(limits.list(), home)?.windows)).toEqual(spellings.map((_, n) => [win("five_hour", n)]));
  });

  it("files a reading that names no folder under the default folder", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading({ windows: [win("five_hour", 10)] }));
    limits.apply("claude", reading({ windows: [win("seven_day", 40)] }), null);

    expect(rowsOf(limits.list(), "claude").map((r) => r.windows)).toEqual([[win("five_hour", 10), win("seven_day", 40)]]);
  });

  it("stamps a reading with the present time when the caller gives none", () => {
    const { limits } = serviceWithBroadcasts();
    const before = Date.now();
    limits.apply("claude", reading());
    const after = Date.now();

    const { ts } = rowFor(limits.list(), "claude");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("keeps one row for every other agent, whichever folder its readings name", () => {
    const { limits } = serviceWithBroadcasts();
    for (const kind of OTHER_KINDS) {
      limits.apply(kind, reading({ windows: [win("primary", 12)] }), WORK);
      limits.apply(kind, reading({ windows: [win("secondary", 40)] }), null);
      limits.apply(kind, reading({ windows: [win("primary", 60)] }), ACME);
    }

    for (const kind of OTHER_KINDS) {
      expect(rowsOf(limits.list(), kind).map((r) => r.windows), kind).toEqual([[win("primary", 60), win("secondary", 40)]]);
    }
  });

  it("answers every other agent's row as it always was, with no folder on it, whether its reading names a folder or none", () => {
    for (const home of [null, WORK]) {
      const { limits } = serviceWithBroadcasts();
      for (const kind of OTHER_KINDS) limits.apply(kind, reading({ windows: [win("primary", 12)] }), home, 1_700_000_000_000);

      for (const kind of OTHER_KINDS) {
        expect(rowsOf(limits.list(), kind), `${kind} under ${home}`).toStrictEqual([{
          agentKind: kind, subscriptionType: "max", organization: null, windows: [win("primary", 12)],
          alert: "none", alertWindow: null, unavailable: null, detail: null, ts: 1_700_000_000_000,
        }]);
      }
    }
  });

  it("answers every agent's row as it always was, with no folder on it, while none has reported", () => {
    const { limits } = serviceWithBroadcasts();

    expect(limits.list()).toStrictEqual((Object.keys(PLAN_LIMIT_REPORTING) as AgentKind[]).map((kind) => ({
      agentKind: kind, subscriptionType: null, organization: null, windows: [],
      alert: "none", alertWindow: null, unavailable: reportsPlanLimits(kind) ? "not-yet-known" : "unsupported", detail: null, ts: 0,
    })));
  });

  it("drops the waiting row once a named folder has reported, so Claude is not listed as both run and not yet run", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading(), WORK);

    expect(rowsOf(limits.list(), "claude").map((r) => r.unavailable)).toEqual([null]);
  });

  it("lists the default folder's row first, even when a named folder reported before it", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading(), WORK);
    limits.apply("claude", reading(), null);

    expect(claudeHomes(limits.list())).toEqual([null, WORK]);
  });

  it("lists named folders after the default one, in the order each first reported", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading(), null, clock(1));
    limits.apply("claude", reading(), WORK, clock(2));
    limits.apply("claude", reading(), ACME, clock(3));

    expect(claudeHomes(limits.list())).toEqual([null, WORK, ACME]);
  });

  it("keeps a named folder's place in the list when it reports again", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply("claude", reading(), null, clock(1));
    limits.apply("claude", reading(), WORK, clock(2));
    limits.apply("claude", reading(), ACME, clock(3));
    limits.apply("claude", reading(), WORK, clock(4));

    expect(claudeHomes(limits.list())).toEqual([null, WORK, ACME]);
  });

  it("keeps the agents in the table's order, every Claude row sitting where Claude's one row sat", () => {
    const { limits } = serviceWithBroadcasts();
    limits.apply(LAST_KIND, reading(), null);
    limits.apply("claude", reading(), WORK);
    limits.apply("claude", reading(), null);

    const kinds = Object.keys(PLAN_LIMIT_REPORTING);
    expect(limits.list().map((r) => r.agentKind)).toEqual(kinds.flatMap((kind) => (kind === "claude" ? [kind, kind] : [kind])));
  });

  it("broadcasts the whole list with every reading, whichever agent or folder it came from", () => {
    const { limits, broadcasts } = serviceWithBroadcasts();
    const readings: [AgentKind, string | null][] = [["claude", null], ["claude", WORK], ["claude", ACME], ["claude", WORK], ["claude", null], ["codex", WORK]];
    readings.forEach(([kind, home], n) => {
      limits.apply(kind, reading(), home, clock(n));

      expect(broadcasts).toHaveLength(n + 1);
      expect(broadcasts[n]).toEqual(limits.list());
    });
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
