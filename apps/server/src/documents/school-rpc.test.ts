import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { progressSidecarPath } from "@realm/contracts";
import { createApp, type App } from "../app";
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

async function setup() {
  const home = tempDir("realm-home-");
  const app = await createApp({ home, port: 0 }); apps.push(app);
  const c = await client(app.port);
  const prof = (await c.call("profiles.create", { name: "School" })).result;
  const space = (await c.call("spaces.create", { profileId: prof.id, name: "MAT 226" })).result;
  const { documentsId, itemId } = (await c.call("documents.create", { spaceId: space.id })).result;
  const ws = (await c.call("documents.get", { documentsId })).result;
  const env = (await c.call("environments.list", { spaceId: space.id })).result.find((e: any) => e.id === ws.environmentId);
  return { app, c, space, documentsId, itemId, env, root: env.path as string };
}

describe("documents.previewInfo — the frame URL's ingredients", () => {
  it("answers a port and token, and the served guide carries the runtime", async () => {
    const { c, documentsId, root } = await setup();
    const info = (await c.call("documents.previewInfo", {})).result;
    expect(info.port).toBeGreaterThan(0);
    expect(typeof info.token).toBe("string");
    await mkdir(join(root, "guides"), { recursive: true });
    await writeFile(join(root, "guides", "g.html"), "<html><head></head><body><p>hi</p></body></html>");
    const r = await fetch(`http://127.0.0.1:${info.port}/p/${info.token}/${documentsId}/guides/g.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("guide.js");
    // A workspace id that does not exist is a 404, not a path into anything.
    expect((await fetch(`http://127.0.0.1:${info.port}/p/${info.token}/01ARZ3NDEKTSV4RRFFQ69G5FAV/guides/g.html`)).status).toBe(404);
    c.close();
  });
});

describe("documents.openPath", () => {
  it("adds the tab, makes it active, broadcasts, and reuses the one workspace", async () => {
    const { c, space, documentsId, itemId, env, root } = await setup();
    await writeFile(join(root, "notes.md"), "# n");
    await writeFile(join(root, "other.md"), "# o");
    await c.call("documents.setTabs", { documentsId, openPaths: ["other.md"], activePath: "other.md" });
    const r = (await c.call("documents.openPath", { spaceId: space.id, path: "notes.md" })).result;
    expect(r).toEqual({ documentsId, itemId, environmentId: env.id });
    const ws = (await c.call("documents.get", { documentsId })).result;
    expect(ws.openPaths).toEqual(["other.md", "notes.md"]);
    expect(ws.activePath).toBe("notes.md");
    await waitFor(() => c.events.some((e) => e.event === "documents.openRequested"));
    expect(c.events.find((e) => e.event === "documents.openRequested").payload).toEqual({ spaceId: space.id, environmentId: env.id, documentsId, itemId, path: "notes.md" });
    // Opening an already-open tab does not duplicate it.
    await c.call("documents.openPath", { spaceId: space.id, path: "other.md" });
    expect((await c.call("documents.get", { documentsId })).result.openPaths).toEqual(["other.md", "notes.md"]);
    c.close();
  });

  it("refuses a missing file and an escaping path", async () => {
    const { c, space } = await setup();
    expect((await c.call("documents.openPath", { spaceId: space.id, path: "nope.md" })).error?.code).toBe("NOT_FOUND");
    expect((await c.call("documents.openPath", { spaceId: space.id, path: "../x.md" })).error?.code).toBe("BAD_PATH");
    c.close();
  });
});

describe("documents.progressRead / progressRecord", () => {
  it("starts empty, folds attempts into a hidden sidecar beside the guide, and survives a bad sidecar", async () => {
    const { c, documentsId, root } = await setup();
    await mkdir(join(root, "guides"), { recursive: true });
    await writeFile(join(root, "guides", "g.html"), "<p>g</p>");
    expect((await c.call("documents.progressRead", { documentsId, path: "guides/g.html" })).result).toEqual({ version: 1, topics: {} });
    const a = (await c.call("documents.progressRecord", { documentsId, path: "guides/g.html", topic: "limits", correct: 2, total: 4 })).result;
    expect(a.topics.limits).toMatchObject({ best: 0.5, last: 0.5 });
    const b = (await c.call("documents.progressRecord", { documentsId, path: "guides/g.html", topic: "limits", correct: 4, total: 4 })).result;
    expect(b.topics.limits).toMatchObject({ best: 1, last: 1 });
    expect(b.topics.limits.attempts).toHaveLength(2);
    const sidecar = join(root, progressSidecarPath("guides/g.html"));
    expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual(b);
    // The sidecar is hidden from the picker.
    const entries = (await c.call("documents.list", { documentsId, dir: "guides" })).result.entries;
    expect(entries.map((e: any) => e.name)).toEqual(["g.html"]);
    // Sidecar corruption is not fatal: it reads as empty and the next record starts over.
    await writeFile(sidecar, "{not json");
    expect((await c.call("documents.progressRead", { documentsId, path: "guides/g.html" })).result).toEqual({ version: 1, topics: {} });
    // correct is clamped to total; a zero total is rejected by the schema.
    const clamped = (await c.call("documents.progressRecord", { documentsId, path: "guides/g.html", topic: "t", correct: 9, total: 3 })).result;
    expect(clamped.topics.t.last).toBe(1);
    expect((await c.call("documents.progressRecord", { documentsId, path: "guides/g.html", topic: "t", correct: 0, total: 0 })).error?.code).toBe("INVALID_PARAMS");
    c.close();
  });

  it("the sidecar write is Realm's own and does not echo as an external change", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "g.html"), "<p>g</p>");
    await c.call("documents.setTabs", { documentsId, openPaths: ["g.html"], activePath: "g.html" });
    await c.call("documents.read", { documentsId, path: "g.html" });
    await c.call("documents.progressRecord", { documentsId, path: "g.html", topic: "t", correct: 1, total: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(c.events.filter((e) => e.event === "documents.fileChanged")).toEqual([]);
    c.close();
  });
});
