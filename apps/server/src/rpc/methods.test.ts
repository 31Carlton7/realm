import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../app";

let app: App;
afterEach(async () => { await app?.close(); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => ws.close() };
}

describe("rpc methods", () => {
  it("full flow: profile → space → item → layout, with change events", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "Work" })).result;
    expect(prof.icon).toBe("user");
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    expect(space.folderPath).toContain("versed");
    const item = (await c.call("items.create", { spaceId: space.id, kind: "terminal", title: "zsh", refId: space.id })).result;
    const layout = { type: "leaf", id: "L1", tabs: [item.id], activeTab: item.id };
    const updated = (await c.call("spaces.setLayout", { id: space.id, layout })).result;
    expect(updated.layout).toEqual(layout);
    const listed = (await c.call("spaces.list", { profileId: prof.id })).result;
    expect(listed).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.events.map((e) => e.event)).toEqual(expect.arrayContaining(["profiles.changed", "spaces.changed", "items.changed"]));
    const info = (await c.call("system.info", {})).result;
    expect(info.realmHome).toBe(home);
    c.close();
  });

  it("terminals.create makes an item and streams data events", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    app = await createApp({ home, port: 0 });
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { terminalId, itemId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    expect(itemId).toBeTruthy();
    await c.call("terminals.write", { terminalId, data: "echo REALM_RPC_OK\n" });
    await new Promise((r) => setTimeout(r, 500));
    const data = c.events.filter((e) => e.event === "terminal.data").map((e) => e.payload.data).join("");
    expect(data).toContain("REALM_RPC_OK");
    await c.call("terminals.close", { terminalId });
    c.close();
  });
});
