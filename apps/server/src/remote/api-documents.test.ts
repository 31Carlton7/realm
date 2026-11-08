import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { MobileCalls } from "@realm/remote";
import { MobileApi, MobileError } from "./api";
import { channel, fakeRpc } from "./api.test-fakes";

/**
 * A space's folder and the Library as a phone reads them: what is listed, in what order and in what
 * pages, and what is refused however it is asked for.
 */

const SECRET = "That file holds a secret, so Realm does not send it to a phone.";
const api = () => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: "/nonexistent", dev: false });

function folder(files: Record<string, string> = {}): string {
  const root = tempDir("realm-api-documents-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const rigFor = (root: string, listed: { path: string; name: string; isDir: boolean; size: number }[] = [], hits: string[] = []) => fakeRpc({ sessions: [], items: [] }, {
  "documents.spaceRoot": (() => ({ root })) as never,
  "documents.listInSpace": (() => ({ entries: listed })) as never,
  "project.files": (() => ({ hits: hits.map((path) => ({ path, score: 1, segments: [] })), truncated: false, source: "git" })) as never,
});

async function attempt(rpc: ReturnType<typeof fakeRpc>, method: string, params: unknown): Promise<{ ok: true; result: never } | { ok: false; code: string; message: string }> {
  try { return { ok: true, result: await api().handle(channel(rpc), method, params) as never }; }
  catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
}

const entry = (path: string, isDir = false) => ({ path, name: path.split("/").at(-1)!, isDir, size: 0 });

describe("documents.list", () => {
  it("keeps the desktop's order, and says what each file is", async () => {
    const root = folder({ "notes/a.md": "# a", "report.pdf": "%PDF", "run.py": "print()", "shot.png": "png" });
    const rpc = rigFor(root, [entry("notes", true), entry("report.pdf"), entry("run.py"), entry("shot.png")]);
    const got = await attempt(rpc, "documents.list", { spaceId: "s1" });
    expect(got.ok && MobileCalls["documents.list"].result.parse(got.result)).toMatchObject({
      total: 4, next: null,
      entries: [
        { path: "notes", isDir: true, size: 0, kind: "folder", mime: "" },
        { path: "report.pdf", kind: "pdf", mime: "application/pdf", size: 4 },
        { path: "run.py", kind: "code" },
        { path: "shot.png", kind: "preview", mime: "image/png" },
      ],
    });
  });

  it("does not list a file that holds a secret, in the page or in the count", async () => {
    const root = folder({ "deploy.pem": "KEY", "credentials.json": "{}", "a.md": "a", "keep.pem.example": "x" });
    const rpc = rigFor(root, [entry("a.md"), entry("credentials.json"), entry("deploy.pem"), entry("keep.pem.example")]);
    const got = await attempt(rpc, "documents.list", { spaceId: "s1" });
    expect(got.ok && (got.result as { total: number }).total).toBe(2);
    expect(got.ok && (got.result as { entries: { path: string }[] }).entries.map((e) => e.path)).toEqual(["a.md", "keep.pem.example"]);
  });

  it("pages a big folder by offset, each page bounded, the last saying there is no more", async () => {
    const names = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, "0")}.md`);
    const root = folder(Object.fromEntries(names.map((n) => [n, "x"])));
    const rpc = rigFor(root, names.map((n) => entry(n)));
    const first = await attempt(rpc, "documents.list", { spaceId: "s1" }) as { ok: true; result: { entries: { path: string }[]; total: number; next: number | null } };
    expect(first.result.entries).toHaveLength(100);
    expect([first.result.total, first.result.next]).toEqual([250, 100]);
    const last = await attempt(rpc, "documents.list", { spaceId: "s1", offset: 200 }) as typeof first;
    expect(last.result.entries.map((e) => e.path)).toEqual(names.slice(200));
    expect(last.result.next).toBeNull();
    expect(await attempt(rpc, "documents.list", { spaceId: "s1", limit: 201 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("refuses a folder outside the space's, or one it never shows", async () => {
    const root = folder({ "a.md": "a" });
    const rpc = rigFor(root);
    expect(await attempt(rpc, "documents.list", { spaceId: "s1", dir: "../" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await attempt(rpc, "documents.list", { spaceId: "s1", dir: "/etc" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await attempt(rpc, "documents.list", { spaceId: "s1", dir: "node_modules" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await attempt(rpc, "documents.list", { spaceId: "s1", dir: "gone" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("leaves out a link that leaves the folder, and a linked file, and keeps a linked folder inside it", async () => {
    const root = folder({ "real/a.md": "a" });
    const away = folder({ "away.md": "a" });
    symlinkSync(away, join(root, "outside"));
    symlinkSync(join(away, "away.md"), join(root, "outside.md"));
    symlinkSync(join(root, "real/a.md"), join(root, "linked.md"));
    symlinkSync(join(root, "real"), join(root, "shortcut"));
    const rpc = rigFor(root, [entry("outside", true), entry("real", true), entry("shortcut", true), entry("linked.md"), entry("outside.md")]);
    const got = await attempt(rpc, "documents.list", { spaceId: "s1" }) as { ok: true; result: { entries: { path: string }[] } };
    expect(got.result.entries.map((e) => e.path)).toEqual(["real", "shortcut"]);
  });
});

describe("documents.file and documents.fileData", () => {
  const reads = (rpc: ReturnType<typeof fakeRpc>, path: string) => Promise.all([
    attempt(rpc, "documents.file", { spaceId: "s1", path }),
    attempt(rpc, "documents.fileData", { spaceId: "s1", path }),
  ]);

  it("reads a file in the folder, and says when it last changed", async () => {
    const rpc = rigFor(folder({ "notes/a.md": "# Hello" }));
    const [preview, data] = await reads(rpc, "notes/a.md");
    expect(preview).toMatchObject({ ok: true, result: { name: "a.md", preview: { kind: "text", text: "# Hello", truncated: false } } });
    expect(data).toMatchObject({ ok: true, result: { data: Buffer.from("# Hello").toString("base64"), next: null } });
    expect(data.ok && (data.result as { modifiedAt: number }).modifiedAt).toBeGreaterThan(0);
  });

  it("answers a read past the end with no bytes, as a phone asks whether its copy is still the file", async () => {
    const rpc = rigFor(folder({ "a.md": "# Hello" }));
    expect(await attempt(rpc, "documents.fileData", { spaceId: "s1", path: "a.md", from: 2 ** 40 })).toMatchObject({ ok: true, result: { data: "", size: 7, next: null } });
  });

  it.each([".env", ".env.local", "deploy.pem", "nested/id_rsa", ".ssh/config", "credentials.json"])("refuses %s, which holds a secret, whether or not it exists", async (path) => {
    const rpc = rigFor(folder({ ".env": "TOKEN=1", "deploy.pem": "KEY", "nested/id_rsa": "KEY", ".ssh/config": "Host", "credentials.json": "{}" }));
    for (const got of await reads(rpc, path)) expect(got).toEqual({ ok: false, code: "FORBIDDEN", message: SECRET });
  });

  it.each(["../outside.md", "notes/../../outside.md", "/etc/passwd", "a\0b.md"])("refuses %j, which is outside the folder", async (path) => {
    const rpc = rigFor(folder({ "notes/a.md": "a" }));
    for (const got of await reads(rpc, path)) expect(got).toMatchObject({ ok: false, code: "FORBIDDEN", message: "That file is not in this space's folder." });
  });

  it("refuses what a folder's link lands on outside it, and a secret a link names under another name", async () => {
    const root = folder({ "a.md": "a" });
    const away = folder({ "away.md": "away", ".aws/keys.md": "secret" });
    symlinkSync(away, join(root, "outside"));
    mkdirSync(join(root, "inner/.aws"), { recursive: true });
    writeFileSync(join(root, "inner/.aws/keys.md"), "secret");
    symlinkSync(join(root, "inner/.aws"), join(root, "plain"));
    const rpc = rigFor(root);
    for (const got of await reads(rpc, "outside/away.md")) expect(got).toMatchObject({ ok: false, code: "FORBIDDEN", message: "That file is not in this space's folder." });
    for (const got of await reads(rpc, "plain/keys.md")) expect(got).toEqual({ ok: false, code: "FORBIDDEN", message: SECRET });
  });

  it("refuses a linked file, and what is under a folder it never shows", async () => {
    const root = folder({ "a.md": "a", "node_modules/pkg/index.js": "x", ".git/config": "token" });
    symlinkSync(join(root, "a.md"), join(root, "link.md"));
    const rpc = rigFor(root);
    for (const got of await reads(rpc, "link.md")) expect(got).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const got of await reads(rpc, "node_modules/pkg/index.js")) expect(got).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const got of await reads(rpc, ".git/config")) expect(got).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("says a file is gone once it is", async () => {
    const rpc = rigFor(folder({ "a.md": "a" }));
    for (const got of await reads(rpc, "gone.md")) expect(got).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("documents.search", () => {
  it("answers in the search's order, leaving out secrets and what a read would refuse", async () => {
    const root = folder({ "notes.md": "n", "src/notes.ts": "n", "notes.pem": "KEY", "dist/notes.js": "n" });
    const rpc = rigFor(root, [], ["src/notes.ts", "notes.pem", "dist/notes.js", "notes.md", "gone/notes.md"]);
    const got = await attempt(rpc, "documents.search", { spaceId: "s1", query: "notes" }) as { ok: true; result: { entries: { path: string }[]; withheld: unknown } };
    expect(got.result.entries.map((e) => e.path)).toEqual(["src/notes.ts", "notes.md"]);
    // A near match to a secret is not said.
    expect(got.result.withheld).toBeNull();
  });

  it("says a secret is there only for its exact name or path, and only where it is", async () => {
    const root = folder({ ".env": "TOKEN=1", "ops/deploy.pem": "KEY" });
    const rpc = rigFor(root, [], ["ops/deploy.pem"]);
    expect(await attempt(rpc, "documents.search", { spaceId: "s1", query: ".env" })).toMatchObject({ ok: true, result: { entries: [], withheld: { path: ".env", name: ".env" } } });
    expect(await attempt(rpc, "documents.search", { spaceId: "s1", query: "deploy.pem" })).toMatchObject({ ok: true, result: { withheld: { path: "ops/deploy.pem" } } });
    expect(await attempt(rpc, "documents.search", { spaceId: "s1", query: "id_rsa" })).toMatchObject({ ok: true, result: { withheld: null } });
    expect(await attempt(rpc, "documents.search", { spaceId: "s1", query: "../.env" })).toMatchObject({ ok: true, result: { withheld: null } });
  });
});

describe("library.files, library.file and library.fileData", () => {
  const row = (path: string, ts: number, kind = "output") => ({ id: `s:${ts}:${path}`, sessionId: kind === "added" ? null : "s", spaceId: kind === "added" ? null : "s1", kind, path, name: path.split("/").at(-1)!, ext: "", ts, sessionTitle: kind === "added" ? null : "Title", agentKind: null });
  const library = (rows: ReturnType<typeof row>[], asked: unknown[] = []) => fakeRpc({ sessions: [], items: [] }, {
    "library.artifacts": ((p: { limit: number; before: { ts: number } | null; query: string; kind: string | null }) => {
      asked.push(p);
      const matching = rows.filter((r) => r.name.includes(p.query) && (!p.before || r.ts < p.before.ts) && (!p.kind || r.kind === p.kind));
      return { entries: matching.slice(0, p.limit), total: rows.length };
    }) as never,
  });

  it("asks for one row to a file, in the scope the phone named", async () => {
    const asked: unknown[] = [];
    await attempt(library([], asked), "library.files", { profileId: "p1", spaceId: "s1", origin: "upload", query: " deck " });
    expect(asked).toEqual([{ perFile: true, limit: 40, query: "deck", profileId: "p1", spaceId: "s1", kind: "upload", before: null }]);
  });

  it("pages by the last row of the page, even where a secret was left out of it", async () => {
    const rows = [row("/a/one.md", 5), row("/a/two.pem", 4), row("/a/three.md", 3), row("/a/four.md", 2)];
    const rpc = library(rows);
    const first = await attempt(rpc, "library.files", { limit: 2 }) as { ok: true; result: { entries: { name: string }[]; next: { ts: number; id: string } | null } };
    expect(first.result.entries.map((e) => e.name)).toEqual(["one.md"]);
    expect(first.result.next).toEqual({ ts: 4, id: "s:4:/a/two.pem" });
    const second = await attempt(rpc, "library.files", { limit: 2, before: first.result.next }) as typeof first;
    expect(second.result.entries.map((e) => e.name)).toEqual(["three.md", "four.md"]);
    const third = await attempt(rpc, "library.files", { limit: 2, before: second.result.next }) as typeof first;
    expect(third.result).toEqual({ entries: [], next: null });
  });

  it("says where a file came from, and nothing of a session for one the person added", async () => {
    const got = await attempt(library([row("/a/report.pdf", 5, "added")]), "library.files", {});
    expect(got.ok && MobileCalls["library.files"].result.parse(got.result).entries[0]).toMatchObject({ name: "report.pdf", origin: "added", sessionId: null, sessionTitle: null, kind: "pdf", mime: "application/pdf", at: 5 });
  });

  it("reads a file the Library lists, however deep in the index, and no other", async () => {
    const root = folder({ "made.md": "# Made", "other.md": "# Other" });
    const crowd = Array.from({ length: 250 }, (_, i) => row(`/elsewhere/${i}-made.md`, 1000 - i));
    const rpc = library([...crowd, row(join(root, "made.md"), 1)]);
    expect(await attempt(rpc, "library.file", { path: join(root, "made.md") })).toMatchObject({ ok: true, result: { preview: { kind: "text", text: "# Made" } } });
    expect(await attempt(rpc, "library.fileData", { path: join(root, "made.md") })).toMatchObject({ ok: true, result: { data: Buffer.from("# Made").toString("base64") } });
    const refused = { ok: false, code: "FORBIDDEN", message: "That file is not in the Library." };
    expect(await attempt(rpc, "library.file", { path: join(root, "other.md") })).toEqual(refused);
    expect(await attempt(rpc, "library.fileData", { path: join(root, "other.md") })).toEqual(refused);
  });

  it("refuses a secret even where the Library lists it", async () => {
    const root = folder({ ".env": "TOKEN=1" });
    const rpc = library([row(join(root, ".env"), 1)]);
    expect(await attempt(rpc, "library.file", { path: join(root, ".env") })).toEqual({ ok: false, code: "FORBIDDEN", message: SECRET });
    expect(await attempt(rpc, "library.fileData", { path: join(root, ".env") })).toEqual({ ok: false, code: "FORBIDDEN", message: SECRET });
    const listed = await attempt(rpc, "library.files", {}) as { ok: true; result: { entries: unknown[] } };
    expect(listed.result.entries).toEqual([]);
  });
});
