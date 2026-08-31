import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../app";
import { TerminalsStore } from "../store/terminals";
import { waitFor } from "../test-utils";

const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close().catch(() => {}); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => ws.close() };
}

describe("TerminalService.restoreAll", () => {
  it("respawns ptys for persisted terminal rows on boot; prunes rows whose cwd is gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c1 = await client(app1.port);
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { terminalId, itemId } = (await c1.call("terminals.create", { spaceId: space.id })).result;
    // A row pointing at a directory that no longer exists (e.g. the user deleted the folder).
    new TerminalsStore(app1.db).insert({ id: "bogus-cwd", spaceId: space.id, cwd: join(home, "does-not-exist"), shell: process.env.SHELL ?? "/bin/zsh" });
    c1.close();
    await app1.close(); // shutdown keeps rows + items

    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    expect(app2.terminals.has(terminalId)).toBe(true);
    expect(app2.terminals.has("bogus-cwd")).toBe(false);
    expect(new TerminalsStore(app2.db).get("bogus-cwd")).toBeNull();
    expect(new TerminalsStore(app2.db).get(terminalId)).not.toBeNull();
    const c2 = await client(app2.port);
    expect((await c2.call("items.list", { spaceId: space.id })).result.map((i: any) => i.id)).toEqual([itemId]);
    const w = await c2.call("terminals.write", { terminalId, data: "echo REALM_RESTORED\n" });
    expect(w.ok).toBe(true);
    await waitFor(() => c2.events.some((e) => e.event === "terminal.data" && e.payload.terminalId === terminalId && String(e.payload.data).includes("REALM_RESTORED")));
    c2.close();
  });
});

/**
 * The port block (Plan 7 W2) has to reach a real shell, not merely a row — so these assert on what
 * `echo $REALM_PORT_BASE` prints inside the pty.
 */
describe("terminal port blocks", () => {
  const echoed = (c: { events: any[] }, terminalId: string) =>
    c.events.filter((e) => e.event === "terminal.data" && e.payload.terminalId === terminalId).map((e) => String(e.payload.data)).join("");

  it("exports the environment's port block into the shell, and keeps it across a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c1 = await client(app1.port);
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { terminalId } = (await c1.call("terminals.create", { spaceId: space.id })).result;

    const block = (app1.db.prepare("SELECT port_block_start AS s FROM environments WHERE space_id = ?").get(space.id) as { s: number }).s;
    expect(block).toBeGreaterThan(0);
    await c1.call("terminals.write", { terminalId, data: "echo BASE=$REALM_PORT_BASE PORT=$PORT END=$REALM_PORT_END\n" });
    await waitFor(() => echoed(c1, terminalId).includes(`BASE=${block} PORT=${block} END=${block + 9}`));
    c1.close();
    await app1.close();

    // MUTANT: reallocate on restore, or drop the env off restoreAll, and the shell comes back bare.
    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    const c2 = await client(app2.port);
    await c2.call("terminals.write", { terminalId, data: "echo AGAIN=$REALM_PORT_BASE\n" });
    await waitFor(() => echoed(c2, terminalId).includes(`AGAIN=${block}`));
    c2.close();
  });

  it("gives two spaces' terminals different blocks", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c = await client(app1.port);
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    const a = (await c.call("spaces.create", { profileId: prof.id, name: "A" })).result;
    const b = (await c.call("spaces.create", { profileId: prof.id, name: "B" })).result;
    await c.call("terminals.create", { spaceId: a.id });
    await c.call("terminals.create", { spaceId: b.id });
    const blocks = (app1.db.prepare("SELECT port_block_start AS s FROM environments WHERE port_block_start IS NOT NULL").all() as { s: number }[]).map((r) => r.s);
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks).size).toBe(2);
    c.close();
  });
});
