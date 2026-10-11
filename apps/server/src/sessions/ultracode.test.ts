import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import type { CreateScheduleInput } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * Ultracode as a session option, through the real app: from the RPC that sets it, by way of every
 * place that copies option fields by name, to the row a window is answered with and the options an
 * agent is started and changed with. Each of those places compiles with the field left out, and a
 * window's own tests cannot see one that drops it, because their fake server merges whatever it is
 * given.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** An answer over the socket, as much of it as these tests read: a session's row, a new session's,
 *  and a settings value. */
type Reply = { result: { id: string; ultracode?: boolean; session: { id: string }; value: unknown } };
type Call = (method: string, params: unknown) => Promise<Reply>;

/** A scripted adapter that keeps what each session was started with, and every change of options
 *  a live one was handed. It answers to whichever kinds the app registers it under. */
class Watched extends FakeAdapter {
  readonly starts: StartOptions[] = [];
  readonly changes: Parameters<AgentHandle["setOptions"]>[0][] = [];
  override start(o: StartOptions): AgentHandle {
    this.starts.push(o);
    return { ...super.start(o), setOptions: async (change) => { this.changes.push(change); } };
  }
}

async function client(port: number): Promise<{ call: Call; close(): void }> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (reply: Reply) => void>();
  let n = 0;
  const call: Call = (method, params) => new Promise((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (reply) => { clearTimeout(timer); res(reply); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()) as Reply & { id?: string }; if (m.id !== undefined) pending.get(m.id)?.(m); });
  return { call, close: () => ws.close() };
}

/** The app with one watched adapter under two kinds, Claude's and one whose harness has no
 *  Ultracode, and a space to make sessions in. */
async function boot() {
  const agent = new Watched({ script: [], delayMs: 2 });
  app = await createApp({ home: tempDir("realm-ultracode-"), port: 0, adapters: { claude: agent, fake: agent }, agentRun: { fallbackKind: "fake" } });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  const session = async (agentKind: "claude" | "fake") => (await c.call("sessions.create", { spaceId: space.id, agentKind })).result.session.id;
  const set = async (id: string, options: Record<string, unknown>) => (await c.call("sessions.setOptions", { id, ...options })).result;
  const start = async (id: string) => {
    const before = agent.starts.length;
    await c.call("sessions.send", { id, text: "go" });
    await waitFor(() => agent.starts.length > before);
    return agent.starts[before]!;
  };
  const kept = async (id: string) => (await c.call("settings.get", { key: `sessions.ultracode:${id}` })).result.value;
  return { agent, c, space, session, set, start, kept };
}

describe("sessions.setOptions — Ultracode on a Claude session", () => {
  it("returns the row with it", async () => {
    const t = await boot();
    expect((await t.set(await t.session("claude"), { ultracode: true })).ultracode).toBe(true);
    t.c.close();
  });

  it("is on the row sessions.get reads afterwards", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    expect((await t.c.call("sessions.get", { id })).result.ultracode).toBe(true);
    t.c.close();
  });

  it("starts the agent with it", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    expect((await t.start(id)).ultracode).toBe(true);
    t.c.close();
  });

  it("starts a session that never asked with no such option at all", async () => {
    const t = await boot();
    expect(await t.start(await t.session("claude"))).not.toHaveProperty("ultracode");
    t.c.close();
  });

  it("returns the row without it once it is taken back", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    expect(await t.set(id, { ultracode: false })).not.toHaveProperty("ultracode");
    t.c.close();
  });

  it("leaves it as it is when another option is set", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    expect((await t.set(id, { effort: "high" })).ultracode).toBe(true);
    t.c.close();
  });

  it("hands a live agent the switch as it is pressed, on and then off", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.start(id);
    await t.set(id, { ultracode: true });
    await t.set(id, { ultracode: false });
    expect(t.agent.changes.map((change) => change.ultracode)).toEqual([true, false]);
    t.c.close();
  });

  it("keeps its settings key until the session is deleted, and not after", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    const before = await t.kept(id);
    await t.c.call("sessions.delete", { id });
    expect([before, await t.kept(id)]).toEqual([true, null]);
    t.c.close();
  });
});

describe("sessions.setOptions — Ultracode on a session whose agent has no such setting", () => {
  it("returns the row without it when the option is switched on", async () => {
    const t = await boot();
    expect(await t.set(await t.session("fake"), { ultracode: true })).not.toHaveProperty("ultracode");
    t.c.close();
  });

  it("writes no settings key for the request it refused", async () => {
    const t = await boot();
    const id = await t.session("fake");
    await t.set(id, { ultracode: true });
    expect(await t.kept(id)).toBeNull();
    t.c.close();
  });

  it("still sets the other options that came in the same call", async () => {
    const t = await boot();
    expect(await t.set(await t.session("fake"), { ultracode: true, effort: "high" })).toMatchObject({ effort: "high" });
    t.c.close();
  });

  it("does not hand a live agent the request it refused", async () => {
    const t = await boot();
    const id = await t.session("fake");
    await t.start(id);
    await t.set(id, { ultracode: true });
    expect(t.agent.changes.map((change) => change.ultracode)).toEqual([undefined]);
    t.c.close();
  });

  it("accepts off, which takes back a request the row was left with when its agent changed", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    const moved = (await t.c.call("sessions.setAgent", { id, agentKind: "fake" })).result.ultracode;
    expect({ moved, takenBack: (await t.set(id, { ultracode: false })).ultracode }).toEqual({ moved: true, takenBack: undefined });
    t.c.close();
  });

  it("starts without the option though its row still holds the request", async () => {
    const t = await boot();
    const id = await t.session("claude");
    await t.set(id, { ultracode: true });
    await t.c.call("sessions.setAgent", { id, agentKind: "fake" });
    expect(await t.start(id)).not.toHaveProperty("ultracode");
    t.c.close();
  });
});

describe("a run that is handed a session to continue", () => {
  const task = (spaceId: string): CreateScheduleInput => ({
    spaceId, title: "Weekly", goal: "Write the status update.", cron: "0 9 * * 1", enabled: true,
    constraints: { agentKind: "claude" }, newSessionPerRun: false, archiveSucceeded: false,
  });
  const run = async (scheduleId: string) => {
    const id = app!.schedules.runNow(scheduleId).lastRunId!;
    await waitFor(() => ["succeeded", "failed", "cancelled", "expired"].includes(app!.runs.get(id)!.run.state));
    return app!.runs.get(id)!.run.sessionId!;
  };

  it("takes Ultracode back on that session, though a person switched it on there since the last run", async () => {
    const t = await boot();
    const schedule = app!.schedules.create(task(t.space.id));
    const id = await run(schedule.id);
    const switchedOn = (await t.set(id, { ultracode: true })).ultracode;
    await run(schedule.id);
    expect({ switchedOn, afterTheNextRun: app!.sessions.get(id).ultracode }).toEqual({ switchedOn: true, afterTheNextRun: undefined });
    t.c.close();
  });

  it("tells the session's live agent so, in the one change of options that resets its level and speed", async () => {
    const t = await boot();
    const schedule = app!.schedules.create(task(t.space.id));
    const id = await run(schedule.id);
    await t.set(id, { ultracode: true });
    await run(schedule.id);
    expect(t.agent.changes.at(-1)).toMatchObject({ effort: null, fastMode: false, ultracode: false, permissionMode: "default" });
    t.c.close();
  });
});
