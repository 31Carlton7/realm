import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type MemoryExtractionInput } from "@realm/adapters";
import { sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import type { MemorySink, SpaceFolder } from "./sink";

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** An engine under a real kind that answers every message and settles, the way a turn ends. */
class AnsweringAdapter implements AgentAdapter {
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("status", { status: "idle" }));
    let n = 0;
    return {
      events,
      send: async () => {
        events.push(sessionEvent("status", { status: "running" }));
        events.push(sessionEvent("assistant_text", { messageId: `m${++n}`, text: `answer ${n}` }));
        events.push(sessionEvent("status", { status: "idle" }));
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
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call };
}

/**
 * The whole path with no billed call: a real app, real sessions on a real kind, the settle and the
 * archive arriving through the session rail and `items.update` — and a fake model function handed in
 * through the same `createApp` seam the titler uses, with a sink standing in for the repo's helpers.
 */
async function boot() {
  const home = tempDir("realm-learn-int-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const repoPath = join(home, "profile-repo");
  // The profile's id is known only once it is made below; the sink reads it when it is asked.
  let profileId = "";
  const place = (): SpaceFolder => ({ owner: { scope: "profile", id: profileId }, repoPath, folder: "work", dir: join(repoPath, "spaces", "work") });
  mkdirSync(place().dir, { recursive: true });
  writeFileSync(join(repoPath, "MEMORY.md"), "# Memory\n\n## Index\n");
  const saved: { spaceId: string; name: string; sessionId?: string; author?: string }[] = [];
  const ok = { changed: true, file: "x.md", line: null, sha: "abc", diff: "" };
  const sink: MemorySink = {
    spaceFolderFor: () => place(),
    writeBatch: async () => ok,
    saveSpaceMemory: async (spaceId, m) => { saved.push({ spaceId, name: m.name, sessionId: m.sessionId, author: m.author }); return ok; },
    edit: async () => ok,
  };
  const extract = vi.fn(async (_input: MemoryExtractionInput) => JSON.stringify({ memories: [
    { scope: "space", type: "project", name: "billing-owner", description: "Who owns billing", body: "Dana owns billing." },
  ] }));
  const tidy = vi.fn(async () => JSON.stringify({ operations: [] }));
  app = await createApp({
    home, port: 0, adapters: { claude: new AnsweringAdapter("claude"), fake: new AnsweringAdapter("fake") },
    memoryLearning: { extract, tidy, sink, idleMs: 40 },
  });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  profileId = profile.id;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "Work" })).result;
  const start = async (agentKind: AgentKind) => (await c.call("sessions.create", { spaceId: space.id, agentKind })).result as { session: { id: string }; itemId: string };
  const say = async (id: string, text: string) => {
    await c.call("sessions.send", { id, text });
    await waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");
  };
  return { c, profile, space, start, say, extract, tidy, saved };
}

describe("memory learning, end to end with a fake model", () => {
  it("reads a session once it goes quiet after two turns of the person's, and saves what the model found", async () => {
    const t = await boot();
    const { session } = await t.start("claude");
    await t.say(session.id, "Dana owns billing");
    // One turn: the quiet spell passes and nothing is read.
    await new Promise((r) => setTimeout(r, 150));
    expect(t.extract).not.toHaveBeenCalled();
    await t.say(session.id, "and invoices go out on the 1st");
    await waitFor(() => t.saved.length === 1);
    expect(t.extract).toHaveBeenCalledTimes(1);
    expect(t.extract.mock.calls[0]![0].transcript).toBe("User: Dana owns billing\nAssistant: answer 1\nUser: and invoices go out on the 1st\nAssistant: answer 2");
    expect(t.extract.mock.calls[0]![0].known[0]!.index).toBe("# Memory\n\n## Index\n");
    expect(t.saved).toEqual([{ spaceId: t.space.id, name: "billing-owner", sessionId: session.id, author: "Realm" }]);
    // The save reached the tidy pass, which — meeting this profile for the first time — only started its clock.
    await waitFor(async () => typeof (await t.c.call("settings.get", { key: `memory.tidiedAt:${t.profile.id}` })).result.value === "number");
    expect(t.tidy).not.toHaveBeenCalled();
  });

  it("reads a session the moment it is archived, even after a single turn", async () => {
    const t = await boot();
    const { session, itemId } = await t.start("claude");
    await t.say(session.id, "Dana owns billing");
    await t.c.call("items.update", { id: itemId, archived: true });
    await waitFor(() => t.saved.length === 1);
    expect(t.extract).toHaveBeenCalledTimes(1);
  });

  it("never reads a scripted-agent session, quiet or archived", async () => {
    const t = await boot();
    const { session, itemId } = await t.start("fake");
    await t.say(session.id, "Dana owns billing");
    await t.say(session.id, "and invoices go out on the 1st");
    await t.c.call("items.update", { id: itemId, archived: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.extract).not.toHaveBeenCalled();
    expect(t.saved).toEqual([]);
  });
});
