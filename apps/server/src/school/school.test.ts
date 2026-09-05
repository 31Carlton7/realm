import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { normalizeBody } from "./plynn";

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

async function setup(o: { plynnDir?: string } = {}) {
  const home = tempDir("realm-home-");
  const app = await createApp({ home, port: 0, plynnMeetingsDir: o.plynnDir ?? join(home, "no-plynn") }); apps.push(app);
  const c = await client(app.port);
  const prof = (await c.call("profiles.create", { name: "School" })).result;
  const space = (await c.call("spaces.create", { profileId: prof.id, name: "EE 457" })).result;
  return { app, c, space, home };
}

describe("lectures RPC", () => {
  it("start writes today's file from the template, opens it in the pane, and broadcasts", async () => {
    const { c, space } = await setup();
    const r = (await c.call("lectures.start", { spaceId: space.id, title: "Pipelining" })).result;
    expect(r.path).toMatch(/^lectures\/\d{4}-\d{2}-\d{2}-pipelining\.md$/);
    const ws = (await c.call("documents.get", { documentsId: r.documentsId })).result;
    expect(ws).toMatchObject({ openPaths: [r.path], activePath: r.path, environmentId: r.environmentId });
    const text = (await c.call("documents.read", { documentsId: r.documentsId, path: r.path })).result.text;
    expect(text).toContain("course: EE 457\n");
    expect(text).toContain("title: Pipelining\n");
    expect(text).toContain("## Questions");
    await waitFor(() => c.events.some((e) => e.event === "documents.openRequested"));
    const ev = c.events.find((e) => e.event === "documents.openRequested");
    expect(ev.payload).toMatchObject({ spaceId: space.id, documentsId: r.documentsId, itemId: r.itemId, path: r.path });
    // The items list carries the documents pane item
    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items.find((i: any) => i.id === r.itemId)).toMatchObject({ kind: "documents" });
    c.close();
  });

  it("a second lecture with the same title on the same day gets a numbered suffix, never an overwrite", async () => {
    const { c, space } = await setup();
    const a = (await c.call("lectures.start", { spaceId: space.id, title: "Caches" })).result;
    const b = (await c.call("lectures.start", { spaceId: space.id, title: "Caches" })).result;
    const cc = (await c.call("lectures.start", { spaceId: space.id, title: "" })).result;
    expect(b.path).toBe(a.path.replace(/\.md$/, "-2.md"));
    expect(cc.path).toMatch(/^lectures\/\d{4}-\d{2}-\d{2}\.md$/);
    const ws = (await c.call("documents.get", { documentsId: a.documentsId })).result;
    expect(ws.openPaths).toEqual([a.path, b.path, cc.path]);
    expect(ws.activePath).toBe(cc.path);
    c.close();
  });

  it("list reads front-matter, sorts newest first, flags transcripts, and is empty without the folder", async () => {
    const { c, space } = await setup();
    expect((await c.call("lectures.list", { spaceId: space.id })).result.lectures).toEqual([]);
    const r = (await c.call("lectures.start", { spaceId: space.id, title: "Today" })).result;
    const root = (await c.call("environments.list", { spaceId: space.id })).result.find((e: any) => e.id === r.environmentId).path;
    writeFileSync(join(root, "lectures", "2020-01-05-old.md"), "---\ntitle: Old one\ndate: 2020-01-05\n---\n\n## Transcript\n\nwords\n");
    writeFileSync(join(root, "lectures", "undated.md"), "# Just notes\n");
    writeFileSync(join(root, "lectures", "ignored.txt"), "not a lecture");
    const list = (await c.call("lectures.list", { spaceId: space.id })).result.lectures;
    expect(list.map((l: any) => l.path)).toEqual([r.path, "lectures/2020-01-05-old.md", "lectures/undated.md"]);
    expect(list[1]).toMatchObject({ title: "Old one", date: "2020-01-05", hasTranscript: true });
    expect(list[2]).toMatchObject({ title: "Just notes", date: null, hasTranscript: false });
    expect((await c.call("lectures.list", { spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error?.code).toBe("NOT_FOUND");
    c.close();
  });
});

describe("plynn RPC", () => {
  function plynnFixture() {
    const dir = tempDir("plynn-meetings-");
    writeFileSync(join(dir, "2026-09-02 14.05 EE 457 lecture.md"), "# EE 457 lecture\n\n- Hazards\n\n---\n\n## Transcript\n\nToday we cover hazards.\n");
    writeFileSync(join(dir, "2026-09-01 09.00 Standup.md"), "Notes without a heading\n\n---\n\n## Transcript\n\nhi\n");
    writeFileSync(join(dir, "README.txt"), "not a meeting");
    return dir;
  }

  it("list reports an absent folder as unavailable rather than empty", async () => {
    const { c } = await setup();
    const r = (await c.call("plynn.list", {})).result;
    expect(r.available).toBe(false);
    expect(r.meetings).toEqual([]);
    c.close();
  });

  it("list parses the filename convention, newest first, with import state", async () => {
    const dir = plynnFixture();
    const { c } = await setup({ plynnDir: dir });
    const r = (await c.call("plynn.list", {})).result;
    expect(r.available).toBe(true);
    expect(r.folder).toBe(dir);
    expect(r.meetings.map((m: any) => m.title)).toEqual(["EE 457 lecture", "Standup"]);
    expect(r.meetings[0]).toMatchObject({ startedAt: "2026-09-02T14:05", imported: false });
    c.close();
  });

  it("import copies under lectures/ with a source header, opens the first, remembers it, and never touches Plynn's file", async () => {
    const dir = plynnFixture();
    const { c, space } = await setup({ plynnDir: dir });
    const files = (await c.call("plynn.list", {})).result.meetings.map((m: any) => m.file);
    const before = await readdir(dir);
    const r = (await c.call("plynn.import", { spaceId: space.id, files })).result;
    expect(r.skipped).toEqual([]);
    expect(r.imported.map((i: any) => i.path)).toEqual(["lectures/2026-09-02-ee-457-lecture.md", "lectures/2026-09-01-standup.md"]);
    expect(await readdir(dir)).toEqual(before); // read-only source
    const ws = (await c.call("documents.create", { spaceId: space.id })).result;
    const doc = (await c.call("documents.get", { documentsId: ws.documentsId })).result;
    expect(doc.activePath).toBe("lectures/2026-09-02-ee-457-lecture.md");
    const text = (await c.call("documents.read", { documentsId: ws.documentsId, path: "lectures/2026-09-02-ee-457-lecture.md" })).result.text;
    expect(text.startsWith("---\ncourse: EE 457\ntitle: EE 457 lecture\ndate: 2026-09-02\nsource: plynn\n")).toBe(true);
    expect(text).toContain("## Transcript\n\nToday we cover hazards.");
    // The headingless recording gets a title heading so the list has something to show.
    const second = (await c.call("documents.read", { documentsId: ws.documentsId, path: "lectures/2026-09-01-standup.md" })).result.text;
    expect(second).toContain("\n# Standup\n\nNotes without a heading");
    expect((await c.call("plynn.list", {})).result.meetings.every((m: any) => m.imported)).toBe(true);
    // Re-importing does not overwrite: it lands beside with a suffix.
    const again = (await c.call("plynn.import", { spaceId: space.id, files: [files[0]] })).result;
    expect(again.imported[0].path).toBe("lectures/2026-09-02-ee-457-lecture-2.md");
    const lectures = (await c.call("lectures.list", { spaceId: space.id })).result.lectures;
    expect(lectures.every((l: any) => l.hasTranscript)).toBe(true);
    c.close();
  });

  it("refuses paths outside the meetings folder, and fails outright when nothing could be imported", async () => {
    const dir = plynnFixture();
    const { c, space, home } = await setup({ plynnDir: dir });
    const outside = join(home, "secret.md"); writeFileSync(outside, "no");
    const r = await c.call("plynn.import", { spaceId: space.id, files: [outside, join(dir, "..", "x.md"), "relative.md"] });
    expect(r.error?.code).toBe("INVALID_PARAMS");
    const mixed = (await c.call("plynn.import", { spaceId: space.id, files: [outside, join(dir, "2026-09-01 09.00 Standup.md")] })).result;
    expect(mixed.imported).toHaveLength(1);
    expect(mixed.skipped).toEqual([{ file: outside, reason: "not a file in Plynn's meetings folder" }]);
    c.close();
  });

  it("normalizeBody adds a heading only when the notes lack one", () => {
    expect(normalizeBody("# T\n\nbody", "X")).toBe("# T\n\nbody\n");
    expect(normalizeBody("\n\nbody\n", "X")).toBe("# X\n\nbody\n");
  });
});

describe("plynn — the real default folder is never read by tests", () => {
  it("setup points every app at a scratch folder", async () => {
    const { c, home } = await setup();
    expect((await c.call("plynn.list", {})).result.folder.startsWith(home)).toBe(true);
    mkdirSync(join(home, "no-plynn"));
    expect((await c.call("plynn.list", {})).result).toMatchObject({ available: true, meetings: [] });
    c.close();
  });
});

describe("imported lecture files are real files", () => {
  it("land in the space's primary checkout on disk", async () => {
    const dir = plynnOne();
    const { c, space } = await setup({ plynnDir: dir });
    const files = (await c.call("plynn.list", {})).result.meetings.map((m: any) => m.file);
    await c.call("plynn.import", { spaceId: space.id, files });
    const env = (await c.call("environments.list", { spaceId: space.id })).result[0];
    expect(await readFile(join(env.path, "lectures", "2026-09-02-l.md"), "utf8")).toContain("source: plynn");
    c.close();
  });
  function plynnOne() {
    const dir = tempDir("plynn-meetings-");
    writeFileSync(join(dir, "2026-09-02 10.00 L.md"), "# L\n\nnotes\n");
    return dir;
  }
});
