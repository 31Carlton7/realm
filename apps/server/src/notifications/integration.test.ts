import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import type { Notification } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { EnvironmentService } from "../environments/service";
import { RpcError } from "../store/rows";
import type { PortAllocator } from "../workspace/ports";
import type { WorktreeService } from "../workspace/worktrees";
import { dbPath } from "../paths";

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

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
  return { call, events, close: () => ws.close() };
}

const fake = () => new FakeAdapter({ script: [{ on: "go", emit: [{ kind: "text", text: "ok" }, { kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] }] });

async function boot(home = tempDir("realm-notif-")) {
  app = await createApp({ home, port: 0, adapters: { fake: fake() } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  return { home, c, sp };
}

const list = async (c: { call: (m: string, p: unknown) => Promise<Any> }) =>
  (await c.call("notifications.list", {})).result as { notifications: Notification[]; nextCursor: string | null; unread: number };

describe("notifications over rpc — the real wiring", () => {
  it("permission request → pending row; answered from the session pane → the row reconciles; settle → session_done", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(async () => (await list(c)).notifications.some((n) => n.category === "permission"));

    let perm = (await list(c)).notifications.find((n) => n.category === "permission")!;
    expect(perm).toMatchObject({ sessionId: session.id, spaceId: sp.id, actedAt: null, readAt: null });
    expect(perm.refId).toBeTruthy();

    // Answer in "the session pane" (the plain RPC every surface uses).
    await c.call("sessions.respondPermission", { id: session.id, requestId: perm.refId, decision: "allow" });
    await waitFor(async () => (await list(c)).notifications.find((n) => n.category === "permission")!.actedAt !== null);
    perm = (await list(c)).notifications.find((n) => n.category === "permission")!;
    expect(perm.body).toContain("Allowed");

    // The turn settles → a session_done row, and notifications.changed broadcasts carried the count.
    await waitFor(async () => (await list(c)).notifications.some((n) => n.category === "session_done"));
    const done = (await list(c)).notifications.find((n) => n.category === "session_done")!;
    expect(done).toMatchObject({ sessionId: session.id, refId: session.id });
    expect(done.actedAt).not.toBeNull();
    const changed = c.events.filter((e) => e.event === "notifications.changed");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.at(-1)!.payload.unread).toBe((await list(c)).unread);

    // markRead all: global, and the returned count is the same one list reports.
    const marked = (await c.call("notifications.markRead", { all: true })).result;
    expect(marked.unread).toBe(0);
    expect((await list(c)).unread).toBe(0);
    c.close();
  });

  it("the feed is durable: an unanswered permission survives restart, and boot's synthetic deny resolves it", async () => {
    const { home, c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(async () => (await list(c)).notifications.some((n) => n.category === "permission" && n.actedAt === null));
    c.close();
    await app!.close(); app = null;

    app = await createApp({ home, port: 0, adapters: { fake: fake() } });
    const c2 = await client(app.port);
    const rows = (await list(c2)).notifications;
    const perm = rows.find((n) => n.category === "permission")!;
    expect(perm).toBeTruthy(); // survived the restart — server-side rows, not renderer memory
    expect(perm.actedAt).not.toBeNull(); // markStaleOnBoot's deny reconciled it
    expect(perm.body).toContain("Denied");
    c2.close();
  });

  it("agents.probe regressions ride the same probe the install card uses (no second poll)", async () => {
    const { home, c } = await boot();
    await c.call("agents.probe", { force: true }); // seeds the durable baseline: fake is available
    c.close();
    await app!.close(); app = null;

    // Reboot with a probe that fails — the same CLI "vanishing" between runs.
    const broken = new FakeAdapter({ script: [] });
    broken.probe = async () => ({ kind: "fake", available: false, version: null, loggedIn: null, reason: "gone" });
    app = await createApp({ home, port: 0, adapters: { fake: broken } });
    const c2 = await client(app.port);
    await c2.call("agents.probe", { force: true });
    const rows = (await list(c2)).notifications;
    expect(rows.some((n) => n.category === "agent_probe" && n.refId === "fake" && n.actedAt === null)).toBe(true);
    c2.close();
  });

  it("a disabled category writes no rows end to end", async () => {
    const { c, sp } = await boot();
    await c.call("settings.set", { key: "notifications.disabledCategories", value: ["permission", "session_done"] });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    // Wait for the request to actually be raised, then answer and settle.
    await waitFor(() => c.events.some((e) => e.event === "session.event" && e.payload.event.type === "permission_request"));
    const req = c.events.find((e) => e.event === "session.event" && e.payload.event.type === "permission_request")!.payload.event.payload.requestId;
    await c.call("sessions.respondPermission", { id: session.id, requestId: req, decision: "allow" });
    await waitFor(() => c.events.some((e) => e.event === "session.status" && e.payload.status === "idle"));
    expect((await list(c)).notifications).toHaveLength(0);
    c.close();
  });
});

describe("the stale-ack hook (EnvironmentService.removeWorktree)", () => {
  it("a PRESENT-but-stale acknowledgement writes a worktree_hazard row; the ask-first null ack does not", async () => {
    const home = tempDir("realm-notifenv-");
    const db = openDatabase(dbPath(home));
    const profiles = new ProfilesStore(db);
    const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "user", color: "#000000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "folder" });
    const environments = new EnvironmentsStore(db);
    const env = environments.create({ spaceId: sp.id, path: join(home, "worktrees", sp.id, "x"), kind: "worktree", branch: "realm/x" });
    const hazards: { environmentId: string; title: string }[] = [];
    const svc = new EnvironmentService({
      environments, spaces,
      worktrees: { remove: async () => { throw new RpcError("WORKTREE_UNSAFE", "2 changed files"); } } as unknown as WorktreeService,
      ports: { ensureBlock: async () => null } as unknown as PortAllocator,
      notifications: { worktreeHazard: (i) => hazards.push(i) },
    });
    // Null ack (the ask-first flow): refused, but NOT a hazard event.
    await expect(svc.removeWorktree(env.id, null)).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(hazards).toHaveLength(0);
    // A stale ack: the user said yes to numbers the tree moved past — that IS the hazard.
    await expect(svc.removeWorktree(env.id, { dirtyFiles: 1, unpushedCommits: 0 })).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(hazards).toEqual([{ spaceId: sp.id, environmentId: env.id, title: "Worktree removal refused", body: "2 changed files" }]);
    db.close();
  });
});
