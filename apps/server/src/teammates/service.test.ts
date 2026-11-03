import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentAdapter, type AgentHandle, type FakeScript } from "@realm/adapters";
import { DEFAULT_MODEL_LABEL, type AgentModel, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * Teammates over the real app with the scripted agent: each owns a chat that is an ordinary session,
 * `team_message` is a turn in the other's chat (queued behind a live one, and answered with `wait`),
 * a wait that could never end is refused at once, and what a teammate starts runs in its mode.
 */

let app: App;
afterEach(async () => { await app?.close(); });

const SCRIPT: FakeScript = [
  { on: "hello there", emit: [{ kind: "text", text: "Hi, I am on it." }] },
  { on: "tell design", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "@design", message: "the icon needs a second colour" } }, { kind: "text", text: "Told design." }] },
  { on: "ask design", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "design", message: "which colour is the icon?", wait: true } }, { kind: "text", text: "Design answered." }] },
  { on: "which colour is the icon?", emit: [{ kind: "text", text: "Violet, on graphite." }] },
  { on: "second colour", emit: [{ kind: "text", text: "Noted." }] },
  { on: "slow work", emit: [{ kind: "text", text: "one two three four five six seven eight nine ten", paceMs: 40 }] },
  { on: "start a task", emit: [{ kind: "call", tool: "realm-agent__agent_start", input: { goal: "Move search to SQLite", title: "sqlite search" } }, { kind: "text", text: "Started it." }] },
  { on: "Move search to SQLite", emit: [{ kind: "text", text: "Moved." }] },
  { on: "Do your scheduled work.", emit: [{ kind: "text", text: "Nothing is due today." }] },
  { on: "clock task", emit: [{ kind: "call", tool: "realm-agent__agent_start", input: { goal: "Long migration", title: "long migration" } },
    { kind: "text", text: "a b c d e f g h i j k l m n o p q r s t", paceMs: 150 }] },
  { on: "Long migration", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 400 }] },
];

async function boot(extra: { clockTurnMs?: number } = {}) {
  const home = tempDir("realm-teammates-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" },
    ...(extra.clockTurnMs ? { teammates: { clockTurnMs: extra.clockTurnMs } } : {}) });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  return { spaceId: space.id, make };
}

const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const userMessages = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "user_message" ? [e.payload] : []));
const toolResults = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "tool_result" ? [e.payload.content] : []));
const idle = (sessionId: string) => waitFor(() => app.sessions.get(sessionId).status === "idle" && events(sessionId).some((e) => e.type === "assistant_text"));

describe("a teammate", () => {
  it("is made with its chat: a session in its folder, on its agent and mode, titled with its name and tagged as its home", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO", { permissionMode: "acceptEdits" });
    expect(cto).toMatchObject({ handle: "cto", lead: false, state: "idle", archived: false });
    const home = app.sessions.get(cto.homeSessionId!);
    expect(home).toMatchObject({ title: "CTO", agentKind: "fake", permissionMode: "acceptEdits", teammateId: cto.id, teammateHome: true });
    expect(home.cwd).toBe(cto.folder);
    expect(app.team.list(spaceId).map((t) => t.handle)).toEqual(["cto"]);
  });

  it("takes the person's message as a turn in its chat, told who it is and who its team is", async () => {
    const { make } = await boot();
    make("Design engineer");
    const cto = make("CTO", { lead: true });
    const { sessionId } = await app.team.message(cto.id, "hello there");
    expect(sessionId).toBe(cto.homeSessionId);
    await idle(sessionId);
    expect(userMessages(sessionId).map((m) => m.text)).toEqual(["hello there"]);
    const context = app.team.contextFor(sessionId)!;
    expect(context).toContain("You are @cto (CTO)");
    expect(context).toContain("- @design-engineer — Design engineer: You are Design engineer.");
    expect(context).toContain("You are the Lead.");
    expect(context).toContain('titled "cto - <task>"');
  });

  it("keeps one Lead per space, and leaves the list and the tools when archived", async () => {
    const { spaceId, make } = await boot();
    const a = make("Ops", { lead: true });
    const b = make("Research");
    expect(app.team.setLead(spaceId, b.id).map((t) => [t.handle, t.lead])).toEqual([["research", true], ["ops", false]]);
    app.team.archive(b.id, true);
    expect(app.team.list(spaceId).map((t) => [t.handle, t.lead])).toEqual([["ops", false]]);
    expect(app.team.list(spaceId, true).map((t) => t.handle)).toEqual(["research"]);
    // Its chat stays a session the person can read.
    expect(app.sessions.get(b.homeSessionId!).teammateHome).toBe(true);
    app.team.archive(a.id, true);
    const s = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    expect(app.gateway.realmProvidersFor(s.id, spaceId)).not.toContain("realm-team");
  });

  it("takes its chat back to the agent's default model and effort when set to Default", async () => {
    const home = tempDir("realm-teammates-");
    const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
    const sent: Parameters<AgentHandle["setOptions"]>[0][] = [];
    const claude: AgentAdapter = {
      kind: "claude",
      probe: () => fake.probe(),
      start: (o) => {
        const handle = fake.start(o);
        return { ...handle, setOptions: async (opts) => { sent.push(opts); await handle.setOptions(opts); } };
      },
    };
    app = await createApp({ home, port: 0, adapters: { fake, claude }, agentRun: { fallbackKind: "fake" } });
    const said: string[] = [];
    const broadcast = app.rpc.broadcast.bind(app.rpc);
    vi.spyOn(app.rpc, "broadcast").mockImplementation((event, payload) => { said.push(event); broadcast(event, payload); });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
    const scout = app.team.create({ spaceId: space.id, name: "Scout", brief: "Scouts.", agentKind: "claude", model: "claude-sonnet-5-5", effort: "high" });
    const { sessionId } = await app.team.message(scout.id, "hello there");
    await idle(sessionId);
    said.length = 0;
    app.team.update({ id: scout.id, model: null, effort: null });
    await waitFor(() => sent.length > 0);
    expect(sent).toEqual([{ model: null, effort: null }]);
    expect(app.sessions.get(sessionId)).toMatchObject({ model: null, effort: null });
    // The open chat's chip is re-read too.
    await waitFor(() => said.includes("items.changed"));
  });
});

describe("team_list", () => {
  it("names the model each teammate runs: its own, or the one the CLI says it runs when none is picked", async () => {
    const home = tempDir("realm-teammates-");
    const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
    // The account's CLI runs Opus 5.5 when nothing is pinned, not the model Realm's static label names.
    const models: AgentModel[] = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    ];
    const claude: AgentAdapter = {
      kind: "claude",
      probe: async () => ({ kind: "claude", available: true, version: "fake", loggedIn: true, reason: null, models }),
      start: (o) => fake.start(o),
    };
    app = await createApp({ home, port: 0, adapters: { fake, claude }, agentRun: { fallbackKind: "fake" } });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
    await app.sessions.probe();
    const captain = app.team.create({ spaceId: space.id, name: "Captain", brief: "Releases.", agentKind: "claude" });
    app.team.create({ spaceId: space.id, name: "Scout", brief: "Scouts.", agentKind: "claude", model: "claude-sonnet-5-5" });
    const listed = app.team.teamList({ sessionId: captain.homeSessionId!, spaceId: space.id }).content
      .flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    expect(listed).toContain("@captain (you) — Captain: Releases. · idle · Claude Opus 5.5");
    expect(listed).toContain("@scout — Scout: Scouts. · idle · Claude Sonnet 5.5");
    expect(listed).not.toContain(DEFAULT_MODEL_LABEL.claude);
  });
});

describe("team_message", () => {
  it("puts a turn in the other teammate's chat, marked as from the sender", async () => {
    const { make } = await boot();
    const design = make("Design");
    const cto = make("CTO");
    await app.team.message(cto.id, "tell design");
    await waitFor(() => userMessages(design.homeSessionId!).length === 1);
    const [got] = userMessages(design.homeSessionId!);
    expect(got).toMatchObject({ text: "From @cto: the icon needs a second colour", from: { sessionId: cto.homeSessionId, title: "@cto", teammateId: cto.id } });
    await idle(cto.homeSessionId!);
    expect(toolResults(cto.homeSessionId!)[0]).toMatch(/^Sent to @design\. You are not waiting/);
  });

  it("waits behind a turn the other is on, and with wait answers with its reply", async () => {
    const { make } = await boot();
    const design = make("Design");
    const cto = make("CTO");
    // Design is busy when the question comes.
    await app.team.message(design.id, "slow work");
    await waitFor(() => app.sessions.get(design.homeSessionId!).status === "running");
    await app.team.message(cto.id, "ask design");
    await waitFor(() => toolResults(cto.homeSessionId!).length === 1, { timeout: 10_000 });
    const answer = toolResults(cto.homeSessionId!)[0]!;
    expect(answer).toContain("@design answered");
    expect(answer).toContain("Violet, on graphite.");
    // The question went in after the turn it found running: the slow one's answer is not taken for it.
    expect(answer).not.toContain("one two three");
    expect(userMessages(design.homeSessionId!).map((m) => m.text)).toEqual(["slow work", "From @cto: which colour is the icon?"]);
  });

  it("refuses at once a wait on yourself, or on a teammate that is waiting on you", async () => {
    const { spaceId, make } = await boot();
    const design = make("Design");
    const cto = make("CTO");
    const ctx = (sessionId: string) => ({ sessionId, spaceId });
    const self = await app.team.teamMessage(ctx(cto.homeSessionId!), { to: "cto", message: "anything", wait: true });
    expect(self.isError).toBe(true);
    expect(JSON.stringify(self.content)).toContain("that is you");

    // Design's own task session messaging Design's chat with wait: still Design waiting on itself.
    const task = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default",
      teammate: { id: design.id, home: false } }).session;
    const onItself = await app.team.teamMessage(ctx(task.id), { to: "design", message: "anything", wait: true });
    expect(JSON.stringify(onItself.content)).toContain("waiting on yourself would never end");

    // Design waits on the CTO, who is busy, so the wait stays open…
    await app.team.message(cto.id, "slow work");
    await waitFor(() => app.sessions.get(cto.homeSessionId!).status === "running");
    const designWaits = app.team.teamMessage(ctx(design.homeSessionId!), { to: "cto", message: "which colour is the icon?", wait: true });
    // …and the CTO waiting on Design now would never end.
    const started = Date.now();
    const loop = await app.team.teamMessage(ctx(cto.homeSessionId!), { to: "design", message: "and you?", wait: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(loop.isError).toBe(true);
    expect(JSON.stringify(loop.content)).toContain("@design is waiting on you");
    expect((await designWaits).isError).toBe(false);
  });

  it("names who is here when the handle is wrong, and finds the Lead by \"lead\"", async () => {
    const { spaceId, make } = await boot();
    const ops = make("Ops");
    const cto = make("CTO");
    const ctx = { sessionId: cto.homeSessionId!, spaceId };
    expect(JSON.stringify((await app.team.teamMessage(ctx, { to: "lead", message: "hi" })).content)).toContain("no Lead");
    expect(JSON.stringify((await app.team.teamMessage(ctx, { to: "@nobody", message: "hi" })).content)).toContain("there is no @nobody here. Teammates here: @ops, @cto");
    app.team.setLead(spaceId, ops.id);
    expect((await app.team.teamMessage(ctx, { to: "lead", message: "hi" })).isError).toBe(false);
    await waitFor(() => userMessages(ops.homeSessionId!).length === 1);
  });

  it("reaches a teammate from the person's own session, and an @ in the person's message passes it on", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    const mine = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    expect(app.gateway.realmProvidersFor(mine.id, spaceId)).toContain("realm-team");
    const refs = await app.team.passMentioned(mine.id, "@[cto] hello there", [{ kind: "role", label: "cto", roleId: cto.id }]);
    expect(refs).toEqual([{ kind: "role", label: "cto", roleId: cto.id, sessionId: cto.homeSessionId, delivered: true }]);
    await waitFor(() => userMessages(cto.homeSessionId!).some((m) => m.text === "@cto hello there"));
  });
});

describe("what a teammate starts", () => {
  it("is never hidden: it carries the teammate, leads with its handle, and runs in the teammate's mode", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO", { permissionMode: "acceptEdits" });
    // The person set its chat's chip lower; the task still runs as the teammate does.
    await app.sessions.setOptions(cto.homeSessionId!, { permissionMode: "default" });
    await app.team.message(cto.id, "start a task");
    await waitFor(() => app.sessions.listAll().some((s) => s.dispatchedBy?.sessionId === cto.homeSessionId));
    const task = app.sessions.listAll().find((s) => s.dispatchedBy?.sessionId === cto.homeSessionId)!;
    expect(task).toMatchObject({ teammateId: cto.id, teammateHome: false, title: "cto - sqlite search", permissionMode: "acceptEdits" });
    const view = app.team.get(cto.id);
    expect(view.taskSessions.map((t) => [t.id, t.title, t.parentId])).toEqual([[task.id, "cto - sqlite search", null]]);
    expect(app.team.sessions(cto.id).map((t) => t.id)).toEqual([task.id]);
    void spaceId;
  });

  it("runs in Full access when the teammate does", async () => {
    const { make } = await boot();
    const cto = make("CTO", { permissionMode: "bypassPermissions" });
    await app.team.message(cto.id, "start a task");
    await waitFor(() => app.sessions.listAll().some((s) => s.dispatchedBy?.sessionId === cto.homeSessionId));
    expect(app.sessions.listAll().find((s) => s.dispatchedBy?.sessionId === cto.homeSessionId)).toMatchObject({ permissionMode: "bypassPermissions", teammateId: cto.id });
  });
});

describe("a teammate's clock", () => {
  /** The clock's next occurrence is now, and the scheduler's minute has come. */
  const due = (scheduleId: string) => {
    app.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1_000, scheduleId);
    app.schedules.tick();
  };
  const clockTurns = (sessionId: string) => userMessages(sessionId).filter((m) => m.scheduled);

  it("writes its prompt into the teammate's chat as the clock's turn, in the teammate's mode, unread and without a pane", async () => {
    const { make } = await boot();
    const ops = make("Ops", { permissionMode: "acceptEdits", schedule: { cron: "0 8 * * 1" } });
    expect(ops.schedule).toMatchObject({ cron: "0 8 * * 1", prompt: "Do your scheduled work.", enabled: true, lastRunAt: null });
    expect(ops.schedule!.nextRunAt).toBeGreaterThan(Date.now());
    // The person set the chat's chip lower; the clock's turn runs as the teammate does.
    await app.sessions.setOptions(ops.homeSessionId!, { permissionMode: "default" });
    const broadcast = app.rpc.broadcast.bind(app.rpc);
    const said: string[] = [];
    vi.spyOn(app.rpc, "broadcast").mockImplementation((event, payload) => { said.push(event); broadcast(event, payload); });

    due(ops.schedule!.id);
    await waitFor(() => clockTurns(ops.homeSessionId!).length === 1);
    const [turn] = clockTurns(ops.homeSessionId!);
    expect(turn!.text.startsWith("Do your scheduled work.\n\n[Realm] Your schedule sent this")).toBe(true);
    expect(turn!.scheduled).toMatchObject({ task: "Ops", scheduleId: ops.schedule!.id });
    expect(turn!.from).toBeUndefined();
    await idle(ops.homeSessionId!);
    expect(app.sessions.get(ops.homeSessionId!).permissionMode).toBe("acceptEdits");
    // No run, no new session: the chat is where it happened.
    expect(app.sessions.listAll().filter((s) => s.teammateId === ops.id).map((s) => s.id)).toEqual([ops.homeSessionId]);
    const after = app.team.get(ops.id);
    expect(after.unread).toBe(true);
    expect(after.schedule!.lastRunAt).not.toBeNull();
    expect(after.schedule!.nextRunAt).toBeGreaterThan(Date.now());
    expect(said).toContain("teammates.changed");
    expect(said).not.toContain("session.agentOpened");
  });

  it("does not fire while paused, stops while its teammate is archived, and starts again from now when it is back", async () => {
    const { make } = await boot();
    const paused = make("Research", { schedule: { cron: "0 9 * * 1-5", enabled: false } });
    expect(paused.schedule).toMatchObject({ enabled: false, nextRunAt: null });
    due(paused.schedule!.id);
    const ops = make("Ops", { schedule: { cron: "0 8 * * 1" } });
    app.team.archive(ops.id, true);
    expect(app.team.get(ops.id).schedule!.nextRunAt).toBeNull();
    due(ops.schedule!.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(clockTurns(paused.homeSessionId!)).toEqual([]);
    expect(clockTurns(ops.homeSessionId!)).toEqual([]);
    expect(app.team.get(ops.id).schedule!.lastRunAt).toBeNull();

    const back = app.team.archive(ops.id, false);
    expect(back.schedule!.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("is set, changed and removed with the teammate, and a clock that would never run is refused with the rest of the edit", async () => {
    const { spaceId, make } = await boot();
    const ops = make("Ops");
    expect(ops.schedule).toBeNull();
    expect(() => app.team.update({ id: ops.id, schedule: { prompt: "Check the invoices." } })).toThrow(/needs a cron/);
    const set = app.team.update({ id: ops.id, schedule: { cron: "0 8 * * 1", prompt: "Check the invoices." } });
    expect(set.schedule).toMatchObject({ cron: "0 8 * * 1", prompt: "Check the invoices.", enabled: true });
    expect(app.team.update({ id: ops.id, schedule: { enabled: false } }).schedule).toMatchObject({ cron: "0 8 * * 1", prompt: "Check the invoices.", enabled: false, nextRunAt: null });
    expect(() => app.team.update({ id: ops.id, name: "Admin", schedule: { cron: "not a clock", enabled: true } })).toThrow(/will ever run/);
    expect(app.team.get(ops.id).name).toBe("Ops");
    // A rename carries to the clock's title, which the chat draws above its turns.
    app.team.update({ id: ops.id, name: "Admin" });
    expect(app.schedules.forTeammate(ops.id)!.title).toBe("Admin");
    // Its page edits it; the Scheduled page neither lists nor edits it.
    expect(app.schedules.list(spaceId)).toEqual([]);
    expect(() => app.schedules.update({ id: set.schedule!.id, cron: "0 9 * * *" })).toThrow(/teammate's clock/);
    expect(app.team.update({ id: ops.id, schedule: null }).schedule).toBeNull();
    expect(() => make("Bad", { schedule: { cron: "never" } })).toThrow(/will ever run/);
    expect(app.team.list(spaceId).map((t) => t.handle)).toEqual(["ops"]);
  });

  it("skips an occurrence while its last turn is still going", async () => {
    const { make } = await boot();
    const ops = make("Ops", { schedule: { cron: "0 8 * * 1", prompt: "slow work" } });
    due(ops.schedule!.id);
    await waitFor(() => app.sessions.get(ops.homeSessionId!).status === "running");
    due(ops.schedule!.id);
    expect(app.team.get(ops.id).schedule!.lastSkippedAt).not.toBeNull();
    expect(() => app.schedules.runNow(ops.schedule!.id)).toThrow(/has not ended yet/);
    await idle(ops.homeSessionId!);
    expect(clockTurns(ops.homeSessionId!)).toHaveLength(1);
    // Once it has ended, the next one goes.
    app.schedules.runNow(ops.schedule!.id);
    await waitFor(() => clockTurns(ops.homeSessionId!).length === 2);
  });

  it("stops a turn that runs past its time, and leaves the task session it started working", async () => {
    const { make } = await boot({ clockTurnMs: 1_500 });
    const ops = make("Ops", { schedule: { cron: "0 8 * * 1", prompt: "clock task" } });
    due(ops.schedule!.id);
    await waitFor(() => app.sessions.listAll().some((s) => s.dispatchedBy?.sessionId === ops.homeSessionId), { timeout: 10_000 });
    const task = app.sessions.listAll().find((s) => s.dispatchedBy?.sessionId === ops.homeSessionId)!;
    // The settle after its turn began (an engine's start reports one of its own before it).
    const settle = () => {
      const statuses = events(ops.homeSessionId!).flatMap((e) => (e.type === "status" ? [e.payload] : []));
      return statuses.slice(statuses.findIndex((p) => p.status === "running")).find((p) => p.status === "idle") ?? null;
    };
    await waitFor(() => settle() !== null, { timeout: 10_000 });
    expect(settle()).toMatchObject({ interrupted: true });
    expect(app.sessions.get(task.id).status).toBe("running");
    await waitFor(() => app.sessions.get(task.id).status === "idle", { timeout: 10_000 });
    expect(events(task.id).some((e) => e.type === "assistant_text" && e.payload.text.includes("seven eight"))).toBe(true);
    expect(events(task.id).some((e) => e.type === "status" && e.payload.interrupted)).toBe(false);
  });
});
