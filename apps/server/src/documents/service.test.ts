import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { hashText } from "./files";

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

/** A space, its primary environment (the space folder), and a documents workspace over it. */
async function setup() {
  const home = tempDir("realm-home-");
  const app = await createApp({ home, port: 0 }); apps.push(app);
  const c = await client(app.port);
  const prof = (await c.call("profiles.create", { name: "Work" })).result;
  const space = (await c.call("spaces.create", { profileId: prof.id, name: "Docs" })).result;
  const { documentsId, itemId } = (await c.call("documents.create", { spaceId: space.id })).result;
  const ws = (await c.call("documents.get", { documentsId })).result;
  const env = (await c.call("environments.list", { spaceId: space.id })).result
    .find((e: any) => e.id === ws.environmentId);
  return { app, c, space, env, documentsId, itemId, root: env.path as string };
}

describe("documents RPC — lifecycle", () => {
  it("create makes row + item as one unit, titled after the checkout", async () => {
    const { c, space, env, documentsId, itemId } = await setup();
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: itemId, kind: "documents", refId: documentsId });
    const ws = (await c.call("documents.get", { documentsId })).result;
    expect(ws).toMatchObject({ id: documentsId, environmentId: env.id, openPaths: [], activePath: null });
    c.close();
  });

  /** Two panes over one checkout would mean two tab strips and two autosaves racing on each buffer. */
  it("is one workspace per environment — re-creating returns the existing one", async () => {
    const { c, space, env, documentsId } = await setup();
    const again = (await c.call("documents.create", { spaceId: space.id, environmentId: env.id })).result;
    expect(again.documentsId).toBe(documentsId);
    expect((await c.call("items.list", { spaceId: space.id })).result).toHaveLength(1);
    c.close();
  });

  it("persists the tab strip across a restart", async () => {
    const home = tempDir("realm-home-");
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const c1 = await client(app1.port);
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Docs" })).result;
    const { documentsId } = (await c1.call("documents.create", { spaceId: space.id })).result;
    const root = (await c1.call("documents.get", { documentsId })).result;
    const env = (await c1.call("environments.list", { spaceId: space.id })).result
      .find((e: any) => e.id === root.environmentId);
    await writeFile(join(env.path, "a.md"), "a");
    await writeFile(join(env.path, "b.md"), "b");
    await c1.call("documents.setTabs", { documentsId, openPaths: ["a.md", "b.md"], activePath: "b.md" });
    c1.close();
    await app1.close(); apps.splice(apps.indexOf(app1), 1);

    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    const c2 = await client(app2.port);
    const ws = (await c2.call("documents.get", { documentsId })).result;
    expect(ws.openPaths).toEqual(["a.md", "b.md"]);
    expect(ws.activePath).toBe("b.md");
    c2.close();
  });

  it("corrects an activePath that is not among the open tabs", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "a");
    const ws = (await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "ghost.md" })).result;
    expect(ws.activePath).toBe("a.md");
    const empty = (await c.call("documents.setTabs", { documentsId, openPaths: [], activePath: "a.md" })).result;
    expect(empty.activePath).toBeNull();
    c.close();
  });

  it("deleting the item removes the workspace row too", async () => {
    const { c, documentsId, itemId } = await setup();
    await c.call("items.delete", { id: itemId });
    const res = await c.call("documents.get", { documentsId });
    expect(res.error?.code).toBe("NOT_FOUND");
    c.close();
  });
});

describe("documents RPC — files", () => {
  it("lists a directory, folders first, hiding dotfiles and vendor directories", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "b.md"), "");
    await writeFile(join(root, "a.csv"), "");
    await mkdir(join(root, "sub"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, ".hidden"), "");
    const { entries } = (await c.call("documents.list", { documentsId, dir: "" })).result;
    expect(entries.map((e: any) => e.name)).toEqual(["sub", "a.csv", "b.md"]);
    expect(entries[0].isDir).toBe(true);
    c.close();
  });

  it("reads a document with its hash and writes it back", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "# One\n");
    const read = (await c.call("documents.read", { documentsId, path: "a.md" })).result;
    expect(read).toEqual({ text: "# One\n", hash: hashText("# One\n") });
    const w = (await c.call("documents.write", { documentsId, path: "a.md", text: "# Two\n", baseHash: read.hash })).result;
    expect(w).toEqual({ ok: true, hash: hashText("# Two\n") });
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("# Two\n");
    c.close();
  });

  /** The case the whole conflict policy exists for: an agent wrote while the user was typing. */
  it("refuses a stale write and hands back the current text", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "original");
    const read = (await c.call("documents.read", { documentsId, path: "a.md" })).result;
    await writeFile(join(root, "a.md"), "the agent's rewrite"); // outside edit
    const w = (await c.call("documents.write", { documentsId, path: "a.md", text: "the user's paragraph", baseHash: read.hash })).result;
    expect(w).toEqual({ ok: false, currentText: "the agent's rewrite", currentHash: hashText("the agent's rewrite") });
    // Nothing was destroyed.
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("the agent's rewrite");
    c.close();
  });

  it("creates a new document from its kind's template", async () => {
    const { c, documentsId, root } = await setup();
    await c.call("documents.createFile", { documentsId, path: "paper.tex", kind: "latex", title: "My Paper" });
    const text = await readFile(join(root, "paper.tex"), "utf8");
    expect(text).toContain("\\documentclass{article}");
    expect(text).toContain("\\title{My Paper}");
    const again = await c.call("documents.createFile", { documentsId, path: "paper.tex", kind: "latex", title: "X" });
    expect(again.error?.code).toBe("EXISTS");
    c.close();
  });

  it("renames a document and carries its open tab with it", async () => {
    const { c, documentsId, root } = await setup();
    await c.call("documents.createFile", { documentsId, path: "Untitled document.md", kind: "doc", title: "Untitled document" });
    await c.call("documents.setTabs", { documentsId, openPaths: ["Untitled document.md"], activePath: "Untitled document.md" });

    const r = await c.call("documents.renameFile", { documentsId, from: "Untitled document.md", to: "Q3 review.md" });
    expect(r.result).toEqual({ path: "Q3 review.md" });
    expect(await readFile(join(root, "Q3 review.md"), "utf8")).toContain("# Untitled document");
    await expect(readFile(join(root, "Untitled document.md"), "utf8")).rejects.toThrow();
    // The tab moved with the file. Had it not, the pane would still be holding a path that is gone.
    const ws = (await c.call("documents.get", { documentsId })).result;
    expect(ws.openPaths).toEqual(["Q3 review.md"]);
    expect(ws.activePath).toBe("Q3 review.md");
    c.close();
  });

  it("a rename is not seen as an outside edit — the tab it just moved must not go into conflict", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "v1");
    await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "a.md" });
    await c.call("documents.read", { documentsId, path: "a.md" });
    await c.call("documents.renameFile", { documentsId, from: "a.md", to: "b.md" });
    await new Promise((r) => setTimeout(r, 250));
    // The vanished old path is a real event (the file IS gone from there); what must not happen is
    // the NEW path arriving as a change the user never made.
    expect(c.events.filter((e) => e.event === "documents.fileChanged" && e.params.path === "b.md")).toEqual([]);
    c.close();
  });

  it("refuses to rename onto a file that already exists, and leaves both alone", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "mine");
    await writeFile(join(root, "b.md"), "theirs");
    const r = await c.call("documents.renameFile", { documentsId, from: "a.md", to: "b.md" });
    expect(r.error?.code).toBe("EXISTS");
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("mine");
    expect(await readFile(join(root, "b.md"), "utf8")).toBe("theirs");
    c.close();
  });

  it("refuses to rename out of the environment root, in either direction", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "mine");
    for (const [from, to] of [["a.md", "../escaped.md"], ["../../etc/passwd", "a.md"]] as const) {
      const r = await c.call("documents.renameFile", { documentsId, from, to });
      expect(r.error?.code, `${from} -> ${to}`).toBe("BAD_PATH");
    }
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("mine");
    c.close();
  });

  it("refuses to read or write outside the environment root", async () => {
    const { c, documentsId } = await setup();
    for (const path of ["../escape.md", "/etc/passwd", "a/../../escape.md"]) {
      const r = await c.call("documents.read", { documentsId, path });
      expect(r.error?.code).toBe("BAD_PATH");
      const w = await c.call("documents.write", { documentsId, path, text: "x", baseHash: null });
      expect(w.error?.code).toBe("BAD_PATH");
    }
    c.close();
  });
});

describe("documents RPC — live reload", () => {
  it("broadcasts an outside edit to an open document", async () => {
    const { c, env, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "v1");
    await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "a.md" });

    await writeFile(join(root, "a.md"), "edited by an agent");
    await waitFor(() => c.events.some((e) => e.event === "documents.fileChanged"));
    const ev = c.events.find((e) => e.event === "documents.fileChanged");
    expect(ev.payload).toEqual({ environmentId: env.id, path: "a.md", hash: hashText("edited by an agent") });
    c.close();
  });

  /** Realm's own save must not come back as somebody else's edit, or the pane fights its autosave. */
  it("does not broadcast Realm's own writes", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "v1");
    const read = (await c.call("documents.read", { documentsId, path: "a.md" })).result;
    await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "a.md" });
    await c.call("documents.write", { documentsId, path: "a.md", text: "saved by the pane", baseHash: read.hash });
    await new Promise((r) => setTimeout(r, 250));
    expect(c.events.filter((e) => e.event === "documents.fileChanged")).toEqual([]);
    c.close();
  });

  it("stops broadcasting for a tab that was closed", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "v1");
    await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "a.md" });
    await c.call("documents.setTabs", { documentsId, openPaths: [], activePath: null });
    await writeFile(join(root, "a.md"), "changed after close");
    await new Promise((r) => setTimeout(r, 250));
    expect(c.events.filter((e) => e.event === "documents.fileChanged")).toEqual([]);
    c.close();
  });

  it("detach releases watches without forgetting the tabs", async () => {
    const { c, documentsId, root } = await setup();
    await writeFile(join(root, "a.md"), "v1");
    await c.call("documents.setTabs", { documentsId, openPaths: ["a.md"], activePath: "a.md" });
    await c.call("documents.detach", { documentsId });

    await writeFile(join(root, "a.md"), "changed after detach");
    await new Promise((r) => setTimeout(r, 250));
    expect(c.events.filter((e) => e.event === "documents.fileChanged")).toEqual([]);
    // The tab strip survived — closing a pane is layout-only.
    expect((await c.call("documents.get", { documentsId })).result.openPaths).toEqual(["a.md"]);
    c.close();
  });
});
