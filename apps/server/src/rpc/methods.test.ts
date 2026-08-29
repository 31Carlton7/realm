import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "realm-home-"));
  app = await createApp({ home, port: 0 });
  const c = await client(app.port);
  return { home, c };
}

describe("rpc methods", () => {
  it("full flow: profile → space → item → layout, with change events", async () => {
    const { home, c } = await boot();
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    expect(prof.icon).toBe("user");
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    expect(space.folderPath).toContain("versed");
    const item = (await c.call("items.create", { spaceId: space.id, kind: "terminal", title: "zsh", refId: space.id })).result;
    const layout = { type: "leaf", id: "L1", itemId: item.id };
    const updated = (await c.call("spaces.setLayout", { id: space.id, layout })).result;
    expect(updated.layout).toEqual(layout);
    const listed = (await c.call("spaces.list", {})).result;
    expect(listed).toHaveLength(1);
    expect(listed[0].layout).toEqual(layout); // survives the SQLite round-trip unchanged
    // Legacy pre-Plan-4 leaf shape migrates on parse: the server stores and returns the one-item form.
    const legacy = { type: "leaf", id: "L2", tabs: [item.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"], activeTab: item.id };
    const migrated = (await c.call("spaces.setLayout", { id: space.id, layout: legacy })).result;
    expect(migrated.layout).toEqual({ type: "leaf", id: "L2", itemId: item.id });
    expect((await c.call("spaces.list", {})).result[0].layout).toEqual({ type: "leaf", id: "L2", itemId: item.id });
    await waitFor(() => ["profiles.changed", "spaces.changed", "items.changed"].every((e) => c.events.some((x) => x.event === e)));
    const info = (await c.call("system.info", {})).result;
    expect(info.realmHome).toBe(home);
    c.close();
  });

  it("items.listAll spans spaces, newest-updated first", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const s1 = (await c.call("spaces.create", { profileId: prof.id, name: "One" })).result;
    const s2 = (await c.call("spaces.create", { profileId: prof.id, name: "Two" })).result;
    const a = (await c.call("items.create", { spaceId: s1.id, kind: "terminal", title: "a", refId: s1.id })).result;
    const b = (await c.call("items.create", { spaceId: s2.id, kind: "terminal", title: "b", refId: s2.id })).result;
    await new Promise((r) => setTimeout(r, 5)); // updated_at has ms resolution
    await c.call("items.update", { id: a.id, title: "a2" }); // touch a: it becomes the newest
    const all = (await c.call("items.listAll", {})).result;
    expect(all.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    expect(all.map((i: { spaceId: string }) => i.spaceId)).toEqual([s1.id, s2.id]);
    c.close();
  });

  it("returns NOT_FOUND for items.create with a bogus spaceId", async () => {
    const { c } = await boot();
    const r = await c.call("items.create", { spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "terminal", title: "t", refId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("terminals.create makes an item titled after its cwd basename and streams data events", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(itemId).toBeTruthy();
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items.map((i: any) => i.id)).toEqual([itemId]);
    expect(items[0].refId).toBe(terminalId);
    // Auto-title (U-M1): the cwd basename, not a generic "Terminal".
    expect(items[0].title).toBe(space.folderPath.split("/").pop());
    expect(items[0].title).not.toBe("Terminal");
    await c.call("terminals.write", { terminalId, data: "echo REALM_RPC_OK\n" });
    const termData = () => c.events.filter((e) => e.event === "terminal.data").map((e) => e.payload.data).join("");
    await waitFor(() => termData().includes("REALM_RPC_OK"));
    await c.call("terminals.close", { terminalId });
    c.close();
  });

  it("workspace.gitInfo answers over rpc: null for a non-repo cwd, INVALID_PARAMS for a relative one", async () => {
    const { home, c } = await boot();
    // `home` is a fresh temp dir — a real absolute path that is not a git repo.
    expect((await c.call("workspace.gitInfo", { cwd: home })).result).toBeNull();
    const bad = await c.call("workspace.gitInfo", { cwd: "not/absolute" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("INVALID_PARAMS");
    c.close();
  });

  it("closing a terminal removes its item and pty", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(app.terminals.has(terminalId)).toBe(true);
    const r = await c.call("terminals.close", { terminalId });
    expect(r.ok).toBe(true);
    expect(app.terminals.has(terminalId)).toBe(false);
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items.map((i: any) => i.id)).not.toContain(itemId);
    // second close → NOT_FOUND
    expect((await c.call("terminals.close", { terminalId })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("items.delete on a terminal item closes the pty", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect((await c.call("items.delete", { id: itemId })).ok).toBe(true);
    expect(app.terminals.has(terminalId)).toBe(false);
    expect((await c.call("items.list", { spaceId: space.id })).result).toEqual([]);
    c.close();
  });

  it("deleting a space closes its terminals", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const a = (await c.call("terminals.create", { spaceId: space.id })).result;
    const b = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(app.terminals.has(a.terminalId)).toBe(true);
    expect((await c.call("spaces.delete", { id: space.id })).ok).toBe(true);
    expect(app.terminals.has(a.terminalId)).toBe(false);
    expect(app.terminals.has(b.terminalId)).toBe(false);
    expect((await c.call("spaces.list", {})).result).toEqual([]);
    c.close();
  });

  it("when the shell exits on its own the item survives (UI shows exited) and terminal.exit is broadcast", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    await c.call("terminals.write", { terminalId, data: "exit\n" });
    await waitFor(() => c.events.some((e) => e.event === "terminal.exit" && e.payload.terminalId === terminalId));
    expect(app.terminals.has(terminalId)).toBe(false);
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items.map((i: any) => i.id)).toContain(itemId);
    // closing after exit still cleans up the item
    expect((await c.call("terminals.close", { terminalId })).ok).toBe(true);
    expect((await c.call("items.list", { spaceId: space.id })).result).toEqual([]);
    c.close();
  });
  it("spaces.list is global and spaces.reorder + settings work over rpc", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-")); app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const p1 = (await c.call("profiles.create", { name: "Work" })).result;
    const p2 = (await c.call("profiles.create", { name: "School" })).result;
    const a = (await c.call("spaces.create", { profileId: p1.id, name: "A" })).result;
    const b = (await c.call("spaces.create", { profileId: p2.id, name: "B" })).result;
    expect((await c.call("spaces.list", {})).result.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
    await c.call("spaces.reorder", { ids: [b.id, a.id] });
    expect((await c.call("spaces.list", {})).result.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    await c.call("settings.set", { key: "ui.activeSpaceId", value: b.id });
    expect((await c.call("settings.get", { key: "ui.activeSpaceId" })).result).toEqual({ value: b.id });
    await c.call("settings.set", { key: "ui.activeSpaceId" });
    expect((await c.call("settings.get", { key: "ui.activeSpaceId" })).result).toEqual({ value: null });
    expect((await c.call("spaces.update", { id: a.id, color: "red" })).ok).toBe(false);
    c.close();
  });
});

/** Plan 7 W2 over the wire: the contract shapes, the broadcast, and the sessions.create seam. */
describe("environments over rpc", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

  async function bootRepoSpace() {
    const { home, c } = await boot();
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    git(space.folderPath, "init", "-b", "main");
    writeFileSync(join(space.folderPath, "a.txt"), "one\n");
    git(space.folderPath, "add", "."); git(space.folderPath, "commit", "-m", "init");
    return { home, c, space };
  }

  it("creates a worktree, lists it, and broadcasts environments.changed", async () => {
    const { c, space } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: space.id, title: "Fix login" })).result;
    expect(env).toMatchObject({ kind: "worktree", branch: "realm/fix-login", spaceId: space.id });
    expect(env.portBlockStart).toBeGreaterThan(0);
    expect(existsSync(env.path)).toBe(true);
    await waitFor(() => c.events.some((e) => e.event === "environments.changed" && e.payload.spaceId === space.id));
    const listed = (await c.call("environments.list", { spaceId: space.id })).result;
    expect(listed.map((e: any) => e.kind).sort()).toEqual(["primary", "worktree"]);
    c.close();
  });

  it("runs a session in the worktree when sessions.create names it", async () => {
    const { c, space } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: space.id, title: "wt" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "claude", environmentId: env.id })).result;
    expect(session.environmentId).toBe(env.id);
    expect(session.cwd).toBe(env.path);           // cwd is derived from the environment (W1)
    expect(session.cwd).not.toBe(space.folderPath);
    c.close();
  });

  it("reports the hazard, refuses without a matching acknowledgement, then removes", async () => {
    const { c, space } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: space.id, title: "risk" })).result;
    writeFileSync(join(env.path, "work.txt"), "hours\n");

    const st = (await c.call("environments.worktreeStatus", { id: env.id })).result;
    expect(st).toMatchObject({ environmentId: env.id, branch: "realm/risk", present: true, dirtyFiles: 1, unpushedCommits: 1, removable: true, blockedBy: null });

    const refused = await c.call("environments.removeWorktree", { id: env.id });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("WORKTREE_UNSAFE");
    expect(existsSync(env.path)).toBe(true);

    const wrong = await c.call("environments.removeWorktree", { id: env.id, acknowledge: { dirtyFiles: 0, unpushedCommits: 0 } });
    expect(wrong.error.code).toBe("WORKTREE_UNSAFE");
    expect(existsSync(env.path)).toBe(true);

    const ok = await c.call("environments.removeWorktree", { id: env.id, acknowledge: { dirtyFiles: st.dirtyFiles, unpushedCommits: st.unpushedCommits } });
    expect(ok.ok).toBe(true);
    expect(existsSync(env.path)).toBe(false);
    expect((await c.call("environments.list", { spaceId: space.id })).result.map((e: any) => e.kind)).toEqual(["primary"]);
    c.close();
  });

  // MUTANT: removal reachable for `primary`, over the wire this time.
  it("refuses to remove a space's own checkout however it is asked", async () => {
    const { c, space } = await bootRepoSpace();
    // The primary environment is created lazily, on the first thing that needs a cwd.
    await c.call("sessions.create", { spaceId: space.id, agentKind: "claude" });
    const primary = (await c.call("environments.list", { spaceId: space.id })).result.find((e: any) => e.kind === "primary");
    expect(primary).toBeDefined();
    for (const acknowledge of [null, { dirtyFiles: 0, unpushedCommits: 0 }, { dirtyFiles: 99, unpushedCommits: 99 }]) {
      const r = await c.call("environments.removeWorktree", { id: primary.id, acknowledge });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("ENVIRONMENT_PRIMARY");
    }
    expect(existsSync(join(space.folderPath, "a.txt"))).toBe(true);
    expect(git(space.folderPath, "branch", "--list", "main").trim()).not.toBe("");
    c.close();
  });

  it("environments.delete will not forget a worktree row and strand its directory", async () => {
    const { c, space } = await bootRepoSpace();
    const env = (await c.call("environments.createWorktree", { spaceId: space.id, title: "kept" })).result;
    const r = await c.call("environments.delete", { id: env.id });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("ENVIRONMENT_IS_WORKTREE");
    expect(existsSync(env.path)).toBe(true);
    // Still reachable through the operation that takes the directory with it.
    expect((await c.call("environments.removeWorktree", { id: env.id, acknowledge: { dirtyFiles: 0, unpushedCommits: 1 } })).ok).toBe(true);
    expect(existsSync(env.path)).toBe(false);
    c.close();
  });

  it("refuses a worktree in a space folder that is not a repository", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    const plain = (await c.call("spaces.create", { profileId: prof.id, name: "Notes" })).result;
    const r = await c.call("environments.createWorktree", { spaceId: plain.id, title: "x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_A_REPOSITORY");
    // The space itself still works: a plain directory is a normal Realm space.
    expect((await c.call("sessions.create", { spaceId: plain.id, agentKind: "claude" })).result.session.cwd).toBe(plain.folderPath);
    c.close();
  });
});
