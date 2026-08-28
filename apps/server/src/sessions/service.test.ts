import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
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
