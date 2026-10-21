import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mimeForPath } from "@realm/contracts";
import { prefixedAttachmentName, safeAttachmentName, sweepTempAttachments, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import { SEND_LIMITS, type MobileParams } from "@realm/remote";

/**
 * The files a phone sends with a message (`session.send`, `session.create`), made into the paths every
 * adapter takes: each checked whole before any is written, then written where a desktop paste goes
 * (`<home>/tmp/attachments/<random>-<name>`, swept after a day), so the session's `user_message` keeps
 * paths that work, as it does for the desktop's.
 *
 * Every part of an upload is the phone's to say and is read as hostile: the name is cut to a bare
 * file name by the desktop's own sanitiser, sizes are checked against `SEND_LIMITS` before anything
 * is decoded, the data must be base64 exactly as it encodes, and a picture must be one of the four
 * kinds every adapter takes inline, and must be what its type says.
 */

export type Upload = MobileParams<"session.send">["attachments"][number];

export class UploadRefused extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The pictures every agent takes inline: what each is called, its extension, and how its first bytes read. */
const PICTURES: Record<string, { name: string; ext: string; is: (b: Buffer) => boolean }> = {
  "image/jpeg": { name: "JPEG", ext: "jpg", is: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { name: "PNG", ext: "png", is: (b) => b.subarray(0, 8).equals(PNG_SIGNATURE) },
  "image/gif": { name: "GIF", ext: "gif", is: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
  "image/webp": { name: "WebP", ext: "webp", is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};

/** A media type as RFC 6838 names one, without its parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const MB = 1024 * 1024;

/** The fewest bytes a base64 string of this length decodes to: what a size is checked by before the
 *  string is decoded at all. */
const decodedAtLeast = (base64: string): number => Math.max(0, Math.floor(base64.length / 4) * 3 - 2);

type Checked = { name: string; mime: string; bytes: Buffer };

const tooBig = (name: string) => new UploadRefused(`${name} is over ${SEND_LIMITS.maxBytes / MB} MB, the most this Mac takes in one file.`);

function check(u: Upload): Checked {
  const name = safeAttachmentName(u.name);
  const mime = u.mime.split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_TYPE.test(mime)) throw new UploadRefused(`${name} has no type this Mac can read.`);
  if (decodedAtLeast(u.data) > SEND_LIMITS.maxBytes) throw tooBig(name);
  const bytes = Buffer.from(u.data, "base64");
  // Node's decoder skips what is not base64 rather than refusing it; encoding again is what tells.
  if (bytes.toString("base64") !== u.data) throw new UploadRefused(`${name} did not arrive as base64.`);
  if (bytes.length > SEND_LIMITS.maxBytes) throw tooBig(name);
  if (!mime.startsWith("image/")) return { name, mime, bytes };
  const picture = PICTURES[mime];
  if (!picture) throw new UploadRefused(`${name} is a picture this Mac can't hand every agent. Send it as a JPEG, PNG, GIF or WebP.`);
  if (!picture.is(bytes)) throw new UploadRefused(`${name} is not the ${picture.name} its type says.`);
  // The extension is what the Mac reads a file's type by (`mimeForPath`): a photo the phone named
  // without one would otherwise be no picture to a preview, or to Finder.
  return { name: mimeForPath(name) === mime ? name : `${name}.${picture.ext}`, mime, bytes };
}

/** Each upload checked whole — sizes, base64, type — or the first refusal, before anything is written. */
export function checkUploads(uploads: readonly Upload[]): Checked[] {
  if (uploads.length > SEND_LIMITS.maxCount) throw new UploadRefused(`A message takes at most ${SEND_LIMITS.maxCount} files.`);
  const over = () => new UploadRefused(`These files come to more than ${SEND_LIMITS.maxTotalBytes / MB} MB, the most this Mac takes with one message.`);
  if (uploads.reduce((n, u) => n + decodedAtLeast(u.data), 0) > SEND_LIMITS.maxTotalBytes) throw over();
  const checked = uploads.map(check);
  if (checked.reduce((n, c) => n + c.bytes.length, 0) > SEND_LIMITS.maxTotalBytes) throw over();
  return checked;
}

/**
 * Writes checked uploads into `home`'s attachments folder and returns what `sessions.send` carries for
 * them. The folder must really be that folder: one that is a link elsewhere is refused rather than
 * written through. Each file is created new (`wx`), so nothing already there is ever written over.
 */
export async function saveUploads(home: string, checked: readonly Checked[]): Promise<{ path: string; mime: string }[]> {
  if (checked.length === 0) return [];
  const dir = tempAttachmentDir(home);
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== tempAttachmentDir(await realpath(home))) throw new Error("The attachments folder is not inside this Mac's Realm home.");
  void sweepTempAttachments(dir).catch(() => {});
  const out: { path: string; mime: string }[] = [];
  for (const c of checked) {
    const path = join(dir, prefixedAttachmentName(c.name));
    await writeFile(path, c.bytes, { flag: "wx" });
    out.push({ path, mime: c.mime });
  }
  return out;
}
