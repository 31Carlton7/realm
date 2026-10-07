import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  extOf, LIBRARY_ADD_MAX, LibraryAddSchema, LibraryRemoveSchema, LibraryRestoreSchema, MAX_ATTACHMENT_BYTES, newId,
  type LibraryAddInput, type LibraryAddResult, type LibraryEntry, type LibraryRemoveInput, type LibraryRemoveResult,
  type LibraryRestoreInput, type LibraryRestoreResult,
} from "@realm/contracts";
import type { Db } from "../db/database";
import { NotFoundError, RpcError, now } from "./rows";

/** Where a profile's added files are kept: in the Realm home, under the profile's id — which, unlike
 *  its name, never changes, so a renamed profile does not strand its files under the old one. */
export const libraryDir = (home: string, profileId: string): string => join(home, "library", profileId);

/** The longest name a copy is given, in bytes. APFS keeps 255; the room left is for ` 2` and the like. */
const NAME_MAX_BYTES = 200;

/**
 * The name a copy is kept under: the chosen file's own, as far as it can be, because the Library shows
 * it. Never a path — no separator, no `..`, and no `:`, which the Finder shows as one — never hidden,
 * since a copy the Finder will not show is one nobody can find, no control characters, and short
 * enough that a numbered twin still fits. Composed, so a name the Finder handed over decomposed is
 * searched and compared the way it was typed.
 */
export function safeLibraryName(name: string): string {
  const clean = basename(name).normalize("NFC")
    .replace(/[\u0000-\u001f\u007f:]+/g, "-").replace(/^[\s.]+/, "").trim();
  if (clean === "") return "file";
  if (Buffer.byteLength(clean) <= NAME_MAX_BYTES) return clean;
  const ext = extOf(clean);
  const tail = ext === "" ? "" : `.${ext}`;
  let stem = clean.slice(0, clean.length - tail.length);
  while (Buffer.byteLength(stem + tail) > NAME_MAX_BYTES) stem = [...stem].slice(0, -1).join("");
  return stem + tail;
}

/** Where removed copies wait while their removal can still be undone: in the profile's own folder, so
 *  putting one back is a move on the same disk, and hidden, because nothing in it is the Library's any
 *  more. No copy can be given the name — `safeLibraryName` never starts one with a dot. */
const SET_ASIDE = ".removed";

/** How long a removal can be undone. The toast's Undo is up for seconds, longer only while it is read;
 *  this is the backstop for a window closed with one up. Past it, the copies are deleted for good. */
export const LIBRARY_UNDO_MS = 10 * 60_000;

/**
 * Whether `path` names one of the copies Realm keeps in `dir`: a name directly in the profile's own
 * folder, as an add writes one. Never a path that walks out with `..`, one in a folder inside it, or
 * the folder the removed wait in — the only paths a removal may take a file from.
 */
export function isLibraryCopy(dir: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const at = resolve(path);
  const name = basename(at);
  return dirname(at) === resolve(dir) && name !== "" && !name.startsWith(".");
}

/** The Finder's name for a second file of the same name, kept beside the first: `report 2.pdf`. */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name;
  const ext = extOf(name);
  return ext === "" ? `${name} ${n}` : `${name.slice(0, name.length - ext.length - 1)} ${n}.${ext}`;
}

type Skip = LibraryAddResult["skipped"][number];
type FolderNote = LibraryAddResult["folders"][number];

/** The Library's own folder refusing a write — the disk full, the home read-only. Not a fact about the
 *  file chosen, so it stops the add and says so, rather than calling the file unreadable. */
const unwritable = (e: unknown): RpcError =>
  new RpcError("LIBRARY_UNWRITABLE", `Realm couldn't keep a copy in its Library folder: ${e instanceof Error ? e.message : String(e)}`);
const unmovable = (name: string, e: unknown): RpcError =>
  new RpcError("LIBRARY_UNWRITABLE", `Realm couldn't move ${name} in its Library folder: ${e instanceof Error ? e.message : String(e)}`);

type FileRow = { id: string; profile_id: string; path: string; name: string; ext: string; size: number; digest: string; ts: number };
type ListingRow = { id: string; session_id: string; seq: number; kind: string; path: string; name: string; ext: string; ts: number };

const entryOf = (r: FileRow): LibraryEntry => ({
  id: r.id, sessionId: null, spaceId: null, kind: "added", path: r.path, name: r.name, ext: r.ext, ts: r.ts, sessionTitle: null, agentKind: null,
});

/** A removal that can still be undone: the rows it took, each with where its copy was set aside (null
 *  for a copy that was not there to take, or was not a file Realm made), and the Library's other
 *  listings of those copies. Held in memory, so a removal outlives neither its hold nor the server. */
type Removal = {
  profileId: string;
  files: { row: FileRow; held: string | null }[];
  listings: ListingRow[];
  timer: ReturnType<typeof setTimeout>;
};

/** A folder's own files — not what the folders inside it hold, not what is hidden, never a link — in
 *  name order, with what that leaves out. */
async function folderFiles(dir: string): Promise<{ files: string[]; links: string[]; subfolders: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [], links: string[] = [];
  let subfolders = 0;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // `.DS_Store` and its kind: nobody drops a folder of screenshots to add the Finder's own notes.
    if (e.name.startsWith(".")) continue;
    // A dirent describes the entry ITSELF, so a link to a folder or a file says it is a link — and a
    // link is never followed: it could point anywhere on this Mac, and only what was chosen is copied.
    if (e.isSymbolicLink()) links.push(e.name);
    else if (e.isDirectory()) subfolders += 1;
    else if (e.isFile()) files.push(join(dir, e.name));
  }
  return { files, links, subfolders };
}

/**
 * The files a person added to the Library themselves (migration v40): a COPY of each, kept under the
 * profile in Realm's home, and a `library_files` row naming it. The Library lists them beside what
 * sessions made (`ArtifactsStore.list`), as `added`.
 *
 * A copy, not a link to where the file was, because the Library is where it is KEPT: the original may
 * be moved, edited or thrown away, and none of that should change what Realm shows — the reason the
 * picture on the page about you is a copy too (`AvatarStore`).
 *
 * Three rules hold whatever is chosen. Nothing is overwritten: a copy is created exclusively, and a
 * different file of the same name is kept beside it as `name 2.ext`. Nothing is copied twice: the same
 * bytes, or a file the Library already lists by its own path, come back as `duplicate`. And no link is
 * followed, at the top or inside a folder: the source is opened `O_NOFOLLOW`, so a link swapped in
 * after it was looked at is refused rather than read.
 *
 * And what was added can be taken out again (`remove`), which is the one place Realm deletes a file
 * here — so it deletes only its own copies, and only after a wait: a removed copy is set aside in the
 * profile's folder until the removal is undone (`restore`) or `LIBRARY_UNDO_MS` has passed.
 */
export class LibraryFilesStore {
  /** The change in progress. Changes run one at a time, so the same file dropped twice in quick
   *  succession is recognised the second time rather than both copies passing the check before either
   *  is written — and an undo can never cross the end of its own hold. */
  private last: Promise<unknown> = Promise.resolve();
  private removals = new Map<string, Removal>();

  constructor(private db: Db, private home: string) {}

  add(input: LibraryAddInput): Promise<LibraryAddResult> {
    return this.serially(() => this.addNow(input));
  }

  remove(input: LibraryRemoveInput): Promise<LibraryRemoveResult> {
    return this.serially(() => this.removeNow(input));
  }

  restore(input: LibraryRestoreInput): Promise<LibraryRestoreResult> {
    return this.serially(() => this.restoreNow(input));
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.last.then(fn);
    this.last = next.catch(() => {});
    return next;
  }

  private async addNow(input: LibraryAddInput): Promise<LibraryAddResult> {
    const q = LibraryAddSchema.parse(input);
    if (!this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(q.profileId)) throw new NotFoundError("profile", q.profileId);
    const result: LibraryAddResult = { added: [], renamed: [], skipped: [], folders: [] };
    const skip = (name: string, reason: Skip["reason"], extra: Partial<Pick<Skip, "size" | "existing">> = {}) =>
      result.skipped.push({ name, reason, size: extra.size ?? null, existing: extra.existing ?? null });

    // What the chosen items come to, as files: a file is itself, a folder its own files (when asked).
    const chosen: string[] = [];
    for (const raw of q.paths) {
      const name = basename(raw) || raw;
      if (!isAbsolute(raw)) { skip(name, "unreadable"); continue; }
      const path = resolve(raw);
      let st: Stats;
      try { st = await lstat(path); } catch { skip(name, "unreadable"); continue; }
      if (st.isSymbolicLink()) { skip(name, "link"); continue; }
      if (st.isDirectory()) {
        let inside: Awaited<ReturnType<typeof folderFiles>>;
        try { inside = await folderFiles(path); } catch { skip(name, "unreadable"); continue; }
        if (!q.folders) { result.folders.push(await this.describe(path, name, inside)); continue; }
        chosen.push(...inside.files);
        for (const link of inside.links) skip(link, "link");
        continue;
      }
      if (!st.isFile()) { skip(name, "unreadable"); continue; }
      chosen.push(path);
    }
    if (chosen.length > LIBRARY_ADD_MAX) {
      throw new RpcError("LIBRARY_TOO_MANY", `That is ${chosen.length} files, and the Library takes ${LIBRARY_ADD_MAX} at a time. Add them in smaller groups.`);
    }

    const dir = libraryDir(this.home, q.profileId);
    if (chosen.length > 0) await mkdir(dir, { recursive: true });
    // The chosen order is the order they are listed in: the first file chosen is the newest by a hair.
    const start = now();
    for (const [i, path] of chosen.entries()) await this.copyIn(q.profileId, dir, path, start - i, result, skip);
    return result;
  }

  /** What adding a folder's files would add, for the offer the person answers before anything is copied. */
  private async describe(path: string, name: string, inside: { files: string[]; subfolders: number }): Promise<FolderNote> {
    const more = inside.files.length > LIBRARY_ADD_MAX;
    let bytes = 0;
    if (!more) {
      for (const f of inside.files) { try { bytes += (await lstat(f)).size; } catch { /* gone since the listing */ } }
    }
    return { path, name, files: inside.files.length, bytes, subfolders: inside.subfolders, more };
  }

  private async copyIn(profileId: string, dir: string, path: string, ts: number, result: LibraryAddResult,
    skip: (name: string, reason: Skip["reason"], extra?: Partial<Pick<Skip, "size" | "existing">>) => void): Promise<void> {
    const chosenName = basename(path);
    let bytes: Buffer;
    try {
      const src = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await src.stat();
        if (!st.isFile()) { skip(chosenName, "unreadable"); return; }
        if (st.size > MAX_ATTACHMENT_BYTES) { skip(chosenName, "too-large", { size: st.size }); return; }
        bytes = await src.readFile();
      } finally { await src.close(); }
    } catch (e) {
      skip(chosenName, (e as NodeJS.ErrnoException).code === "ELOOP" ? "link" : "unreadable");
      return;
    }
    // Read whole and checked after: a file that grew past the ceiling between the stat and the read is
    // still refused, rather than copied because the stat was early.
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) { skip(chosenName, "too-large", { size: bytes.byteLength }); return; }

    const existing = this.alreadyHas(profileId, path, createHash("sha256").update(bytes).digest("hex"));
    if (existing.name !== null) { skip(chosenName, "duplicate", { existing: existing.name }); return; }

    const wanted = safeLibraryName(chosenName);
    let stored: string | null = null;
    for (let n = 1; n < 1000 && stored === null; n++) {
      const name = numberedName(wanted, n);
      let out: FileHandle;
      // `wx`: made here or not at all — a file already of this name is never written over.
      try { out = await open(join(dir, name), "wx"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw unwritable(e);
      }
      try { await out.writeFile(bytes); } catch (e) {
        await out.close();
        await rm(join(dir, name), { force: true });
        throw unwritable(e);
      }
      await out.close();
      stored = name;
    }
    if (stored === null) { skip(chosenName, "unreadable"); return; }

    const entry: LibraryEntry = {
      id: newId(), sessionId: null, spaceId: null, kind: "added", path: join(dir, stored), name: stored, ext: extOf(stored), ts,
      sessionTitle: null, agentKind: null,
    };
    this.db.prepare("INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, profileId, entry.path, entry.name, entry.ext, bytes.byteLength, existing.digest, ts);
    result.added.push(entry);
    if (stored !== wanted) result.renamed.push({ from: chosenName, to: stored });
  }

  /**
   * The Library's name for this file, if it has it already: a file the Library lists by this very path
   * — one of its own copies dragged back in, or a file a session made — or the same bytes added before.
   * A copy deleted from disk by hand has its row dropped here, so adding the file again puts it back.
   */
  private alreadyHas(profileId: string, path: string, digest: string): { name: string | null; digest: string } {
    const listed = this.db.prepare(`
      SELECT name FROM library_files WHERE profile_id = ? AND path = ?
      UNION ALL
      SELECT a.name FROM artifacts a JOIN sessions s ON s.id = a.session_id JOIN spaces sp ON sp.id = s.space_id
        WHERE sp.profile_id = ? AND a.path = ?
      LIMIT 1`).get(profileId, path, profileId, path) as { name: string } | undefined;
    if (listed) return { name: listed.name, digest };
    const same = this.db.prepare("SELECT id, name, path FROM library_files WHERE profile_id = ? AND digest = ?").all(profileId, digest) as { id: string; name: string; path: string }[];
    for (const row of same) {
      if (existsSync(row.path)) return { name: row.name, digest };
      this.db.prepare("DELETE FROM library_files WHERE id = ?").run(row.id);
    }
    return { name: null, digest };
  }

  /**
   * Take these added files out of the profile's Library: their rows, and their copies set aside.
   *
   * Only a row of the profile's own `library_files` is taken — a path a session made or was given is
   * not one, so it is left alone whatever is asked. Only a regular FILE at a path an add would have
   * written is moved: a link standing where a copy was, or a folder, was put there by something else,
   * and stays exactly as it is while its row goes. The move is a rename, which moves the entry and
   * never what a link names, so even a link swapped in after the look is set aside as a link.
   *
   * The Library's other listings of a copy — the message that carried it, an agent's write to it — name
   * a file about to be gone, so they go with it and come back with it. The messages themselves keep
   * their words and the file's name: a transcript is never rewritten.
   */
  private async removeNow(input: LibraryRemoveInput): Promise<LibraryRemoveResult> {
    const q = LibraryRemoveSchema.parse(input);
    if (!this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(q.profileId)) throw new NotFoundError("profile", q.profileId);
    const paths = [...new Set(q.paths)];
    const rows = this.db.prepare(`SELECT * FROM library_files WHERE profile_id = ? AND path IN (${paths.map(() => "?").join(", ")})
      ORDER BY ts DESC, id DESC`).all(q.profileId, ...paths) as FileRow[];
    if (rows.length === 0) return { removed: [], messages: 0, removal: null };

    const dir = libraryDir(this.home, q.profileId);
    const removal = newId();
    const aside = join(dir, SET_ASIDE, removal);
    const files: Removal["files"] = [];
    // Each one moved is put back if a later one cannot be, so a removal happens whole or not at all.
    const undoMoves = async () => { for (const f of files) if (f.held) await rename(f.held, resolve(f.row.path)).catch(() => {}); };
    for (const row of rows) {
      let held: string | null = null;
      if (isLibraryCopy(dir, row.path) && (await lstat(row.path).catch(() => null))?.isFile()) {
        await this.setAsideFolder(dir, aside);
        held = join(aside, basename(resolve(row.path)));
        try { await rename(resolve(row.path), held); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") held = null; // gone since the look: nothing to set aside
          else { await undoMoves(); throw unmovable(row.name, e); }
        }
      }
      files.push({ row, held });
    }

    const copies = rows.map((r) => r.path).filter((p) => isLibraryCopy(dir, p));
    const listings = copies.length === 0 ? [] : this.db.prepare(`SELECT * FROM artifacts WHERE path IN (${copies.map(() => "?").join(", ")})`)
      .all(...copies) as ListingRow[];
    this.db.exec("BEGIN");
    try {
      const dropFile = this.db.prepare("DELETE FROM library_files WHERE id = ?");
      for (const r of rows) dropFile.run(r.id);
      const dropListing = this.db.prepare("DELETE FROM artifacts WHERE id = ?");
      for (const a of listings) dropListing.run(a.id);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); await undoMoves(); throw e; }

    const timer = setTimeout(() => { void this.serially(() => this.discard(removal)); }, LIBRARY_UNDO_MS);
    timer.unref?.();
    this.removals.set(removal, { profileId: q.profileId, files, listings, timer });
    const messages = new Set(listings.filter((a) => a.kind === "upload").map((a) => `${a.session_id}:${a.seq}`)).size;
    return { removed: rows.map(entryOf), messages, removal };
  }

  /** The folder a removal's copies wait in, made if need be — and refused unless it is a real folder
   *  inside the profile's own: a link planted at its name would carry the copies out of the Library.
   *  Looked at before anything is made in it, and one level at a time, so a refusal leaves no trace. */
  private async setAsideFolder(dir: string, aside: string): Promise<void> {
    const made = async (at: string) => {
      try { await mkdir(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw unmovable("the files", e); }
      if (!(await lstat(at).catch(() => null))?.isDirectory()) {
        throw new RpcError("LIBRARY_UNWRITABLE", `Realm couldn't set the removed files aside: ${at} is not a folder of its own.`);
      }
    };
    await made(join(dir, SET_ASIDE));
    await made(aside);
  }

  /**
   * Undo a removal: each copy back where it was — the same bytes under the same name, its row with the
   * same id and time, so it is in the same place in the list — and the listings that went with it. A
   * file added since under a copy's name is never written over: the copy goes back beside it as
   * `name 2`, and the listings, which named the other file's path, stay gone.
   */
  private async restoreNow(input: LibraryRestoreInput): Promise<LibraryRestoreResult> {
    const q = LibraryRestoreSchema.parse(input);
    const r = this.removals.get(q.removal);
    if (!r) throw new RpcError("LIBRARY_UNDO_GONE", "That removal can't be undone any more: Realm has deleted its copies.");
    if (!this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(r.profileId)) throw new NotFoundError("profile", r.profileId);
    const dir = libraryDir(this.home, r.profileId);
    const result: LibraryRestoreResult = { restored: [], renamed: [] };
    const put = this.db.prepare("INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    // A session deleted in the meantime took its listings with it, and they do not come back without it.
    const relist = this.db.prepare(`INSERT OR IGNORE INTO artifacts (id, session_id, seq, kind, path, name, ext, ts)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`);
    // A file at a time, whole — its copy and its rows — and struck off the removal once back, so an undo
    // that stopped part way can be asked again and finish rather than put anything back twice.
    while (r.files.length > 0) {
      const f = r.files[0]!;
      const at = f.held === null ? f.row.path : await this.putBack(dir, f.held, f.row.name);
      const row: FileRow = { ...f.row, path: at, name: basename(at) };
      this.db.exec("BEGIN");
      try {
        put.run(row.id, row.profile_id, row.path, row.name, row.ext, row.size, row.digest, row.ts);
        if (at === f.row.path) {
          for (const a of r.listings) if (a.path === at) relist.run(a.id, a.session_id, a.seq, a.kind, a.path, a.name, a.ext, a.ts, a.session_id);
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        if (f.held !== null) await rename(at, f.held).catch(() => {});
        throw e;
      }
      r.files.shift();
      if (row.name !== f.row.name) result.renamed.push({ from: f.row.name, to: row.name });
      result.restored.push(entryOf(row));
    }
    clearTimeout(r.timer);
    this.removals.delete(q.removal);
    await rmdir(join(dir, SET_ASIDE, q.removal)).catch(() => {});
    await rmdir(join(dir, SET_ASIDE)).catch(() => {}); // still holding another removal's copies: kept
    return result;
  }

  /** A set-aside copy back in the folder under its own name, or beside a file that has taken it since,
   *  the way an add keeps one. Linked and then unlinked, never renamed: a rename replaces whatever has
   *  the name, and nothing in the Library is ever written over. */
  private async putBack(dir: string, held: string, name: string): Promise<string> {
    try { await mkdir(dir, { recursive: true }); } catch (e) { throw unmovable(name, e); }
    for (let n = 1; n < 1000; n++) {
      const at = join(dir, numberedName(name, n));
      try { await link(held, at); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw unmovable(name, e);
      }
      await unlink(held);
      return at;
    }
    throw unmovable(name, new Error("every name it could take is in use"));
  }

  /** The end of a removal's hold: its copies deleted for good, one file at a time, and the folder they
   *  waited in. Only ever a name inside that folder, and `unlink`, which neither follows a link nor
   *  empties a folder. */
  private async discard(removal: string): Promise<void> {
    const r = this.removals.get(removal);
    if (!r) return;
    this.removals.delete(removal);
    clearTimeout(r.timer);
    for (const f of r.files) if (f.held) await unlink(f.held).catch(() => {});
    const dir = libraryDir(this.home, r.profileId);
    await rmdir(join(dir, SET_ASIDE, removal)).catch(() => {});
    await rmdir(join(dir, SET_ASIDE)).catch(() => {});
  }

  /**
   * Copies a last run set aside and never finished holding — the app quit with an Undo still up.
   * Nothing can undo those any more (a hold lives in memory), so they are deleted, at boot, the way
   * their hold would have ended: one file or link at a time, in folders of the Library's own that are
   * real folders and not links to somewhere else, so this can reach nothing outside them.
   */
  sweep(): Promise<void> {
    return this.serially(async () => {
      const root = join(this.home, "library");
      for (const profile of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!profile.isDirectory()) continue;
        const aside = join(root, profile.name, SET_ASIDE);
        if (!(await lstat(aside).catch(() => null))?.isDirectory()) continue;
        for (const hold of await readdir(aside, { withFileTypes: true }).catch(() => [])) {
          if (!hold.isDirectory()) continue;
          const at = join(aside, hold.name);
          for (const f of await readdir(at, { withFileTypes: true }).catch(() => [])) {
            if (f.isFile() || f.isSymbolicLink()) await unlink(join(at, f.name)).catch(() => {});
          }
          await rmdir(at).catch(() => {});
        }
        await rmdir(aside).catch(() => {});
      }
    });
  }
}
