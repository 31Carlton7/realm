import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { LIBRARY_ADD_MAX, MAX_ATTACHMENT_BYTES, sessionEvent, type LibraryAddResult, type LibraryEntry } from "@realm/contracts";
import { createApp, type App } from "../app";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { EnvironmentsStore } from "./environments";
import { SettingsStore } from "./settings";
import { ArtifactsStore } from "./artifacts";
import { LibraryFilesStore, libraryDir, numberedName, safeLibraryName } from "./library-files";

function fresh() {
  const home = tempDir("realm-library-");
  const db = openDatabase(join(home, "realm.db"));
  const settings = new SettingsStore(db);
  const profiles = new ProfilesStore(db);
  const profile = profiles.create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, home).create({ profileId: profile.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(db).ensurePrimary(space.id);
  const artifacts = new ArtifactsStore(db, settings);
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db, artifacts);
  const session = sessions.create({
    spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null,
    permissionMode: "default", environmentId: env.id, title: "The parser rewrite",
  });
  const files = new LibraryFilesStore(db, home);
  // Where the person's own files are — the Desktop a picker or a drop names them from.
  const desk = join(home, "desk");
  mkdirSync(desk);
  const put = (rel: string, text: string) => {
    const p = join(desk, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  return { db, home, profile, profiles, space, session, sessions, events, artifacts, files, desk, put };
}

const write = (path: string) => sessionEvent("tool_call", { toolUseId: `t${path}`, name: "Write", input: { file_path: path }, parentToolUseId: null });
const rows = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT COUNT(*) AS n FROM library_files").get() as { n: number }).n;

describe("adding files to the Library", () => {
  it("copies the file into the profile's own folder, leaves the original alone, and lists it beside what sessions made", async () => {
    /* THE mutants: keep a pointer to where the file was rather than a copy (the Library loses it the
       moment the original moves), or list only the index (the file is added and never shown). */
    const { home, profile, session, events, artifacts, files, put } = fresh();
    // Long before anything is added, so the order of the two is the order they happened in.
    events.append(session.id, { ...write("/tmp/plan.md"), ts: 1 });
    const original = put("notes.md", "# Notes\n");
    const r = await files.add({ profileId: profile.id, paths: [original] });
    expect(r.skipped).toEqual([]);
    expect(r.added).toHaveLength(1);
    const copy = r.added[0]!;
    expect(copy).toMatchObject({ kind: "added", name: "notes.md", ext: "md", sessionId: null, spaceId: null, sessionTitle: null });
    expect(copy.path).toBe(join(libraryDir(home, profile.id), "notes.md"));
    expect(copy.path).not.toBe(original);
    expect(readFileSync(copy.path, "utf8")).toBe("# Notes\n");
    expect(readFileSync(original, "utf8")).toBe("# Notes\n");
    rmSync(original);
    expect(existsSync(copy.path)).toBe(true);
    expect(artifacts.list({ profileId: profile.id }).map((e) => [e.name, e.kind])).toEqual([["notes.md", "added"], ["plan.md", "output"]]);
  });

  it("keeps a different file of the same name beside the first as `name 2`, and never writes over a file", async () => {
    /* THE mutant: open the copy for writing without `wx`. The second report.md replaces the first,
       and a file already in the folder that no row names is written over too. */
    const { home, db, profile, files, put } = fresh();
    const one = await files.add({ profileId: profile.id, paths: [put("a/report.md", "one")] });
    const two = await files.add({ profileId: profile.id, paths: [put("b/report.md", "two")] });
    expect(two.added.map((e) => e.name)).toEqual(["report 2.md"]);
    expect(two.renamed).toEqual([{ from: "report.md", to: "report 2.md" }]);
    expect(readFileSync(one.added[0]!.path, "utf8")).toBe("one");
    expect(readFileSync(two.added[0]!.path, "utf8")).toBe("two");
    // A file in the folder no row names — put there by hand — is no more overwritten than a listed one.
    writeFileSync(join(libraryDir(home, profile.id), "draft.txt"), "mine");
    const three = await files.add({ profileId: profile.id, paths: [put("draft.txt", "theirs")] });
    expect(three.added.map((e) => e.name)).toEqual(["draft 2.txt"]);
    expect(readFileSync(join(libraryDir(home, profile.id), "draft.txt"), "utf8")).toBe("mine");
    expect(rows(db)).toBe(3);
  });

  it("does not copy the same file twice — the same bytes under any name, or a file the Library already lists", async () => {
    /* THE mutants: no digest check (a second copy of the same picture), or no path check (a tile
       dragged back onto its own page, or a session's output, copied in beside itself). */
    const { db, home, profile, session, events, files, put } = fresh();
    const first = await files.add({ profileId: profile.id, paths: [put("photo.png", "PIXELS")] });
    const again = await files.add({ profileId: profile.id, paths: [put("elsewhere/copy of photo.png", "PIXELS")] });
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual([{ name: "copy of photo.png", reason: "duplicate", size: null, existing: "photo.png" }]);
    // One of the Library's own copies, chosen again.
    const own = await files.add({ profileId: profile.id, paths: [first.added[0]!.path] });
    expect(own.skipped.map((s) => [s.reason, s.existing])).toEqual([["duplicate", "photo.png"]]);
    // A file a session made, which the Library lists already.
    const made = join(home, "work", "out.md");
    mkdirSync(join(home, "work"));
    writeFileSync(made, "made by the agent");
    events.append(session.id, write(made));
    const out = await files.add({ profileId: profile.id, paths: [made] });
    expect(out.skipped.map((s) => [s.reason, s.existing])).toEqual([["duplicate", "out.md"]]);
    // The same file twice in one add is one file.
    const twice = put("twice.txt", "same");
    const both = await files.add({ profileId: profile.id, paths: [twice, twice] });
    expect(both.added.map((e) => e.name)).toEqual(["twice.txt"]);
    expect(both.skipped.map((s) => s.reason)).toEqual(["duplicate"]);
    expect(rows(db)).toBe(2);
  });

  it("puts a copy deleted from the folder by hand back, rather than calling it already there", async () => {
    const { db, profile, files, put } = fresh();
    const src = put("scan.pdf", "%PDF-1.7");
    const first = await files.add({ profileId: profile.id, paths: [src] });
    rmSync(first.added[0]!.path);
    const back = await files.add({ profileId: profile.id, paths: [src] });
    expect(back.skipped).toEqual([]);
    expect(back.added.map((e) => e.name)).toEqual(["scan.pdf"]);
    expect(existsSync(back.added[0]!.path)).toBe(true);
    expect(rows(db)).toBe(1);
  });

  it("refuses a file past the attachment ceiling, saying how big it is, and copies none of it", async () => {
    const { home, profile, files, put } = fresh();
    const big = put("movie.mov", "");
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
    const ok = put("small.txt", "fine");
    const r = await files.add({ profileId: profile.id, paths: [big, ok] });
    expect(r.skipped).toEqual([{ name: "movie.mov", reason: "too-large", size: MAX_ATTACHMENT_BYTES + 1, existing: null }]);
    expect(r.added.map((e) => e.name)).toEqual(["small.txt"]);
    expect(readdirSync(libraryDir(home, profile.id))).toEqual(["small.txt"]);
  });

  it("never follows a link, chosen or inside a folder", async () => {
    /* THE mutants: `stat` where it should be `lstat` (the chosen link is followed to whatever it names),
       or a folder's links listed with its files. */
    const { home, profile, files, put, desk } = fresh();
    const secret = join(home, "secret.txt");
    writeFileSync(secret, "not chosen");
    symlinkSync(secret, join(desk, "shortcut.txt"));
    const chosen = await files.add({ profileId: profile.id, paths: [join(desk, "shortcut.txt")] });
    expect(chosen.added).toEqual([]);
    expect(chosen.skipped.map((s) => [s.name, s.reason])).toEqual([["shortcut.txt", "link"]]);
    put("album/one.png", "1");
    symlinkSync(secret, join(desk, "album", "two.png"));
    const folder = await files.add({ profileId: profile.id, paths: [join(desk, "album")], folders: true });
    expect(folder.added.map((e) => e.name)).toEqual(["one.png"]);
    expect(folder.skipped.map((s) => [s.name, s.reason])).toEqual([["two.png", "link"]]);
    expect(readdirSync(libraryDir(home, profile.id))).toEqual(["one.png"]);
  });

  it("describes a folder rather than copying it, until asked to add its own files", async () => {
    /* A folder is a question before it is a copy. THE mutants: copy a folder's files on the first
       ask, take the folders inside it too, or take what is hidden (`.DS_Store`). */
    const { home, profile, files, put, desk } = fresh();
    put("shots/a.png", "aa");
    put("shots/b.png", "bbb");
    put("shots/.DS_Store", "finder");
    put("shots/old/c.png", "c");
    const asked = await files.add({ profileId: profile.id, paths: [join(desk, "shots")] });
    expect(asked.added).toEqual([]);
    expect(asked.folders).toEqual([{ path: join(desk, "shots"), name: "shots", files: 2, bytes: 5, subfolders: 1, more: false }]);
    expect(existsSync(libraryDir(home, profile.id))).toBe(false);
    const added = await files.add({ profileId: profile.id, paths: [join(desk, "shots")], folders: true });
    expect(added.added.map((e) => e.name)).toEqual(["a.png", "b.png"]);
    expect(added.folders).toEqual([]);
    expect(readdirSync(libraryDir(home, profile.id)).sort()).toEqual(["a.png", "b.png"]);
  });

  it("refuses more files than one add takes, before copying any", async () => {
    const { db, home, profile, files, desk } = fresh();
    mkdirSync(join(desk, "dump"));
    for (let i = 0; i <= LIBRARY_ADD_MAX; i++) writeFileSync(join(desk, "dump", `f${i}.txt`), String(i));
    const asked = await files.add({ profileId: profile.id, paths: [join(desk, "dump")] });
    expect(asked.folders[0]).toMatchObject({ files: LIBRARY_ADD_MAX + 1, more: true });
    await expect(files.add({ profileId: profile.id, paths: [join(desk, "dump")], folders: true })).rejects.toThrow(/at a time/);
    expect(rows(db)).toBe(0);
    expect(existsSync(libraryDir(home, profile.id))).toBe(false);
  });

  it("refuses what it cannot read, and a profile that does not exist", async () => {
    const { profile, files, desk } = fresh();
    const r = await files.add({ profileId: profile.id, paths: [join(desk, "gone.md"), "relative/notes.md"] });
    expect(r.skipped.map((s) => [s.name, s.reason])).toEqual([["gone.md", "unreadable"], ["notes.md", "unreadable"]]);
    await expect(files.add({ profileId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", paths: [join(desk, "x")] })).rejects.toThrow(/not found/);
  });

  it("takes one add at a time, so the same file dropped twice at once is copied once", async () => {
    // THE mutant: no queue — both adds pass the duplicate check before either has written its row.
    const { db, profile, files, put } = fresh();
    const src = put("twice.png", "PIXELS");
    const [a, b] = await Promise.all([files.add({ profileId: profile.id, paths: [src] }), files.add({ profileId: profile.id, paths: [src] })]);
    expect([...a.added, ...b.added]).toHaveLength(1);
    expect([...a.skipped, ...b.skipped].map((s) => s.reason)).toEqual(["duplicate"]);
    expect(rows(db)).toBe(1);
  });
});

describe("the name a copy is kept under", () => {
  it("is the file's own name, made safe to keep: no separator, never hidden, never too long", () => {
    expect(safeLibraryName("Q3 report.pdf")).toBe("Q3 report.pdf");
    expect(safeLibraryName("a:b.png")).toBe("a-b.png");
    expect(safeLibraryName("line\nbreak.txt")).toBe("line-break.txt");
    expect(safeLibraryName(".env")).toBe("env");
    expect(safeLibraryName("..")).toBe("file");
    expect(safeLibraryName("/etc/passwd")).toBe("passwd");
    // Decomposed, as the Finder hands some names over, and composed as they were typed.
    expect(safeLibraryName("Café.md")).toBe("Café.md");
    const long = safeLibraryName(`${"é".repeat(150)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("numbers a second file of the same name the way the Finder does", () => {
    expect(numberedName("report.pdf", 1)).toBe("report.pdf");
    expect(numberedName("report.pdf", 2)).toBe("report 2.pdf");
    expect(numberedName("Makefile", 3)).toBe("Makefile 3");
  });
});

describe("the Library's two sources, read as one list", () => {
  /** A row as `add` writes it, at a chosen moment — what the paging cases need, without a clock. */
  const insertAdded = (db: ReturnType<typeof openDatabase>, profileId: string, name: string, ts: number) =>
    db.prepare("INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .run(`F${name}`, profileId, `/lib/${name}`, name, name.split(".").pop()!, name, ts);

  it("lists an added file in its profile, by kind, type and name — and never in a space or a session", async () => {
    /* An added file belongs to a profile and to no session. THE mutants: every profile's added files
       in every window, or an added file listed under "In this space" or a session's own files. */
    const { db, profile, profiles, space, session, events, artifacts, files, put } = fresh();
    const other = profiles.create({ name: "Other", icon: "x", color: "#111" });
    events.append(session.id, { ...write("/tmp/plan.md"), ts: 1 });
    await files.add({ profileId: profile.id, paths: [put("shot.png", "png")] });
    await files.add({ profileId: other.id, paths: [put("theirs.md", "theirs")] });
    const names = (q: Parameters<typeof artifacts.list>[0]) => artifacts.list(q).map((e) => e.name);
    expect(names({ profileId: profile.id })).toEqual(["shot.png", "plan.md"]);
    expect(names({ profileId: other.id })).toEqual(["theirs.md"]);
    expect(names({ profileId: profile.id, kind: "added" })).toEqual(["shot.png"]);
    expect(names({ profileId: profile.id, kind: "output" })).toEqual(["plan.md"]);
    expect(names({ profileId: profile.id, type: "image" })).toEqual(["shot.png"]);
    expect(names({ profileId: profile.id, type: "document" })).toEqual(["plan.md"]);
    expect(names({ profileId: profile.id, query: "sho" })).toEqual(["shot.png"]);
    expect(names({ spaceId: space.id })).toEqual(["plan.md"]);
    expect(names({ sessionId: session.id, perFile: true })).toEqual(["plan.md"]);
    expect(names({ profileId: profile.id, perFile: true })).toEqual(["shot.png", "plan.md"]);
    expect(artifacts.count(null, profile.id)).toBe(2);
    expect(artifacts.count(null, profile.id, { perFile: true })).toBe(2);
    expect(artifacts.count(space.id)).toBe(1);
    expect(artifacts.count(null, null, { sessionId: session.id })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_files").get()).toEqual({ n: 2 });
  });

  it("pages across both sources by one keyset, neither repeating nor dropping a row", () => {
    /* THE mutant: the cursor applied to one source only — every page lists the other source's newest
       rows again. */
    const { db, profile, session, events, artifacts } = fresh();
    for (const [name, ts] of [["a.md", 600], ["c.md", 400], ["e.md", 200]] as const) events.append(session.id, { ...write(`/tmp/${name}`), ts });
    for (const [name, ts] of [["b.png", 500], ["d.png", 300], ["f.png", 100]] as const) insertAdded(db, profile.id, name, ts);
    const seen: string[] = [];
    let before: { ts: number; id: string } | null = null;
    for (let page = 0; page < 5; page++) {
      const rowsOf = artifacts.list({ profileId: profile.id, limit: 2, before });
      if (rowsOf.length === 0) break;
      seen.push(...rowsOf.map((e) => e.name));
      before = { ts: rowsOf.at(-1)!.ts, id: rowsOf.at(-1)!.id };
    }
    expect(seen).toEqual(["a.md", "b.png", "c.md", "d.png", "e.md", "f.png"]);
  });

  it("goes with its profile", async () => {
    const { db, profile, profiles, files, put } = fresh();
    const other = profiles.create({ name: "Other", icon: "x", color: "#111" });
    await files.add({ profileId: other.id, paths: [put("theirs.md", "theirs")] });
    await files.add({ profileId: profile.id, paths: [put("mine.md", "mine")] });
    profiles.delete(other.id);
    expect(db.prepare("SELECT name FROM library_files").all()).toEqual([{ name: "mine.md" }]);
  });
});

describe("library.add over rpc", () => {
  let app: App | null = null;
  afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

  /** One request on a fresh socket — the shape the renderer's client sends. */
  async function call<T>(port: number, method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> {
    const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
    try {
      return await new Promise((res) => {
        ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id === "1") res(m); });
        ws.send(JSON.stringify({ id: "1", method, params }));
      });
    } finally { ws.close(); }
  }

  it("copies a picked file in and lists it in the profile's Library, where the next read finds it", async () => {
    // THE mutant: the method left unregistered, or the store left out of the app's wiring.
    const home = tempDir("realm-library-rpc-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0 });
    const [profile] = (await call<{ id: string }[]>(app.port, "profiles.list", {})).result!;
    const src = join(home, "brief.pdf");
    writeFileSync(src, "%PDF-1.7");
    const added = (await call<LibraryAddResult>(app.port, "library.add", { profileId: profile!.id, paths: [src] })).result!;
    expect(added.added.map((e) => e.name)).toEqual(["brief.pdf"]);
    const page = (await call<{ entries: LibraryEntry[]; total: number }>(app.port, "library.artifacts", { profileId: profile!.id })).result!;
    expect(page.entries.map((e) => [e.name, e.kind, e.sessionId])).toEqual([["brief.pdf", "added", null]]);
    expect(page.total).toBe(1);
    expect(readFileSync(join(home, "library", profile!.id, "brief.pdf"), "utf8")).toBe("%PDF-1.7");
    // An add of nothing is refused by the contract, before anything is asked of the disk.
    const bad = (await call(app.port, "library.add", { profileId: profile!.id, paths: [] })).error;
    expect(bad?.code).toBeTruthy();
  });
});
