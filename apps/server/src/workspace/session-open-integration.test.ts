import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/** `waitFor`, answering with what it waited for. */
async function until<T>(read: () => Promise<T | null | undefined>, timeout = 10_000): Promise<T> {
  let got: T | null | undefined = null;
  await waitFor(async () => (got = await read()) != null, { timeout });
  return got as T;
}

/* `session_open` through the whole server: the scripted agent calls it through the real gateway, the
   broker gates it on the caller's mode, and the session it opens is a real one that answers. */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = async (method: string, params: unknown): Promise<Any> => {
    const id = String(++n);
    const m = await new Promise<Any>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    if (!m.ok) throw new Error(`${method}: ${m.error?.message}`);
    return m.result;
  };
  return { call, events, close: () => ws.close() };
}

const SCRIPT: FakeScript = [{ on: "open one beside me", emit: [{ kind: "call", tool: "realm-workspace__session_open", input: { prompt: "echo hi", beside: "below" } }] }];

async function boot() {
  app = await createApp({ home: tempDir("realm-session-open-"), port: 0, adapters: { fake: new FakeAdapter({ script: SCRIPT }) } });
  const c = await client(app.port);
  const p = await c.call("profiles.create", { name: "W" });
  const sp = await c.call("spaces.create", { profileId: p.id, name: "S" });
  const { session } = await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" });
  return { c, spaceId: sp.id as string, id: session.id as string };
}

describe("session_open, end to end", () => {
  it("opens a real session beside the caller in Full access, with the prompt sent as the caller's, and it answers", { timeout: 25_000 }, async () => {
    const { c, spaceId, id } = await boot();
    await c.call("sessions.setOptions", { id, permissionMode: "bypassPermissions" });
    await c.call("sessions.send", { id, text: "open one beside me" });
    const opened: Any = await until(async () => (await c.call("sessions.list", { spaceId })).find((s: Any) => s.id !== id));
    expect(opened.dispatchedBy).toEqual({ kind: "session_open", sessionId: id });
    expect(opened.agentKind).toBe("fake");
    const events = async () => (await c.call("sessions.events", { id: opened.id, afterSeq: 0, limit: 200 })).map((e: Any) => e.event);
    await waitFor(async () => (await events()).some((e: Any) => e.type === "assistant_text" && e.payload.text === "echo: echo hi"), { timeout: 10_000 });
    const asked = (await events()).find((e: Any) => e.type === "user_message");
    expect(asked.payload.from).toEqual({ sessionId: id, title: expect.any(String) });
    const announced = c.events.find((e: Any) => e.event === "session.openRequested");
    expect(announced?.payload).toEqual({ spaceId, sessionId: opened.id, itemId: expect.any(String), openedBy: id, edge: "bottom" });
    // A delegated child is announced differently and gets no pane; this one is nobody's child.
    expect(c.events.some((e: Any) => e.event === "session.agentOpened")).toBe(false);
  });

  it("puts the user's card in front of it in Ask-each-time, and opens nothing until it is answered", { timeout: 25_000 }, async () => {
    const { c, spaceId, id } = await boot();
    await c.call("sessions.send", { id, text: "open one beside me" });
    const card: Any = await until(async () => (await c.call("sessions.events", { id, afterSeq: 0, limit: 200 }))
      .map((e: Any) => e.event).find((e: Any) => e.type === "permission_request" && e.payload.toolName === "session_open"));
    expect((await c.call("sessions.list", { spaceId })).length).toBe(1);
    await c.call("sessions.respondPermission", { id, requestId: card.payload.requestId, decision: "allow" });
    await waitFor(async () => (await c.call("sessions.list", { spaceId })).length === 2, { timeout: 10_000 });
  });
});
