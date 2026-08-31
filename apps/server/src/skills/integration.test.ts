import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Stands in for a real adapter under a real agent kind, and records the StartOptions it was handed. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: "claude" | "acp:cursor") {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("assistant_text", { messageId: "m1", text: "ok" })); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

const skill = (dir: string, id: string) => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "SKILL.md"), `---\nname: ${id}\ndescription: does ${id}.\n---\n\n# ${id}\n`);
};

/** A home with no bundled install, so each test's library is exactly what it wrote. */
async function boot(opts: { bundled?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "realm-skills-int-"));
  vi.stubEnv("REALM_BUNDLED_SKILLS", opts.bundled ?? join(home, "no-bundle"));
  const claude = new RecordingAdapter("claude");
  const cursor = new RecordingAdapter("acp:cursor");
  app = await createApp({ home, port: 0, adapters: { claude, "acp:cursor": cursor } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  return { home, c, sp, claude, cursor };
}

/** Starts the session's adapter the way anything real does — on the first send. */
async function startSession(c: Any, spaceId: string, agentKind: string) {
  const { session } = (await c.call("sessions.create", { spaceId, agentKind })).result;
  await c.call("sessions.send", { id: session.id, text: "go" });
  return session;
}

describe("skills over rpc", () => {
  it("lists the library per space and toggles one skill, broadcasting the change", async () => {
    const { c, sp, home } = await boot();
    skill(join(home, "skills"), "mac");
    skill(join(home, "skills"), "notes");
    const listed = (await c.call("skills.list", { spaceId: sp.id })).result;
    expect(listed.root).toBe(join(home, "skills"));
    expect(listed.skills.map((s: Any) => [s.id, s.enabled])).toEqual([["mac", true], ["notes", true]]);

    expect((await c.call("skills.setEnabled", { spaceId: sp.id, id: "notes", enabled: false })).result).toEqual({ ok: true });
    await waitFor(() => c.events.some((e: Any) => e.event === "skills.changed" && e.payload.spaceId === sp.id));
    expect((await c.call("skills.list", { spaceId: sp.id })).result.skills.map((s: Any) => [s.id, s.enabled]))
      .toEqual([["mac", true], ["notes", false]]);
    c.close();
  });

  it("refuses a space that does not exist rather than reading preferences for a typo", async () => {
    const { c } = await boot();
    const gone = newId(); // well-formed, just not a space: the preferences are keyed by this id
    expect((await c.call("skills.list", { spaceId: gone })).error.code).toBe("NOT_FOUND");
    expect((await c.call("skills.setEnabled", { spaceId: gone, id: "mac", enabled: false })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("hands the staged skills root to the adapter when the session starts", async () => {
    const { c, sp, home, claude } = await boot();
    skill(join(home, "skills"), "mac");
    await startSession(c, sp.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    const injected = claude.starts[0]!.skills!;
    expect(injected).toBeTruthy();
    expect(injected.root).toBe(join(injected.pluginPath, "skills"));
    expect(readdirSync(injected.root)).toEqual(["mac"]);
    c.close();
  });

  it("does not hand over a skill this space has disabled", async () => {
    const { c, sp, home, claude } = await boot();
    skill(join(home, "skills"), "mac");
    skill(join(home, "skills"), "notes");
    await c.call("skills.setEnabled", { spaceId: sp.id, id: "notes", enabled: false });
    await startSession(c, sp.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    expect(readdirSync(claude.starts[0]!.skills!.root)).toEqual(["mac"]);
    c.close();
  });

  it("hands over nothing at all when the space has no skills", async () => {
    const { c, sp, claude } = await boot();
    await startSession(c, sp.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    expect(claude.starts[0]!.skills).toBeUndefined();
    c.close();
  });

  it("hands over nothing to an agent Realm cannot inject skills into", async () => {
    const { c, sp, home, cursor } = await boot();
    skill(join(home, "skills"), "mac");
    await startSession(c, sp.id, "acp:cursor");
    await waitFor(() => cursor.starts.length === 1);
    expect(cursor.starts[0]!.skills).toBeUndefined();
    c.close();
  });

  it("survives a malformed SKILL.md: the session starts and the good skills still go over", async () => {
    const { c, sp, home, claude } = await boot();
    skill(join(home, "skills"), "mac");
    mkdirSync(join(home, "skills", "broken"), { recursive: true });
    writeFileSync(join(home, "skills", "broken", "SKILL.md"), "no frontmatter here");
    const session = await startSession(c, sp.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    expect(readdirSync(claude.starts[0]!.skills!.root)).toEqual(["mac"]);
    expect((await c.call("sessions.get", { id: session.id })).result.status).toBe("idle");
    expect((await c.call("skills.list", { spaceId: sp.id })).result.skills.find((s: Any) => s.id === "broken"))
      .toMatchObject({ valid: false });
    c.close();
  });

  it("installs the bundled skills into the library once, on boot", async () => {
    const bundled = mkdtempSync(join(tmpdir(), "realm-skills-bundle-"));
    skill(bundled, "mac");
    const { c, sp, home } = await boot({ bundled });
    expect(readdirSync(join(home, "skills"))).toEqual(["mac"]);
    expect((await c.call("skills.list", { spaceId: sp.id })).result.skills.map((s: Any) => s.id)).toEqual(["mac"]);
    c.close();
  });
});
