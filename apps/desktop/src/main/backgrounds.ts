import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { BACKGROUND_EFFECTS as EFFECTS, type BackgroundEffect, type BackgroundImage, type BackgroundsAdded } from "@realm/contracts";

/**
 * The person's own backgrounds: pictures they chose, kept under the Realm home as
 * `backgrounds/<id>.jpg` with a small `<id>.thumb.jpg` beside it and one `index.json` naming them.
 *
 * Main reads exactly the files the person picked or dropped, and nothing else: a path is refused on
 * its extension before anything is opened, then on its size and its first bytes, and only what the
 * renderer can decode gets that far. Every picture is decoded and written again as a JPEG no longer
 * than `MAX_EDGE` on its long side, so what is kept is a picture and only a picture, whatever the
 * original carried with it. The renderer gets the kept copies back as data: URLs, by id; an id is
 * looked up in the index, never joined onto a path as given.
 */

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_EDGE = 3200;
export const THUMB_EDGE = 480;
const NAME_MAX = 60;
const ID = /^[0-9a-f]{16}$/;

/** What Chromium decodes, by extension and by the bytes the file starts with. */
const KINDS: { ext: string[]; sniff: (b: Buffer) => boolean }[] = [
  { ext: [".png"], sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: [".jpg", ".jpeg"], sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: [".gif"], sniff: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: [".webp"], sniff: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Decodes a picture and writes it back as a JPEG at most `maxEdge` on its long side; null for bytes
 *  that do not decode. Main passes Electron's `nativeImage`; tests pass a stand-in. */
export type Reencode = (bytes: Buffer, maxEdge: number) => { jpeg: Buffer; width: number; height: number } | null;

const dir = (home: string) => join(home, "backgrounds");
const indexPath = (home: string) => join(dir(home), "index.json");
const fullPath = (home: string, id: string) => join(dir(home), `${id}.jpg`);
const thumbPath = (home: string, id: string) => join(dir(home), `${id}.thumb.jpg`);

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
  if (!kind) return "Realm can show PNG, JPEG, GIF and WebP pictures.";
  let real: string;
  try { real = await realpath(path); } catch { return "The file is no longer there."; }
  const s = await stat(real);
  if (!s.isFile()) return "That is not a file.";
  if (s.size > MAX_BYTES) return `It is over ${MAX_BYTES / 1024 / 1024} MB.`;
  const head = Buffer.alloc(12);
  const fh = await open(real, "r");
  try { await fh.read(head, 0, 12, 0); } finally { await fh.close(); }
  return kind.sniff(head) ? null : "The file is not the picture its name says it is.";
}

const nameFrom = (path: string) => basename(path, extname(path)).trim().slice(0, NAME_MAX) || "Picture";

/** Adds each path in turn; a refusal names its file and leaves the others to go ahead. */
export async function addBackgrounds(home: string, paths: readonly string[], reencode: Reencode, now = Date.now): Promise<BackgroundsAdded> {
  const out: BackgroundsAdded = { added: [], refused: [] };
  for (const path of paths) {
    const file = basename(path);
    const why = await refusal(path).catch(() => "Realm could not read it.");
    if (why) { out.refused.push({ name: file, reason: why }); continue; }
    const bytes = await readFile(path);
    const full = reencode(bytes, MAX_EDGE);
    const thumb = full && reencode(full.jpeg, THUMB_EDGE);
    if (!full || !thumb) { out.refused.push({ name: file, reason: "Realm could not read it as a picture." }); continue; }
    const id = randomBytes(8).toString("hex");
    await mkdir(dir(home), { recursive: true });
    await writeFile(fullPath(home, id), full.jpeg);
    await writeFile(thumbPath(home, id), thumb.jpeg);
    const entry: BackgroundImage = { id, name: nameFrom(path), added: now(), effect: "dither-color", asIs: false, width: full.width, height: full.height };
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
  return true;
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
