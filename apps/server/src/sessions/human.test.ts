import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AdapterRegistry, type AgentHandle, type FakeScript, type StartOptions, type UserMessage } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * `human`, from the RPC that says it to the two places it has to arrive: the stored `user_message`,
 * which is what a transcript and Retry read, and the message the adapter is handed, which is what
 * Claude Code is told. Through the real app, because the value is carried by hand at every step,
 * and a step that drops it compiles, as does one that invents it.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** An answer over the socket, as much of it as these tests read: a row's id, or a new session's. */
type Reply = { result: { id: string; session: { id: string } } };
type Call = (method: string, params: unknown) => Promise<Reply>;

/** A scripted adapter that keeps every message it is handed, as it was handed it. */
class Recording extends FakeAdapter {
  readonly sent: UserMessage[] = [];
  override start(o: StartOptions): AgentHandle {
    const handle = super.start(o);
    return { ...handle, send: async (m) => { this.sent.push(m); await handle.send(m); } };
  }
}

/** A turn for the word `go` that stops on a permission card, which is what keeps it in flight for as
 *  long as a test needs with no timer. Any other message is answered at once, so the message a test
 *  sends behind that turn leaves nothing waiting when the app closes. */
const HOLDS: FakeScript = [{ on: "go", emit: [{ kind: "tool", name: "Bash", input: { command: "go" }, needsPermission: true, result: "x" }] }];

async function client(port: number): Promise<{ call: Call; close(): void }> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (reply: Reply) => void>();
  let n = 0;
  const call: Call = (method, params) => new Promise((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (reply) => { clearTimeout(timer); res(reply); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()) as Reply & { id?: string }; if (m.id !== undefined) pending.get(m.id)?.(m); });
  return { call, close: () => ws.close() };
}

/** The app on these adapters, a space, and one session on the scripted kind. */
async function boot(adapters: AdapterRegistry) {
  app = await createApp({ home: tempDir("realm-human-"), port: 0, adapters });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).result;
  const send = (params: Record<string, unknown>) => c.call("sessions.send", { id: session.id, ...params });
  return { c, space, id: session.id, send };
}

/** One session on a recording adapter, which is all most of these need. */
async function session() {
  const agent = new Recording({ script: HOLDS });
  return { agent, ...(await boot({ fake: agent })) };
}

/** Every `user_message` the session's log holds, oldest first. */
const stored = (id: string) => app!.sessions.events(id, 0, 500).flatMap((e) => (e.event.type === "user_message" ? [e.event.payload] : []));

/** Sends the message that holds a turn in flight, and waits until that turn is stopped on its card. */
async function holdTurn(s: Awaited<ReturnType<typeof session>>, params: Record<string, unknown> = {}): Promise<void> {
  await s.send({ text: "go", ...params });
  await waitFor(() => app!.sessions.events(s.id, 0, 500).some((e) => e.event.type === "permission_request"));
}

/** Allows the card the held turn is stopped on, which lets it run to its settle. */
async function releaseTurn(s: Awaited<ReturnType<typeof session>>): Promise<void> {
  const cards = app!.sessions.events(s.id, 0, 500).flatMap((e) => (e.event.type === "permission_request" ? [e.event.payload.requestId] : []));
  await s.c.call("sessions.respondPermission", { id: s.id, requestId: cards.at(-1), decision: "allow" });
}

/** The two ways a client leaves a message unmarked: by saying so, and by not saying. */
const UNSAID: { how: string; flag: { human?: boolean } }[] = [{ how: "said to be false", flag: { human: false } }, { how: "left out", flag: {} }];

describe("sessions.send — whose message it is said to be", () => {
  it("stores a message sent as a person's with the mark", async () => {
    const s = await session();
    await s.send({ text: "hello", human: true });
    await waitFor(() => stored(s.id).length === 1);
    expect(stored(s.id)[0]).toEqual({ text: "hello", attachments: [], human: true });
    s.c.close();
  });

  it("hands the adapter a message sent as a person's with the mark", async () => {
    const s = await session();
    await s.send({ text: "hello", human: true });
    await waitFor(() => s.agent.sent.length === 1);
    expect(s.agent.sent[0]).toEqual({ text: "hello", attachments: [], human: true });
    s.c.close();
  });

  it.each(UNSAID)("stores a message with no mark when human is $how", async ({ flag }) => {
    const s = await session();
    await s.send({ text: "hello", ...flag });
    await waitFor(() => stored(s.id).length === 1);
    expect(Object.keys(stored(s.id)[0]!)).toEqual(["text", "attachments"]);
    s.c.close();
  });

  it.each(UNSAID)("hands the adapter a message with no mark when human is $how", async ({ flag }) => {
    const s = await session();
    await s.send({ text: "hello", ...flag });
    await waitFor(() => s.agent.sent.length === 1);
    expect(Object.keys(s.agent.sent[0]!)).toEqual(["text", "attachments"]);
    s.c.close();
  });
});

describe("a person's message that does not go straight to the agent", () => {
  it("is handed to the adapter as a person's after it has waited in the queue", async () => {
    const s = await session();
    await holdTurn(s);
    await s.send({ text: "next", human: true });
    await releaseTurn(s);
    await waitFor(() => s.agent.sent.length === 2);
    expect(s.agent.sent[1]).toEqual({ text: "next", attachments: [], human: true });
    s.c.close();
  });

  it("is stored as a person's when it is drained from the queue", async () => {
    const s = await session();
    await holdTurn(s);
    await s.send({ text: "next", human: true });
    await releaseTurn(s);
    await waitFor(() => stored(s.id).length === 2);
    expect(stored(s.id)[1]).toEqual({ text: "next", attachments: [], human: true });
    s.c.close();
  });

  it("leaves a queued message that was not a person's unmarked, though the turn it waited behind was a person's", async () => {
    const s = await session();
    await holdTurn(s, { human: true });
    await s.send({ text: "next" });
    await releaseTurn(s);
    await waitFor(() => s.agent.sent.length === 2);
    expect(s.agent.sent.map((m) => m.human)).toEqual([true, undefined]);
    s.c.close();
  });

  it("is handed to the adapter as a person's when it is sent now, into a turn in flight", async () => {
    const s = await session();
    await holdTurn(s);
    await s.send({ text: "next", human: true, delivery: "steer" });
    await waitFor(() => s.agent.sent.length === 2);
    expect(s.agent.sent[1]).toEqual({ text: "next", attachments: [], human: true });
    s.c.close();
  });

  it("is handed to the next agent as a person's when failover sends its turn again", async () => {
    const failing = new Recording({ script: [{ on: "go", emit: [{ kind: "throw", message: "Claude AI usage limit reached|123" }] }] });
    const next = new Recording({ script: [{ on: "go", emit: [{ kind: "text", text: "finished on the other one" }] }] });
    const s = await boot({ fake: failing, codex: next });
    await s.c.call("failover.set", { spaceId: s.space.id, policy: { retry: true, chain: ["codex"] } });
    await s.send({ text: "go", human: true });
    await waitFor(() => next.sent.length === 1);
    expect(next.sent[0]).toEqual({ text: "go", attachments: [], human: true });
    s.c.close();
  });
});
