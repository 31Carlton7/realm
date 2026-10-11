import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions, type UserMessage } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { PATCH, fakeGh, pr, type GhFixture } from "./fake-gh.test-fakes";

/**
 * What the Code Review page's question box hands to the session it asks, through the real app and
 * over the socket: whose message a question is said to be, which the page says and the service
 * carries on both of the sends a question can take. Beside it, the prompt a reviewer is sent, which
 * Realm writes and which is never a person's whatever its caller says.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

const ref = { owner: "acme", repo: "widgets", number: 42 };
const FIXTURE: GhFixture = {
  user: { login: "carlton" },
  sections: { authored: ["acme/widgets#42"], review: [] },
  prs: { "acme/widgets#42": pr("acme", "widgets", 42, { title: "Stream the tokenizer", files: [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH }], view: { body: "Why: speed.", changedFiles: 1 } }) },
};

/** An answer over the socket, as much of it as these tests read: the session a call went to. */
type Reply = { ok: boolean; result: { sessionId: string }; error?: { message: string } };
type Call = (method: string, params: unknown) => Promise<{ sessionId: string }>;

/** A scripted adapter that keeps what each session was started with and every message it is handed,
 *  as it was handed it. It answers to whichever kinds the app registers it under. */
class Recording extends FakeAdapter {
  readonly starts: StartOptions[] = [];
  readonly sent: UserMessage[] = [];
  override start(o: StartOptions): AgentHandle {
    this.starts.push(o);
    const handle = super.start(o);
    return { ...handle, send: async (m) => { this.sent.push(m); await handle.send(m); } };
  }
}

async function client(port: number): Promise<{ call: Call; close(): void }> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (reply: Reply) => void>();
  let n = 0;
  const call: Call = (method, params) => new Promise((res, rej) => {
    const id = String(++n);
    pending.set(id, (reply) => (reply.ok ? res(reply.result) : rej(new Error(reply.error?.message ?? `rpc ${method} failed`))));
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()) as Reply & { id?: string }; if (m.id !== undefined) pending.get(m.id)?.(m); });
  return { call, close: () => ws.close() };
}

/** The app with a fake `gh`, a recording agent on the scripted kind and under Claude's name, and a
 *  space to ask in. */
async function boot() {
  const home = tempDir("realm-cr-ask-");
  const agent = new Recording({ script: [], delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake: agent, claude: agent }, codeReview: { gh: fakeGh(FIXTURE).command, timeouts: { budgetMs: 5000, pollMs: 20 } } });
  const profiles = new ProfilesStore(app.db);
  const profile = profiles.list()[0] ?? profiles.create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(app.db, home);
  const space = spaces.list(profile.id)[0] ?? spaces.create({ profileId: profile.id, name: "S", icon: "folder" });
  const rpc = await client(app.port);
  const ask = (text: string, over: Record<string, unknown> = {}) => rpc.call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text, ...over });
  return { agent, rpc, ask, profileId: profile.id, space };
}

/** Every `user_message` a session's log holds, oldest first, once it holds `count` of them. */
async function stored(sessionId: string, count: number) {
  const read = () => app!.sessions.events(sessionId, 0, 200).flatMap((e) => (e.event.type === "user_message" ? [e.event.payload] : []));
  await waitFor(() => read().length >= count);
  return read();
}

describe("codeReview.ask — whose question it is said to be", () => {
  it("stores the first question about a request as a person's when the page says a person asked", async () => {
    const t = await boot();
    const { sessionId } = await t.ask("What does this change?", { human: true });
    expect((await stored(sessionId, 1))[0]!.human).toBe(true);
    t.rpc.close();
  });

  it("stores a later question in the same thread as a person's too", async () => {
    const t = await boot();
    const { sessionId } = await t.ask("What does this change?", { human: true });
    await t.ask("And the tests?", { human: true });
    expect((await stored(sessionId, 2)).map((m) => [m.text, m.human])).toEqual([["About pull request acme/widgets#42 (attached): What does this change?", true], ["And the tests?", true]]);
    t.rpc.close();
  });

  it("hands the adapter both questions as a person's", async () => {
    const t = await boot();
    await t.ask("What does this change?", { human: true });
    await t.ask("And the tests?", { human: true });
    await waitFor(() => t.agent.sent.length === 2);
    expect(t.agent.sent.map((m) => m.human)).toEqual([true, true]);
    t.rpc.close();
  });

  it("stores a question with no mark when the page does not say a person asked", async () => {
    const t = await boot();
    const { sessionId } = await t.ask("What does this change?");
    expect((await stored(sessionId, 1))[0]).not.toHaveProperty("human");
    t.rpc.close();
  });

  it("marks only the question whose own call says a person asked, in a thread that holds both kinds", async () => {
    const t = await boot();
    const { sessionId } = await t.ask("What does this change?", { human: true });
    await t.ask("And the tests?");
    expect((await stored(sessionId, 2)).map((m) => m.human)).toEqual([true, undefined]);
    t.rpc.close();
  });
});

describe("codeReview.review — the prompt Realm writes for a reviewer", () => {
  it("is stored with no mark, though the call that started the review claims a person's hand", async () => {
    const t = await boot();
    const { sessionId } = await t.rpc.call("codeReview.review", { ref, profileId: t.profileId, spaceId: t.space.id, agentKind: "fake", human: true });
    expect((await stored(sessionId, 1))[0]).not.toHaveProperty("human");
    t.rpc.close();
  });

  it("is handed to the adapter with no mark", async () => {
    const t = await boot();
    await t.rpc.call("codeReview.review", { ref, profileId: t.profileId, spaceId: t.space.id, agentKind: "fake", human: true });
    await waitFor(() => t.agent.sent.length === 1);
    expect(t.agent.sent[0]).not.toHaveProperty("human");
    t.rpc.close();
  });
});
