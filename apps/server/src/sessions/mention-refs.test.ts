import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type McpServerConfig, type StartOptions, type UserMessage } from "@realm/adapters";
import { sessionEvent, type MentionRef, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * What a named thing in a message does once it is sent, end to end over RPC: a file reaches the
 * agent as an attachment, an app is computer use for that one session and that one app, and @mac
 * is handed over even where the skill could not be invoked. What must die: a file that is attached
 * without its chip in the text, a secret attached because it was asked for, a grant that leaks to
 * another session or another app, and a grant that outlives the server.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A real agent kind's stand-in that records what it was started with and every message it got. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  readonly sent: UserMessage[] = [];
  readonly kind = "claude" as const;
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async (m) => { this.sent.push(m); events.push(sessionEvent("assistant_text", { messageId: `m${this.sent.length}`, text: "ok" })); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number, onEvent?: (event: string, payload: Any, call: (m: string, p: unknown) => Promise<Any>) => void) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else onEvent?.(m.event, m.payload, call); });
  return { call, close: () => ws.close() };
}

async function boot(home = tempDir("realm-mention-refs-")) {
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const agent = new RecordingAdapter();
  app = await createApp({ home, port: 0, adapters: { claude: agent } });
  // Electron main's half of the computer tools: the helper's answers, scripted.
  const c = await client(app.port, (event, payload, call) => {
    if (event !== "browserHost.op") return;
    const { callId, op, params } = payload as { callId: string; op: string; params: { bundleId?: string } };
    if (op === "computerListApps") void call("browserHost.result", { callId, ok: true, result: { accessibility: true, screenRecording: true, apps: [
      { pid: 1, bundleId: "com.apple.TextEdit", name: "TextEdit", frontmost: true, hidden: false },
      { pid: 2, bundleId: "com.apple.mail", name: "Mail", frontmost: false, hidden: false }] } });
    else if (op === "computerSnapshot") void call("browserHost.result", { callId, ok: true, result: { snapshotId: "ax_1", pid: 1, bundleId: params.bundleId, appName: "TextEdit", frontmost: true, truncated: false, elements: [], text: '[0] AXButton "Save"' } });
    else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
  });
  await c.call("browserHost.register", {});
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  return { home, c, space, agent };
}

/** A session started the way anything real starts one — on its first send. */
async function started(c: Any, spaceId: string, agent: RecordingAdapter) {
  const { session } = (await c.call("sessions.create", { spaceId, agentKind: "claude" })).result;
  const before = agent.sent.length;
  await c.call("sessions.send", { id: session.id, text: "go" });
  await waitFor(() => agent.sent.length > before);
  return session;
}

/** The agent's own MCP client on this session's gateway entry, re-reading on `tools/list_changed`
 *  the way a client that honours it does. */
async function gatewayFor(agent: RecordingAdapter, startIndex: number) {
  const cfg = agent.starts[startIndex]!.mcpServers[0] as Extract<McpServerConfig, { url: string }>;
  const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  mcp.setNotificationHandler(ToolListChangedNotificationSchema, async () => { await mcp.listTools(); });
  const computerTools = async () => (await mcp.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("realm-computer__"));
  return { mcp, computerTools };
}

const textOf = (r: CallToolResult) => r.content.filter((x): x is { type: "text"; text: string } => x.type === "text").map((x) => x.text).join("\n");
const userMessages = async (c: Any, id: string) =>
  (await c.call("sessions.events", { id })).result.filter((e: Any) => e.event.type === "user_message").map((e: Any) => e.event.payload);

describe("a mentioned file", () => {
  it("reaches the agent as an attachment and a line naming its chip, and the log keeps the chip", async () => {
    const { c, space, agent, home } = await boot();
    const path = join(home, "proj", "src", "auth.ts");
    mkdirSync(join(home, "proj", "src"), { recursive: true });
    writeFileSync(path, "export const a = 1;\n");
    const session = await started(c, space.id, agent);
    const ref: MentionRef = { kind: "file", label: "auth.ts", path };
    await c.call("sessions.send", { id: session.id, text: "explain @[auth.ts] ", mentionRefs: [ref] });
    await waitFor(() => agent.sent.length === 2);
    expect(agent.sent[1]!.attachments).toEqual([{ path, mime: "text/typescript" }]);
    expect(agent.sent[1]!.text).toContain(`@[auth.ts] — ${path}`);
    // The transcript keeps what the user typed, the chip's ref beside it, and NO tile: the file is
    // already on screen as the chip.
    const sent = (await userMessages(c, session.id)).at(-1);
    expect(sent).toMatchObject({ text: "explain @[auth.ts] ", attachments: [], refs: [ref] });
    c.close();
  });

  it("is a claim the sentence has to make: a ref with no token in the text is dropped", async () => {
    const { c, space, agent, home } = await boot();
    writeFileSync(join(home, "a.md"), "x");
    const session = await started(c, space.id, agent);
    await c.call("sessions.send", { id: session.id, text: "no chip here", mentionRefs: [{ kind: "file", label: "a.md", path: join(home, "a.md") }] });
    await waitFor(() => agent.sent.length === 2);
    expect(agent.sent[1]!.attachments).toEqual([]);
    expect(agent.sent[1]!.text).toBe("no chip here");
    expect((await userMessages(c, session.id)).at(-1).refs).toBeUndefined();
    c.close();
  });

  it("never attaches a file that holds secrets, and says a missing one is missing rather than failing the turn", async () => {
    const { c, space, agent, home } = await boot();
    writeFileSync(join(home, ".env"), "TOKEN=hunter2\n");
    const session = await started(c, space.id, agent);
    await c.call("sessions.send", { id: session.id, text: "see @[.env] and @[gone.md] ", mentionRefs: [
      { kind: "file", label: ".env", path: join(home, ".env") }, { kind: "library", label: "gone.md", path: join(home, "gone.md") }] });
    await waitFor(() => agent.sent.length === 2);
    // THE asked-for-it mutant: attach whatever the request names.
    expect(agent.sent[1]!.attachments).toEqual([]);
    expect(agent.sent[1]!.text).toMatch(/@\[\.env\] — .*\.env \(not attached: Realm does not hand over files that hold secrets\)/);
    expect(agent.sent[1]!.text).toMatch(/@\[gone\.md\] — .*gone\.md \(not on disk any more, so not attached\)/);
    expect(agent.sent[1]!.text).not.toContain("hunter2");
    c.close();
  });
});

describe("a mentioned app", () => {
  const TEXTEDIT: MentionRef = { kind: "app", label: "TextEdit", name: "TextEdit", bundleId: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app" };

  it("is computer use for that session alone and that app alone, in a space that never switched it on", async () => {
    const { c, space, agent } = await boot();
    const session = await started(c, space.id, agent);
    const a = await gatewayFor(agent, 0);
    expect(await a.computerTools()).toEqual([]);

    await c.call("sessions.send", { id: session.id, text: "save it in @[TextEdit] ", mentionRefs: [TEXTEDIT] });
    await waitFor(() => agent.sent.length === 2);
    expect(agent.sent[1]!.text).toMatch(/Computer use is on for this session for these apps and no others/);
    expect(await a.computerTools()).toEqual(["realm-computer__computer_list_apps", "realm-computer__computer_snapshot", "realm-computer__computer_act", "realm-computer__computer_do"]);

    // The mentioned app is reachable; another app is refused before the helper reads it.
    const ok = await a.mcp.callTool({ name: "realm-computer__computer_snapshot", arguments: { bundleId: "com.apple.TextEdit" } }) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    const mail = await a.mcp.callTool({ name: "realm-computer__computer_snapshot", arguments: { bundleId: "com.apple.mail" } }) as CallToolResult;
    expect(textOf(mail)).toMatch(/only for the apps the user mentioned — TextEdit/);
    const listed = await a.mcp.callTool({ name: "realm-computer__computer_list_apps", arguments: {} }) as CallToolResult;
    expect(textOf(listed)).not.toContain("com.apple.mail");

    // THE leaking mutant: a grant keyed on the space. Another session there sees nothing.
    await started(c, space.id, agent);
    const b = await gatewayFor(agent, 1);
    expect(await b.computerTools()).toEqual([]);
    await a.mcp.close();
    await b.mcp.close();
    c.close();
  });

  it("is forgotten when the server stops — the session's next run has to be given it again", async () => {
    const { c, space, agent, home } = await boot();
    const session = await started(c, space.id, agent);
    await c.call("sessions.send", { id: session.id, text: "use @[TextEdit] ", mentionRefs: [TEXTEDIT] });
    await waitFor(() => agent.sent.length === 2);
    c.close();
    await app!.close();
    app = null;

    const again = await boot(home);
    await again.c.call("sessions.send", { id: session.id, text: "and again, no chip" });
    await waitFor(() => again.agent.sent.length === 1);
    const g = await gatewayFor(again.agent, 0);
    expect(await g.computerTools()).toEqual([]);
    await g.mcp.close();
    again.c.close();
  });
});

describe("@mac", () => {
  const macSkill = (home: string) => {
    mkdirSync(join(home, "skills", "mac"), { recursive: true });
    writeFileSync(join(home, "skills", "mac", "SKILL.md"), "---\nname: mac\ndescription: Drives this Mac's apps.\n---\n\n# mac\n");
  };

  it("invokes the skill natively where it is on and staged, with no note beside it", async () => {
    const home = tempDir("realm-mention-refs-");
    macSkill(home);
    const { c, space, agent } = await boot(home);
    const session = await started(c, space.id, agent);
    await c.call("sessions.send", { id: session.id, text: "@mac what is on today", mentions: ["mac"] });
    await waitFor(() => agent.sent.length === 2);
    expect(agent.sent[1]!.skill?.id).toBe("mac");
    expect(agent.sent[1]!.text).toBe("mac what is on today");
    c.close();
  });

  it("is handed over by its instructions for this session where the space switched it off — and the switch stays off", async () => {
    const home = tempDir("realm-mention-refs-");
    macSkill(home);
    const { c, space, agent } = await boot(home);
    await c.call("skills.setEnabled", { spaceId: space.id, id: "mac", enabled: false });
    const session = await started(c, space.id, agent);
    await c.call("sessions.send", { id: session.id, text: "@mac what is on today", mentions: ["mac"] });
    await waitFor(() => agent.sent.length === 2);
    expect(agent.sent[1]!.skill).toBeUndefined();
    expect(agent.sent[1]!.text).toMatch(/^mac what is on today/);
    expect(agent.sent[1]!.text).toMatch(/Read its instructions at .*skills\/mac\/SKILL\.md first/);
    expect((await c.call("skills.list", { spaceId: space.id })).result.skills.find((s: Any) => s.id === "mac").enabled).toBe(false);
    c.close();
  });
});
