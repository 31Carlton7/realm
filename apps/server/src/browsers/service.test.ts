import { describe, expect, it, afterEach } from "vitest";
import { join } from "node:path";
import { newId } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
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
    const home = tempDir("realm-home-");
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
    const home = tempDir("realm-home-");
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
    const home = tempDir("realm-home-");
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

  describe("the page's favicon", () => {
    const G = "data:image/x-icon;base64,AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQ";
    async function setup() {
      const home = tempDir("realm-home-");
      const app = await createApp({ home, port: 0 }); apps.push(app);
      const c = await client(app.port);
      const space = await makeSpace(c);
      const { browserId, itemId } = (await c.call("browsers.create", { spaceId: space.id })).result;
      const listed = async () => (await c.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId);
      const changes = () => c.events.filter((e) => e.event === "items.changed").length;
      return { home, app, c, space, browserId, itemId, listed, changes };
    }

    it("is kept on the row and drawn from the item, which the lists are told to read again", async () => {
      // THE mutant: store it and say nothing. The tab keeps the glyph until something else happens to
      // rename an item in the space.
      const { c, browserId, listed, changes } = await setup();
      expect((await listed()).favicon).toBeUndefined(); // a fresh pane has none, and its item says so
      // The page as it usually lands: its title first, its icon once main has fetched it.
      await c.call("browsers.update", { browserId, url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: "" });
      const before = changes();
      await c.call("browsers.update", { browserId, url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: G });
      expect((await c.call("browsers.get", { browserId })).result.favicon).toBe(G);
      expect((await listed()).favicon).toBe(G);
      expect(changes()).toBe(before + 1);
      // …and nothing for a write that changes neither the title nor the icon.
      await c.call("browsers.update", { browserId, url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: G });
      expect(changes()).toBe(before + 1);
      c.close();
    });

    it("is the page's, so a new address without one clears it rather than lending it on", async () => {
      // THE mutant: keep the row's icon across navigations. A page that never showed Google's G would
      // wear it in the tab strip because the page before it did.
      const { c, browserId, listed } = await setup();
      await c.call("browsers.update", { browserId, url: "https://www.google.com/", title: "Google", favicon: G });
      await c.call("browsers.update", { browserId, url: "https://example.com/", title: "Example" });
      expect((await c.call("browsers.get", { browserId })).result.favicon).toBe("");
      expect((await listed()).favicon).toBeUndefined();
      c.close();
    });

    it("keeps anything that is not a picture as none — and the url and title beside it still land", async () => {
      // THE mutant: store it as given. A remote address on the row would have the window fetch it.
      const { c, browserId } = await setup();
      const r = await c.call("browsers.update", { browserId, url: "https://example.com/", title: "Example", favicon: "https://example.com/favicon.ico" });
      expect(r.ok).toBe(true);
      expect((await c.call("browsers.get", { browserId })).result).toMatchObject({ url: "https://example.com/", title: "Example", favicon: "" });
      c.close();
    });

    it("survives a restart, so a restored tab draws it before the page has loaded again", async () => {
      const { home, app, c, space, browserId, itemId } = await setup();
      await c.call("browsers.update", { browserId, url: "https://www.google.com/", title: "Google", favicon: G });
      c.close();
      await app.close();
      const app2 = await createApp({ home, port: 0 }); apps.push(app2);
      const c2 = await client(app2.port);
      expect((await c2.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId).favicon).toBe(G);
      c2.close();
    });

    it("goes into the history with the page, for the suggestions and Recently visited", async () => {
      const { c, space, browserId } = await setup();
      await c.call("browsers.update", { browserId, url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: G });
      await c.call("browsers.update", { browserId, url: "https://example.com/", title: "Example", favicon: "" });
      const pages = (await c.call("browsers.recent", { spaceId: space.id })).result.pages as { url: string; favicon: string }[];
      // Keyed rather than ordered: both visits can land in the same millisecond.
      expect(Object.fromEntries(pages.map((p) => [p.url, p.favicon]))).toEqual({ "https://example.com/": "", "https://www.google.com/search?q=hi": G });
      c.close();
    });
  });

  it("close deletes row + item; a second close is NOT_FOUND; items.delete routes through it", async () => {
    const home = tempDir("realm-home-");
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
    const home = tempDir("realm-home-");
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);
    const { browserId } = (await c.call("browsers.create", { spaceId: space.id })).result;
    expect((await c.call("spaces.delete", { id: space.id })).ok).toBe(true);
    expect(new BrowsersStore(app.db).get(browserId)).toBeNull();
    c.close();
  });

  it("screenshotDir is the space's own folder, under screenshots/ — and nothing for a space that is not there", async () => {
    /* A pane's Take a screenshot writes where this says. THE mutant: a project's root instead of the
       space's folder — a space with no project would then have nowhere to put the picture it just took. */
    const home = tempDir("realm-home-");
    const app = await createApp({ home, port: 0 }); apps.push(app);
    const c = await client(app.port);
    const space = await makeSpace(c);
    expect((await c.call("browsers.screenshotDir", { spaceId: space.id })).result).toEqual({ dir: join(space.folderPath, "screenshots") });
    expect((await c.call("browsers.screenshotDir", { spaceId: newId() })).result).toEqual({ dir: null });
    c.close();
  });

  describe("history and the address field's suggestions (Plan 26 W7c)", () => {
    async function setup() {
      const home = tempDir("realm-home-");
      const app = await createApp({ home, port: 0 }); apps.push(app);
      const c = await client(app.port);
      const work = (await c.call("profiles.create", { name: "Work" })).result;
      const play = (await c.call("profiles.create", { name: "Play" })).result;
      const a = (await c.call("spaces.create", { profileId: work.id, name: "Realm" })).result;
      const b = (await c.call("spaces.create", { profileId: work.id, name: "Site" })).result;
      const other = (await c.call("spaces.create", { profileId: play.id, name: "Games" })).result;
      const pane = async (spaceId: string) => (await c.call("browsers.create", { spaceId })).result.browserId as string;
      const suggest = async (spaceId: string, query: string) =>
        ((await c.call("browsers.suggest", { spaceId, query })).result.pages as { url: string; title: string; visits: number }[]);
      return { c, a, b, other, pane, suggest };
    }

    it("a pane's navigation is a visit, offered back to every space of the same profile", async () => {
      const { c, a, b, other, pane, suggest } = await setup();
      const p = await pane(a.id);
      await c.call("browsers.update", { browserId: p, url: "https://docs.example/start", title: "Getting started" });
      await c.call("browsers.update", { browserId: p, url: "https://docs.example/config", title: "Configuration" });
      expect((await suggest(a.id, "docs")).map((x) => x.title).sort()).toEqual(["Configuration", "Getting started"]);
      // Another space in the same profile is offered the same pages; a different profile is not.
      expect((await suggest(b.id, "docs")).map((x) => x.title).sort()).toEqual(["Configuration", "Getting started"]);
      expect(await suggest(other.id, "docs")).toEqual([]);
      c.close();
    });

    it("the same page renaming itself is not another visit — or every app that retitles would rank first", async () => {
      /* THE mutant: count every update. The renderer persists on every settled state, and a page
         that sets its title after load (or a single-page app that retitles each view) would gain a
         visit per rename. */
      const { c, a, pane, suggest } = await setup();
      const p = await pane(a.id);
      await c.call("browsers.update", { browserId: p, url: "https://mail.example/", title: "Loading…" });
      await c.call("browsers.update", { browserId: p, url: "https://mail.example/", title: "Inbox (3)" });
      expect(await suggest(a.id, "mail")).toEqual([expect.objectContaining({ url: "https://mail.example/", title: "Inbox (3)", visits: 1 })]);
      // Coming back to it later is a visit.
      await c.call("browsers.update", { browserId: p, url: "https://news.example/", title: "News" });
      await c.call("browsers.update", { browserId: p, url: "https://mail.example/", title: "Inbox (3)" });
      expect((await suggest(a.id, "mail"))[0]!.visits).toBe(2);
      c.close();
    });

    it("ranks what a person goes back to above what they saw once", async () => {
      const { c, a, pane, suggest } = await setup();
      const p = await pane(a.id);
      for (const url of ["https://x.example/once", "https://x.example/often", "https://x.example/other", "https://x.example/often"]) {
        await c.call("browsers.update", { browserId: p, url, title: url.split("/").pop() });
        await new Promise((r) => setTimeout(r, 3)); // recency is the tiebreak, so no two visits share a millisecond
      }
      expect((await suggest(a.id, "x.example")).map((x) => x.title)).toEqual(["often", "other", "once"]);
      c.close();
    });

    it("records nothing that is not an address: Realm's blank page, a credential, an empty pane", async () => {
      const { c, a, pane, suggest } = await setup();
      const p = await pane(a.id);
      await c.call("browsers.update", { browserId: p, url: "about:blank", title: "" });
      await c.call("browsers.update", { browserId: p, url: "https://me:hunter2@intranet.example/", title: "Intranet" });
      expect(await suggest(a.id, "a")).toEqual([]);
      c.close();
    });

    it("a blank tab's recent pages are the space's profile's, newest first, and a handful unless asked for more", async () => {
      /* THE mutants: read the history without the space's profile, and the newest visit anywhere — a
         page in another profile — heads this one's list; drop the default bound, and the new-tab page
         lists the whole history under its tools. */
      const { c, a, b, other, pane } = await setup();
      const recent = async (spaceId: string, limit?: number) =>
        ((await c.call("browsers.recent", { spaceId, ...(limit ? { limit } : {}) })).result.pages as { title: string }[]).map((x) => x.title);
      const p = await pane(a.id);
      for (let i = 1; i <= 7; i++) {
        await c.call("browsers.update", { browserId: p, url: `https://docs.example/${i}`, title: `Page ${i}` });
        await new Promise((r) => setTimeout(r, 3)); // recency is the order, so no two visits share a millisecond
      }
      await c.call("browsers.update", { browserId: await pane(other.id), url: "https://games.example/", title: "Games" });
      expect(await recent(a.id)).toEqual(["Page 7", "Page 6", "Page 5", "Page 4", "Page 3"]);
      // Another space of the same profile lists the same pages; the other profile lists only its own.
      expect(await recent(b.id, 2)).toEqual(["Page 7", "Page 6"]);
      expect(await recent(other.id)).toEqual(["Games"]);
      expect(await recent(newId())).toEqual([]);
      c.close();
    });

    it("an empty query suggests nothing, and clearHistory forgets every profile's pages", async () => {
      const { c, a, other, pane, suggest } = await setup();
      await c.call("browsers.update", { browserId: await pane(a.id), url: "https://a.example/", title: "A" });
      await c.call("browsers.update", { browserId: await pane(other.id), url: "https://b.example/", title: "B" });
      expect(await suggest(a.id, "")).toEqual([]);
      expect((await c.call("browsers.clearHistory", {})).result).toEqual({ ok: true });
      expect(await suggest(a.id, "example")).toEqual([]);
      expect(await suggest(other.id, "example")).toEqual([]);
      c.close();
    });
  });
});
