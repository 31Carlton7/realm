import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent, StoredSessionEvent, TeamAccess } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * A space's Team access: one mode for every teammate in it, set by the person through
 * `teams.access.set`, carried to each teammate by `setPermissionMode`, and taken by a teammate made
 * later. Over the real app with the scripted agent.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const SCRIPT: FakeScript = [
  { on: "start the build", emit: [{ kind: "call", tool: "realm-agent__agent_start", input: { goal: "Run the build", title: "build" } }, { kind: "text", text: "Started it." }] },
  { on: "Run the build", emit: [{ kind: "tool", name: "Bash", input: { command: "pnpm build" }, needsPermission: true, result: "built" }] },
];

async function boot(home = tempDir("realm-team-access-")) {
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  return { home, spaceId: space.id, make };
}

const get = (spaceId: string) => app.rpc.call("teams.access.get", { spaceId }) as Promise<TeamAccess>;
const set = (spaceId: string, mode: string | null) => app.rpc.call("teams.access.set", { spaceId, mode }) as Promise<TeamAccess>;

const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const openCards = (sessionId: string): string[] => {
  const answered = new Set(events(sessionId).flatMap((e) => (e.type === "permission_response" ? [e.payload.requestId] : [])));
  return events(sessionId).flatMap((e) => (e.type === "permission_request" && !answered.has(e.payload.requestId) ? [e.payload.toolName] : []));
};
const answers = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "permission_response" ? [e.payload.decision] : []));
const taskOf = (homeSessionId: string, title: string) =>
  app.sessions.listAll().find((s) => !s.teammateHome && s.title.endsWith(title) && s.dispatchedBy?.sessionId === homeSessionId);

describe("teams.access.get", () => {
  it("has no space setting at first, and says whether the teammates' modes differ", async () => {
    const { spaceId, make } = await boot();
    make("CTO", { permissionMode: "default" });
    expect(await get(spaceId)).toEqual({ mode: null, mixed: false, teammates: [{ handle: "cto", mode: "default" }] });
    make("Ops", { permissionMode: "acceptEdits" });
    expect(await get(spaceId)).toEqual({ mode: null, mixed: true, teammates: [{ handle: "cto", mode: "default" }, { handle: "ops", mode: "acceptEdits" }] });
  });
});

describe("teams.access.set", () => {
  it("puts every teammate on Full access, carries it to a task waiting on a card, and answers the card", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    const ops = make("Ops", { permissionMode: "acceptEdits" });
    await app.team.message(cto.id, "start the build");
    await waitFor(() => { const t = taskOf(cto.homeSessionId!, "build"); return !!t && openCards(t.id).length === 1; }, { timeout: 10_000 });
    const task = taskOf(cto.homeSessionId!, "build")!;

    const told: { event: string; payload: unknown }[] = [];
    const broadcast = app.rpc.broadcast.bind(app.rpc);
    const spy = vi.spyOn(app.rpc, "broadcast").mockImplementation((event, payload) => { told.push({ event, payload }); broadcast(event, payload); });
    const after = await set(spaceId, "bypassPermissions");

    const all = [{ handle: "cto", mode: "bypassPermissions" }, { handle: "ops", mode: "bypassPermissions" }];
    expect(after).toEqual({ mode: "bypassPermissions", mixed: false, teammates: all });
    expect(await get(spaceId)).toEqual(after);
    expect(app.team.get(cto.id).permissionMode).toBe("bypassPermissions");
    expect(app.team.get(ops.id).permissionMode).toBe("bypassPermissions");
    expect(app.sessions.get(task.id).permissionMode).toBe("bypassPermissions");
    expect(app.sessions.get(ops.homeSessionId!).permissionMode).toBe("bypassPermissions");
    expect(openCards(task.id)).toEqual([]);
    expect(answers(task.id)).toEqual(["allow"]);
    await waitFor(() => events(task.id).some((e) => e.type === "tool_result" && e.payload.content === "built"));

    expect(told.filter((t) => t.event === "teams.access.changed").map((t) => t.payload)).toEqual([{ spaceId, mode: "bypassPermissions", teammates: all }]);
    expect(told.some((t) => t.event === "items.changed")).toBe(true);
    await waitFor(() => told.some((t) => t.event === "teammates.changed"));
    spy.mockRestore();
  }, 20_000);

  it("puts a teammate made later on the space's mode, whatever mode it was made with", async () => {
    const { spaceId, make } = await boot();
    make("CTO");
    await set(spaceId, "acceptEdits");
    const later = make("Design", { permissionMode: "default" });
    expect(later.permissionMode).toBe("acceptEdits");
    expect(app.sessions.get(later.homeSessionId!).permissionMode).toBe("acceptEdits");
    expect((await get(spaceId)).mixed).toBe(false);
  });

  it("clears with null: every teammate keeps its mode, and one made after starts on its own", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    await set(spaceId, "bypassPermissions");
    const told: { event: string; payload: unknown }[] = [];
    const broadcast = app.rpc.broadcast.bind(app.rpc);
    const spy = vi.spyOn(app.rpc, "broadcast").mockImplementation((event, payload) => { told.push({ event, payload }); broadcast(event, payload); });
    expect(await set(spaceId, null)).toEqual({ mode: null, mixed: false, teammates: [{ handle: "cto", mode: "bypassPermissions" }] });
    spy.mockRestore();
    expect(app.team.get(cto.id).permissionMode).toBe("bypassPermissions");
    expect(told.filter((t) => t.event === "teams.access.changed").map((t) => t.payload))
      .toEqual([{ spaceId, mode: null, teammates: [{ handle: "cto", mode: "bypassPermissions" }] }]);
    expect(make("Design", { permissionMode: "default" }).permissionMode).toBe("default");
  });

  it("refuses a read-only mode, and leaves the setting and the teammates as they were", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    await set(spaceId, "acceptEdits");
    await expect(set(spaceId, "plan")).rejects.toThrow();
    await expect(set(spaceId, "ask")).rejects.toThrow();
    expect((await get(spaceId)).mode).toBe("acceptEdits");
    expect(app.team.get(cto.id).permissionMode).toBe("acceptEdits");
  });

  it("is the person's on this Mac: a paired phone is refused", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    await expect(app.rpc.call("teams.access.set", { spaceId, mode: "bypassPermissions" }, { client: null, principal: "phone:abc" })).rejects.toThrow(/FORBIDDEN|only this Mac/);
    expect((await get(spaceId)).mode).toBeNull();
    expect(app.team.get(cto.id).permissionMode).toBe("default");
  });

  it("outlives a restart", async () => {
    const { home, spaceId, make } = await boot();
    make("CTO");
    await set(spaceId, "acceptEdits");
    await app.close();
    const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
    app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
    expect((await get(spaceId)).mode).toBe("acceptEdits");
  });
});

describe("a teammate edited one by one under a Team access setting", () => {
  it("keeps the space setting, and the space reads as mixed", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    make("Ops");
    await set(spaceId, "bypassPermissions");
    app.team.update({ id: cto.id, permissionMode: "default" });
    expect(await get(spaceId)).toEqual({ mode: "bypassPermissions", mixed: true, teammates: [{ handle: "cto", mode: "default" }, { handle: "ops", mode: "bypassPermissions" }] });
  });

  it("reads as mixed even when it is the only teammate, since it is off the space's mode", async () => {
    const { spaceId, make } = await boot();
    const cto = make("CTO");
    await set(spaceId, "acceptEdits");
    app.team.update({ id: cto.id, permissionMode: "default" });
    expect(await get(spaceId)).toEqual({ mode: "acceptEdits", mixed: true, teammates: [{ handle: "cto", mode: "default" }] });
  });
});

/** Every server source file, test files and this feature's two owners aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.test(-fakes)?\.ts$/.test(name) ? [p] : [];
  });
}

describe("Team access is out of an agent's reach", () => {
  it("is set from the RPC method alone: no tool provider, the phone's API or any other path calls it", () => {
    const root = join(__dirname, "..");
    const calls = (p: string) => readFileSync(p, "utf8").match(/teams\.access\.set|\.setAccess\(/g)?.length ?? 0;
    const callers = sources(root).filter((p) => calls(p) > 0).map((p) => relative(root, p));
    expect(callers.sort()).toEqual(["rpc/methods.ts", "teammates/service.ts"]);
    // The service's one call is its own write to the store, inside `setAccess`.
    expect(calls(join(root, "teammates", "service.ts"))).toBe(1);
  });

  it("is named to agents as the user's alone", () => {
    const catalog = readFileSync(join(__dirname, "..", "workspace", "catalog.ts"), "utf8");
    expect(catalog).toMatch(/Team access[^"]*the user's alone/);
  });
});
