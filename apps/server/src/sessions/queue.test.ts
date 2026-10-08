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

  /* Claude's interrupt resolves on the control response, and the cancelled turn settles after it. A
   * steer that sent on the acknowledgement landed its message inside the turn still unwinding, and
   * the late settle left the session idle with the message unanswered — "Send now" read as Stop. */
  it("sends a released message only once the interrupted turn has settled", async () => {
    class LateSettle extends FakeAdapter {
      override start(opts: Parameters<FakeAdapter["start"]>[0]) {
        const h = super.start(opts);
        return { ...h, interrupt: async () => { setTimeout(() => void h.interrupt(), 50); } };
      }
    }
    const { c, session } = await boot(new LateSettle({ script: [{ on: "go", emit: [{ kind: "tool", name: "Bash", input: { command: "go" }, needsPermission: true, result: "x" }] }] }));
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "queued" });
    const { queued } = (await c.call("sessions.queued", { id: session.id })).result;

    await c.call("sessions.releaseQueued", { id: session.id, queuedId: queued[0].id });

    await waitFor(() => c.userMessages(session.id).includes("queued"));
    const mine = c.events.filter((e) => e.event === "session.event" && e.payload.sessionId === session.id).map((e) => e.payload.event);
    const stopped = mine.findIndex((e) => e.type === "status" && e.payload.interrupted === true);
    const sent = mine.findIndex((e) => e.type === "user_message" && e.payload.text === "queued");
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(stopped);
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

describe("editing a queued message", () => {
  const texts = (q: { text: string }[]) => q.map((x) => x.text);
  const queued = async (c: Awaited<ReturnType<typeof client>>, id: string) => (await c.call("sessions.queued", { id })).result.queued as { id: string; text: string; held: boolean }[];

  it("replaces the text and keeps the message's place", async () => {
    // THE MUTANT: an edit as remove-and-re-enqueue, which sends the corrected message last.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    const [a] = await queued(c, session.id);

    expect((await c.call("sessions.editQueued", { id: session.id, queuedId: a!.id, text: "first, edited" })).result).toEqual({ edited: true });

    expect(texts(await queued(c, session.id))).toEqual(["first, edited", "second"]);
    await releaseTurn(c, session.id);
    await waitFor(() => c.userMessages(session.id).length === 2);
    expect(c.userMessages(session.id)).toEqual(["go", "first, edited"]);
  });

  it("answers edited:false for a message that already went out, and sends nothing twice", async () => {
    // THE MUTANT: an edit of a gone id that re-sends it, or re-queues it.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);
    await releaseTurn(c, session.id);
    await waitFor(() => c.userMessages(session.id).includes("first"));

    expect((await c.call("sessions.editQueued", { id: session.id, queuedId: a!.id, text: "too late" })).result).toEqual({ edited: false });

    await new Promise((r) => setTimeout(r, 50));
    expect(c.userMessages(session.id)).toEqual(["go", "first"]);
    expect(await queued(c, session.id)).toEqual([]);
  });

  it("does not drain a held head at the settle, and letting go drains it", async () => {
    // THE MUTANTS: a drain that ignores the hold (the old text goes out mid-edit), and a let-go that
    // never pays the drain the settle owed (the message sits until something else settles).
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);
    expect((await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true })).result).toEqual({ ok: true, held: true });

    await releaseTurn(c, session.id);
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));
    await new Promise((r) => setTimeout(r, 50));
    expect(c.userMessages(session.id)).toEqual(["go"]);

    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: false });
    await waitFor(() => c.userMessages(session.id).includes("first"));
  });

  it("saving the edit of a held head lets go and sends the edited text", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });
    await releaseTurn(c, session.id);
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));

    await c.call("sessions.editQueued", { id: session.id, queuedId: a!.id, text: "later" });

    await waitFor(() => c.userMessages(session.id).includes("later"));
    expect(c.userMessages(session.id)).toEqual(["go", "later"]);
  });

  it("letting go after the user's Stop starts no turn", async () => {
    // THE MUTANT: a let-go that drains whenever the session is idle — the Stop button undone by an edit.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });

    await c.call("sessions.interrupt", { id: session.id });
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: false });

    await new Promise((r) => setTimeout(r, 80));
    expect(c.userMessages(session.id)).toEqual(["go"]);
    expect(texts(await queued(c, session.id))).toEqual(["first"]);
  });

  it("a held head blocks the messages behind it", async () => {
    // THE MUTANT: a drain that skips the held message and sends the next one in its place.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    const [a] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });

    await releaseTurn(c, session.id);
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));
    await new Promise((r) => setTimeout(r, 50));

    expect(c.userMessages(session.id)).toEqual(["go"]);
    expect(texts(await queued(c, session.id))).toEqual(["first", "second"]);
  });

  it("lets go of a hold nobody came back to", async () => {
    // THE MUTANT: a hold with no timer — a window closed mid-edit strands the queue for good.
    const { c, session } = await boot();
    app.sessions.queueHoldTtlMs = 60;
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });
    await releaseTurn(c, session.id);

    await waitFor(() => c.userMessages(session.id).includes("first"));
    expect(await queued(c, session.id)).toEqual([]);
  });

  it("drops an element chip whose token the edit took out", async () => {
    // THE MUTANT: the edit keeping the old `elements` — the agent handed a picked element the message
    // no longer mentions.
    const element = { ref: 1, url: "https://example.com", title: "Example", rect: { x: 0, y: 0, w: 10, h: 10 }, selector: "#buy", tag: "button", role: "button", name: "Buy", text: "Buy", html: "<button id=buy>Buy</button>" };
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first @[Buy] and @[Cart]", elements: [{ label: "Buy", element }, { label: "Cart", element: { ...element, name: "Cart" } }] });
    const [a] = await queued(c, session.id);

    await c.call("sessions.editQueued", { id: session.id, queuedId: a!.id, text: "first @[Cart] only" });

    expect(app.sessions.queuedFor(session.id)[0]!.msg.elements!.map((e) => e.label)).toEqual(["Cart"]);
  });

  it("refuses an edit to nothing at all", async () => {
    // THE MUTANT: no guard — an empty message queued that the adapter would be handed.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    const [a] = await queued(c, session.id);

    const res = await c.call("sessions.editQueued", { id: session.id, queuedId: a!.id, text: "" });

    expect(res.ok).toBe(false);
    expect(texts(await queued(c, session.id))).toEqual(["first"]);
  });

  it("dequeue and send-now take the hold with them", async () => {
    // THE MUTANT: a hold left behind on an id that is gone, still marked on the next broadcast and
    // still owed a drain.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "plain" });
    // "plain" is no script line of the fake, so it echoes and settles: the steer's new turn is not
    // left parked on a card while the app closes.
    const [a, b] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });
    await c.call("sessions.dequeue", { id: session.id, queuedId: a!.id });
    expect(await queued(c, session.id)).toEqual([expect.objectContaining({ text: "plain", held: false })]);

    await c.call("sessions.holdQueued", { id: session.id, queuedId: b!.id, held: true });
    await c.call("sessions.releaseQueued", { id: session.id, queuedId: b!.id });
    await waitFor(() => c.userMessages(session.id).includes("plain"));
    expect(c.queues(session.id).at(-1)).toEqual([]);
  });

  it("removing a held head that stopped a drain sends the message behind it", async () => {
    // THE MUTANT: a dequeue that leaves the hold and its owed drain behind — the next message sits
    // until some later settle that may never come.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    const [a] = await queued(c, session.id);
    await c.call("sessions.holdQueued", { id: session.id, queuedId: a!.id, held: true });
    await releaseTurn(c, session.id);
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.sessionId === session.id && e.payload.status === "idle"));

    await c.call("sessions.dequeue", { id: session.id, queuedId: a!.id });

    await waitFor(() => c.userMessages(session.id).includes("second"));
    expect(c.userMessages(session.id)).toEqual(["go", "second"]);
  });

  it("marks the held message on the broadcast, and only that one", async () => {
    // THE MUTANT: `held` left off the wire, so no other window can tell the message is being edited.
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    await c.call("sessions.send", { id: session.id, text: "first" });
    await c.call("sessions.send", { id: session.id, text: "second" });
    const [, b] = await queued(c, session.id);

    await c.call("sessions.holdQueued", { id: session.id, queuedId: b!.id, held: true });

    await waitFor(() => c.queues(session.id).at(-1)?.some((q: Any) => q.held) === true);
    expect(c.queues(session.id).at(-1)!.map((q: Any) => [q.text, q.held])).toEqual([["first", false], ["second", true]]);
  });

  it("answers held:false for a hold on a message that has already gone", async () => {
    const { c, session } = await boot();
    await holdTurn(c, session.id);
    expect((await c.call("sessions.holdQueued", { id: session.id, queuedId: "gone", held: true })).result).toEqual({ ok: true, held: false });
  });
});
