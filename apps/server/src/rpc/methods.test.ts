import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
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

  it("returns NOT_FOUND for items.create with a bogus spaceId", async () => {
    const { c } = await boot();
    const r = await c.call("items.create", { spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "terminal", title: "t", refId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("terminals.create makes an item and streams data events", async () => {
    const { c } = await boot();
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(itemId).toBeTruthy();
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items.map((i: any) => i.id)).toEqual([itemId]);
    expect(items[0].refId).toBe(terminalId);
    await c.call("terminals.write", { terminalId, data: "echo REALM_RPC_OK\n" });
    const termData = () => c.events.filter((e) => e.event === "terminal.data").map((e) => e.payload.data).join("");
    await waitFor(() => termData().includes("REALM_RPC_OK"));
    await c.call("terminals.close", { terminalId });
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
