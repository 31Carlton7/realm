import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type FakeScript, type StartOptions } from "@realm/adapters";
import type { CreateScheduleInput } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { ItemsStore } from "../store/items";
import { waitFor } from "../test-utils";

/**
 * Scheduled tasks end to end, through the REAL app (`createApp` + a scripted agent): a task in the
 * shape the Schedule a task modal writes, fired with Run now, read back the way the Scheduled page
 * reads it — the run under its task, the session it ran in, the first message it was sent.
 *
 * The named mutants:
 *
 *   - the chosen model left off the session   → "the model it was given"
 *   - the instructions wrapped or rewritten    → "verbatim"
 *   - a scheduled run popping open a pane      → "no pane"
 *   - continuing as a fresh session            → "one conversation"
 *   - the success left in the sidebar          → "archived"
 *   - a task from the tool shaped differently  → "the tool's path"
 */

let app: App;
afterEach(async () => { await app?.close(); });

class CaptureFake extends FakeAdapter {
  readonly seen: StartOptions[] = [];
  constructor(cfg: ConstructorParameters<typeof FakeAdapter>[0]) { super(cfg); }
  override start(o: StartOptions): AgentHandle { this.seen.push(o); return super.start(o); }
}

const GOAL = "Plan the migration, then have GPT-6 Luna implement it with sub-agents.\n\nKeep the plan in docs/plan.md.";
const SCRIPT: FakeScript = [
  { on: "schedule it", emit: [
    { kind: "mcp", tool: "realm-schedule__schedule_create", args: { title: "Weekly review", goal: "Write the status update.", cron: "0 16 * * 5" } },
    { kind: "text", text: "Scheduled." },
  ] },
];

async function boot() {
  const home = tempDir("realm-sched-int-");
  const fake = new CaptureFake({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  return { fake, spaceId: space.id };
}

/** Every broadcast the app makes, in order — what a window would hear. */
async function listen(port: number): Promise<{ events: { event: string; payload: Record<string, unknown> }[]; close: () => void }> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (!("id" in m)) events.push(m); });
  return { events, close: () => ws.close() };
}

const task = (spaceId: string, over: Partial<CreateScheduleInput> = {}): CreateScheduleInput => ({
  spaceId, title: "Migration", goal: GOAL, cron: "0 9 * * 1", enabled: true,
  constraints: { agentKind: "fake", model: "fake-pro", effort: "high" }, newSessionPerRun: true, archiveSucceeded: false, ...over,
});

const runOf = (id: string) => app.runs.get(id)!.run;
const settled = (id: string) => waitFor(() => ["succeeded", "failed", "cancelled", "expired"].includes(runOf(id).state));
const userMessages = (sessionId: string) => app.sessions.events(sessionId, 0, 500)
  .filter((e) => e.event.type === "user_message").map((e) => (e.event.payload as { text: string }).text);

describe("a task fired from the Scheduled page", () => {
  it("runs on the model it was given, sent its instructions verbatim, linked to its task, and opens no pane", async () => {
    const { fake, spaceId } = await boot();
    const ears = await listen(app.port);
    const schedule = app.schedules.create(task(spaceId));
    const runId = app.schedules.runNow(schedule.id).lastRunId!;
    await settled(runId);
    const run = runOf(runId);

    expect(run.state).toBe("succeeded");
    expect(run.scheduleId).toBe(schedule.id);
    // The chosen model is the one that runs: on the session row, and in what the agent was started with.
    const session = app.sessions.get(run.sessionId!);
    expect(session).toMatchObject({ agentKind: "fake", model: "fake-pro", effort: "high" });
    expect(fake.seen.at(-1)).toMatchObject({ model: "fake-pro", effort: "high" });
    // The instructions are the first message, as written — the models named in them included.
    const [first] = userMessages(run.sessionId!);
    expect(first!.startsWith(`${GOAL}\n`)).toBe(true);
    // No pane opened beside whatever the person was doing: the run lands under its task instead. The
    // settle's own broadcast goes out after the one a pane would have, so once it has arrived here,
    // any `session.agentOpened` would have too.
    await waitFor(() => ears.events.some((e) => e.event === "runs.changed" && (e.payload.run as { state?: string } | null)?.state === "succeeded"));
    expect(ears.events.filter((e) => e.event === "session.agentOpened")).toEqual([]);
    ears.close();
  });

  it("lists the run under its task, and only there", async () => {
    const { spaceId } = await boot();
    const a = app.schedules.create(task(spaceId, { title: "A" }));
    const b = app.schedules.create(task(spaceId, { title: "B" }));
    const runA = app.schedules.runNow(a.id).lastRunId!;
    await settled(runA);
    expect(app.runs.list({ spaceId, scheduleId: a.id, states: [], cursor: null, limit: 10 }).runs.map((r) => r.id)).toEqual([runA]);
    expect(app.runs.list({ spaceId, scheduleId: b.id, states: [], cursor: null, limit: 10 }).runs).toEqual([]);
  });
});

describe("a task that continues one session", () => {
  it("sends its next run into the same conversation, one more turn", async () => {
    const { spaceId } = await boot();
    const schedule = app.schedules.create(task(spaceId, { newSessionPerRun: false }));
    const first = app.schedules.runNow(schedule.id).lastRunId!;
    await settled(first);
    const second = app.schedules.runNow(schedule.id).lastRunId!;
    expect(second).not.toBe(first);
    await settled(second);
    expect(runOf(second).sessionId).toBe(runOf(first).sessionId);
    expect(userMessages(runOf(first).sessionId!)).toHaveLength(2);
    expect(runOf(second).state).toBe("succeeded");
  });

  it("a task that does not starts each run in a session of its own", async () => {
    const { spaceId } = await boot();
    const schedule = app.schedules.create(task(spaceId));
    const first = app.schedules.runNow(schedule.id).lastRunId!;
    await settled(first);
    const second = app.schedules.runNow(schedule.id).lastRunId!;
    await settled(second);
    expect(runOf(second).sessionId).not.toBe(runOf(first).sessionId);
  });
});

describe("archiving successful runs", () => {
  it("puts a successful run's session away, and leaves it out when the task does not ask", async () => {
    const { spaceId } = await boot();
    const items = new ItemsStore(app.db);
    const archiving = app.schedules.create(task(spaceId, { archiveSucceeded: true }));
    const keeping = app.schedules.create(task(spaceId, { title: "Keep", archiveSucceeded: false }));
    const a = app.schedules.runNow(archiving.id).lastRunId!;
    const k = app.schedules.runNow(keeping.id).lastRunId!;
    await settled(a); await settled(k);
    await waitFor(() => items.findByRefId(runOf(a).sessionId!)?.archived === true);
    expect(items.findByRefId(runOf(k).sessionId!)?.archived).toBe(false);
  });
});

describe("a task scheduled from a conversation", () => {
  it("goes through the gateway and lands as the same row the modal writes, on the asking session's agent", async () => {
    const { spaceId } = await boot();
    const { session } = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, environmentId: null, model: null, effort: null, permissionMode: "default", title: "Chat" });
    await app.sessions.send(session.id, { text: "please schedule it", attachments: [] });
    await waitFor(() => app.schedules.list(spaceId).length === 1);
    const [made] = app.schedules.list(spaceId);
    expect(made).toMatchObject({
      title: "Weekly review", goal: "Write the status update.", cron: "0 16 * * 5", enabled: true,
      constraints: { agentKind: "fake" }, newSessionPerRun: true, archiveSucceeded: false,
    });
    // The agent saw the tool's own answer, so it can tell the person when the task runs.
    await waitFor(() => app.sessions.events(session.id, 0, 500).some((e) => e.event.type === "tool_result"));
    const result = app.sessions.events(session.id, 0, 500).find((e) => e.event.type === "tool_result")!.event.payload as { content: string; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Scheduled \"Weekly review\"");
  });
});
