import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { TerminalHistoryStore, TerminalsStore } from "../store/terminals";
import { TERMINALS_HISTORY_KEY } from "@realm/contracts";
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
    const home = tempDir("realm-home-");
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
    const home = tempDir("realm-home-");
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
    const home = tempDir("realm-home-");
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

  /** Output from every `terminal.data` frame this client saw, and the cursor to resume from. */
  const streamed = (c: { events: any[] }, terminalId: string) => {
    const frames = c.events.filter((e) => e.event === "terminal.data" && e.payload.terminalId === terminalId);
    return { text: frames.map((e) => String(e.payload.data)).join(""), last: frames.at(-1)?.payload as { runId: string; seq: number } | undefined };
  };

  it("with history on, a terminal comes back with what it printed before the restart", async () => {
    const home = tempDir("realm-home-");
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c1 = await client(app1.port);
    await c1.call("settings.set", { key: TERMINALS_HISTORY_KEY, value: true });
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { terminalId } = (await c1.call("terminals.create", { spaceId: space.id, cols: 132, rows: 44 })).result;
    await c1.call("terminals.write", { terminalId, data: "echo SCROLLBACK_MARKER_9F2\n" });
    await waitFor(() => streamed(c1, terminalId).text.includes("SCROLLBACK_MARKER_9F2"));
    c1.close();
    await app1.close(); // closeAll flushes synchronously, so a clean quit loses nothing

    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    const c2 = await client(app2.port);
    const read = (await c2.call("terminals.read", { terminalId, cursor: null })).result;
    // MUTANT: drop the synchronous flush in closeAll, or read `terminals` instead of
    // `terminal_history`, and the marker is nowhere.
    expect(read.history.data).toContain("SCROLLBACK_MARKER_9F2");
    // It is HISTORY, not live: the shell that printed it is gone, and the pane draws a seam there.
    expect(read.live).not.toContain("SCROLLBACK_MARKER_9F2");
    expect(read.running).toBe(true);
    // Respawned at the size the output was printed at, not the old hardcoded 80x24.
    expect(read.history.cols).toBe(132);
    c2.close();
  });

  it("with history off, nothing reaches the disk — and turning it off purges what was kept", async () => {
    const home = tempDir("realm-home-");
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { terminalId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    await c.call("terminals.write", { terminalId, data: "echo OFF_MARKER\n" });
    await waitFor(() => streamed(c, terminalId).text.includes("OFF_MARKER"));

    const history = new TerminalHistoryStore(app.db);
    app.terminals.flushHistory();
    // Default is off, and off means nothing is written.
    expect(history.count()).toBe(0);
    // …but the in-memory buffer is always on, because it holds bytes already broadcast and is what
    // makes a reattach after a dropped socket show what arrived meanwhile.
    expect((await c.call("terminals.read", { terminalId, cursor: null })).result.live).toContain("OFF_MARKER");

    await c.call("settings.set", { key: TERMINALS_HISTORY_KEY, value: true });
    app.terminals.flushHistory();
    expect(history.count()).toBe(1);
    // MUTANT: make settings.set a plain write and the purge never happens — a switch that leaves
    // yesterday's terminal output on disk is not an off switch.
    await c.call("settings.set", { key: TERMINALS_HISTORY_KEY, value: false });
    expect(history.count()).toBe(0);
    c.close();
  });

  it("a reattaching client gets exactly what it missed, with no gap in seq", async () => {
    const home = tempDir("realm-home-");
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c1 = await client(app.port);
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { terminalId } = (await c1.call("terminals.create", { spaceId: space.id })).result;
    await c1.call("terminals.write", { terminalId, data: "echo BEFORE_DROP\n" });
    await waitFor(() => streamed(c1, terminalId).text.includes("BEFORE_DROP"));
    const cursor = streamed(c1, terminalId).last!;
    c1.close();

    // Output arrives with nobody listening — the ordinary case once the server outlives the app.
    const c2 = await client(app.port);
    await c2.call("terminals.write", { terminalId, data: "echo WHILE_AWAY\n" });
    await waitFor(() => streamed(c2, terminalId).text.includes("WHILE_AWAY"));

    const caught = (await c2.call("terminals.read", { terminalId, cursor })).result;
    expect(caught.runId).toBe(cursor.runId);
    expect(caught.truncated).toBe(false);
    expect(caught.live).toContain("WHILE_AWAY");
    // MUTANT: ignore the cursor and return the whole ring, and the pane draws its own scrollback a
    // second time on every reconnect.
    expect(caught.live).not.toContain("BEFORE_DROP");
    // Nothing before the cursor comes back as history either — the client still has it on screen.
    expect(caught.history).toBeNull();
    c2.close();
  });
});