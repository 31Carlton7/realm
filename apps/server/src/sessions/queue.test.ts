import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { MID_TURN_MODE_KEY } from "@realm/contracts";
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
  const userMessages = (sessionId: string) => events
    .filter((e) => e.event === "session.event" && e.payload.sessionId === sessionId && e.payload.event.type === "user_message")
    .map((e) => e.payload.event.payload.text as string);
  const eventTypes = (sessionId: string) => events.filter((e) => e.event === "session.event" && e.payload.sessionId === sessionId).map((e) => e.payload.event.type as string);
  const queues = (sessionId: string) => events.filter((e) => e.event === "session.queue" && e.payload.sessionId === sessionId).map((e) => e.payload.queued as { id: string; text: string }[]);
  return { call, events, eventTypes, userMessages, queues, close: () => ws.close() };
}

/* One tool call that asks for permission, which is what holds a turn open with no timer in the test:
 * the session sits in `waiting_permission` until the card is answered, and that is a turn in flight.
 *
 * Every message the suite sends gets its own held turn, drained ones included — that is what makes
 * "one message per settle" observable. A script entry the fake cannot match falls through to an
 * instant echo, which would settle on its own and drain the whole queue in one pass. */
const holdsEveryTurn = () => new FakeAdapter({
  script: ["go", "first", "second", "look", "later"].map((on) => ({
    on, emit: [{ kind: "tool" as const, name: "Bash", input: { command: on }, needsPermission: true, result: "x" }],
  })),
});

async function boot(fake = holdsEveryTurn()) {
  const home = tempDir("realm-");
  app = await createApp({ home, port: 0, adapters: { fake } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
  return { c, sp, session };
}

/** Start the turn and wait until it is parked on its permission card. */
async function holdTurn(c: Awaited<ReturnType<typeof client>>, id: string) {
  await c.call("sessions.send", { id, text: "go" });
  await waitFor(() => c.eventTypes(id).includes("permission_request"));
}

/** Answer the newest card, which lets the turn holding on it run to its settle. */
async function releaseTurn(c: Awaited<ReturnType<typeof client>>, id: string) {
  const cards = c.events.filter((e) => e.event === "session.event" && e.payload.sessionId === id && e.payload.event.type === "permission_request");
  const req = cards[cards.length - 1]!.payload.event.payload.requestId;
  await c.call("sessions.respondPermission", { id, requestId: req, decision: "allow" });
}

describe("mid-turn prompts", () => {
  it("queues a message typed during a turn instead of sending it", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "also fix the test" });

    // The transcript is what an agent was actually asked, so a queued message has no line in it yet.
    expect(c.userMessages(session.id)).toEqual(["go"]);
    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;
    expect(queued.map((q: { text: string }) => q.text)).toEqual(["also fix the test"]);
  });

  it("drains one queued message per settle, oldest first", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });

    await releaseTurn(c, session.id);

    // The settle releases exactly one. The second stays queued behind the turn the first just started.
    await waitFor(() => c.userMessages(session.id).includes("first"));
    expect(c.userMessages(session.id)).toEqual(["go", "first"]);
    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;
    expect(queued.map((q: { text: string }) => q.text)).toEqual(["second"]);
  });

  it("parks the queue when the user stops the turn, rather than starting a fresh one", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "queued" });

    await c.call("sessions.interrupt", { id: session.id });
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));

    // Stop has to mean stop: the settle it produced must not release the queue.
    expect(c.userMessages(session.id)).toEqual(["go"]);
    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;
    expect(queued.map((q: { text: string }) => q.text)).toEqual(["queued"]);
  });

  it("sends straight through when the setting says steer", async () => {
    const { c, session } = await boot();
    await c.call("settings.set", { key: MID_TURN_MODE_KEY, value: "steer" });
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "actually stop and do this" });

    await waitFor(() => c.userMessages(session.id).includes("actually stop and do this"));
    expect((await c.call("sessions.queued", { id: session.id })).result.queued).toEqual([]);
  });

  it("steers on request even while the setting says queue", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "now", delivery: "steer" });

    await waitFor(() => c.userMessages(session.id).includes("now"));
  });

  it("queues on request even while the setting says steer", async () => {
    const { c, session } = await boot();
    await c.call("settings.set", { key: MID_TURN_MODE_KEY, value: "steer" });
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "later", delivery: "queue" });

    expect(c.userMessages(session.id)).toEqual(["go"]);
    expect((await c.call("sessions.queued", { id: session.id })).result.queued.map((q: { text: string }) => q.text)).toEqual(["later"]);
  });

  it("sends immediately when no turn is in flight, whatever the setting says", async () => {
    const { c, session } = await boot();
    await c.call("settings.set", { key: MID_TURN_MODE_KEY, value: "queue" });

    await c.call("sessions.send", { id: session.id, text: "straight through" });

    await waitFor(() => c.userMessages(session.id).includes("straight through"));
    expect((await c.call("sessions.queued", { id: session.id })).result.queued).toEqual([]);
  });

  it("drops a queued message on dequeue and leaves the rest in order", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;

    await c.call("sessions.dequeue", { id: session.id, queuedId: queued[0].id });

    expect((await c.call("sessions.queued", { id: session.id })).result.queued.map((q: { text: string }) => q.text)).toEqual(["second"]);
  });

  it("treats a dequeue of an id the queue no longer holds as a no-op", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "queued" });

    const res = await c.call("sessions.dequeue", { id: session.id, queuedId: "gone" });

    expect(res.result).toEqual({ ok: true });
    expect((await c.call("sessions.queued", { id: session.id })).result.queued).toHaveLength(1);
  });

  it("broadcasts the whole queue on every change", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    await waitFor(() => c.queues(session.id).length >= 2);

    expect(c.queues(session.id).map((q) => q.map((p) => p.text))).toEqual([["first"], ["first", "second"]]);
  });

  it("keeps a queued message's attachments", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);

    await c.call("sessions.send", { id: session.id, text: "look", attachments: [{ path: "/tmp/shot.png", mime: "image/png" }] });

    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;
    expect(queued[0].attachments).toEqual([{ path: "/tmp/shot.png", mime: "image/png" }]);
  });
});
