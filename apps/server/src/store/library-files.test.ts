import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { LIBRARY_ADD_MAX, MAX_ATTACHMENT_BYTES, sessionEvent, type LibraryAddResult, type LibraryEntry, type LibraryRemoveResult, type LibraryRestoreResult } from "@realm/contracts";
import { createApp, type App } from "../app";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { EnvironmentsStore } from "./environments";
import { SettingsStore } from "./settings";
import { ArtifactsStore } from "./artifacts";
import { LIBRARY_UNDO_MS, LibraryFilesStore, isLibraryCopy, libraryDir, numberedName, safeLibraryName } from "./library-files";

/* A file swapped for a link AFTER it was looked at: `lstat` of `path` answers for `as`, a regular file,
   the way it would have the instant before the swap. Everything else is the real filesystem. */
const swapped = vi.hoisted(() => ({ path: null as string | null, as: null as string | null }));
/* A move the disk refuses: a rename OUT of `from` fails as a full or read-only disk would. */
const refused = vi.hoisted(() => ({ from: null as string | null }));
vi.mock("node:fs/promises", async (real) => {
  const fs = await real<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: ((p: string, ...rest: never[]) => fs.lstat(p === swapped.path && swapped.as ? swapped.as : p, ...rest)) as typeof fs.lstat,
    rename: ((from: string, to: string) => (from === refused.from
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), { code: "EACCES" }))
      : fs.rename(from, to))) as typeof fs.rename,
  };
});

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

  it("refuses a file past the attachment ceiling by its size, before reading any of it", async () => {
    /* THE mutant: judge the size only after reading the file whole. A 3 GB file is refused by
       `readFile` itself then, as unreadable, after an attempt to hold all of it in memory. Both files
       are sparse: they take no room on disk. */
    const { home, profile, files, put } = fresh();
    const big = put("movie.mov", "");
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
    const huge = put("disk.img", "");
    truncateSync(huge, 3 * 1024 ** 3);
    const ok = put("small.txt", "fine");
    const r = await files.add({ profileId: profile.id, paths: [big, huge, ok] });
    expect(r.skipped).toEqual([
      { name: "movie.mov", reason: "too-large", size: MAX_ATTACHMENT_BYTES + 1, existing: null },
      { name: "disk.img", reason: "too-large", size: 3 * 1024 ** 3, existing: null },
    ]);
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
    // The offer counts what would be copied, so a folder's links are not in its count either.
    const offer = await files.add({ profileId: profile.id, paths: [join(desk, "album")] });
    expect(offer.folders.map((f) => [f.files, f.bytes])).toEqual([[1, 1]]);
    const folder = await files.add({ profileId: profile.id, paths: [join(desk, "album")], folders: true });
    expect(folder.added.map((e) => e.name)).toEqual(["one.png"]);
    expect(folder.skipped.map((s) => [s.name, s.reason])).toEqual([["two.png", "link"]]);
    expect(readdirSync(libraryDir(home, profile.id))).toEqual(["one.png"]);
  });

  it("refuses a file that became a link after it was looked at, rather than reading where it points", async () => {
    /* The check and the read are two moments, and a link can be put in between them. THE mutant: open
       the source without O_NOFOLLOW — the look said "a file", and the read follows the link. */
    const { home, profile, files, desk } = fresh();
    const secret = join(home, "secret.txt");
    writeFileSync(secret, "not chosen");
    writeFileSync(join(desk, "before.txt"), "a plain file");
    symlinkSync(secret, join(desk, "after.txt"));
    Object.assign(swapped, { path: join(desk, "after.txt"), as: join(desk, "before.txt") });
    try {
      const r = await files.add({ profileId: profile.id, paths: [join(desk, "after.txt")] });
      expect(r.added).toEqual([]);
      expect(r.skipped.map((s) => [s.name, s.reason])).toEqual([["after.txt", "link"]]);
    } finally { Object.assign(swapped, { path: null, as: null }); }
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

describe("removing files from the Library", () => {
  afterEach(() => { refused.from = null; vi.useRealTimers(); });

  const upload = (path: string) => sessionEvent("user_message", { text: "Look at this", attachments: [{ path, mime: "image/png" }] });
  const listed = (artifacts: ArtifactsStore, profileId: string) => artifacts.list({ profileId }).map((e) => [e.name, e.kind]);
  /** What the profile's folder holds, set-aside folder and all, by name. */
  const onDisk = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

  it("deletes Realm's copy and its row — never the file it was copied from — and leaves the rest as they were", async () => {
    /* THE mutants: forget the row and leave the copy on disk (the Library frees nothing, and an add of
       the same name is numbered for ever), or take the file at the path it was CHOSEN from. */
    const { db, home, profile, artifacts, files, put } = fresh();
    const original = put("hero.png", "PNG-hero");
    const r = await files.add({ profileId: profile.id, paths: [original, put("notes.md", "# Notes")] });
    const copy = r.added.find((e) => e.name === "hero.png")!;
    const out = await files.remove({ profileId: profile.id, paths: [copy.path] });
    expect(out.removed.map((e) => [e.id, e.name, e.kind])).toEqual([[copy.id, "hero.png", "added"]]);
    expect(out.removal).toBeTruthy();
    expect(out.messages).toBe(0);
    expect(existsSync(copy.path)).toBe(false);
    expect(readFileSync(original, "utf8")).toBe("PNG-hero");
    expect(listed(artifacts, profile.id)).toEqual([["notes.md", "added"]]);
    expect(rows(db)).toBe(1);
    // Set aside, hidden, until the undo or the end of the hold — not yet gone from the disk.
    expect(onDisk(libraryDir(home, profile.id))).toEqual([".removed", "notes.md"]);
  });

  it("puts a removed file back exactly as it was: its bytes, its name and its place in the list", async () => {
    /* THE mutant: put the row back as a new one — a fresh id, or the time of the undo — and the file
       lands at the top of the list rather than where it was taken from. */
    const { home, profile, artifacts, files, put } = fresh();
    const r = await files.add({ profileId: profile.id, paths: [put("a.md", "first"), put("b.png", "PNG-second"), put("c.pdf", "%PDF-third")] });
    const before = artifacts.list({ profileId: profile.id }).map((e) => [e.id, e.name, e.ts]);
    const b = r.added.find((e) => e.name === "b.png")!;
    const out = await files.remove({ profileId: profile.id, paths: [b.path] });
    expect(artifacts.list({ profileId: profile.id }).map((e) => e.name)).toEqual(["a.md", "c.pdf"]);
    const back = await files.restore({ removal: out.removal! });
    expect(back).toEqual({ restored: [b], renamed: [] });
    expect(artifacts.list({ profileId: profile.id }).map((e) => [e.id, e.name, e.ts])).toEqual(before);
    expect(readFileSync(b.path, "utf8")).toBe("PNG-second");
    expect(onDisk(libraryDir(home, profile.id))).toEqual(["a.md", "b.png", "c.pdf"]);
    // An undo is one undo: asked again, there is nothing left to put back.
    await expect(files.restore({ removal: out.removal! })).rejects.toMatchObject({ code: "LIBRARY_UNDO_GONE" });
  });

  it("removes only what was added: a session's files are left alone whatever path is asked for", async () => {
    /* THE mutant: take any file the Library LISTS. An agent's output and a file attached from the
       Desktop are the session's work, and a removal must never be able to reach them. */
    const { db, profile, session, events, artifacts, files, put } = fresh();
    const written = put("plan.md", "the plan");
    const attached = put("shot.png", "PNG-shot");
    events.append(session.id, { ...write(written), ts: 1 });
    events.append(session.id, { ...upload(attached), ts: 2 });
    const out = await files.remove({ profileId: profile.id, paths: [written, attached] });
    expect(out).toEqual({ removed: [], messages: 0, removal: null });
    expect(readFileSync(written, "utf8")).toBe("the plan");
    expect(readFileSync(attached, "utf8")).toBe("PNG-shot");
    expect(listed(artifacts, profile.id)).toEqual([["shot.png", "upload"], ["plan.md", "output"]]);
    expect(rows(db)).toBe(0);
  });

  it("never deletes outside the profile's folder: a row naming a file elsewhere, or walking out with `..`, loses only its row", async () => {
    /* THE mutant: trust the row's path. A row is only a string in a database, and a path that names
       the Desktop, another profile's folder or `../..` is a file Realm did not make. */
    const { db, home, profile, profiles, files, put } = fresh();
    const other = profiles.create({ name: "Other", icon: "x", color: "#111" });
    const theirs = (await files.add({ profileId: other.id, paths: [put("theirs.md", "theirs")] })).added[0]!;
    const desktop = put("taxes.pdf", "%PDF-taxes");
    const dir = libraryDir(home, profile.id);
    // Written out, not `join`ed: `join` would resolve the `..` before the row ever held it.
    const walked = `${dir}/../${other.id}/theirs.md`;
    const insert = db.prepare("INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)");
    insert.run("Fdesk", profile.id, desktop, "taxes.pdf", "pdf", "d1", 2);
    insert.run("Fwalk", profile.id, walked, "theirs.md", "md", "d2", 1);
    // Another profile's copy, named exactly, is that profile's to remove and not this one's.
    expect(await files.remove({ profileId: profile.id, paths: [theirs.path] })).toEqual({ removed: [], messages: 0, removal: null });
    expect(rows(db)).toBe(3);
    const out = await files.remove({ profileId: profile.id, paths: [desktop, walked] });
    expect(out.removed.map((e) => e.id).sort()).toEqual(["Fdesk", "Fwalk"]);
    expect(readFileSync(desktop, "utf8")).toBe("%PDF-taxes");
    expect(readFileSync(theirs.path, "utf8")).toBe("theirs");
    expect(rows(db)).toBe(1); // the other profile's own
    expect(isLibraryCopy(dir, walked)).toBe(false);
    expect(isLibraryCopy(dir, desktop)).toBe(false);
    expect(isLibraryCopy(dir, join(dir, ".removed"))).toBe(false);
    expect(isLibraryCopy(dir, join(dir, "sub", "x.md"))).toBe(false);
    expect(isLibraryCopy(dir, join(dir, "x.md"))).toBe(true);
    // Undone, the rows come back as they were, and nothing on disk has moved either way.
    await files.restore({ removal: out.removal! });
    expect(rows(db)).toBe(3);
    expect(readFileSync(desktop, "utf8")).toBe("%PDF-taxes");
  });

  it("leaves a link standing where a copy was, and what it points to, through the end of the hold", async () => {
    /* THE mutant: follow the link (`stat`, or a `realpath` before the move) — and the file it names,
       on the person's Desktop, is the one set aside and deleted. */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { db, home, profile, files, put } = fresh();
    const target = put("hero.png", "PNG-hero");
    const dir = libraryDir(home, profile.id);
    mkdirSync(dir, { recursive: true });
    const linked = join(dir, "hero.png");
    symlinkSync(target, linked);
    db.prepare("INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts) VALUES ('Flink', ?, ?, 'hero.png', 'png', 8, 'd', 1)").run(profile.id, linked);
    const out = await files.remove({ profileId: profile.id, paths: [linked] });
    expect(out.removed.map((e) => e.id)).toEqual(["Flink"]);
    expect(rows(db)).toBe(0);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    await vi.advanceTimersByTimeAsync(LIBRARY_UNDO_MS);
    await files.sweep();
    expect(readFileSync(target, "utf8")).toBe("PNG-hero");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it("refuses to set copies aside through a link planted where their folder goes, and moves nothing", async () => {
    /* THE mutant: make the folder and trust it. A link at `.removed` carries every copy out of the
       Library, to be deleted wherever it points when the hold ends. */
    const { db, home, profile, files, put, desk } = fresh();
    const copy = (await files.add({ profileId: profile.id, paths: [put("notes.md", "# Notes")] })).added[0]!;
    const elsewhere = join(desk, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(libraryDir(home, profile.id), ".removed"));
    await expect(files.remove({ profileId: profile.id, paths: [copy.path] })).rejects.toMatchObject({ code: "LIBRARY_UNWRITABLE" });
    expect(readFileSync(copy.path, "utf8")).toBe("# Notes");
    expect(rows(db)).toBe(1);
    // Not so much as an empty folder made there.
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("happens whole or not at all: a copy the disk will not move puts back the ones moved before it", async () => {
    /* THE mutant: stop where the move failed — the first file is set aside, its row still listed, and
       the Library shows a file that is not where it says. */
    const { db, profile, files, put } = fresh();
    const r = await files.add({ profileId: profile.id, paths: [put("a.md", "A"), put("b.md", "B")] });
    const [a, b] = [r.added.find((e) => e.name === "a.md")!, r.added.find((e) => e.name === "b.md")!];
    refused.from = b.path;
    await expect(files.remove({ profileId: profile.id, paths: [a.path, b.path] })).rejects.toMatchObject({ code: "LIBRARY_UNWRITABLE" });
    expect(readFileSync(a.path, "utf8")).toBe("A");
    expect(readFileSync(b.path, "utf8")).toBe("B");
    expect(rows(db)).toBe(2);
  });

  it("deletes the copies for good once the hold ends, and an undo after it says so", async () => {
    /* THE mutant: no end to the hold. Every removed file stays on disk, hidden, until the app is next
       started — and a removal that frees nothing is not one. */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { home, profile, files, put } = fresh();
    const copy = (await files.add({ profileId: profile.id, paths: [put("big.mov", "MOV")] })).added[0]!;
    const out = await files.remove({ profileId: profile.id, paths: [copy.path] });
    const dir = libraryDir(home, profile.id);
    expect(readdirSync(join(dir, ".removed", out.removal!))).toEqual(["big.mov"]);
    await vi.advanceTimersByTimeAsync(LIBRARY_UNDO_MS - 1);
    expect(readdirSync(join(dir, ".removed", out.removal!))).toEqual(["big.mov"]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(files.restore({ removal: out.removal! })).rejects.toMatchObject({ code: "LIBRARY_UNDO_GONE" });
    expect(onDisk(dir)).toEqual([]);
  });

  it("deletes at boot what a last run set aside, file by file, and nothing a link inside it points to", async () => {
    /* THE mutant: walk into whatever the set-aside folder holds — a link to a folder on the Desktop is
       read as one of its own, and the Desktop's files are deleted. */
    const { home, profile, files, put, desk } = fresh();
    const kept = (await files.add({ profileId: profile.id, paths: [put("kept.md", "kept")] })).added[0]!;
    const aside = join(libraryDir(home, profile.id), ".removed");
    mkdirSync(join(aside, "R1"), { recursive: true });
    writeFileSync(join(aside, "R1", "old.png"), "PNG-old");
    const precious = put("precious.txt", "precious");
    symlinkSync(precious, join(aside, "R1", "link.txt"));
    mkdirSync(join(desk, "photos"));
    writeFileSync(join(desk, "photos", "beach.jpg"), "JPG");
    symlinkSync(join(desk, "photos"), join(aside, "R2"));
    await files.sweep();
    expect(readFileSync(precious, "utf8")).toBe("precious");
    expect(readFileSync(join(desk, "photos", "beach.jpg"), "utf8")).toBe("JPG");
    expect(existsSync(join(aside, "R1"))).toBe(false);
    expect(readFileSync(kept.path, "utf8")).toBe("kept");
  });

  it("takes the Library's listing of a copy sent with a message, says how many messages had it, and gives it back with the undo", async () => {
    /* THE mutants: leave the message's listing (the Library goes on showing a file that is gone, as
       "Attached to…"), or forget to bring it back with the copy. The message itself is never touched. */
    const { profile, session, events, artifacts, files, put } = fresh();
    const copy = (await files.add({ profileId: profile.id, paths: [put("hero.png", "PNG-hero")] })).added[0]!;
    events.append(session.id, { ...upload(copy.path), ts: copy.ts + 10 });
    events.append(session.id, { ...upload(copy.path), ts: copy.ts + 20 });
    const before = artifacts.list({ profileId: profile.id }).map((e) => [e.id, e.kind]);
    expect(before.map(([, kind]) => kind)).toEqual(["upload", "upload", "added"]);
    const out = await files.remove({ profileId: profile.id, paths: [copy.path] });
    expect(out.messages).toBe(2);
    expect(listed(artifacts, profile.id)).toEqual([]);
    expect(events.listAfter(session.id, 0, 100).filter((e) => e.event.type === "user_message")).toHaveLength(2);
    await files.restore({ removal: out.removal! });
    expect(artifacts.list({ profileId: profile.id }).map((e) => [e.id, e.kind])).toEqual(before);
  });

  it("never writes over a file added since under the same name: the copy goes back beside it", async () => {
    /* THE mutant: move the copy back with a rename, which replaces whatever has the name — the file
       added in the meantime is lost to the undo of another one. */
    const { profile, artifacts, files, put } = fresh();
    const first = (await files.add({ profileId: profile.id, paths: [put("notes.md", "# Launch")] })).added[0]!;
    const out = await files.remove({ profileId: profile.id, paths: [first.path] });
    const second = (await files.add({ profileId: profile.id, paths: [put("other/notes.md", "# Review")] })).added[0]!;
    expect(second.path).toBe(first.path);
    const back = await files.restore({ removal: out.removal! }) as LibraryRestoreResult;
    expect(back.renamed).toEqual([{ from: "notes.md", to: "notes 2.md" }]);
    expect(readFileSync(second.path, "utf8")).toBe("# Review");
    expect(readFileSync(back.restored[0]!.path, "utf8")).toBe("# Launch");
    expect(artifacts.list({ profileId: profile.id }).map((e) => [e.id, e.name])).toEqual([[second.id, "notes.md"], [first.id, "notes 2.md"]]);
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

  it("takes an added file out and puts it back, and the next read says each", async () => {
    // THE mutant: either method left unregistered.
    const home = tempDir("realm-library-rpc-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0 });
    const port = app.port;
    const [profile] = (await call<{ id: string }[]>(port, "profiles.list", {})).result!;
    const src = join(home, "brief.pdf");
    writeFileSync(src, "%PDF-1.7");
    const copy = (await call<LibraryAddResult>(port, "library.add", { profileId: profile!.id, paths: [src] })).result!.added[0]!;
    const read = async () => (await call<{ entries: LibraryEntry[]; total: number }>(port, "library.artifacts", { profileId: profile!.id })).result!;
    const out = (await call<LibraryRemoveResult>(port, "library.remove", { profileId: profile!.id, paths: [copy.path] })).result!;
    expect(out.removed.map((e) => e.name)).toEqual(["brief.pdf"]);
    expect(await read()).toEqual({ entries: [], total: 0 });
    const back = (await call<LibraryRestoreResult>(port, "library.restore", { removal: out.removal })).result!;
    expect(back.restored).toEqual([copy]);
    expect((await read()).entries).toEqual([copy]);
    expect(readFileSync(src, "utf8")).toBe("%PDF-1.7");
  });
});
