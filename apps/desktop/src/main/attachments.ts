import { basename, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { nativeImage } from "electron";
import { isImageMime, isOpenablePath, mimeForPath } from "@realm/contracts";

/** What the picker and the paste path hand the renderer. `size` is here so the prompter can refuse a
 *  file over MAX_ATTACHMENT_BYTES before it is ever attached; only `path` and `mime` go on the wire. */
export type PickedFile = { path: string; mime: string; name: string; size: number };

/**
 * Where a pasted image is written.
 *
 * A pasted image has no file on disk, and every adapter's contract is a PATH — so one has to be made.
 * It goes under Realm's own home rather than the OS temp dir for two reasons: macOS purges
 * `/var/folders` on its own schedule, which would break the path recorded in the session's
 * `user_message` event while the session is still open; and a file the user can go and look at is
 * better than one they cannot.
 */
export const tempAttachmentDir = (home: string): string => join(home, "tmp", "attachments");

/** How long a pasted file survives. Longer than any single turn (the adapter reads it asynchronously,
 *  after `sessions.send` has already resolved), short enough that the directory cannot creep. */
export const TEMP_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A filesystem-safe name for a pasted file.
 *
 * The name arrives from the renderer (`File.name` on a clipboard item), so it is untrusted: strip it to
 * a basename, then to a conservative character set, so nothing can escape the directory or collide with
 * a name the sweep is meant to recognise. The extension is preserved when there is one — it is what
 * `mimeForPath` reads, and what makes the file openable.
 */
export function safeAttachmentName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim();
  return base.length === 0 ? "pasted" : base.slice(0, 120);
}

/**
 * Delete pasted files older than `ttlMs`.
 *
 * Called at launch AND on every save: a launch-only sweep leaks for as long as the app stays up, which
 * for a workstation app is the normal case. Each sweep is one directory read over a handful of entries.
 * Errors are swallowed per entry — a file another window is mid-read is not worth failing a paste over.
 */
export async function sweepTempAttachments(dir: string, ttlMs = TEMP_ATTACHMENT_TTL_MS, now = Date.now()): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; } // never created = nothing to sweep
  const removed: string[] = [];
  for (const name of names) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (now - s.mtimeMs < ttlMs) continue;
      await rm(p, { recursive: true, force: true });
      removed.push(name);
    } catch { /* vanished, or not ours to remove */ }
  }
  return removed;
}

/** Write a pasted file into the temp directory and describe it the way the picker does. The random
 *  prefix is what keeps two pastes of "image.png" from overwriting each other. */
export async function saveTempAttachment(home: string, name: string, mime: string, bytes: Uint8Array): Promise<PickedFile> {
  const dir = tempAttachmentDir(home);
  await mkdir(dir, { recursive: true });
  void sweepTempAttachments(dir).catch(() => {});
  const safe = safeAttachmentName(name);
  const path = join(dir, `${randomBytes(6).toString("hex")}-${safe}`);
  await writeFile(path, bytes);
  // The browser already knows a clipboard item's type; fall back to the extension only when it does not.
  return { path, mime: mime || mimeForPath(safe), name: safe, size: bytes.byteLength };
}

/** Icon assets never render past 20px in the UI (`SpaceIcon.tsx`), so anything beyond a few times that,
 *  at retina scale, is wasted bytes sitting in the icon_assets table forever. */
const ICON_COMPRESS_THRESHOLD_BYTES = 10 * 1024;
const ICON_MAX_DIM = 128;

/** Downscale a raster icon upload once it clears `ICON_COMPRESS_THRESHOLD_BYTES`. SVGs are vector and
 *  already tiny, so they're left alone. Re-encodes through `nativeImage` rather than pulling in an
 *  image library — the same approach `attachment-thumbnail` already uses in `index.ts`. Falls back to
 *  the original file whenever the re-encode can't beat it (a failed decode, or a file that was already
 *  small for its dimensions), so the caller never has to know compression was attempted. */
export async function compressIconIfNeeded(home: string, file: PickedFile): Promise<PickedFile> {
  if (file.size <= ICON_COMPRESS_THRESHOLD_BYTES || !isImageMime(file.mime) || file.mime === "image/svg+xml") return file;
  const img = nativeImage.createFromPath(file.path);
  if (img.isEmpty()) return file;
  const { width, height } = img.getSize();
  const scale = Math.min(1, ICON_MAX_DIM / Math.max(width, height, 1));
  const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
  const jpeg = file.mime === "image/jpeg";
  const buf = jpeg ? resized.toJPEG(80) : resized.toPNG();
  if (buf.byteLength === 0 || buf.byteLength >= file.size) return file;

  const dir = tempAttachmentDir(home);
  await mkdir(dir, { recursive: true });
  void sweepTempAttachments(dir).catch(() => {});
  const mime = jpeg ? "image/jpeg" : "image/png";
  const path = join(dir, `${randomBytes(6).toString("hex")}-icon.${jpeg ? "jpg" : "png"}`);
  await writeFile(path, buf);
  return { path, mime, name: file.name, size: buf.byteLength };
}

/**
 * How long QuickLook gets to render one thumbnail.
 *
 * This is load-bearing, not belt-and-braces: handed a file no generator claims, `qlmanage` does not
 * fail — it waits, indefinitely. Three seconds is several times what a cold render of a real PDF
 * costs (~0.5s measured) and short enough that a file nobody can preview does not hold a process for
 * the length of a conversation. The caller degrades to the file glyph on expiry and caches that, so
 * the ceiling is paid at most once per path.
 */
export const QUICKLOOK_TIMEOUT_MS = 3_000;

/**
 * A rendered preview of any file macOS can preview — the first page of a PDF, a frame of a movie, a
 * slide of a Keynote — as a PNG data URL, or `null` when there is nothing to show.
 *
 * `nativeImage` decodes image formats and nothing else, which left every non-image attachment
 * showing the same generic glyph. QuickLook is the same machinery Finder's icons and the space bar
 * use, so what the tile shows is what the user already recognises the file by.
 *
 * `qlmanage` writes `<basename>.png` into an output DIRECTORY it does not let you name, so each call
 * gets a scratch directory of its own — two thumbnails of two different `report.pdf`s must not race
 * for one filename. The directory is removed on every path out, including failure.
 */
export async function quickLookThumbnail(home: string, path: string, sizePx: number): Promise<string | null> {
  if (process.platform !== "darwin") return null; // qlmanage is macOS's; elsewhere the glyph stands
  // A path that has since moved is the single commonest miss, and `qlmanage` answers it by hanging
  // rather than by failing — so it never gets asked. One stat is far cheaper than one timeout.
  try { if (!(await stat(path)).isFile()) return null; } catch { return null; }
  const dir = join(home, "tmp", "thumbs", randomBytes(8).toString("hex"));
  try {
    await mkdir(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      // execFile, never a shell: `path` is user data and a filename with a space, a quote or a `;`
      // in it is ordinary, not an attack — but through a shell it would be both.
      execFile("/usr/bin/qlmanage", ["-t", "-s", String(sizePx), "-o", dir, path],
        { timeout: QUICKLOOK_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
    });
    // qlmanage reports success on stdout even when it produced nothing (a type with no generator),
    // so the directory listing — not the exit code — is what says whether there is a thumbnail.
    const [name] = (await readdir(dir)).filter((n) => n.endsWith(".png"));
    if (!name) return null;
    const png = await readFile(join(dir, name));
    return png.byteLength === 0 ? null : `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null; // an unpreviewable file is not an error the prompter should hear about
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Describe files chosen in the native picker. A path that cannot be stat'd is dropped rather than
 *  reported with a made-up size — the prompter's size check would then be checking a fiction. */
export async function describeFiles(paths: readonly string[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const path of paths) {
    try {
      const s = await stat(path);
      if (!s.isFile()) continue;
      out.push({ path, mime: mimeForPath(path), name: basename(path), size: s.size });
    } catch { /* gone between the dialog and here */ }
  }
  return out;
}

/**
 * The absolute path of an attachment Realm may hand to the OS, or null.
 *
 * `media.ts` has `servablePath` for the same question about MEDIA, and the two are deliberately not
 * one function: that gate gets asked about paths harvested from an agent's PROSE, so it admits only
 * the inert formats an `img`/`video`/`audio` element can decode. This one is asked about a file the
 * user themselves picked or dropped, and it admits every document type Realm's mime table knows.
 *
 * The extension is checked twice for the reason `servablePath` documents: before the syscall on the
 * `..`-collapsed string, and again on the fully-resolved real path, so a symlink cannot lend its own
 * extension to something the gate would otherwise refuse.
 */
export async function openablePath(candidate: unknown): Promise<string | null> {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return null;
  const path = resolve(candidate);
  if (!isOpenablePath(path)) return null;
  try {
    const real = await realpath(path);
    if (!isOpenablePath(real)) return null;
    if (!(await stat(real)).isFile()) return null;
    return path;
  } catch { return null; }
}
