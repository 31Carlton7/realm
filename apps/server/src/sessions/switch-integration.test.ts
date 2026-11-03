import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { handoffsRoot } from "./handover";

/**
 * A switch of agents through the real RPC surface, database and (scripted) adapters: that the row
 * really moves, that the hand-off note is written where the transcript's line says, and — the half a
 * unit test cannot see — that the incoming adapter's first start is handed that note as context.
 */
let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(o: StartOptions) { this.starts.push(o); return super.start(o); }
}

async function setup(permissionMode = "bypassPermissions") {
  const home = tempDir("realm-switch-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  const first = new RecordingFake({ script: [
    { on: "go", emit: [{ kind: "text", text: "first answer" }] },
    { on: "wait", emit: [{ kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] },
  ] });
  const second = new RecordingFake({ script: [{ on: "next", emit: [{ kind: "text", text: "second answer" }] }] });
  const third = new RecordingFake({ script: [] });
  app = await createApp({ home, port: 0, adapters: { fake: first, codex: second, "acp:cursor": third } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", permissionMode })).result;
  return { home, c, sp, session, first, second };
}

const idle = (c: Awaited<ReturnType<typeof client>>, id: string) =>
  waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");

describe("sessions.switchAgent", () => {
  it("moves a session that has run, writes its hand-off note, and briefs the new agent with it", async () => {
    const { home, c, session, second } = await setup();
    await c.call("sessions.send", { id: session.id, text: "go" });
    await idle(c, session.id);

    const moved = (await c.call("sessions.switchAgent", { sessionId: session.id, agentKind: "codex", model: "gpt-5.6" })).result;
    expect(moved).toMatchObject({ agentKind: "codex", model: "gpt-5.6", providerSessionId: null, permissionMode: "bypassPermissions" });
    // The old engine leaves quietly: the session is as idle as it was, not ended.
    expect(moved.status).toBe("idle");

    const events = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 })).result;
    const handoff = events.find((e: Any) => e.event.type === "handoff").event.payload;
    expect(events.filter((e: Any) => e.event.type === "status").map((e: Any) => e.event.payload.status)).not.toContain("ended");
    const path = join(handoffsRoot(home), session.id, "handoff-1.md");
    expect(handoff).toMatchObject({ from: "fake", to: "codex", reason: "switch", note: "Switched from Fake agent to Codex gpt-5.6", summaryPath: path });
    // No generator in a suite, so the note carries the conversation as it was written.
    const notes = readFileSync(path, "utf8");
    expect(notes).toContain("No summary was written");
    expect(notes).toContain("User: go\n\nAssistant: first answer");

    await c.call("sessions.send", { id: session.id, text: "next" });
    await waitFor(() => second.starts.length === 1);
    const start = second.starts[0]!;
    expect(start.resume ?? null).toBeNull();
    expect(start.model).toBe("gpt-5.6");
    expect(start.systemContext).toContain("# Switched mid-session");
    expect(start.systemContext).toContain(`saved at ${path}`);
    expect(start.systemContext).toContain("User: go");
    c.close();
  });

  it("holds a message sent during the switch for the new agent", async () => {
    const { c, session, first, second } = await setup();
    await c.call("sessions.send", { id: session.id, text: "go" });
    await idle(c, session.id);
    const switching = c.call("sessions.switchAgent", { sessionId: session.id, agentKind: "codex" });
    const sent = c.call("sessions.send", { id: session.id, text: "next" });
    await Promise.all([switching, sent]);
    await waitFor(() => second.starts.length === 1);
    expect(first.starts).toHaveLength(1);
    c.close();
  });

  it("refuses while a turn is live, and says why", async () => {
    const { c, session } = await setup("default");
    await c.call("sessions.send", { id: session.id, text: "wait" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");
    const r = await c.call("sessions.switchAgent", { sessionId: session.id, agentKind: "codex" });
    expect(r.error.code).toBe("SESSION_BUSY");
    expect(r.error.message).toBe("Fake agent is still working on this turn. Stop it or let it finish, then switch.");
    expect((await c.call("sessions.get", { id: session.id })).result.agentKind).toBe("fake");
    c.close();
  });

  it("drops a permission mode the new agent has no lever for", async () => {
    const { c, session } = await setup();
    await c.call("sessions.send", { id: session.id, text: "go" });
    await idle(c, session.id);
    const moved = (await c.call("sessions.switchAgent", { sessionId: session.id, agentKind: "acp:cursor" })).result;
    expect(moved).toMatchObject({ agentKind: "acp:cursor", permissionMode: "default", model: null });
    c.close();
  });

  it("takes a teammate with its chat, so the chat stays its own and an edit after does not move it back", async () => {
    const { c, sp } = await setup();
    const mate = (await c.call("teammates.create", { spaceId: sp.id, name: "Reviewer", brief: "Reviews.", agentKind: "fake", permissionMode: "default" })).result;
    const { sessionId } = (await c.call("teammates.home", { id: mate.id })).result;
    await c.call("sessions.send", { id: sessionId, text: "go" });
    await idle(c, sessionId);

    await c.call("sessions.switchAgent", { sessionId, agentKind: "codex", model: "gpt-5.6" });
    expect((await c.call("teammates.get", { id: mate.id })).result).toMatchObject({ agentKind: "codex", model: "gpt-5.6", homeSessionId: sessionId });
    // The mutant this guards: an edit reading the row's old agent and starting a new chat, or putting
    // the old model back on this one.
    await c.call("teammates.update", { id: mate.id, name: "Code reviewer" });
    expect((await c.call("teammates.get", { id: mate.id })).result.homeSessionId).toBe(sessionId);
    expect((await c.call("sessions.get", { id: sessionId })).result).toMatchObject({ agentKind: "codex", model: "gpt-5.6" });
    expect((await c.call("teammates.home", { id: mate.id })).result.sessionId).toBe(sessionId);
    c.close();
  });

  it("only re-points an untouched session — nothing to hand over, no note", async () => {
    const { home, c, session } = await setup();
    const moved = (await c.call("sessions.switchAgent", { sessionId: session.id, agentKind: "codex", model: "gpt-5.6" })).result;
    expect(moved).toMatchObject({ agentKind: "codex", model: "gpt-5.6" });
    expect((await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 50 })).result).toEqual([]);
    expect(existsSync(join(handoffsRoot(home), session.id))).toBe(false);
    c.close();
  });
});

describe("a model or level picked on a teammate's chat", () => {
  it("is saved to the teammate, and nothing else the chat's chips set is", async () => {
    const { c, sp } = await setup();
    const mate = (await c.call("teammates.create", { spaceId: sp.id, name: "Reviewer", brief: "Reviews.", agentKind: "fake", model: "fake-1", permissionMode: "default" })).result;
    const { sessionId } = (await c.call("teammates.home", { id: mate.id })).result;
    await c.call("sessions.send", { id: sessionId, text: "go" });
    await idle(c, sessionId);

    await c.call("sessions.setOptions", { id: sessionId, model: "fake-2" });
    await c.call("sessions.setOptions", { id: sessionId, effort: "high" });
    await c.call("sessions.setOptions", { id: sessionId, permissionMode: "acceptEdits" });
    expect((await c.call("teammates.get", { id: mate.id })).result).toMatchObject({ model: "fake-2", effort: "high", permissionMode: "default", homeSessionId: sessionId });
    expect((await c.call("sessions.get", { id: sessionId })).result).toMatchObject({ model: "fake-2", effort: "high", permissionMode: "acceptEdits" });
    c.close();
  });

  it("takes the agent with it when the model picked is another agent's, before the chat has run", async () => {
    const { c, sp } = await setup();
    const mate = (await c.call("teammates.create", { spaceId: sp.id, name: "Reviewer", brief: "Reviews.", agentKind: "fake", model: "fake-1", permissionMode: "default" })).result;
    await c.call("sessions.setAgent", { id: mate.homeSessionId, agentKind: "codex" });
    expect((await c.call("teammates.get", { id: mate.id })).result).toMatchObject({ agentKind: "codex", model: null });
    await c.call("sessions.setOptions", { id: mate.homeSessionId, model: "gpt-5.6" });
    expect((await c.call("teammates.get", { id: mate.id })).result).toMatchObject({ agentKind: "codex", model: "gpt-5.6", homeSessionId: mate.homeSessionId });
    c.close();
  });

  it("is not saved from a task session the teammate started", async () => {
    const { c, sp } = await setup();
    const mate = (await c.call("teammates.create", { spaceId: sp.id, name: "Reviewer", brief: "Reviews.", agentKind: "fake", model: "fake-1", permissionMode: "default" })).result;
    const home = (await c.call("sessions.get", { id: mate.homeSessionId })).result;
    const { session: task } = app.sessions.create({ spaceId: sp.id, agentKind: "fake", projectId: null, environmentId: home.environmentId, model: "fake-1", effort: null,
      permissionMode: "default", title: "reviewer - task", teammate: { id: mate.id, home: false } });
    await c.call("sessions.setOptions", { id: task.id, model: "fake-2", effort: "high" });
    expect((await c.call("teammates.get", { id: mate.id })).result).toMatchObject({ model: "fake-1", effort: null });
    c.close();
  });
});
