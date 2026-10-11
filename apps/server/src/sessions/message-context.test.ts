import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions, type UserMessage } from "@realm/adapters";
import { macSkillContext, mentionRefContext, sessionEvent, sessionRefContext, type MentionRef, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * What the server names as a message's `context`, end to end over RPC: the part of the text it
 * appended itself, handed over a second time so that an adapter can tell it from the person's words.
 * The text is held to what it always was, the words and then everything appended, and the context
 * to being exactly that tail. An adapter that splits on it would otherwise cut the text in the wrong
 * place, or find no tail and send Realm's blocks in with the person's words.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

/** An answer over the socket, as much of it as these tests read: a row's id, or a new session's. */
type Reply = { result: { id: string; session: { id: string } } };
type Call = (method: string, params: unknown) => Promise<Reply>;

/** A real agent kind's stand-in that records every message it was handed. */
class RecordingAdapter implements AgentAdapter {
  readonly sent: UserMessage[] = [];
  readonly kind = "claude" as const;
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async (m) => { this.sent.push(m); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

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

/** A home with no bundled skills, a space in it, and a file on disk for a message to mention. */
async function boot() {
  const home = tempDir("realm-message-context-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const agent = new RecordingAdapter();
  app = await createApp({ home, port: 0, adapters: { claude: agent } });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  const path = join(home, "auth.ts");
  writeFileSync(path, "export const a = 1;\n");
  const file: MentionRef = { kind: "file", label: "auth.ts", path };
  return { home, c, space, agent, file };
}

/** Sends one message into a new session and returns it as the adapter was handed it. */
async function handed(t: Awaited<ReturnType<typeof boot>>, params: Record<string, unknown>): Promise<UserMessage> {
  const { session } = (await t.c.call("sessions.create", { spaceId: t.space.id, agentKind: "claude" })).result;
  const before = t.agent.sent.length;
  await t.c.call("sessions.send", { id: session.id, ...params });
  await waitFor(() => t.agent.sent.length > before);
  t.c.close();
  return t.agent.sent[before]!;
}

/** Puts the `mac` skill in a home's library, and answers with its instructions' real path. */
function macSkill(home: string): string {
  mkdirSync(join(home, "skills", "mac"), { recursive: true });
  writeFileSync(join(home, "skills", "mac", "SKILL.md"), "---\nname: mac\ndescription: Drives this Mac's apps.\n---\n\n# mac\n");
  return realpathSync(join(home, "skills", "mac", "SKILL.md"));
}

const PICKED = {
  ref: 42, url: "https://example.com/login", title: "Sign in", rect: { x: 4, y: 8, w: 90, h: 32 },
  selector: "#submit", tag: "button", role: "button", name: "Sign in", text: "Sign in", html: '<button id="submit">Sign in</button>',
};

describe("the context of a message with no skill mention", () => {
  it("is the block the server appended for a mentioned file", async () => {
    const t = await boot();
    const sent = await handed(t, { text: "explain @[auth.ts] ", mentionRefs: [t.file] });
    expect(sent.context).toBe(mentionRefContext([t.file]));
  });

  it("is the tail of a text that is still the words and then everything appended", async () => {
    const t = await boot();
    const sent = await handed(t, { text: "explain @[auth.ts] ", mentionRefs: [t.file] });
    expect(sent.text).toBe(`explain @[auth.ts] ${sent.context}`);
  });

  it("holds the picked elements, the sessions pointed at and the mentioned files, in the order they are appended", async () => {
    const t = await boot();
    const other = (await t.c.call("sessions.create", { spaceId: t.space.id, agentKind: "claude" })).result.session;
    const ref = { sessionId: other.id, title: "The other one", agent: "claude" };
    const sent = await handed(t, { text: 'make @[button "Sign in"] match @[auth.ts] ', elements: [{ label: 'button "Sign in"', element: PICKED }], sessionRefs: [ref], mentionRefs: [t.file] });
    const context = sent.context ?? "";
    const pointed = sessionRefContext([ref]);
    const [elements, sessions, files] = ["\n\nElements the user picked in Realm's browser pane", pointed.slice(0, pointed.indexOf(":")), mentionRefContext([t.file])].map((part) => context.indexOf(part));
    expect({ elements, sessionsAfterElements: sessions! > elements!, filesLast: files === context.length - mentionRefContext([t.file]).length && files! > sessions! })
      .toEqual({ elements: 0, sessionsAfterElements: true, filesLast: true });
  });

  it("is absent from a message the server appended nothing to", async () => {
    const t = await boot();
    const sent = await handed(t, { text: "plain" });
    expect("context" in sent).toBe(false);
  });
});

describe("the context of a message with a skill mention", () => {
  it("ends with the note that hands the mac skill over, where the skill could not be invoked", async () => {
    const t = await boot();
    const instructions = macSkill(t.home);
    await t.c.call("skills.setEnabled", { spaceId: t.space.id, id: "mac", enabled: false });
    const sent = await handed(t, { text: "@mac read @[auth.ts] ", mentions: ["mac"], mentionRefs: [t.file] });
    expect(sent.context).toBe(mentionRefContext([t.file]) + macSkillContext(instructions));
  });

  it("is the tail of a text that is still the words without their @ and then everything appended", async () => {
    const t = await boot();
    macSkill(t.home);
    await t.c.call("skills.setEnabled", { spaceId: t.space.id, id: "mac", enabled: false });
    const sent = await handed(t, { text: "@mac read @[auth.ts] ", mentions: ["mac"], mentionRefs: [t.file] });
    expect(sent.text).toBe(`mac read @[auth.ts] ${sent.context}`);
  });

  it("is the note alone for a message that names nothing else", async () => {
    const t = await boot();
    const instructions = macSkill(t.home);
    await t.c.call("skills.setEnabled", { spaceId: t.space.id, id: "mac", enabled: false });
    const sent = await handed(t, { text: "@mac what is on today", mentions: ["mac"] });
    expect(sent.context).toBe(macSkillContext(instructions));
  });

  it("is the appended blocks without the note for a message whose skill is invoked", async () => {
    const t = await boot();
    macSkill(t.home);
    const sent = await handed(t, { text: "@mac read @[auth.ts] ", mentions: ["mac"], mentionRefs: [t.file] });
    expect({ skill: sent.skill?.id, context: sent.context }).toEqual({ skill: "mac", context: mentionRefContext([t.file]) });
  });

  it("is absent from a message that only invokes a skill", async () => {
    const t = await boot();
    macSkill(t.home);
    const sent = await handed(t, { text: "@mac what is on today", mentions: ["mac"] });
    expect("context" in sent).toBe(false);
  });
});
