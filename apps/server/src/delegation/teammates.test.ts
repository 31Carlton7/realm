import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions, type FakeScript, type UserMessage } from "@realm/adapters";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { GoalsStore } from "../store/goals";
import { waitFor } from "../test-utils";

/**
 * Teammates, driven through the real app and its RPC socket, as the prompter's "+" reaches them.
 * The mutants this suite exists to kill:
 *
 *   - a second spawn path (sessions.create)        → "adds the teammate through agent_start's path"
 *   - the child put in the space's primary          → "…in the lead's own checkout"
 *   - the lead never told / told twice / on the log  → "the lead's agent is told on its next message"
 *   - a dismissal that does not reach the list      → "dismissing takes it off the lead's list"
 *   - a message to a teammate steered mid-turn      → "a message naming a teammate is passed to it"
 *   - agent_ask still refusing every child / any session asking another's child / asking mid-run
 *                                                   → "the lead can ask its own teammate"
 */

let app: App;
afterEach(async () => { await app?.close(); });

/** Every message a session's agent is handed, by session — the wire, after Realm has added to it. */
class WireFake extends FakeAdapter {
  readonly wire: { cwd: string; text: string }[] = [];
  override start(o: StartOptions): AgentHandle {
    const handle = super.start(o);
    const send = handle.send.bind(handle);
    return { ...handle, events: handle.events, send: async (m: UserMessage) => { this.wire.push({ cwd: o.cwd, text: m.text }); await send(m); } };
  }
}

const SCRIPT: FakeScript = [
  { on: "Plan the release", emit: [{ kind: "text", text: "We ship on Friday once the migration lands." }] },
  { on: "You are a delegated agent.", emit: [{ kind: "text", text: "partial: reading" }, { kind: "text", text: "FINAL: tests written" }] },
];

async function boot(opts: { leadMode?: string; script?: FakeScript; delayMs?: number } = {}) {
  const home = tempDir("realm-tm-");
  const fake = new WireFake({ script: opts.script ?? SCRIPT, delayMs: opts.delayMs ?? 5 });
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake },
    browserAgent: { fallbackKind: "fake", timeouts: { baseMs: 5000, perActMs: 0, pollMs: 20 } },
    agentRun: { timeouts: { baseMs: 5000, perTurnMs: 0, pollMs: 20 } },
    ask: { timeouts: { budgetMs: 5000, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const lead = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: opts.leadMode ?? "default" });
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app.port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: { result?: unknown; error?: { code: string; message: string } }) => void>();
  const frames: { event: string; payload: Record<string, unknown> }[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else frames.push(m); });
  let n = 0;
  const call = <T>(method: string, params: unknown) => new Promise<T>((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.error ? rej(Object.assign(new Error(v.error.message), { code: v.error.code })) : res(v.result as T)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { home, fake, spaceId: space.id, folder: space.folderPath, leadId: lead.session.id, call, frames, close: () => ws.close() };
}

const childrenOf = (spaceId: string, leadId: string) => app.sessions.list(spaceId).filter((s) => s.id !== leadId);
const text = (r: CallToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const settled = (childId: string) => () => app.agentRuns.record(childId)?.outcome !== undefined;

describe("adding a teammate", () => {
  it("adds the teammate through agent_start's path: the lead's sub-agent, its run in the lead's registry, in the lead's mode", async () => {
    const b = await boot({ leadMode: "acceptEdits" });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake", brief: "Write the tests" });
    const child = app.sessions.get(childId);
    expect(child.dispatchedBy).toEqual({ sessionId: b.leadId, kind: "agent_run" });
    expect(child.permissionMode).toBe("acceptEdits");
    expect(child.title).toBe("Write the tests");
    expect(app.agentRuns.record(childId)).toMatchObject({ parentSessionId: b.leadId, mode: { granted: "acceptEdits", inherited: true } });
    const { running } = await b.call<{ running: { sessionId: string; owned: boolean; detached: boolean }[] }>("delegation.running", { sessionId: b.leadId });
    expect(running).toEqual([expect.objectContaining({ sessionId: childId, owned: true, detached: true })]);
    await waitFor(settled(childId));
    b.close();
  });

  it("works in the lead's own checkout when asked for the same folder — not the space's primary", async () => {
    const b = await boot();
    const envs = new EnvironmentsStore(app.db);
    const primary = envs.ensurePrimary(b.spaceId);
    const other = envs.create({ spaceId: b.spaceId, path: join(b.folder, ".."), kind: "checkout", branch: null });
    const lead = app.sessions.create({ spaceId: b.spaceId, agentKind: "fake", projectId: null, environmentId: other.id, model: null, effort: null, permissionMode: "default" });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: lead.session.id });
    const child = app.sessions.get(childId);
    expect(child.environmentId).toBe(other.id);
    expect(child.environmentId).not.toBe(primary.id);
    expect(child.cwd).toBe(app.sessions.get(lead.session.id).cwd);
    await waitFor(settled(childId));
    b.close();
  });

  it("names a teammate given no brief after what runs it, and briefs it with the session's goal and the tail of its conversation", async () => {
    const b = await boot();
    await app.sessions.send(b.leadId, { text: "Plan the release", attachments: [] });
    await waitFor(() => app.sessions.get(b.leadId).status === "idle" && app.sessions.events(b.leadId, 0, 500).some((e) => e.event.type === "assistant_text"));
    new GoalsStore(app.db).start({ sessionId: b.leadId, objective: "Ship 2.4 by Friday", tokenBudget: null });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId });
    expect(app.sessions.get(childId).title).toBe("Fake agent teammate");
    await waitFor(() => b.fake.wire.some((w) => w.text.startsWith("You are a delegated agent.")));
    const handed = b.fake.wire.find((w) => w.text.startsWith("You are a delegated agent."))!.text;
    // The brief is the task, so it is the goal's first line — where its card and its name are read from.
    expect(handed).toMatch(/Accomplish this goal:\n\nHelp with the work in this session wherever you can\./);
    expect(handed).toContain("The session's goal: Ship 2.4 by Friday");
    expect(handed).toContain("User: Plan the release");
    expect(handed).toContain("Assistant: We ship on Friday once the migration lands.");
    await waitFor(settled(childId));
    b.close();
  });

  it("refuses for a session that cannot delegate, in words the prompter can show, creating nothing", async () => {
    const b = await boot();
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId });
    await waitFor(settled(childId));
    const refused = b.call("delegation.addTeammate", { sessionId: childId });
    await expect(refused).rejects.toMatchObject({ code: "TEAMMATE_REFUSED" });
    await expect(refused).rejects.toThrow(/maximum delegation depth/);
    expect(childrenOf(b.spaceId, b.leadId)).toHaveLength(1);
    b.close();
  });
});

describe("the lead's agent is told on its next message", () => {
  it("says the handle and how to coordinate once, on the wire only — the transcript keeps what the user typed", async () => {
    const b = await boot();
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake", brief: "Write the tests" });
    await waitFor(settled(childId));
    await b.call("sessions.send", { id: b.leadId, text: "Plan the release" });
    await waitFor(() => b.fake.wire.some((w) => w.text.startsWith("Plan the release")));
    const told = b.fake.wire.filter((w) => w.text.startsWith("Plan the release"))[0]!.text;
    expect(told).toContain(`"Write the tests" (handle ${childId})`);
    expect(told).toContain("asked to: Write the tests");
    expect(told).toContain("It has already finished: collect its report with agent_wait.");
    expect(told).toMatch(/agent_status lists it and agent_wait collects its report/);
    const said = app.sessions.events(b.leadId, 0, 500).find((e) => e.event.type === "user_message")!.event;
    expect(said.type === "user_message" && said.payload.text).toBe("Plan the release");
    // Spent: the next message says nothing more about it.
    await waitFor(() => app.sessions.get(b.leadId).status === "idle");
    await b.call("sessions.send", { id: b.leadId, text: "Plan the release again" });
    await waitFor(() => b.fake.wire.some((w) => w.text.startsWith("Plan the release again")));
    expect(b.fake.wire.find((w) => w.text.startsWith("Plan the release again"))!.text).not.toContain(childId);
    b.close();
  });

  it("can then list it with agent_status and collect its report with agent_wait, as if it had started it", async () => {
    const b = await boot();
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake" });
    const ctx = { sessionId: b.leadId, spaceId: b.spaceId };
    await waitFor(settled(childId));
    expect(text(app.agentRuns.status(ctx))).toContain(`${childId}: finished (done)`);
    const report = await app.agentRuns.wait(ctx, { handles: [childId] });
    expect(report.isError).toBe(false);
    expect(text(report)).toContain("FINAL: tests written");
    b.close();
  });
});

describe("stopping and dismissing", () => {
  it("a teammate the person stops settles as stopped, and its lead is told so", async () => {
    const long: FakeScript = [{ on: "You are a delegated agent.", emit: [
      { kind: "text", text: "partial: starting" }, ...Array.from({ length: 60 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })),
    ] }];
    const b = await boot({ script: long, delayMs: 50 });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake" });
    await waitFor(() => app.sessions.events(childId, 0, 500).some((e) => e.event.type === "assistant_text"));
    await b.call("sessions.interrupt", { id: childId });
    await waitFor(settled(childId));
    expect(app.agentRuns.record(childId)!.outcome).toBe("stopped");
    expect(text(await app.agentRuns.wait({ sessionId: b.leadId, spaceId: b.spaceId }, { handles: [childId] }))).toContain("did NOT finish (stopped)");
    b.close();
  });

  it("dismissing takes it off the lead's list for every window, and stops nothing", async () => {
    const long: FakeScript = [{ on: "You are a delegated agent.", emit: Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }];
    const b = await boot({ script: long, delayMs: 50 });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake" });
    await waitFor(() => app.sessions.get(childId).status === "running");
    const before = (await b.call<{ dismissed: string[] }>("delegation.children", { sessionId: b.leadId })).dismissed;
    expect(before).toEqual([]);
    const seen = b.frames.length;
    expect((await b.call<{ dismissed: string[] }>("delegation.dismiss", { sessionId: b.leadId, id: childId })).dismissed).toEqual([childId]);
    // A harness's own sub-agent is dismissed by its launching call's id, on the same list.
    await b.call("delegation.dismiss", { sessionId: b.leadId, id: "toolu_01harness" });
    const after = await b.call<{ children: { session: { id: string } }[]; dismissed: string[] }>("delegation.children", { sessionId: b.leadId });
    expect(after.dismissed).toEqual([childId, "toolu_01harness"]);
    expect(after.children.map((c) => c.session.id)).toEqual([childId]);
    await waitFor(() => b.frames.slice(seen).some((f) => f.event === "delegation.changed" && f.payload.sessionId === b.leadId));
    expect(app.sessions.get(childId).status).toBe("running");
    // Deleting the lead forgets what it hid.
    await app.sessions.interrupt(b.leadId);
    app.teammates.release(b.leadId);
    expect(app.teammates.dismissed(b.leadId)).toEqual([]);
    b.close();
  });
});

describe("a message naming a teammate", () => {
  it("is passed to it, queued behind the turn it is in, and the lead is told it was — by handle", async () => {
    const long: FakeScript = [
      { on: "You are a delegated agent.", emit: Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) },
      { on: "Plan the release", emit: [{ kind: "text", text: "ok" }] },
    ];
    const b = await boot({ script: long, delayMs: 40 });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake", brief: "Write the tests" });
    await waitFor(() => app.sessions.get(childId).status === "running");
    await b.call("sessions.send", { id: b.leadId, text: "Plan the release, and @[Write the tests] cover the parser too",
      mentionRefs: [{ kind: "agent", label: "Write the tests", sessionId: childId, delivered: true }] });
    // Queued, not steered: the child's run is not interrupted by it, so its report is still a finish.
    await waitFor(() => app.sessions.queuedPrompts(childId).length === 1);
    expect(app.sessions.queuedPrompts(childId)[0]!.text).toBe("Plan the release, and @Write the tests cover the parser too");
    const told = b.fake.wire.find((w) => w.text.startsWith("Plan the release"))!.text;
    expect(told).toContain(`@[Write the tests] — Realm passed this message to Write the tests (handle ${childId})`);
    await waitFor(settled(childId), { timeout: 10_000 });
    expect(app.agentRuns.record(childId)!.outcome).toBe("done");
    await waitFor(() => b.fake.wire.some((w) => w.text.includes("cover the parser too") && w.text.startsWith("Plan the release, and @Write")));
    b.close();
  });

  it("refuses a session that is not one of this session's sub-agents, and passes it nothing", async () => {
    const b = await boot();
    const stranger = app.sessions.create({ spaceId: b.spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" });
    await b.call("sessions.send", { id: b.leadId, text: "Plan the release with @[Other]",
      mentionRefs: [{ kind: "agent", label: "Other", sessionId: stranger.session.id }] });
    await waitFor(() => b.fake.wire.some((w) => w.text.startsWith("Plan the release")));
    expect(b.fake.wire.find((w) => w.text.startsWith("Plan the release"))!.text).toContain("@[Other] — not passed on: it is not one of this session's sub-agents");
    expect(app.sessions.events(stranger.session.id, 0, 500).some((e) => e.event.type === "user_message")).toBe(false);
    b.close();
  });
});

describe("agent_ask on a teammate", () => {
  it("the lead can ask its own teammate once the task is done — not while it works, and nobody else can", async () => {
    const script: FakeScript = [
      { on: "You are a delegated agent.", emit: Array.from({ length: 20 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) },
      { on: "[Realm]", emit: [{ kind: "text", text: "The parser is in src/parse.ts." }] },
    ];
    // Full access, so the consent card agent_ask raises on the asker answers itself.
    const b = await boot({ leadMode: "bypassPermissions", script, delayMs: 30 });
    const { childId } = await b.call<{ childId: string }>("delegation.addTeammate", { sessionId: b.leadId, agentKind: "fake" });
    await waitFor(() => app.sessions.get(childId).status === "running");
    const lead = { sessionId: b.leadId, spaceId: b.spaceId };
    const busy = await app.asks.ask(lead, { sessionId: childId, question: "Where is the parser?" });
    expect(busy.isError).toBe(true);
    expect(text(busy)).toContain("still on the task it was given");
    await waitFor(settled(childId), { timeout: 10_000 });
    const stranger = app.sessions.create({ spaceId: b.spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions" }).session;
    const theirs = await app.asks.ask({ sessionId: stranger.id, spaceId: b.spaceId }, { sessionId: childId, question: "Where is the parser?" });
    expect(text(theirs)).toContain("working on one goal for another session");
    const answered = await app.asks.ask(lead, { sessionId: childId, question: "Where is the parser?" });
    expect(answered.isError).toBe(false);
    expect(text(answered)).toContain("The parser is in src/parse.ts.");
    // Its run was over before the question, so the report the lead collects is still the task's.
    expect(text(await app.agentRuns.wait(lead, { handles: [childId] }))).toContain("step 19");
    b.close();
  });
});
