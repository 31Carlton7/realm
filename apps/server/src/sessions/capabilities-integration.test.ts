import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * The capabilities preamble, end to end: a session started through the ordinary path (create, then
 * send) must arrive at its adapter already knowing what Realm's own tools are for, and must be told
 * about exactly the ones its space actually has.
 *
 * The unit-level rules live in `mcp/capabilities.test.ts` (which block appears for which provider)
 * and `mcp/gateway.test.ts` (which providers a session really sees). What is only provable here is
 * that the two are wired together and that the result reaches `StartOptions.systemContext` — the
 * seam where a preamble composed perfectly and then dropped looks identical to no preamble at all.
 */

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Records the StartOptions its sessions are started with — the one seam this file reads. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: `prov_${this.starts.length}`, model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("status", { status: "idle" })); },
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
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-caps-int-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const claude = new RecordingAdapter("claude");
  const cursor = new RecordingAdapter("acp:cursor");
  app = await createApp({ home, port: 0, adapters: { claude, "acp:cursor": cursor }, claudeDir: join(home, "claude-home") });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: p.id, name: "A" })).result;
  return { c, space, claude, cursor };
}

/** Starts the session's adapter the way anything real does — on the first send. */
async function startSession(c: Any, spaceId: string, agentKind: string) {
  const { session } = (await c.call("sessions.create", { spaceId, agentKind })).result;
  await c.call("sessions.send", { id: session.id, text: "go" });
  return session;
}

describe("the capabilities preamble reaches an ordinary session", () => {
  it("names the delegation, browser and document tools the space has — before the agent has asked", async () => {
    const { c, space, claude } = await boot();
    await startSession(c, space.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    const ctx = claude.starts[0]!.systemContext!;
    // THE MUTANT: drop the capabilitiesContext call from ensureLive. Everything still passes except
    // this: the agent goes back to discovering these tools only if it reads the tool list closely.
    expect(ctx).toContain("agent_run");
    expect(ctx).toContain("browser_open");
    expect(ctx).toContain("docs_search");
    // The Mac-app provider is opt-in and this space never opted in, so it must stay unmentioned.
    expect(ctx).not.toContain("computer_act");
    c.close();
  });

  it("stops naming the browser once the space switches that provider off", async () => {
    const { c, space, claude } = await boot();
    await c.call("mcp.setProviderEnabled", { spaceId: space.id, name: "realm-browser", enabled: false });
    await startSession(c, space.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    const ctx = claude.starts[0]!.systemContext!;
    expect(ctx).not.toContain("browser_open");
    // Still the same session's preamble, not an empty one — the switch is per provider, not a mute.
    expect(ctx).toContain("agent_run");
    c.close();
  });

  it("hands Cursor nothing, because Cursor takes no per-session context at all", async () => {
    const { c, space, cursor } = await boot();
    await startSession(c, space.id, "acp:cursor");
    await waitFor(() => cursor.starts.length === 1);
    // THE MUTANT: compose the preamble for every kind. It would be silently dropped by the adapter,
    // and Realm's memory pane — which reports Cursor as receiving nothing — would become a lie.
    expect(cursor.starts[0]!.systemContext).toBeUndefined();
    c.close();
  });
});
