import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { titleFromMessage, TITLE_MAX } from "./service";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const eventTypes = (sessionId: string) => events.filter((e) => e.event === "session.event" && e.payload.sessionId === sessionId).map((e) => e.payload.event.type as string);
  return { call, events, eventTypes, close: () => ws.close() };
}

async function boot(fake = new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "ok" }, { kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] }] })) {
  const home = mkdtempSync(join(tmpdir(), "realm-"));
  app = await createApp({ home, port: 0, adapters: { fake } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  return { home, c, sp };
}

describe("SessionService over rpc", () => {
  it("sessions.listAll spans spaces (sessionId→spaceId map for cross-space badges)", async () => {
    const { c, sp } = await boot();
    const p2 = (await c.call("profiles.create", { name: "X" })).result;
    const sp2 = (await c.call("spaces.create", { profileId: p2.id, name: "T" })).result;
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const b = (await c.call("sessions.create", { spaceId: sp2.id, agentKind: "fake" })).result.session;
    const all = (await c.call("sessions.listAll", {})).result;
    expect(all.map((s: Any) => [s.id, s.spaceId])).toEqual([[a.id, sp.id], [b.id, sp2.id]]);
    // per-space list stays scoped
    expect((await c.call("sessions.list", { spaceId: sp2.id })).result.map((s: Any) => s.id)).toEqual([b.id]);
    c.close();
  });

  it("create → send → permission → respond → idle, all persisted and broadcast", async () => {
    const { c, sp } = await boot();
    const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    expect(itemId).toBeTruthy();
    expect(session).toMatchObject({ agentKind: "fake", status: "idle", cwd: sp.folderPath, title: "Fake agent session", permissionMode: "default" });
    const items = (await c.call("items.list", { spaceId: sp.id })).result;
    expect(items).toMatchObject([{ id: itemId, kind: "session", refId: session.id, title: "Fake agent session" }]);
    expect((await c.call("sessions.list", { spaceId: sp.id })).result.map((s: Any) => s.id)).toEqual([session.id]);

    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => c.eventTypes(session.id).includes("permission_request"));
    expect(c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "waiting_permission")).toBe(true);
    expect((await c.call("sessions.get", { id: session.id })).result.status).toBe("waiting_permission");
    const req = c.events.find((e) => e.event === "session.event" && e.payload.event.type === "permission_request")!.payload.event.payload.requestId;
    await c.call("sessions.respondPermission", { id: session.id, requestId: req, decision: "allow" });
    await waitFor(() => c.eventTypes(session.id).includes("tool_result") && c.events.some((e) => e.event === "session.status" && e.payload.status === "idle" && e.payload.sessionId === session.id));

    // deltas were broadcast (ephemeral, seq -1) but not persisted
    const deltas = c.events.filter((e) => e.event === "session.event" && e.payload.event.type === "assistant_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e) => e.payload.ephemeral === true && e.payload.seq === -1)).toBe(true);
    const stored = (await c.call("sessions.events", { id: session.id })).result;
    const types = stored.map((s: Any) => s.event.type);
    expect(types).toEqual(expect.arrayContaining(["init", "user_message", "assistant_text", "tool_call", "permission_request", "permission_response", "tool_result", "usage", "status"]));
    expect(types).not.toContain("assistant_delta");
    expect(types.indexOf("user_message")).toBeLessThan(types.indexOf("assistant_text"));
    for (let i = 1; i < stored.length; i++) expect(stored[i].seq).toBeGreaterThan(stored[i - 1].seq);
    // persisted broadcasts carry the same seqs as the stored rows
    const broadcastSeqs = c.events.filter((e) => e.event === "session.event" && !e.payload.ephemeral).map((e) => e.payload.seq);
    expect(broadcastSeqs).toEqual(stored.map((s: Any) => s.seq));
    // afterSeq pagination
    const tail = (await c.call("sessions.events", { id: session.id, afterSeq: stored[2].seq })).result;
    expect(tail.map((s: Any) => s.seq)).toEqual(stored.slice(3).map((s: Any) => s.seq));

    const got = (await c.call("sessions.get", { id: session.id })).result;
    expect(got.status).toBe("idle"); expect(got.lastEventSeq).toBe(stored.at(-1).seq); expect(got.providerSessionId).toMatch(/^fake-/);
    expect(app.sessions.isLive(session.id)).toBe(true);

    await c.call("sessions.delete", { id: session.id });
    expect(app.sessions.isLive(session.id)).toBe(false);
    expect((await c.call("items.list", { spaceId: sp.id })).result).toEqual([]);
    expect((await c.call("sessions.get", { id: session.id })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("the first message titles the session and its item (clipped); later messages and custom titles are left alone", async () => {
    const { c, sp } = await boot();
    const long = "Please refactor the   authentication module\nand add tests for everything";
    const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: long });
    const title = titleFromMessage(long);
    expect(title).toBe("Please refactor the authentication modu…"); // first line only, spaces collapsed, ≤ TITLE_MAX
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect((await c.call("sessions.get", { id: session.id })).result.title).toBe(title);
    expect((await c.call("items.list", { spaceId: sp.id })).result.find((i: Any) => i.id === itemId).title).toBe(title);
    await waitFor(() => c.eventTypes(session.id).includes("usage"));
    await c.call("sessions.send", { id: session.id, text: "second message" });
    expect((await c.call("sessions.get", { id: session.id })).result.title).toBe(title);
    const custom = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", title: "Mine" })).result;
    await c.call("sessions.send", { id: custom.session.id, text: "hello there" });
    expect((await c.call("sessions.get", { id: custom.session.id })).result.title).toBe("Mine");
    c.close();
  });

  it("agents.probe lists registered adapters; a throwing probe reports unavailable with the reason", async () => {
    const { c } = await boot();
    expect((await c.call("agents.probe", {})).result).toEqual([{ kind: "fake", available: true, version: "fake", loggedIn: true, reason: null }]);
    c.close(); await app.close();
    class BadProbe extends FakeAdapter { override async probe(): Promise<never> { throw new Error("probe exploded"); } }
    const home = mkdtempSync(join(tmpdir(), "realm-"));
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }), claude: Object.assign(new BadProbe({ script: [] }), { kind: "claude" as const }) } });
    const c2 = await client(app.port);
    expect((await c2.call("agents.probe", {})).result).toEqual([
      { kind: "fake", available: true, version: "fake", loggedIn: true, reason: null },
      { kind: "claude", available: false, version: null, loggedIn: null, reason: "probe exploded" },
    ]);
    c2.close();
  });

  it("agents.probe is cached; force re-asks the adapters", async () => {
    // Probing spawns a child process per registered agent, so the prompter's per-mount call must be
    // cheap. The install card's "Check again" is the one caller that must see through the cache.
    let n = 0;
    class Counting extends FakeAdapter {
      override async probe() { return { kind: this.kind, available: true, version: `v${++n}`, loggedIn: true, reason: null }; }
    }
    const home = mkdtempSync(join(tmpdir(), "realm-"));
    app = await createApp({ home, port: 0, adapters: { fake: new Counting({ script: [] }) } });
    const c = await client(app.port);
    expect((await c.call("agents.probe", {})).result[0].version).toBe("v1");
    expect((await c.call("agents.probe", {})).result[0].version).toBe("v1"); // served from the cache
    expect((await c.call("agents.probe", { force: false })).result[0].version).toBe("v1");
    expect((await c.call("agents.probe", { force: true })).result[0].version).toBe("v2");
    expect((await c.call("agents.probe", {})).result[0].version).toBe("v2"); // force refilled the cache
    expect(n).toBe(2);
    c.close();
  });

  it("respondPermission without a live handle is SESSION_NOT_LIVE", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    expect((await c.call("sessions.respondPermission", { id: session.id, requestId: "r1", decision: "allow" })).error.code).toBe("SESSION_NOT_LIVE");
    c.close();
  });

  it("rejects unknown agents, unknown sessions and unknown projects", async () => {
    const { c, sp } = await boot();
    expect((await c.call("sessions.create", { spaceId: sp.id, agentKind: "codex" })).error.code).toBe("AGENT_UNAVAILABLE");
    expect((await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error.code).toBe("NOT_FOUND");
    expect((await c.call("sessions.send", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", text: "x" })).error.code).toBe("NOT_FOUND");
    expect((await c.call("sessions.events", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("uses the project root as cwd, items.delete routes through the service, spaces.delete removes sessions", async () => {
    const { c, sp } = await boot();
    const pr = (await c.call("projects.create", { spaceId: sp.id, name: "repo", rootPath: "/tmp" })).result;
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", projectId: pr.id, title: "  My task " })).result;
    expect(a.session.cwd).toBe("/tmp"); expect(a.session.title).toBe("My task"); expect(a.session.projectId).toBe(pr.id);
    await c.call("sessions.send", { id: a.session.id, text: "hello" });
    await waitFor(() => c.eventTypes(a.session.id).includes("assistant_text"));
    expect((await c.call("items.delete", { id: a.itemId })).ok).toBe(true);
    expect(app.sessions.isLive(a.session.id)).toBe(false);
    expect((await c.call("sessions.list", { spaceId: sp.id })).result).toEqual([]);

    const b = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: b.session.id, text: "hello" });
    await waitFor(() => c.eventTypes(b.session.id).includes("assistant_text"));
    expect((await c.call("spaces.delete", { id: sp.id })).ok).toBe(true);
    expect(app.sessions.isLive(b.session.id)).toBe(false);
    expect((await c.call("sessions.get", { id: b.session.id })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("interrupt, setOptions, and error events from the adapter", async () => {
    const { c, sp } = await boot(new FakeAdapter({ script: [{ on: "boom", emit: [{ kind: "throw", message: "kaboom" }] }, { on: "slow", emit: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }, { kind: "text", text: "c" }, { kind: "text", text: "d" }, { kind: "text", text: "e" }] }], delayMs: 80 }));
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", model: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "boom" });
    await waitFor(() => c.eventTypes(session.id).includes("error"));
    const err = c.events.find((e) => e.event === "session.event" && e.payload.event.type === "error")!.payload.event.payload;
    expect(err.message).toBe("kaboom");
    await waitFor(() => (c.events.filter((e) => e.event === "session.status" && e.payload.status === "idle").length >= 2));

    await c.call("sessions.send", { id: session.id, text: "slow" });
    await waitFor(() => c.eventTypes(session.id).filter((t) => t === "assistant_text").length >= 1);
    expect((await c.call("sessions.interrupt", { id: session.id })).ok).toBe(true);
    await waitFor(() => c.eventTypes(session.id).includes("usage"));
    expect(c.eventTypes(session.id).filter((t) => t === "assistant_text").length).toBeLessThan(5);

    const updated = (await c.call("sessions.setOptions", { id: session.id, permissionMode: "acceptEdits", effort: "high" })).result;
    expect(updated).toMatchObject({ permissionMode: "acceptEdits", effort: "high", model: "fake" });
    expect((await c.call("sessions.get", { id: session.id })).result.permissionMode).toBe("acceptEdits");
    c.close();
  });

  describe("sessions.setAgent", () => {
    /** Two kinds registered so a switch has somewhere to go; both are the scripted fake. */
    async function bootTwo() {
      const home = mkdtempSync(join(tmpdir(), "realm-"));
      const script = [{ on: "go", emit: [{ kind: "text" as const, text: "ok" }] }];
      app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script }), codex: new FakeAdapter({ script }) } });
      const c = await client(app.port);
      const p = (await c.call("profiles.create", { name: "W" })).result;
      const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
      return { c, sp };
    }

    it("re-points an untouched session, clears the old kind's model, and renames an untouched default title", async () => {
      const { c, sp } = await bootTwo();
      const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", model: "fake", effort: "high", permissionMode: "plan" })).result;
      const r = await c.call("sessions.setAgent", { id: session.id, agentKind: "codex" });
      expect(r.ok).toBe(true);
      // model is per-kind and must not survive; effort and permission mode are not.
      expect(r.result).toMatchObject({ agentKind: "codex", model: null, effort: "high", permissionMode: "plan", title: "Codex session" });
      expect((await c.call("sessions.get", { id: session.id })).result.agentKind).toBe("codex");
      const items = (await c.call("items.list", { spaceId: sp.id })).result;
      expect(items.find((i: Any) => i.id === itemId).title).toBe("Codex session");
      expect(c.events.some((e) => e.event === "items.changed")).toBe(true);
      c.close();
    });

    it("leaves a title the user chose alone", async () => {
      const { c, sp } = await bootTwo();
      const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", title: "Ship the parser" })).result;
      const r = await c.call("sessions.setAgent", { id: session.id, agentKind: "codex" });
      expect(r.result).toMatchObject({ agentKind: "codex", title: "Ship the parser" });
      c.close();
    });

    it("refuses once the session has ANY event — the server is the authority, and it is events, not status", async () => {
      const { c, sp } = await bootTwo();
      const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
      await c.call("sessions.send", { id: session.id, text: "go" });
      await waitFor(() => c.eventTypes(session.id).includes("usage"));
      // Back to idle: a status check would wave this through. It has a transcript, so it is locked.
      await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));
      expect((await c.call("sessions.get", { id: session.id })).result.status).toBe("idle");
      const r = await c.call("sessions.setAgent", { id: session.id, agentKind: "codex" });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("SESSION_STARTED");
      expect((await c.call("sessions.get", { id: session.id })).result.agentKind).toBe("fake"); // nothing moved
      c.close();
    });

    it("rejects an unregistered kind and an unknown session", async () => {
      const { c, sp } = await bootTwo();
      const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
      expect((await c.call("sessions.setAgent", { id: session.id, agentKind: "acp:gemini" })).error.code).toBe("AGENT_UNAVAILABLE");
      expect((await c.call("sessions.setAgent", { id: session.id, agentKind: "not-an-agent" })).error.code).toBe("INVALID_PARAMS");
      expect((await c.call("sessions.setAgent", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", agentKind: "codex" })).error.code).toBe("NOT_FOUND");
      c.close();
    });
  });

  it("survives a restart: statuses reset on boot, dangling permission denied, events replayed, a new send resumes with providerSessionId", async () => {
    const started: Array<{ resume?: string | null }> = [];
    const script = [{ on: "go", emit: [{ kind: "tool" as const, name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] }];
    class SpyFake extends FakeAdapter { override start(o: Parameters<FakeAdapter["start"]>[0]) { started.push({ resume: o.resume }); return super.start(o); } }
    const { home, c, sp } = await boot(new SpyFake({ script }));
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "hello" });
    await waitFor(() => c.eventTypes(session.id).includes("usage"));
    // a turn that stops at a permission prompt, then a "crash": close the app while the row says waiting_permission
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => c.eventTypes(session.id).includes("permission_request"));
    expect((await c.call("sessions.get", { id: session.id })).result.status).toBe("waiting_permission");
    const before = (await c.call("sessions.events", { id: session.id })).result;
    const provider = (await c.call("sessions.get", { id: session.id })).result.providerSessionId;
    const req = before.find((s: Any) => s.event.type === "permission_request").event.payload.requestId;
    // the graceful close disposes the adapter (which denies + ends); undo the resulting status writes so boot sees a real crash
    c.close(); await app.close();
    const raw = new (await import("node:sqlite")).DatabaseSync(join(home, "realm.db"));
    raw.prepare("DELETE FROM session_events WHERE session_id = ? AND seq > ?").run(session.id, before.at(-1).seq);
    // a second, concurrent request that also never got an answer
    raw.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, 'permission_request', ?)").run(session.id, Date.now(),
      JSON.stringify({ requestId: "r-extra", toolName: "Read", input: { file_path: "/x" }, title: "Read x?", suggestions: [] }));
    raw.prepare("UPDATE sessions SET status = 'waiting_permission', last_event_seq = ? WHERE id = ?").run(before.at(-1).seq + 1, session.id);
    raw.close();
    app = await createApp({ home, port: 0, adapters: { fake: new SpyFake({ script }) } });
    const c2 = await client(app.port);
    const got = (await c2.call("sessions.get", { id: session.id })).result;
    expect(got.status).toBe("idle"); expect(got.providerSessionId).toBe(provider);
    const replayed = (await c2.call("sessions.events", { id: session.id })).result;
    expect(replayed.slice(0, before.length)).toEqual(before);
    expect(replayed.slice(before.length).map((s: Any) => s.event)).toMatchObject([
      { type: "permission_request", payload: { requestId: "r-extra" } },
      { type: "permission_response", payload: { requestId: req, decision: "deny" } },
      { type: "permission_response", payload: { requestId: "r-extra", decision: "deny" } },
    ]);
    expect(got.lastEventSeq).toBe(replayed.at(-1).seq);
    expect(app.sessions.isLive(session.id)).toBe(false);
    expect((await c2.call("sessions.respondPermission", { id: session.id, requestId: req, decision: "allow" })).error.code).toBe("SESSION_NOT_LIVE");
    await c2.call("sessions.send", { id: session.id, text: "again" });
    await waitFor(() => c2.eventTypes(session.id).includes("usage"));
    expect(started.at(-1)?.resume).toBe(provider);
    const after = (await c2.call("sessions.events", { id: session.id, afterSeq: replayed.at(-1).seq })).result;
    expect(after.map((s: Any) => s.event.type)).toContain("user_message");
    expect(after[0].seq).toBeGreaterThan(replayed.at(-1).seq);
    c2.close();
  });

  it("boot: `ended` stays terminal without a providerSessionId, becomes idle with one; error is kept", async () => {
    const { home, c, sp } = await boot(new FakeAdapter({ script: [] }));
    const mk = async () => (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session.id as string;
    const [a, b, e] = [await mk(), await mk(), await mk()];
    app.db.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").run(a);
    app.db.prepare("UPDATE sessions SET status = 'ended', provider_session_id = 'p-b' WHERE id = ?").run(b);
    app.db.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(e);
    c.close(); await app.close();
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    const c2 = await client(app.port);
    expect((await c2.call("sessions.get", { id: a })).result.status).toBe("ended");
    expect((await c2.call("sessions.get", { id: b })).result.status).toBe("idle");
    expect((await c2.call("sessions.get", { id: e })).result.status).toBe("error");
    c2.close();
  });
});

describe("the session's terminal side panel (W4)", () => {
  it("is lazy: creating (and using) a session never spawns a pty or a terminal row", async () => {
    const { c, sp } = await boot(new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "ok" }] }] }));
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => c.eventTypes(session.id).includes("usage"));
    expect(session.terminalItemId).toBeNull();
    expect((await c.call("sessions.get", { id: session.id })).result.terminalItemId).toBeNull();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM terminals").get()).toEqual({ n: 0 });
    c.close();
  });

  it("openTerminal creates it once, at the session's cwd, and is idempotent after that", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const first = (await c.call("sessions.openTerminal", { id: session.id })).result;
    expect(app.terminals.has(first.terminalId)).toBe(true);
    expect((await c.call("sessions.get", { id: session.id })).result.terminalItemId).toBe(first.itemId);
    const row = app.db.prepare("SELECT cwd FROM terminals WHERE id = ?").get(first.terminalId);
    expect(row).toEqual({ cwd: sp.folderPath }); // the session's cwd, not some default
    const second = (await c.call("sessions.openTerminal", { id: session.id })).result;
    expect(second).toEqual(first);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM terminals").get()).toEqual({ n: 1 });
    c.close();
  });

  it("a command written without a trailing newline is TYPED into the pty and never runs (the install card's contract)", async () => {
    // The one mutant this whole flow must survive: appending "\n" to the pre-typed command would run an
    // installer nobody asked for. `expr` is chosen so the command TEXT and its OUTPUT share no substring —
    // the echo of "expr 40041 + 1" can never be mistaken for the "40042" that only execution prints.
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const { terminalId } = (await c.call("sessions.openTerminal", { id: session.id })).result;
    const out = () => c.events.filter((e) => e.event === "terminal.data" && e.payload.terminalId === terminalId)
      .map((e) => String(e.payload.data)).join("");

    await c.call("terminals.write", { terminalId, data: "expr 40041 + 1" });
    await waitFor(() => out().includes("40041")); // the shell echoed what we typed…
    await new Promise((r) => setTimeout(r, 250));  // …and given a generous beat, still ran nothing
    expect(out()).not.toContain("40042");

    // Proof the assertion above is not vacuous: the same pty, one Return later, does run it.
    await c.call("terminals.write", { terminalId, data: "\n" });
    await waitFor(() => out().includes("40042"));
    c.close();
  });

  it("its item is hidden from items.list and items.listAll — it belongs to the session, not the space", async () => {
    const { c, sp } = await boot();
    const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const standalone = (await c.call("terminals.create", { spaceId: sp.id })).result;
    const before = (await c.call("items.list", { spaceId: sp.id })).result.map((i: Any) => i.id);
    expect(before).toEqual([itemId, standalone.itemId]);

    const term = (await c.call("sessions.openTerminal", { id: session.id })).result;
    // Both listings skip it; the standalone terminal (same kind, same space) still shows — so this is
    // the session-owned predicate, not "terminals are hidden".
    expect((await c.call("items.list", { spaceId: sp.id })).result.map((i: Any) => i.id)).toEqual([itemId, standalone.itemId]);
    expect((await c.call("items.listAll", {})).result.map((i: Any) => i.id).sort()).toEqual([itemId, standalone.itemId].sort());
    // …while the row itself exists and is findable by the services that own it.
    expect(app.db.prepare("SELECT id FROM items WHERE id = ?").get(term.itemId)).toEqual({ id: term.itemId });
    c.close();
  });

  it("deleting the session kills its pty and its hidden item", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const term = (await c.call("sessions.openTerminal", { id: session.id })).result;
    expect(app.terminals.has(term.terminalId)).toBe(true);

    await c.call("sessions.delete", { id: session.id });
    expect(app.terminals.has(term.terminalId)).toBe(false);
    expect(app.db.prepare("SELECT id FROM items WHERE id = ?").get(term.itemId)).toBeUndefined();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM terminals").get()).toEqual({ n: 0 });
    c.close();
  });

  it("deleting the session's sidebar item takes the same path (items.delete → sessions.delete)", async () => {
    const { c, sp } = await boot();
    const { session, itemId } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const term = (await c.call("sessions.openTerminal", { id: session.id })).result;
    await c.call("items.delete", { id: itemId });
    expect(app.terminals.has(term.terminalId)).toBe(false);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    c.close();
  });

  it("deleting the space takes session-owned terminals with it", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const term = (await c.call("sessions.openTerminal", { id: session.id })).result;
    await c.call("spaces.delete", { id: sp.id });
    expect(app.terminals.has(term.terminalId)).toBe(false);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM terminals").get()).toEqual({ n: 0 });
    c.close();
  });

  it("a recorded terminal whose pty died is replaced, not handed back dead", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const first = (await c.call("sessions.openTerminal", { id: session.id })).result;
    await c.call("terminals.close", { terminalId: first.terminalId }); // e.g. the shell exited
    // ON DELETE SET NULL cleared the pointer along with the item.
    expect((await c.call("sessions.get", { id: session.id })).result.terminalItemId).toBeNull();
    const next = (await c.call("sessions.openTerminal", { id: session.id })).result;
    expect(next.terminalId).not.toBe(first.terminalId);
    expect(app.terminals.has(next.terminalId)).toBe(true);
    c.close();
  });

  it("survives a restart: the pty is respawned and the session still points at it", async () => {
    const { home, c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const term = (await c.call("sessions.openTerminal", { id: session.id })).result;
    c.close(); await app.close();

    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    const c2 = await client(app.port);
    expect(app.terminals.has(term.terminalId)).toBe(true); // restoreAll respawned it
    expect((await c2.call("sessions.get", { id: session.id })).result.terminalItemId).toBe(term.itemId);
    expect((await c2.call("sessions.openTerminal", { id: session.id })).result).toEqual(term); // same trio
    expect((await c2.call("items.list", { spaceId: sp.id })).result.some((i: Any) => i.id === term.itemId)).toBe(false);
    c2.close();
  });
});

describe("environments over rpc", () => {
  it("a space's first session creates its primary environment, and every later one shares it", async () => {
    const { c, sp } = await boot();
    expect((await c.call("environments.list", { spaceId: sp.id })).result).toEqual([]); // nothing until it is needed
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const b = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    expect(b.environmentId).toBe(a.environmentId); // one checkout, many sessions
    const envs = (await c.call("environments.list", { spaceId: sp.id })).result;
    expect(envs).toMatchObject([{ id: a.environmentId, spaceId: sp.id, path: sp.folderPath, kind: "primary", branch: null, portBlockStart: null }]);
    expect(a.cwd).toBe(sp.folderPath);
    expect((await c.call("environments.get", { id: a.environmentId })).result.path).toBe(sp.folderPath);
    c.close();
  });

  it("a project session gets its own `checkout` environment beside the primary, and shares that", async () => {
    const { c, sp } = await boot();
    const pr = (await c.call("projects.create", { spaceId: sp.id, name: "repo", rootPath: "/tmp" })).result;
    const plain = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", projectId: pr.id })).result.session;
    const b = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", projectId: pr.id })).result.session;
    expect(a.environmentId).toBe(b.environmentId);
    expect(a.environmentId).not.toBe(plain.environmentId);
    expect(a.cwd).toBe("/tmp");
    const envs = (await c.call("environments.list", { spaceId: sp.id })).result;
    expect(envs.map((e: Any) => [e.kind, e.path])).toEqual([["primary", sp.folderPath], ["checkout", "/tmp"]]);
    c.close();
  });

  it("sessions.create can be pinned to an environment, and refuses one from another space", async () => {
    const { c, sp } = await boot();
    const sp2 = (await c.call("spaces.create", { profileId: (await c.call("profiles.list", {})).result[0].id, name: "T" })).result;
    const mine = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const theirs = (await c.call("sessions.create", { spaceId: sp2.id, agentKind: "fake" })).result.session;
    const pinned = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: mine.environmentId })).result.session;
    expect(pinned.environmentId).toBe(mine.environmentId);
    expect((await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: theirs.environmentId })).error.code).toBe("ENVIRONMENT_WRONG_SPACE");
    expect((await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("environments.delete: refused while in use, refused for a primary, and never fires on its own", async () => {
    const { c, sp } = await boot();
    const pr = (await c.call("projects.create", { spaceId: sp.id, name: "repo", rootPath: "/tmp" })).result;
    const keep = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const s = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", projectId: pr.id })).result;
    expect((await c.call("environments.delete", { id: s.session.environmentId })).error.code).toBe("ENVIRONMENT_IN_USE");

    await c.call("sessions.delete", { id: s.session.id });
    // Deleting the last session that used it leaves the checkout alone — that is the policy.
    expect((await c.call("environments.list", { spaceId: sp.id })).result.map((e: Any) => e.path)).toEqual([sp.folderPath, "/tmp"]);
    expect((await c.call("environments.delete", { id: s.session.environmentId })).ok).toBe(true);
    expect((await c.call("environments.list", { spaceId: sp.id })).result.map((e: Any) => e.path)).toEqual([sp.folderPath]);

    const primary = (await c.call("environments.get", { id: keep.environmentId })).result;
    expect(primary.kind).toBe("primary");
    expect((await c.call("environments.delete", { id: primary.id })).error.code).toBe("ENVIRONMENT_PRIMARY");
    expect((await c.call("environments.delete", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("cwd follows the environment: the terminal and the agent both land where the environment points", async () => {
    // A script with no permission step: this test tears the app down at the end, and an unanswered
    // permission request would leave the adapter waiting rather than disposing.
    const { c, sp, home } = await boot(new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "ok" }] }], delayMs: 1 }));
    const s = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const moved = join(home, "moved");
    mkdirSync(moved, { recursive: true });
    app.db.prepare("UPDATE environments SET path = ? WHERE id = ?").run(moved, s.environmentId);
    expect((await c.call("sessions.get", { id: s.id })).result.cwd).toBe(moved);
    const term = (await c.call("sessions.openTerminal", { id: s.id })).result;
    expect(app.db.prepare("SELECT cwd FROM terminals WHERE id = ?").get(term.terminalId)).toEqual({ cwd: moved });
    await c.call("sessions.send", { id: s.id, text: "go" });
    await waitFor(() => c.eventTypes(s.id).includes("init"));
    const init = c.events.find((e: Any) => e.event === "session.event" && e.payload.event.type === "init");
    expect(init.payload.event.payload.cwd).toBe(moved); // the adapter was started there, not at the old path
    c.close();
  });
});

/** The port block (Plan 7 W2) must reach the agent's process env, not just the environment row. */
describe("session port blocks", () => {
  class RecordingFake extends FakeAdapter {
    starts: { cwd: string; env?: Record<string, string> }[] = [];
    start(opts: Any) { this.starts.push({ cwd: opts.cwd, env: opts.env }); return super.start(opts); }
  }

  it("starts the agent with the environment's port block in its env", async () => {
    const fake = new RecordingFake({ script: [] });
    const { c, sp } = await boot(fake);
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "hello" });
    await waitFor(() => fake.starts.length === 1);
    const env = fake.starts[0]!.env!;
    const block = (app.db.prepare("SELECT port_block_start AS s FROM environments WHERE space_id = ?").get(sp.id) as { s: number }).s;
    expect(block).toBeGreaterThan(0);
    expect(env).toMatchObject({ REALM_PORT_BASE: String(block), PORT: String(block), REALM_PORT_END: String(block + 9), REALM_PORT_COUNT: "10" });
    c.close();
  });

  // MUTANT: allocate per session rather than per environment, and two sessions sharing a checkout
  // fight over the same dev server anyway — which is the whole point of hanging it on the environment.
  it("two sessions in one checkout share a block; a session in another space does not", async () => {
    const fake = new RecordingFake({ script: [] });
    const { c, sp } = await boot(fake);
    const p2 = (await c.call("profiles.create", { name: "X" })).result;
    const sp2 = (await c.call("spaces.create", { profileId: p2.id, name: "T" })).result;
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const b = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const other = (await c.call("sessions.create", { spaceId: sp2.id, agentKind: "fake" })).result.session;
    for (const s of [a, b, other]) await c.call("sessions.send", { id: s.id, text: "hi" });
    await waitFor(() => fake.starts.length === 3);
    const [ea, eb, eo] = fake.starts.map((s) => s.env!.REALM_PORT_BASE);
    expect(ea).toBe(eb);
    expect(eo).not.toBe(ea);
    c.close();
  });
});

/** W2 left worktree branches reading `realm/session`, `realm/session-2`, because sessions are
 *  created untitled. The first message names the session; the branch follows it here (W3). */
describe("a worktree's branch catches up with its session's first message", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

  async function bootRepoSpace() {
    const { c, sp } = await boot();
    git(sp.folderPath, "init", "-b", "main");
    writeFileSync(join(sp.folderPath, "a.txt"), "one\n");
    git(sp.folderPath, "add", "."); git(sp.folderPath, "commit", "-m", "init");
    return { c, sp };
  }

  it("renames realm/session to the message's slug, and says so", async () => {
    const { c, sp } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: sp.id, title: null })).result;
    expect(env.branch).toBe("realm/session");
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: env.id })).result;

    await c.call("sessions.send", { id: session.id, text: "Fix the login flow" });
    await waitFor(() => (c.events.filter((e: Any) => e.event === "environments.changed").length > 0));
    await waitFor(async () => (await c.call("environments.get", { id: env.id })).result.branch === "realm/fix-the-login-flow");
    // git agrees, and the worktree is still on it.
    expect(git(env.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("realm/fix-the-login-flow");
    // The directory keeps its old leaf: moving it would pull the cwd out from under a live agent.
    expect((await c.call("sessions.get", { id: session.id })).result.cwd).toBe(env.path);
    c.close();
  });

  it("leaves a branch alone when the session was created with a title", async () => {
    const { c, sp } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "Refactor ports" })).result;
    expect(env.branch).toBe("realm/refactor-ports");
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: env.id })).result;
    await c.call("sessions.send", { id: session.id, text: "actually do something else entirely" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.title === "actually do something else entirely");
    expect((await c.call("environments.get", { id: env.id })).result.branch).toBe("realm/refactor-ports");
    c.close();
  });

  it("does not touch a session running in the space's own checkout", async () => {
    const { c, sp } = await bootRepoSpace();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "Fix the login flow" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.title === "Fix the login flow");
    // The primary checkout is the user's own branch. Nothing here may rename it.
    expect(git(sp.folderPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    c.close();
  });
});

/**
 * Plan 9 W3: the direct MCP passthrough is gone. `ensureLive` now hands every adapter exactly one
 * `realm` gateway entry, regardless of agent kind or what the space has enabled — which servers that
 * entry actually exposes is `mcp/gateway.test.ts`'s job, over real HTTP against a stub upstream. This
 * describes only the session-wiring seam: what the adapter is handed, and that the token dies with the
 * session.
 */
describe("MCP gateway wiring (Plan 9 W3)", () => {
  class McpSpyFake extends FakeAdapter {
    starts: Any[] = [];
    start(opts: Any) { this.starts.push(opts); return super.start(opts); }
  }

  it("hands the adapter exactly one `realm` mcp server — http transport, a Bearer Authorization header", async () => {
    // The named mutant: restore the old `mcpServers: this.d.mcp.configFor(...)` (or `[]`) and this fails.
    const fake = new McpSpyFake({ script: [] });
    const { c, sp } = await boot(fake);
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => fake.starts.length === 1);
    const servers = fake.starts[0]!.mcpServers as Any[];
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "realm", transport: "http" });
    expect(servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(servers[0].headers.Authorization).toMatch(/^Bearer .+/);
    c.close();
  });

  it("never leaks a third-party secret into the adapter's start options — only the realm gateway entry, never the deleted passthrough", async () => {
    // The deleted `mcp/integration.test.ts` "hands the space's enabled servers to the adapter at start"
    // test was the only guard against a gateway-entry-PLUS-passthrough regression (restoring
    // `mcpServers: [gateway.register(...), ...this.d.mcp.configFor(...)]`, say). This is that guard,
    // rewritten for what W3 actually promises: exactly one `realm` entry, and the space's real server
    // definition (name, command, and secret value) nowhere in what the adapter was handed.
    const SENTINEL = "sekrit-do-not-leak-me";
    const fake = new McpSpyFake({ script: [] });
    const { c, sp } = await boot(fake);
    await c.call("mcp.add", { spaceId: sp.id, name: "airtable", transport: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { AIRTABLE_API_KEY: SENTINEL } });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => fake.starts.length === 1);
    const opts = fake.starts[0]!;
    expect(opts.mcpServers).toHaveLength(1);
    expect(opts.mcpServers[0]).toMatchObject({ name: "realm", transport: "http" });
    expect(JSON.stringify(opts)).not.toContain(SENTINEL);
    expect(JSON.stringify(opts)).not.toContain("airtable");
    c.close();
  });

  it("mints a fresh token per session — two sessions never share one", async () => {
    const fake = new McpSpyFake({ script: [] });
    const { c, sp } = await boot(fake);
    const a = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    const b = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    await c.call("sessions.send", { id: a.id, text: "go" });
    await c.call("sessions.send", { id: b.id, text: "go" });
    await waitFor(() => fake.starts.length === 2);
    const [tokenA, tokenB] = fake.starts.map((s) => s.mcpServers[0].headers.Authorization as string);
    expect(tokenA).not.toBe(tokenB);
    c.close();
  });

  it("revokes the session's token on session delete — the old token is refused by the gateway afterward", async () => {
    // "release is called on session close", proven behaviorally: a live gateway request carrying the
    // token this session was handed must 401 once the session is gone, not just stop being referenced.
    const fake = new McpSpyFake({ script: [] });
    const { c, sp } = await boot(fake);
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => fake.starts.length === 1);
    const { url, headers } = fake.starts[0]!.mcpServers[0] as { url: string; headers: Record<string, string> };
    const before = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    expect(before.status).not.toBe(401);
    await c.call("sessions.delete", { id: session.id });
    const after = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
    c.close();
  });

});
