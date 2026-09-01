import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../app";
import { BrowsersStore } from "../store/browsers";

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

async function makeSpace(c: Awaited<ReturnType<typeof client>>) {
  const prof = (await c.call("profiles.create", { name: "Work" })).result;
  return (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
}

describe("browsers RPC", () => {
  it("create makes row + item as one unit; url defaults to empty (never navigated)", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);
    const { browserId, itemId, url } = (await c.call("browsers.create", { spaceId: space.id })).result;
    expect(url).toBe("");
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: itemId, kind: "browser", refId: browserId, title: "Browser" });
    const row = (await c.call("browsers.get", { browserId })).result;
    expect(row).toMatchObject({ id: browserId, spaceId: space.id, url: "", title: "Browser" });
    c.close();
  });

  it("survives a restart: the row keeps its last committed url/title", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c1 = await client(app1.port);
    const space = await makeSpace(c1);
    const { browserId, itemId } = (await c1.call("browsers.create", { spaceId: space.id, url: "https://example.com/" })).result;
    expect((await c1.call("browsers.update", { browserId, url: "https://example.com/docs", title: "Example — docs" })).ok).toBe(true);
    c1.close();
    await app1.close();

    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    const c2 = await client(app2.port);
    const row = (await c2.call("browsers.get", { browserId })).result;
    expect(row.url).toBe("https://example.com/docs");
    expect(row.title).toBe("Example — docs");
    const items = (await c2.call("items.list", { spaceId: space.id })).result;
    expect(items.map((i: any) => i.id)).toEqual([itemId]);
    c2.close();
  });

  it("update with a title renames the item and broadcasts items.changed; url-only does not touch the item", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);
    const { browserId, itemId } = (await c.call("browsers.create", { spaceId: space.id })).result;
    const before = c.events.filter((e) => e.event === "items.changed").length;

    await c.call("browsers.update", { browserId, url: "https://example.com/" });
    let item = (await c.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId);
    expect(item.title).toBe("Browser");
    expect(c.events.filter((e) => e.event === "items.changed").length).toBe(before);

    await c.call("browsers.update", { browserId, title: "Example Domain" });
    item = (await c.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId);
    expect(item.title).toBe("Example Domain");
    expect(c.events.filter((e) => e.event === "items.changed").length).toBe(before + 1);

    // An empty page title must not blank the sidebar row.
    await c.call("browsers.update", { browserId, title: "" });
    item = (await c.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId);
    expect(item.title).toBe("Browser");
    c.close();
  });

  it("close deletes row + item; a second close is NOT_FOUND; items.delete routes through it", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);

    const a = (await c.call("browsers.create", { spaceId: space.id })).result;
    expect((await c.call("browsers.close", { browserId: a.browserId })).ok).toBe(true);
    expect((await c.call("items.list", { spaceId: space.id })).result).toHaveLength(0);
    expect(new BrowsersStore(app.db).get(a.browserId)).toBeNull();
    const again = await c.call("browsers.close", { browserId: a.browserId });
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe("NOT_FOUND");

    // Deleting the ITEM (pane menu / sidebar) must reach the row too, like terminals.
    const b = (await c.call("browsers.create", { spaceId: space.id })).result;
    expect((await c.call("items.delete", { id: b.itemId })).ok).toBe(true);
    expect(new BrowsersStore(app.db).get(b.browserId)).toBeNull();
    expect((await c.call("items.list", { spaceId: space.id })).result).toHaveLength(0);
    c.close();
  });

  it("space deletion cascades browser rows away", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-home-"));
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);
    const { browserId } = (await c.call("browsers.create", { spaceId: space.id })).result;
    expect((await c.call("spaces.delete", { id: space.id })).ok).toBe(true);
    expect(new BrowsersStore(app.db).get(browserId)).toBeNull();
    c.close();
  });
});
