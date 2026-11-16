import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prefixedAttachmentName, sweepTempAttachments, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import { UPLOAD_LIMITS } from "@realm/remote";
import { UploadRefused } from "./uploads";

/**
 * Videos too big to go with their message, which a phone sends ahead of it a chunk at a time
 * (`session.uploadBegin` … `session.uploadFinish`, PROTOCOL.md §8). Each streams to
 * `<home>/tmp/uploads/<uploadId>.part`, beside a `<uploadId>.json` that keeps what the phone declared;
 * the bytes on disk are how far it has come, so an upload goes on where it stopped after a dropped
 * connection or a restart of this Mac. Finished, it moves into `tmp/attachments`, where the message
 * that names it finds it. Anything in `tmp/uploads` is swept after a day.
 *
 * The phone names nothing that reaches the disk: the Mac makes the id and the file's name, and an id it
 * did not make, or made for another phone, is not found.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** The ids `begin` makes; anything else a phone names is not one. */
const UPLOAD_ID = /^[0-9a-f]{32}$/;
/** What a finished upload is called on the Mac, and in its message's user row. */
const VIDEO_NAME = "Video.mp4";

type Declared = { phoneId: string; size: number; sha256: string; createdAt: number; attachment: string | null };

/** An upload the phone named that this Mac has no record of for it: aborted, swept, or never made. */
export class UploadNotFound extends Error {
  constructor() { super("That video is no longer on this Mac. Attach it again."); }
}

const freeOnDisk = async (dir: string): Promise<number> => {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
};

export class ChunkedUploads {
  /** Each upload's calls, one after another: chunks sent four at a time must still land in order. */
  private readonly lines = new Map<string, Promise<unknown>>();

  constructor(private readonly home: string, private readonly freeBytes: (dir: string) => Promise<number> = freeOnDisk) {}

  private get dir(): string { return join(this.home, "tmp", "uploads"); }
  private part(id: string): string { return join(this.dir, `${id}.part`); }
  private record(id: string): string { return join(this.dir, `${id}.json`); }

  async begin(phoneId: string, size: number, sha256: string): Promise<{ uploadId: string; size: number; received: number }> {
    await mkdir(this.dir, { recursive: true });
    await sweepTempAttachments(this.dir);
    // Finished but not yet sent still holds room on this Mac, so it counts toward the bytes, not the uploads.
    const pending = (await this.declared()).filter((d) => d.phoneId === phoneId);
    if (pending.filter((d) => d.attachment === null).length >= UPLOAD_LIMITS.maxOpen) {
      throw new UploadRefused(`This iPhone already has ${UPLOAD_LIMITS.maxOpen} videos on their way to this Mac. Send or take out one of them first.`);
    }
    if (pending.reduce((n, d) => n + d.size, size) > UPLOAD_LIMITS.maxOpenBytes) {
      throw new UploadRefused(`This video would put more than ${UPLOAD_LIMITS.maxOpenBytes / MB} MB of videos from this iPhone on this Mac before they are sent. Send or take out one first.`);
    }
    const needed = 2 * size + GB;
    const free = await this.freeBytes(this.dir);
    if (free < needed) throw new UploadRefused(`This Mac has ${Math.floor(free / MB)} MB free, and needs ${Math.ceil(needed / MB)} MB to take this video.`);
    const uploadId = randomBytes(16).toString("hex");
    await writeFile(this.part(uploadId), Buffer.alloc(0), { flag: "wx" });
    const declared: Declared = { phoneId, size, sha256, createdAt: Date.now(), attachment: null };
    await writeFile(this.record(uploadId), JSON.stringify(declared), { flag: "wx" });
    return { uploadId, size, received: 0 };
  }

  chunk(phoneId: string, uploadId: string, offset: number, data: string): Promise<{ received: number }> {
    return this.inLine(uploadId, async () => {
      const declared = await this.find(phoneId, uploadId);
      if (declared.attachment !== null) throw new UploadRefused("That video has already reached this Mac whole.");
      const received = await this.received(uploadId);
      if (offset !== received) throw new UploadRefused(`This Mac has ${received} bytes of that video, so the next chunk starts there, not at ${offset}.`);
      const bytes = Buffer.from(data, "base64");
      // Node's decoder skips what is not base64 rather than refusing it; encoding again is what tells.
      if (bytes.toString("base64") !== data) throw new UploadRefused("That chunk did not arrive as base64.");
      if (bytes.length > UPLOAD_LIMITS.chunkBytes) throw new UploadRefused(`A chunk is at most ${UPLOAD_LIMITS.chunkBytes / 1024} KB.`);
      if (received + bytes.length > declared.size) throw new UploadRefused(`That chunk would take the video past the ${declared.size} bytes it was said to be.`);
      await appendFile(this.part(uploadId), bytes);
      return { received: received + bytes.length };
    });
  }

  /** Checks the upload whole and moves it where a message's files go. A file that is not an MP4, or
   *  not the one the phone declared, is refused and deleted; one with bytes still to come stays. */
  finish(phoneId: string, uploadId: string): Promise<void> {
    return this.inLine(uploadId, async () => {
      const declared = await this.find(phoneId, uploadId);
      if (declared.attachment !== null) return;
      const received = await this.received(uploadId);
      if (received !== declared.size) throw new UploadRefused(`This Mac has ${received} of the video's ${declared.size} bytes.`);
      if (!(await this.isMp4(uploadId))) {
        await this.drop(uploadId);
        throw new UploadRefused("That video is not an MP4, so this Mac did not keep it.");
      }
      if ((await this.sha256(uploadId)) !== declared.sha256) {
        await this.drop(uploadId);
        throw new UploadRefused("That video did not arrive as it left the iPhone. Attach it again.");
      }
      const dir = tempAttachmentDir(this.home);
      await mkdir(dir, { recursive: true });
      if (await realpath(dir) !== tempAttachmentDir(await realpath(this.home))) throw new Error("The attachments folder is not inside this Mac's Realm home.");
      const attachment = join(dir, prefixedAttachmentName(VIDEO_NAME));
      await rename(this.part(uploadId), attachment);
      await writeFile(this.record(uploadId), JSON.stringify({ ...declared, attachment }));
    });
  }

  async status(phoneId: string, uploadId: string): Promise<{ uploadId: string; size: number; received: number; finished: boolean }> {
    const declared = await this.find(phoneId, uploadId);
    const finished = declared.attachment !== null;
    return { uploadId, size: declared.size, received: finished ? declared.size : await this.received(uploadId), finished };
  }

  abort(phoneId: string, uploadId: string): Promise<void> {
    return this.inLine(uploadId, async () => {
      const declared = await this.find(phoneId, uploadId);
      if (declared.attachment !== null) await rm(declared.attachment, { force: true });
      await this.drop(uploadId);
    });
  }

  /** The finished uploads a message names, as `sessions.send` takes its files. */
  async files(phoneId: string, uploadIds: readonly string[]): Promise<{ path: string; mime: string }[]> {
    const files: { path: string; mime: string }[] = [];
    for (const uploadId of uploadIds) {
      const declared = await this.find(phoneId, uploadId);
      if (declared.attachment === null) throw new UploadRefused("That video has not finished reaching this Mac.");
      files.push({ path: declared.attachment, mime: "video/mp4" });
    }
    return files;
  }

  /** Forgets uploads their message has taken: the file is the message's now, swept with its folder. */
  async sent(uploadIds: readonly string[]): Promise<void> {
    for (const uploadId of uploadIds) await rm(this.record(uploadId), { force: true });
  }

  private inLine<T>(uploadId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.lines.get(uploadId) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => {});
    this.lines.set(uploadId, settled);
    void settled.then(() => { if (this.lines.get(uploadId) === settled) this.lines.delete(uploadId); });
    return run;
  }

  private async find(phoneId: string, uploadId: string): Promise<Declared> {
    if (!UPLOAD_ID.test(uploadId)) throw new UploadNotFound();
    let declared: Declared;
    try {
      declared = JSON.parse(await readFile(this.record(uploadId), "utf8")) as Declared;
    } catch {
      throw new UploadNotFound();
    }
    if (declared.phoneId !== phoneId) throw new UploadNotFound();
    return declared;
  }

  private async declared(): Promise<Declared[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const records: Declared[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        records.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as Declared);
      } catch { /* swept or dropped meanwhile */ }
    }
    return records;
  }

  private async received(uploadId: string): Promise<number> {
    return (await stat(this.part(uploadId)).catch(() => { throw new UploadNotFound(); })).size;
  }

  /** An MP4 opens with its `ftyp` box: four bytes of size, then the type. */
  private async isMp4(uploadId: string): Promise<boolean> {
    const file = await open(this.part(uploadId), "r");
    try {
      const head = Buffer.alloc(8);
      const { bytesRead } = await file.read(head, 0, 8, 0);
      return bytesRead === 8 && head.subarray(4, 8).toString("latin1") === "ftyp";
    } finally {
      await file.close();
    }
  }

  private async sha256(uploadId: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const piece of createReadStream(this.part(uploadId))) hash.update(piece as Buffer);
    return hash.digest("hex");
  }

  private async drop(uploadId: string): Promise<void> {
    await rm(this.part(uploadId), { force: true });
    await rm(this.record(uploadId), { force: true });
  }
}
