import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { sessionEvent, type Session } from "@realm/contracts";
import { createApp, type App } from "../app";
import { SessionsStore } from "../store/sessions";
import { waitFor } from "../test-utils";

/**
 * `Session.activityAt` — what every list of sessions is ordered by — moves when the conversation
 * does (a prompt going out, a reply, a turn ending) and for nothing else that writes the row: being
 * opened and read, a resume's init and statuses, a model or mode change, a rename, an archive, a
 * summary Realm wrote, the turn-media catch-up's quiet append.
 */

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
  const statuses = (sessionId: string) => events.filter((e) => e.event === "session.status" && e.payload.sessionId === sessionId).map((e) => e.payload.status as string);
  /** A call that must succeed: a refused write would leave the time alone and pass for the wrong reason. */
  const must = async (method: string, params: unknown) => { const r = await call(method, params); expect(r.error).toBeUndefined(); return r.result; };
  /** The turn ran and ended — an `idle` from before it started (the adapter's boot) is not that. */
  const settled = (sessionId: string) => { const st = statuses(sessionId); return st.includes("running") && st.at(-1) === "idle"; };
  return { call, must, events, statuses, settled };
}

/** A turn that parks on a permission card (`hold`), and an instant echo for anything else. */
const fake = () => new FakeAdapter({
  script: [{ on: "hold", emit: [{ kind: "tool" as const, name: "Bash", input: { command: "x" }, needsPermission: true, result: "x" }] }],
});

async function boot() {
  app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { fake: fake() } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const made = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
  const get = async (): Promise<Session> => (await c.call("sessions.get", { id: made.session.id })).result;
  return { c, sp, id: made.session.id as string, itemId: made.itemId as string, get };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("what moves a session's activity", () => {
  it("starts at its making", async () => {
    const { get } = await boot();
    const s = await get();
    expect(s.activityAt).toBe(s.createdAt);
  });

  it("a prompt going out, and the reply it gets", async () => {
    const { c, id, get } = await boot();
    const made = (await get()).activityAt;
    await tick();
    const sentAt = Date.now();
    await c.call("sessions.send", { id, text: "hello" });
    await waitFor(() => c.settled(id));
    const after = (await get()).activityAt;
    expect(after).toBeGreaterThan(made);
    expect(after).toBeGreaterThanOrEqual(sentAt);
  });

  it("a queued message when it goes OUT — not when it is written", async () => {
    const { c, id, get } = await boot();
    await c.call("sessions.send", { id, text: "hold" });
    await waitFor(() => c.statuses(id).includes("waiting_permission"));
    const held = (await get()).activityAt;
    await tick();
    await c.call("sessions.send", { id, text: "later", delivery: "queue" });
    expect((await get()).activityAt).toBe(held);
    const { queued } = (await c.call("sessions.queued", { id })).result;
    await tick();
    await c.call("sessions.releaseQueued", { id, queuedId: queued[0].id });
    await waitFor(async () => (await get()).activityAt > held);
  });

  it("a turn ending, even one that said nothing", async () => {
    const { id, get } = await boot();
    app.sessions.emitExternal(id, sessionEvent("status", { status: "running" }));
    const before = (await get()).activityAt;
    await tick();
    app.sessions.emitExternal(id, sessionEvent("status", { status: "idle" }));
    expect((await get()).activityAt).toBeGreaterThan(before);
  });
});

describe("what leaves it alone", () => {
  it("being opened and read", async () => {
    const { c, id, get } = await boot();
    await c.call("sessions.send", { id, text: "hello" });
    await waitFor(() => c.settled(id));
    const s = await get();
    await tick();
    await c.must("sessions.events", { id, afterSeq: 0, limit: 500 });
    await c.must("sessions.markSeen", { id, seq: s.lastEventSeq });
    expect((await get()).activityAt).toBe(s.activityAt);
  });

  it("a resume's init and the statuses it passes through, written to the row as they come", async () => {
    const { id, get } = await boot();
    const s = await get();
    await tick();
    app.sessions.emitExternal(id, sessionEvent("init", { providerSessionId: "p-1", model: "m", tools: [], cwd: "/tmp" }));
    app.sessions.emitExternal(id, sessionEvent("status", { status: "idle" }));
    app.sessions.emitExternal(id, sessionEvent("status", { status: "ended" }));
    const after = await get();
    expect(after.updatedAt).toBeGreaterThan(s.updatedAt); // the row WAS written to
    expect(after.activityAt).toBe(s.activityAt);
  });

  it("a model or mode change, a rename, an archive and its undoing", async () => {
    const { c, id, itemId, get } = await boot();
    const s = await get();
    await tick();
    await c.must("sessions.setOptions", { id, model: "other", permissionMode: "plan" });
    await c.must("items.update", { id: itemId, title: "Renamed" });
    await c.must("items.update", { id: itemId, archived: true });
    await c.must("items.update", { id: itemId, archived: false });
    expect((await get()).activityAt).toBe(s.activityAt);
  });

  it("Realm's own writes: a summary on the rail, a cursor, the turn-media catch-up's quiet append", async () => {
    const { id, get } = await boot();
    const s = await get();
    await tick();
    app.sessions.publishServerEvent(id, sessionEvent("error", { message: "a note Realm wrote" }));
    const store = new SessionsStore(app.db);
    store.setProviderCursor(id, "c");
    store.setLastEventSeqQuietly(id, s.lastEventSeq + 1);
    expect((await get()).activityAt).toBe(s.activityAt);
  });
});

describe("touchActivity", () => {
  it("never moves a session backwards", async () => {
    const { id, get } = await boot();
    const store = new SessionsStore(app.db);
    store.touchActivity(id, 5_000_000_000_000);
    store.touchActivity(id, 1);
    expect((await get()).activityAt).toBe(5_000_000_000_000);
  });
});
