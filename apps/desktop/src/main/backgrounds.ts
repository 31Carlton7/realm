import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  BACKGROUND_EFFECTS as EFFECTS, BACKGROUND_LOOPS as LOOPS, type BackgroundEffect, type BackgroundImage, type BackgroundLoop, type BackgroundsAdded,
} from "@realm/contracts";

/**
 * The person's own backgrounds: pictures they chose, kept under the Realm home as
 * `backgrounds/<id>.jpg` with a small `<id>.thumb.jpg` beside it and one `index.json` naming them.
 * A video, or a GIF that moves, is also kept as it was given, `<id>.<ext>`, to be played as a loop;
 * its `<id>.jpg` is then the loop's first frame, the picture shown wherever the loop does not play.
 *
 * Main reads exactly the files the person picked or dropped, and nothing else: a path is refused on
 * its extension before anything is opened, then on its size and its first bytes, and only what the
 * renderer can decode gets that far. Every picture is decoded and written again as a JPEG no longer
 * than `MAX_EDGE` on its long side, so what is kept is a picture and only a picture, whatever the
 * original carried with it. The renderer gets the kept copies back as data: URLs, by id; an id is
 * looked up in the index, never joined onto a path as given.
 */

export const MAX_BYTES = 25 * 1024 * 1024;
/** A video is kept whole rather than re-encoded, so it may be larger than a picture. */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_EDGE = 3200;
export const THUMB_EDGE = 480;
const NAME_MAX = 60;
const ID = /^[0-9a-f]{16}$/;

/** What Chromium decodes, by extension and by the bytes the file starts with. A video is an ISO
 *  media file (its first box is `ftyp`) or a Matroska one (WebM's EBML magic). */
const KINDS: { ext: string[]; video?: true; sniff: (b: Buffer) => boolean }[] = [
  { ext: [".mp4", ".m4v", ".mov"], video: true, sniff: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
  { ext: [".webm"], video: true, sniff: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { ext: [".png"], sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: [".jpg", ".jpeg"], sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: [".gif"], sniff: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: [".webp"], sniff: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Decodes a picture and writes it back as a JPEG at most `maxEdge` on its long side; null for bytes
 *  that do not decode. Main passes Electron's `nativeImage`; tests pass a stand-in. */
export type Reencode = (bytes: Buffer, maxEdge: number) => { jpeg: Buffer; width: number; height: number } | null;

/** A video's first frame as image bytes, or null when it will not decode. Main asks QuickLook. */
export type FirstFrame = (path: string) => Promise<Buffer | null>;

const dir = (home: string) => join(home, "backgrounds");
const indexPath = (home: string) => join(dir(home), "index.json");
const fullPath = (home: string, id: string) => join(dir(home), `${id}.jpg`);
const thumbPath = (home: string, id: string) => join(dir(home), `${id}.thumb.jpg`);
const loopPath = (home: string, id: string, loop: BackgroundLoop) => join(dir(home), `${id}.${loop}`);

/**
 * How many pictures a GIF holds, counted by walking its blocks (GIF89a): one is a still, more is a
 * loop. A file that ends early counts what it got to.
 */
export function gifFrames(b: Buffer): number {
  let i = 13;
  if (b.length < i) return 0;
  if (b[10]! & 0x80) i += 3 << ((b[10]! & 7) + 1);
  const skipBlocks = () => { while (i < b.length && b[i] !== 0) i += b[i]! + 1; i++; };
  let frames = 0;
  while (i < b.length) {
    const kind = b[i++];
    if (kind === 0x21) { i++; skipBlocks(); }
    else if (kind === 0x2c) {
      const flags = b[i + 8] ?? 0;
      i += 9;
      if (flags & 0x80) i += 3 << ((flags & 7) + 1);
      i++;
      skipBlocks();
      if (i <= b.length) frames++;
    } else break;
  }
  return frames;
}

function parseEntry(raw: unknown): BackgroundImage | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !ID.test(e.id) || typeof e.name !== "string" || typeof e.added !== "number") return null;
  return {
    id: e.id, name: e.name, added: e.added,
    effect: EFFECTS.includes(e.effect as BackgroundEffect) ? (e.effect as BackgroundEffect) : "dither-color",
    asIs: e.asIs === true,
    width: typeof e.width === "number" ? e.width : 0,
    height: typeof e.height === "number" ? e.height : 0,
    loop: LOOPS.includes(e.loop as BackgroundLoop) ? (e.loop as BackgroundLoop) : null,
  };
}

export async function listBackgrounds(home: string): Promise<BackgroundImage[]> {
  try {
    const raw = JSON.parse(await readFile(indexPath(home), "utf8")) as { images?: unknown };
    return Array.isArray(raw.images) ? raw.images.map(parseEntry).filter((e): e is BackgroundImage => e !== null) : [];
  } catch {
    return [];
  }
}

async function save(home: string, images: BackgroundImage[]) {
  await mkdir(dir(home), { recursive: true });
  const tmp = `${indexPath(home)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, images }, null, 2));
  await rename(tmp, indexPath(home));
}

/** Why a path cannot be added, as a sentence, or null when it can. Reads at most its first 12 bytes. */
async function refusal(path: string): Promise<string | null> {
  const kind = KINDS.find((k) => k.ext.includes(extname(path).toLowerCase()));
  if (!kind) return "Realm can show PNG, JPEG, GIF and WebP pictures, and MP4, MOV and WebM videos.";
  let real: string;
  try { real = await realpath(path); } catch { return "The file is no longer there."; }
  const s = await stat(real);
  if (!s.isFile()) return "That is not a file.";
  const max = kind.video ? MAX_VIDEO_BYTES : MAX_BYTES;
  if (s.size > max) return `It is over ${max / 1024 / 1024} MB.`;
  const head = Buffer.alloc(12);
  const fh = await open(real, "r");
  try { await fh.read(head, 0, 12, 0); } finally { await fh.close(); }
  return kind.sniff(head) ? null : `The file is not the ${kind.video ? "video" : "picture"} its name says it is.`;
}

const nameFrom = (path: string) => basename(path, extname(path)).trim().slice(0, NAME_MAX) || "Picture";

/** Adds each path in turn; a refusal names its file and leaves the others to go ahead. A video's
 *  picture is its first frame (`firstFrame`); a GIF's is its first picture, and the GIF itself is
 *  kept as its loop when it has more than one. */
export async function addBackgrounds(home: string, paths: readonly string[], reencode: Reencode, firstFrame: FirstFrame, now = Date.now): Promise<BackgroundsAdded> {
  const out: BackgroundsAdded = { added: [], refused: [] };
  for (const path of paths) {
    const file = basename(path);
    const why = await refusal(path).catch(() => "Realm could not read it.");
    if (why) { out.refused.push({ name: file, reason: why }); continue; }
    const ext = extname(path).slice(1).toLowerCase();
    const video = LOOPS.includes(ext as BackgroundLoop) && ext !== "gif";
    const bytes = video ? await firstFrame(path) : await readFile(path);
    const full = bytes && reencode(bytes, MAX_EDGE);
    const thumb = full && reencode(full.jpeg, THUMB_EDGE);
    if (!full || !thumb) { out.refused.push({ name: file, reason: `Realm could not read it as a ${video ? "video" : "picture"}.` }); continue; }
    const loop: BackgroundLoop | null = video ? (ext as BackgroundLoop) : ext === "gif" && gifFrames(bytes) > 1 ? "gif" : null;
    const id = randomBytes(8).toString("hex");
    await mkdir(dir(home), { recursive: true });
    await writeFile(fullPath(home, id), full.jpeg);
    await writeFile(thumbPath(home, id), thumb.jpeg);
    if (loop) await copyFile(path, loopPath(home, id, loop));
    const entry: BackgroundImage = { id, name: nameFrom(path), added: now(), effect: "dither-color", asIs: false, width: full.width, height: full.height, loop };
    await save(home, [...(await listBackgrounds(home)), entry]);
    out.added.push(entry);
  }
  return out;
}

export type BackgroundPatch = { name?: unknown; effect?: unknown; asIs?: unknown };

/** Renames an image or changes how it is drawn; null for an id the index does not hold. A blank
 *  name keeps the old one. */
export async function updateBackground(home: string, id: unknown, patch: BackgroundPatch): Promise<BackgroundImage | null> {
  const images = await listBackgrounds(home);
  const at = images.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const was = images[at]!;
  const name = typeof patch.name === "string" ? patch.name.trim().slice(0, NAME_MAX) : "";
  const next: BackgroundImage = {
    ...was,
    name: name || was.name,
    effect: EFFECTS.includes(patch.effect as BackgroundEffect) ? (patch.effect as BackgroundEffect) : was.effect,
    asIs: typeof patch.asIs === "boolean" ? patch.asIs : was.asIs,
  };
  images[at] = next;
  await save(home, images);
  return next;
}

export async function removeBackground(home: string, id: unknown): Promise<boolean> {
  const images = await listBackgrounds(home);
  const gone = images.find((e) => e.id === id);
  if (!gone) return false;
  await save(home, images.filter((e) => e !== gone));
  await rm(fullPath(home, gone.id), { force: true });
  await rm(thumbPath(home, gone.id), { force: true });
  if (gone.loop) await rm(loopPath(home, gone.id, gone.loop), { force: true });
  return true;
}

/**
 * A video's picture made again from `bytes`, its first frame as the renderer decoded it: QuickLook's
 * frame is the Finder's, picked from partway in, and a loop has to start on the picture already
 * shown. Null for an id with no video, or bytes that are not a picture.
 */
export async function setBackgroundPoster(home: string, id: unknown, bytes: Buffer, reencode: Reencode): Promise<BackgroundImage | null> {
  const images = await listBackgrounds(home);
  const at = images.findIndex((e) => e.id === id);
  const was = images[at];
  if (!was?.loop || was.loop === "gif") return null;
  const full = reencode(bytes, MAX_EDGE);
  const thumb = full && reencode(full.jpeg, THUMB_EDGE);
  if (!full || !thumb) return null;
  await writeFile(fullPath(home, was.id), full.jpeg);
  await writeFile(thumbPath(home, was.id), thumb.jpeg);
  images[at] = { ...was, width: full.width, height: full.height };
  await save(home, images);
  return images[at]!;
}

/** Where a kept background's loop is on disk, by id; null for an id the index does not hold or one
 *  with no loop. The only path `realm-background://` serves. */
export async function backgroundLoopFile(home: string, id: unknown): Promise<{ path: string; loop: BackgroundLoop } | null> {
  const entry = (await listBackgrounds(home)).find((e) => e.id === id);
  return entry?.loop ? { path: loopPath(home, entry.id, entry.loop), loop: entry.loop } : null;
}

/** A kept picture as a data: URL — a data: URL because the backdrop reads its pixels back off a
 *  canvas, which a picture from another origin would taint. */
export async function backgroundImageUrl(home: string, id: unknown, size: unknown): Promise<string | null> {
  if (typeof id !== "string" || !(await listBackgrounds(home)).some((e) => e.id === id)) return null;
  try {
    const bytes = await readFile(size === "thumb" ? thumbPath(home, id) : fullPath(home, id));
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
