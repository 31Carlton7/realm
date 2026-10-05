import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  extOf, LIBRARY_ADD_MAX, LibraryAddSchema, MAX_ATTACHMENT_BYTES, newId,
  type LibraryAddInput, type LibraryAddResult, type LibraryEntry,
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
 */
export class LibraryFilesStore {
  /** The add in progress. Adds run one at a time, so the same file dropped twice in quick succession is
   *  recognised the second time rather than both copies passing the check before either is written. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(private db: Db, private home: string) {}

  add(input: LibraryAddInput): Promise<LibraryAddResult> {
    const next = this.last.then(() => this.addNow(input));
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
}
