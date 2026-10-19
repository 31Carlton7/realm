import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isImageMime, mimeForPath } from "@realm/contracts";
import type { MobileResult } from "@realm/remote";

/**
 * What a phone is shown of a file a turn made (`session.file`): a picture made smaller, the head of a
 * text, or neither. Bounded on every side, because the answer crosses a cellular link inside one
 * application message: a picture is at most PREVIEW_MAX_PX on its longer side and PREVIEW_MAX_BYTES
 * encoded, a text at most TEXT_HEAD_BYTES of its head, and nothing else is read at all.
 *
 * Which file may be previewed is not decided here: the caller has already found `path` in the
 * session's own `files_made` events. This only refuses what is not a plain file at that path — a link
 * could point anywhere, and following it would read a file no turn made.
 */

export type FilePreview = MobileResult<"session.file">;

/** The longer side of a picture the phone is sent, in pixels. */
export const PREVIEW_MAX_PX = 1024;
/** The most a picture's preview may weigh, encoded. A larger one is made smaller once, then given up on. */
export const PREVIEW_MAX_BYTES = 512 * 1024;
/** How much of a text file's head is sent. */
export const TEXT_HEAD_BYTES = 16 * 1024;
/** A picture larger than this is not opened at all: `sips` would spend seconds on it. */
const IMAGE_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** A picture's JPEG, no larger than `maxPx` on its longer side and never enlarged. */
export type Downscale = (path: string, maxPx: number, quality: number) => Promise<Buffer>;

const run = promisify(execFile);

/** macOS's own `sips`: it reads every format Preview does, HEIC included, and runs in its own process. */
export const sipsDownscale: Downscale = async (path, maxPx, quality) => {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: 10_000 });
  const side = Math.max(...[...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])));
  const dir = await mkdtemp(join(tmpdir(), "realm-preview-"));
  try {
    const out = join(dir, "preview.jpg");
    const resize = Number.isFinite(side) && side > maxPx ? ["-Z", String(maxPx)] : [];
    await run("sips", [...resize, "-s", "format", "jpeg", "-s", "formatOptions", String(quality), path, "--out", out], { timeout: 20_000 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export class PreviewRefused extends Error {}

/** Where the last whole UTF-8 sequence in `buf` ends: before a character the end of the buffer cut
 *  in two, else at the end. */
function wholeUtf8End(buf: Buffer): number {
  let i = buf.length - 1;
  for (let cont = 0; i >= 0 && cont < 3 && (buf[i]! & 0xc0) === 0x80; cont++) i--;
  if (i < 0) return buf.length;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? i : buf.length;
}

/** Text, as far as a preview is concerned: no NUL in it, and UTF-8 throughout. A head that was cut
 *  short may end part way through a character, which is dropped. */
function textOf(head: Buffer, cut: boolean): string | null {
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(cut ? head.subarray(0, wholeUtf8End(head)) : head);
  } catch {
    return null;
  }
}

async function head(path: string, bytes: number): Promise<Buffer> {
  const f = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await f.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

export async function filePreview(path: string, o: { downscale?: Downscale } = {}): Promise<FilePreview> {
  if (!isAbsolute(path)) throw new PreviewRefused("Realm previews a file by its full path on this Mac.");
  const s = await lstat(path);
  if (s.isSymbolicLink()) throw new PreviewRefused("That is a link to another file, and Realm previews only the file a turn made.");
  if (!s.isFile()) throw new PreviewRefused("That is not a file.");
  const mime = mimeForPath(path);
  const base = { path, name: basename(path), size: s.size, mime };

  if (isImageMime(mime) && mime !== "image/svg+xml") {
    if (s.size > IMAGE_MAX_INPUT_BYTES) return { ...base, preview: { kind: "none", reason: "This picture is too large to preview on the phone." } };
    const downscale = o.downscale ?? sipsDownscale;
    try {
      let jpeg = await downscale(path, PREVIEW_MAX_PX, 70);
      if (jpeg.length > PREVIEW_MAX_BYTES) jpeg = await downscale(path, PREVIEW_MAX_PX / 2, 50);
      if (jpeg.length <= PREVIEW_MAX_BYTES) return { ...base, preview: { kind: "image", mime: "image/jpeg", data: jpeg.toString("base64") } };
      return { ...base, preview: { kind: "none", reason: "This picture is too detailed to preview on the phone." } };
    } catch {
      return { ...base, preview: { kind: "none", reason: "This Mac could not read the picture." } };
    }
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return { ...base, preview: { kind: "none", reason: "Open this on your Mac to play it." } };
  }
  // Anything else is shown as text if it reads as text: a markdown deck, a CSV, a log.
  const bytes = await head(path, TEXT_HEAD_BYTES + 1);
  const cut = bytes.length > TEXT_HEAD_BYTES;
  const text = textOf(cut ? bytes.subarray(0, TEXT_HEAD_BYTES) : bytes, cut);
  if (text === null) return { ...base, preview: { kind: "none", reason: "This file has no preview on the phone." } };
  return { ...base, preview: { kind: "text", text, truncated: cut } };
}
