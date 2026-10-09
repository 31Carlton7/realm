import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../../app";
import { ProfilesStore } from "../../store/profiles";
import { SpacesStore } from "../../store/spaces";
import { waitFor } from "../../test-utils";

/**
 * Phase 4 over the real socket, with the scripted agent calling the real tools through the gateway:
 * a role hands work to another along an edge and the receiver wakes as a run of its own; a mention in
 * a person's message starts the role as that session's sub-agent; a role's goal runs on the goal loop
 * and its run settles when the goal does; an engine's limit backs every team off until its reset.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const RESET = Date.now() + 10 * 60_000;
const HANDOFF = { to: "Creator Manager", note: "Six slides are done; draft the message to Nathan.", record: "nathan-beyenhof", files: ["deck/01.png"] };

const SCRIPT: FakeScript = [
  { on: "hand it over twice", emit: [
    { kind: "call", tool: "realm-team__team_handoff", input: HANDOFF },
    { kind: "call", tool: "realm-team__team_handoff", input: { ...HANDOFF, note: "And again." } },
    { kind: "text", text: "Handed to Creator Manager." },
  ] },
  { on: "hand it to the editor", emit: [
    { kind: "call", tool: "realm-team__team_handoff", input: { to: "Editor", note: "check these" } },
    { kind: "text", text: "tried" },
  ] },
  { on: "handed you work", emit: [{ kind: "text", text: "Drafting the message to Nathan now, slowly and with care.", paceMs: 40 }] },
  { on: "mentioned you and asked", emit: [{ kind: "usage", costUsd: 2 }, { kind: "text", text: "Nathan's deadline is Friday." }] },
  { on: "Continue working towards this objective:\n\nOBJ-STALL", emit: [{ kind: "idle" }] },
  { on: "OBJ-STALL", emit: [{ kind: "call", tool: "realm-team__team_roles", input: {} }, { kind: "call", tool: "realm-team__team_roles", input: {} }, { kind: "text", text: "Started on it." }] },
  { on: "OBJ-CLOSE", emit: [
    { kind: "call", tool: "realm-goal__update_goal", input: { status: "complete", note: "All four records are current." } },
    { kind: "text", text: "Done: all four records are current." },
  ] },
  { on: "hit the limit", emit: [
    { kind: "rateLimit", payload: { subscriptionType: "max", organization: null, alert: "exceeded", alertWindow: "five_hour", unavailable: null, detail: null,
      windows: [{ id: "five_hour", label: "5-hour", utilization: 100, resetsAt: RESET }] } },
    { kind: "text", text: "Out of quota." },
  ] },
  { on: "take your time", emit: [{ kind: "text", text: "one two three four five six seven eight nine ten", paceMs: 60 }] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 8000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const must = async (method: string, params: unknown) => { const r = await call(method, params); if (!r.ok) throw new Error(`${method}: ${r.error?.message}`); return r.result; };
  return { call, must, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-handoffs-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
  mkdirSync(join(space.folderPath, "deck"), { recursive: true });
  writeFileSync(join(space.folderPath, "deck/01.png"), "png");
  const c = await client(app.port);
  await c.must("team.make", { spaceId: space.id, templates: [] });
  const mk = (name: string, extra: Record<string, unknown> = {}) =>
    c.must("team.roleCreate", { spaceId: space.id, name, brief: `${name}'s brief.`, realmite: { seed: name }, agentKind: "fake", ...extra });
  const producer = await mk("Content Producer");
  const manager = await mk("Creator Manager");
  const editor = await mk("Editor");
  await c.must("team.recordCreate", { spaceId: space.id, name: "Nathan Beyenhof" });
  return { c, spaceId: space.id, producer: producer.id as string, manager: manager.id as string, editor: editor.id as string };
}

const runsOf = async (c: Any, roleId: string) => (await c.must("team.roleRuns", { id: roleId, limit: 30 })) as Any[];
const settled = (r: Any) => !["queued", "running", "blocked"].includes(r.state);
const toolResults = (sessionId: string) => app.sessions.events(sessionId, 0, 500).filter((e) => e.event.type === "tool_result").map((e) => (e.event.payload as Any).content as string);

describe("handoffs", () => {
  it("a role hands off along its edge: the receiver wakes as a run with the note, both pages see it, and a second handoff about the same record starts nothing", async () => {
    const { c, spaceId, producer, manager } = await boot();
    const edited = await c.must("team.roleHandoffs", { id: producer, handsOffTo: [manager] });
    expect(edited.handsOffTo).toEqual([manager]);
    await c.must("team.roleRun", { id: producer, message: "hand it over twice" });
    await waitFor(async () => (await runsOf(c, manager)).length === 1, { timeout: 8000 });
    const [cm] = await runsOf(c, manager);
    expect(cm).toMatchObject({ wokeOn: "handoff", wokeBy: "Content Producer", wokeNote: HANDOFF.note });
    const team = await c.must("team.space", { spaceId });
    /* THE mutant: dedupe dropped — the second call would start a second Creator Manager run. */
    expect(team.handoffs).toHaveLength(1);
    expect(team.handoffs[0]).toMatchObject({ kind: "handoff", fromRoleId: producer, toRoleId: manager, recordPath: "creators/nathan-beyenhof.md", files: ["deck/01.png"], runId: cm.id });
    expect(["queued", "working"]).toContain(team.handoffs[0].state);
    const cpSession = (await runsOf(c, producer))[0].sessionId;
    await waitFor(() => toolResults(cpSession).length === 2, { timeout: 8000 });
    expect(toolResults(cpSession)[1]).toMatch(/already working on this/);
    // The receiver was told what was passed: the note, the record and the files.
    await waitFor(async () => (await runsOf(c, manager))[0].sessionId !== null, { timeout: 8000 });
    const first = app.sessions.events((await runsOf(c, manager))[0].sessionId, 0, 50).find((e) => e.event.type === "user_message")!;
    expect(JSON.stringify(first.event.payload)).toContain("Content Producer handed you work on creators/nathan-beyenhof.md");
    expect(JSON.stringify(first.event.payload)).toContain("- deck/01.png");
    const verbs = (await c.must("team.activity", { spaceId, limit: 50 })).map((a: Any) => `${a.verb}:${a.object}`);
    expect(verbs).toContain("handed_off:Creator Manager");
    await waitFor(async () => (await runsOf(c, manager)).every(settled), { timeout: 10_000 });
    expect((await c.must("team.space", { spaceId })).handoffs[0].state).toBe("done");
    c.close();
  });

  it("refuses a handoff along no edge, and names who it does hand to", async () => {
    const { c, producer, manager } = await boot();
    await c.must("team.roleHandoffs", { id: producer, handsOffTo: [manager] });
    await c.must("team.roleRun", { id: producer, message: "hand it to the editor" });
    await waitFor(async () => (await runsOf(c, producer)).every(settled), { timeout: 8000 });
    const [result] = toolResults((await runsOf(c, producer))[0].sessionId);
    expect(result).toMatch(/does not hand work to Editor — it hands off to Creator Manager/);
    expect(await runsOf(c, manager)).toEqual([]);
    c.close();
  });

  it("refuses a handoff from a session that is not a role's run", async () => {
    const { c, spaceId } = await boot();
    const { session } = await c.must("sessions.create", { spaceId, agentKind: "fake" });
    await c.must("sessions.send", { id: session.id, text: "hand it to the editor", attachments: [] });
    await waitFor(() => toolResults(session.id).length === 1, { timeout: 8000 });
    expect(toolResults(session.id)[0]).toMatch(/only a role's own run hands work off/);
    c.close();
  });

  it("a new team's starters hand off where their templates say", async () => {
    const { c } = await boot();
    const profile = new ProfilesStore(app.db).create({ name: "Q", icon: "x", color: "#000" });
    const other = new SpacesStore(app.db, tempDir("realm-handoffs-other-")).create({ profileId: profile.id, name: "Fresh", icon: "folder" });
    const team = await c.must("team.make", { spaceId: other.id, templates: ["content-producer", "creator-manager", "growth-analyst"] });
    const by = (name: string) => team.roles.find((r: Any) => r.name === name);
    expect(by("Content Producer").handsOffTo).toEqual([by("Creator Manager").id]);
    expect(by("Creator Manager").handsOffTo).toEqual([by("Content Producer").id]);
    expect(by("Growth Analyst").handsOffTo).toEqual([]);
    c.close();
  });

  it("starters hand off where their templates say, and a role cannot hand off to itself", async () => {
    const { c, spaceId } = await boot();
    const team = await c.must("team.make", { spaceId, templates: ["researcher", "editor"] });
    // "Editor" was already a role by name, so only Researcher was made — and it hands off to no template-made editor.
    const researcher = team.roles.find((r: Any) => r.name === "Researcher");
    expect(researcher.handsOffTo).toEqual([]);
    const r = await c.call("team.roleHandoffs", { id: researcher.id, handsOffTo: [researcher.id] });
    expect(r.ok).toBe(false);
    c.close();
  });
});

describe("mentions", () => {
  it("@Role in a person's message starts the role as that session's sub-agent, at the tighter of the two modes, and its cost counts in the role's week", async () => {
    const { c, spaceId, manager } = await boot();
    await c.must("team.roleUpdate", { id: manager, permissionMode: "plan" });
    const { session } = await c.must("sessions.create", { spaceId, agentKind: "fake", permissionMode: "acceptEdits" });
    await c.must("sessions.send", { id: session.id, text: "@[Creator Manager] when is Nathan due?", attachments: [],
      mentionRefs: [{ kind: "role", label: "Creator Manager", roleId: manager, childId: "01FORGED0000000000000000000" }] });
    await waitFor(async () => (await c.must("team.space", { spaceId })).handoffs.length === 1, { timeout: 8000 });
    const h = (await c.must("team.space", { spaceId })).handoffs[0];
    expect(h).toMatchObject({ kind: "mention", toRoleId: manager, fromSessionId: session.id });
    const child = app.sessions.get(h.sessionId);
    /* THE mutant: the role's own mode, or the lead's, not the tighter. */
    expect(child.permissionMode).toBe("plan");
    // The lead's own message names the sub-agent Realm started — never the id a client forged.
    const msg = app.sessions.events(session.id, 0, 50).find((e) => e.event.type === "user_message")!;
    expect((msg.event.payload as Any).refs[0]).toMatchObject({ kind: "role", childId: h.sessionId });
    await waitFor(async () => (await c.must("team.space", { spaceId })).handoffs[0].state === "done", { timeout: 10_000 });
    const role = (await c.must("team.space", { spaceId })).roles.find((r: Any) => r.id === manager);
    expect(role.weekSpendUsd).toBeCloseTo(2, 4);
    const [row] = await runsOf(c, manager);
    expect(row).toMatchObject({ wokeOn: "mention", wokeBy: "You", state: "succeeded", sessionId: h.sessionId });
    c.close();
  });

  it("a mention never runs looser than the session that asked: a role on Accept edits under a lead on Ask runs on Ask", async () => {
    const { c, spaceId, manager } = await boot();
    await c.must("team.roleUpdate", { id: manager, permissionMode: "acceptEdits" });
    const { session } = await c.must("sessions.create", { spaceId, agentKind: "fake", permissionMode: "default" });
    await c.must("sessions.send", { id: session.id, text: "@[Creator Manager] status?", attachments: [], mentionRefs: [{ kind: "role", label: "Creator Manager", roleId: manager }] });
    await waitFor(async () => (await c.must("team.space", { spaceId })).handoffs.length === 1, { timeout: 8000 });
    expect(app.sessions.get((await c.must("team.space", { spaceId })).handoffs[0].sessionId).permissionMode).toBe("default");
    c.close();
  });

  it("a role set not to wake on mentions is not started, and the message says why", async () => {
    const { c, spaceId, manager } = await boot();
    await c.must("team.roleHandoffs", { id: manager, wakeOnMention: false });
    const { session } = await c.must("sessions.create", { spaceId, agentKind: "fake" });
    await c.must("sessions.send", { id: session.id, text: "@[Creator Manager] status?", attachments: [], mentionRefs: [{ kind: "role", label: "Creator Manager", roleId: manager }] });
    await waitFor(() => app.sessions.events(session.id, 0, 50).some((e) => e.event.type === "user_message"), { timeout: 8000 });
    const msg = app.sessions.events(session.id, 0, 50).find((e) => e.event.type === "user_message")!;
    expect((msg.event.payload as Any).refs[0].refused).toMatch(/not to wake on a mention/);
    expect((await c.must("team.space", { spaceId })).handoffs).toEqual([]);
    c.close();
  });
});

describe("goals", () => {
  it("a role's goal run outlives its first turn and stops with the goal loop's stall stop", async () => {
    const { c, spaceId, manager } = await boot();
    const run = await c.must("team.roleGoal", { id: manager, objective: "OBJ-STALL keep every record current" });
    expect(run.wokeOn).toBe("goal");
    await waitFor(async () => (await c.must("team.space", { spaceId })).roles.find((r: Any) => r.id === manager).goal?.turns >= 1, { timeout: 8000 });
    /* THE mutant: no hold — the run would settle `succeeded` after the first turn while the goal went on. */
    expect((await runsOf(c, manager))[0].state).toBe("running");
    await waitFor(async () => settled((await runsOf(c, manager))[0]), { timeout: 15_000 });
    const [after] = await runsOf(c, manager);
    expect(after.state).toBe("cancelled");
    expect(after.error).toMatch(/no progress/);
    const role = (await c.must("team.space", { spaceId })).roles.find((r: Any) => r.id === manager);
    expect(role.goal).toMatchObject({ status: "blocked", objective: "OBJ-STALL keep every record current" });
    expect((await c.must("team.activity", { spaceId, limit: 50 })).map((a: Any) => a.verb)).toEqual(expect.arrayContaining(["goal_set", "goal_stopped"]));
    c.close();
  }, 20_000);

  it("a goal the role closes settles its run as done, with the note; a second goal while one is live is refused", async () => {
    const { c, spaceId, manager } = await boot();
    await c.must("team.roleGoal", { id: manager, objective: "OBJ-CLOSE" });
    const again = await c.call("team.roleGoal", { id: manager, objective: "another" });
    expect(again.ok).toBe(false);
    await waitFor(async () => settled((await runsOf(c, manager))[0]), { timeout: 10_000 });
    expect((await runsOf(c, manager))[0]).toMatchObject({ state: "succeeded", summary: "Done: all four records are current." });
    expect((await c.must("team.space", { spaceId })).roles.find((r: Any) => r.id === manager).goal.status).toBe("complete");
    c.close();
  });
});

describe("limits and the back-off", () => {
  it("an engine's plan limit backs every team off until its reset: a new run queues, and lifting it lets the run go", async () => {
    const { c, spaceId, producer, manager } = await boot();
    await c.must("team.roleRun", { id: producer, message: "hit the limit" });
    await waitFor(async () => (await c.must("team.space", { spaceId })).limits.backoff.length === 1, { timeout: 8000 });
    expect((await c.must("team.space", { spaceId })).limits.backoff[0]).toMatchObject({ agentKind: "fake", until: RESET });
    await waitFor(async () => (await runsOf(c, producer)).every(settled), { timeout: 8000 });
    await c.must("team.roleRun", { id: manager, message: "take your time" });
    await new Promise((r) => setTimeout(r, 300));
    /* THE mutant: admit ignores the back-off — the run would start into the limit. */
    expect((await runsOf(c, manager))[0].state).toBe("queued");
    expect((await c.must("team.activity", { spaceId, limit: 50 })).some((a: Any) => a.verb === "backed_off")).toBe(true);
    expect(await c.must("team.liftBackoff", { agentKind: "fake" })).toEqual({ lifted: true });
    await waitFor(async () => (await runsOf(c, manager))[0].state !== "queued", { timeout: 8000 });
    c.close();
  });

  it("a usage-limit error names its reset and backs off until then", async () => {
    const at = Math.floor(Date.now() / 1000) + 3600;
    const { c, spaceId } = await boot();
    const { session } = await c.must("sessions.create", { spaceId, agentKind: "fake" });
    app.sessions.emitExternal(session.id, { type: "error", ts: Date.now(), payload: { message: `Claude AI usage limit reached|${at}` } } as Any);
    await waitFor(async () => (await c.must("team.space", { spaceId })).limits.backoff.length === 1, { timeout: 8000 });
    expect((await c.must("team.space", { spaceId })).limits.backoff[0].until).toBe(at * 1000);
    c.close();
  });

  it("slots: with a team allowed four at once, Realm still runs three unattended and queues the fourth", async () => {
    const { c, spaceId, producer, manager, editor } = await boot();
    const fourth = (await c.must("team.roleCreate", { spaceId, name: "Ops", brief: "b", realmite: { seed: "o" }, agentKind: "fake" })).id;
    const limited = await c.must("team.setLimits", { spaceId, teamMaxLive: 4 });
    expect(limited.limits).toMatchObject({ teamMaxLive: 4, realmMaxUnattended: 3 });
    for (const id of [producer, manager, editor, fourth]) await c.must("team.roleRun", { id, message: "take your time" });
    await waitFor(async () => (await c.must("team.space", { spaceId })).limits.teamRunning === 3, { timeout: 8000 });
    expect((await c.must("team.space", { spaceId })).limits).toMatchObject({ teamRunning: 3, realmRunning: 3, teamQueued: 1 });
    c.close();
  });
});
