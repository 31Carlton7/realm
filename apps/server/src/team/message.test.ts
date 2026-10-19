import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * Messaging a teammate from its chat, over the real socket with the scripted agent: a message starts a
 * run with the person's words and continues the role's conversation, waits behind a run that is
 * working, and answers a run parked on a question.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SCRIPT: FakeScript = [
  // The answer is sent with the run's goal again, so it goes before the question it answers.
  { on: "Start with Nathan", emit: [{ kind: "text", text: "Starting with Nathan." }] },
  { on: "ask me first", emit: [{ kind: "text", text: "Two creators are due.\n\nNEEDS-HUMAN: Which creator should I start with?" }] },
  { on: "find three sources", emit: [{ kind: "text", text: "Found three sources on the launch." }] },
  { on: "which was best", emit: [{ kind: "text", text: "The second one." }] },
  { on: "take your time", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 60 }] },
  { on: "after that", emit: [{ kind: "text", text: "Done after the first." }] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if ("id" in m) pending.get(m.id)?.(m);
  });
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
  const home = tempDir("realm-team-message-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const c = await client(app.port);
  await c.must("team.make", { spaceId: space.id, templates: [] });
  const role = await c.must("team.roleCreate", { spaceId: space.id, name: "Researcher", brief: "Look things up.", realmite: { seed: "r" }, agentKind: "fake", permissionMode: "acceptEdits" });
  return { c, spaceId: space.id, roleId: role.id as string };
}

const runsOf = async (c: Any, roleId: string) => (await c.must("team.roleRuns", { id: roleId, limit: 20 })) as Any[];
const settled = (r: Any) => !["queued", "running", "blocked"].includes(r.state);
const allSettled = (c: Any, roleId: string, timeout = 8000) => waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout });

describe("messaging a teammate", () => {
  it("starts a run with the person's words, and the next message continues the same conversation", async () => {
    const { c, spaceId, roleId } = await boot();
    const first = await c.must("team.roleMessage", { id: roleId, text: "  find three sources  " });
    await allSettled(c, roleId);
    const [a] = await runsOf(c, roleId);
    expect(a).toMatchObject({ id: first.id, state: "succeeded", wokeOn: "manual", wokeNote: "find three sources", report: "Found three sources on the launch." });
    expect(a.sessionId).toBeTruthy();

    const second = await c.must("team.roleMessage", { id: roleId, text: "which was best" });
    await allSettled(c, roleId);
    const runs = await runsOf(c, roleId);
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(runs[0]).toMatchObject({ sessionId: a.sessionId, wokeNote: "which was best", report: "The second one." });
    // The chat's log is the role's own: both wakes, each with what the person said.
    const lines = await c.must("team.activity", { spaceId, roleId, limit: 50 });
    expect(lines.filter((l: Any) => l.verb === "woke").map((l: Any) => l.detail.note)).toEqual(["which was best", "find three sources"]);
    c.close();
  });

  it("while a run works, the message waits behind it in the same session, and both runs settle", async () => {
    const { c, roleId } = await boot();
    const working = await c.must("team.roleRun", { id: roleId, message: "take your time" });
    await waitFor(async () => (await runsOf(c, roleId)).find((r) => r.id === working.id)?.state === "running");
    const queued = await c.must("team.roleMessage", { id: roleId, text: "after that" });
    const live = await runsOf(c, roleId);
    const a = live.find((r) => r.id === working.id)!;
    expect(live.find((r) => r.id === queued.id)).toMatchObject({ state: "queued", sessionId: a.sessionId });
    await allSettled(c, roleId, 10_000);
    const runs = await runsOf(c, roleId);
    const ra = runs.find((r) => r.id === working.id)!, rb = runs.find((r) => r.id === queued.id)!;
    expect(ra).toMatchObject({ state: "succeeded", report: "one two three four five six seven eight" });
    expect(rb).toMatchObject({ state: "succeeded", report: "Done after the first.", sessionId: ra.sessionId });
    expect(rb.startedAt).toBeGreaterThanOrEqual(ra.settledAt);
    c.close();
  });

  it("answers the question a run stopped on, in that run, and the log keeps the question and the answer", async () => {
    const { c, spaceId, roleId } = await boot();
    const asked = await c.must("team.roleMessage", { id: roleId, text: "ask me first" });
    await waitFor(async () => (await runsOf(c, roleId))[0]?.state === "blocked");
    expect((await c.must("team.space", { spaceId })).roles[0].state).toBe("waiting");
    const answered = await c.must("team.roleMessage", { id: roleId, text: "Start with Nathan" });
    expect(answered.id).toBe(asked.id);
    await allSettled(c, roleId);
    const runs = await runsOf(c, roleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "succeeded", report: "Starting with Nathan." });
    const lines = await c.must("team.activity", { spaceId, roleId, limit: 50 });
    expect(lines.find((l: Any) => l.verb === "replied")).toMatchObject({ actor: "user", runId: asked.id, detail: { note: "Start with Nathan", question: "Which creator should I start with?" } });
    c.close();
  });

  it("keeps another role's lines out of a role's log, and refuses an empty message or a removed role", async () => {
    const { c, spaceId, roleId } = await boot();
    const other = await c.must("team.roleCreate", { spaceId, name: "Editor", brief: "Edit.", realmite: { seed: "e" }, agentKind: "fake", permissionMode: "acceptEdits" });
    await c.must("team.roleMessage", { id: other.id, text: "find three sources" });
    await allSettled(c, other.id);
    const mine = await c.must("team.activity", { spaceId, roleId, limit: 50 });
    expect(mine.map((l: Any) => l.verb)).toEqual(["made_role"]);
    expect((await c.call("team.roleMessage", { id: roleId, text: "   " })).ok).toBe(false);
    await c.must("team.roleArchive", { id: roleId });
    const gone = await c.call("team.roleMessage", { id: roleId, text: "hello" });
    expect(gone.ok).toBe(false);
    c.close();
  });
});
