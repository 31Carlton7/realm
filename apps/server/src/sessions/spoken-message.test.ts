import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type UserMessage } from "@realm/adapters";
import { MID_TURN_MODE_KEY, sessionEvent, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { SPOKEN_NOTE } from "./service";

/**
 * A message said in voice mode, end to end over RPC. What must die: a spoken message that reaches the
 * transcript unmarked (a misheard word then reads as the person's typo), a typed message that is
 * marked, the agent never told its reply will be heard, the note leaking into the transcript, and a
 * spoken message queued behind a running turn losing its mark when it finally goes out.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Records every message, and holds a turn open until `finish` is called when `hold` is set. */
class RecordingAdapter implements AgentAdapter {
  readonly sent: UserMessage[] = [];
  readonly kind = "claude" as const;
  hold = false;
  private events: AsyncQueue<SessionEvent> | null = null;
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  finish() { this.events?.push(sessionEvent("status", { status: "idle" })); }
  start(): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    this.events = events;
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async (m) => {
        this.sent.push(m);
        events.push(sessionEvent("status", { status: "running" }));
        events.push(sessionEvent("assistant_text", { messageId: `m${this.sent.length}`, text: "ok" }));
        if (!this.hold) events.push(sessionEvent("status", { status: "idle" }));
      },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); if (v.error) rej(new Error(v.error.message)); else res(v.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  return { call, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-spoken-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const agent = new RecordingAdapter();
  app = await createApp({ home, port: 0, adapters: { claude: agent } });
  const c = await client(app.port);
  const profile = await c.call("profiles.create", { name: "W" });
  const space = await c.call("spaces.create", { profileId: profile.id, name: "S" });
  const { session } = await c.call("sessions.create", { spaceId: space.id, agentKind: "claude" });
  return { c, agent, id: session.id as string };
}

const userMessages = async (c: Any, id: string) =>
  (await c.call("sessions.events", { id })).filter((e: Any) => e.event.type === "user_message").map((e: Any) => e.event.payload);

describe("a spoken message", () => {
  it("is marked in the transcript, and the agent alone is told its reply will be heard", async () => {
    const { c, agent, id } = await boot();
    await c.call("sessions.send", { id, text: "what changed today", spoken: true });
    await waitFor(() => agent.sent.length === 1);
    // THE MUTANT: the server drops `spoken` on its way to `deliver` — the agent answers in markdown
    // tables that the voice view then has to skip.
    expect(agent.sent[0]!.text.endsWith(SPOKEN_NOTE)).toBe(true);
    const [said] = await userMessages(c, id);
    // THE MUTANT: the user_message omits the mark. The note never reaches the log, which keeps the words.
    expect(said).toMatchObject({ text: "what changed today", spoken: true });
    c.close();
  });

  it("leaves a typed message exactly as it was", async () => {
    const { c, agent, id } = await boot();
    await c.call("sessions.send", { id, text: "typed" });
    await waitFor(() => agent.sent.length === 1);
    // THE MUTANT: every message is marked spoken.
    expect(agent.sent[0]!.text).not.toContain(SPOKEN_NOTE);
    const [typed] = await userMessages(c, id);
    expect(typed).not.toHaveProperty("spoken");
    c.close();
  });

  it("keeps its mark when it waits in the queue behind a running turn", async () => {
    const { c, agent, id } = await boot();
    await c.call("settings.set", { key: MID_TURN_MODE_KEY, value: "queue" });
    agent.hold = true;
    await c.call("sessions.send", { id, text: "first" });
    await waitFor(() => agent.sent.length === 1);
    await waitFor(async () => (await c.call("sessions.get", { id })).status === "running");
    await c.call("sessions.send", { id, text: "and then this", spoken: true });
    agent.hold = false;
    agent.finish();
    await waitFor(() => agent.sent.length === 2);
    const said = (await userMessages(c, id)).at(-1);
    // THE MUTANT: the queue rebuilds the message from its text and attachments.
    expect(said).toMatchObject({ text: "and then this", spoken: true });
    expect(agent.sent[1]!.text.endsWith(SPOKEN_NOTE)).toBe(true);
    c.close();
  });
});
