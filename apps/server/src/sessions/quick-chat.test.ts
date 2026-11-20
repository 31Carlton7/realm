import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { QUICK_CHAT_SPARE_SETTING } from "./quick-chat";

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res) => {
    const id = String(++n);
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

/** The fake engine, counting its starts and keeping what each was started with. */
class CountingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(opts: StartOptions) { this.starts.push(opts); return super.start(opts); }
}

async function boot(warmMs = 60_000) {
  const fake = new CountingFake({ script: [{ on: "hi", emit: [{ kind: "text", text: "hello there" }] }] });
  app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { fake }, quickChat: { warmMs } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const start = async (spaceId = sp.id) => (await c.call("sessions.startQuickChat", { spaceId })).result.session;
  const say = async (id: string) => {
    await c.call("sessions.send", { id, text: "hi" });
    await waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle"
      && (await c.call("sessions.events", { id })).result.some((e: Any) => e.event.type === "assistant_text"));
  };
  return { fake, c, sp, start, say };
}

describe("quick chat engines", () => {
  it("starts an engine when a quick chat is deleted, and the next quick chat takes it", async () => {
    const { fake, c, start, say } = await boot();
    const first = await start();
    await say(first.id);
    expect(fake.starts).toHaveLength(1);
    await c.call("sessions.delete", { id: first.id });
    // Started at the delete, before anyone has asked the next question.
    expect(fake.starts).toHaveLength(2);
    const next = await start();
    expect(next.id).not.toBe(first.id);
    await say(next.id);
    // The message went to the engine that was already up: no third start.
    expect(fake.starts).toHaveLength(2);
    c.close();
  });

  it("gives each quick chat a fresh conversation: no resume, no events, nothing from the last", async () => {
    const { fake, c, start, say } = await boot();
    const first = await start();
    await say(first.id);
    const closed = (await c.call("sessions.get", { id: first.id })).result.providerSessionId;
    expect(closed).toBeTruthy();
    await c.call("sessions.delete", { id: first.id });
    const next = await start();
    expect(fake.starts[1]!.resume ?? null).toBeNull();
    // Its own conversation, which its engine reported when it started: never the closed chat's.
    const own = (await c.call("sessions.get", { id: next.id })).result.providerSessionId;
    expect(own).not.toBe(closed);
    expect(next.title).toBe("New session");
    expect((await c.call("sessions.events", { id: next.id })).result.filter((e: Any) => e.event.type === "assistant_text" || e.event.type === "user_message")).toEqual([]);
    // The closed chat is gone, not handed on.
    expect((await c.call("sessions.get", { id: first.id })).error).toBeTruthy();
    c.close();
  });

  it("stops and deletes the spare once it has waited the idle time", async () => {
    const { c, start } = await boot(150);
    const first = await start();
    await c.call("sessions.delete", { id: first.id });
    const spareId = (await c.call("settings.get", { key: QUICK_CHAT_SPARE_SETTING })).result.value as string;
    expect(typeof spareId).toBe("string");
    expect((await c.call("sessions.get", { id: spareId })).result.id).toBe(spareId);
    await waitFor(async () => Boolean((await c.call("sessions.get", { id: spareId })).error));
    expect((await c.call("settings.get", { key: QUICK_CHAT_SPARE_SETTING })).result.value).toBeNull();
    c.close();
  });

  it("does not hand a spare on a different model, or in a different space, to the next quick chat", async () => {
    const { c, start } = await boot();
    const first = await start();
    await c.call("sessions.delete", { id: first.id });
    const spareId = (await c.call("settings.get", { key: QUICK_CHAT_SPARE_SETTING })).result.value as string;
    await c.call("settings.set", { key: "quickChatModel", value: { agentKind: "fake", model: "fake" } });
    const next = await start();
    expect(next.id).not.toBe(spareId);
    expect(next.model).toBe("fake");
    expect((await c.call("sessions.get", { id: spareId })).error).toBeTruthy();

    await c.call("sessions.delete", { id: next.id });
    const p2 = (await c.call("profiles.create", { name: "X" })).result;
    const other = (await c.call("spaces.create", { profileId: p2.id, name: "T" })).result;
    const spare2 = (await c.call("settings.get", { key: QUICK_CHAT_SPARE_SETTING })).result.value as string;
    const elsewhere = await start(other.id);
    expect(elsewhere.id).not.toBe(spare2);
    expect(elsewhere.spaceId).toBe(other.id);
    c.close();
  });

  it("deletes a spare a stopped server left behind", async () => {
    const home = tempDir("realm-");
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    let c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
    // What a crash leaves: a spare's row, and its id in the setting. A clean close deletes both itself.
    const left = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", unlisted: true })).result.session;
    await c.call("settings.set", { key: QUICK_CHAT_SPARE_SETTING, value: left.id });
    c.close();
    await app.close();
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    c = await client(app.port);
    expect((await c.call("sessions.get", { id: left.id })).error).toBeTruthy();
    c.close();
  });
});
