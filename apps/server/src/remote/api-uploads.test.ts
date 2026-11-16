import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { SEND_LIMITS, UPLOAD_LIMITS } from "@realm/remote";
import { MobileApi, MobileError } from "./api";
import { channel, fakeRpc, session } from "./api.test-fakes";

/**
 * A video too big to go with its message, sent ahead of it a chunk at a time, against a real Realm home
 * on disk: what the Mac writes, what it refuses, and that a refusal leaves the upload where it was.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const CHUNK = UPLOAD_LIMITS.chunkBytes;

/** The first bytes of an MP4: its `ftyp` box. */
const FTYP = Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypmp42", "latin1"), 0, 0, 0, 0, ...Buffer.from("mp42isom", "latin1")]);
/** An MP4 of `size` bytes: its `ftyp` box, then bytes that differ from chunk to chunk. */
const movie = (size: number): Buffer => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) % 251;
  FTYP.copy(bytes);
  return bytes;
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const base64 = (b: Buffer) => b.toString("base64");

function rig(o: { free?: number } = {}) {
  const home = tempDir("realm-phone-uploads-");
  const sent: { id: string; text: string; attachments: { path: string; mime: string }[] }[] = [];
  const rpc = fakeRpc({ sessions: [session("s1", "s1")], items: [] }, { "sessions.send": ((p: (typeof sent)[number]) => { sent.push(p); return { ok: true }; }) as never });
  const api = new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: home, dev: false, freeBytes: async () => o.free ?? 10 * GB });
  const call = async (method: string, params: unknown, phoneId = "phone"): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> => {
    try { return { ok: true, result: await api.handle({ ...channel(rpc), phoneId }, method, params) }; }
    catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
  };
  const uploads = join(home, "tmp", "uploads");
  const attachments = join(home, "tmp", "attachments");
  const listed = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const begin = async (bytes: Buffer, phoneId = "phone"): Promise<string> => {
    const got = await call("session.uploadBegin", { size: bytes.length, sha256: sha256(bytes), mime: "video/mp4" }, phoneId);
    if (!got.ok) throw new Error(got.message);
    return (got.result as { uploadId: string }).uploadId;
  };
  const chunk = (uploadId: string, bytes: Buffer, offset: number, phoneId = "phone") =>
    call("session.uploadChunk", { uploadId, offset, data: base64(bytes.subarray(offset, offset + CHUNK)) }, phoneId);
  /** Every chunk, four in flight at a time, as the phone sends them. */
  const sendAll = async (uploadId: string, bytes: Buffer, from = 0) => {
    const offsets: number[] = [];
    for (let at = from; at < bytes.length; at += CHUNK) offsets.push(at);
    for (let i = 0; i < offsets.length; i += 4) {
      const answers = await Promise.all(offsets.slice(i, i + 4).map((at) => chunk(uploadId, bytes, at)));
      for (const a of answers) expect(a).toMatchObject({ ok: true });
    }
  };
  const status = (uploadId: string, phoneId = "phone") => call("session.uploadStatus", { uploadId }, phoneId);
  return { home, sent, call, uploads, attachments, listed, begin, chunk, sendAll, status };
}

describe("a video sent ahead of its message", () => {
  it("goes up in chunks four at a time, and its message carries it under the Mac's own name", async () => {
    const r = rig();
    const bytes = movie(3 * CHUNK + 1234);
    const uploadId = await r.begin(bytes);
    await r.sendAll(uploadId, bytes);
    expect(await r.status(uploadId)).toEqual({ ok: true, result: { uploadId, size: bytes.length, received: bytes.length, finished: false } });
    expect(await r.call("session.uploadFinish", { uploadId })).toEqual({ ok: true, result: { ok: true } });
    expect(await r.call("session.send", { id: "s1", text: "", uploads: [uploadId] })).toEqual({ ok: true, result: { ok: true } });
    const [{ attachments }] = r.sent as [(typeof r.sent)[number]];
    expect(attachments).toHaveLength(1);
    expect(dirname(attachments[0]!.path)).toBe(r.attachments);
    expect(basename(attachments[0]!.path)).toMatch(/^[0-9a-f]{12}-Video\.mp4$/);
    expect(attachments[0]!.mime).toBe("video/mp4");
    expect(readFileSync(attachments[0]!.path).equals(bytes)).toBe(true);
    // Taken by its message, it is not there to send again.
    expect(r.listed(r.uploads)).toEqual([]);
    expect(await r.call("session.send", { id: "s1", text: "again", uploads: [uploadId] })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("is named by the Mac: an id the Mac did not make, or made for another phone, is not found", async () => {
    const r = rig();
    const bytes = movie(CHUNK);
    // Whatever else the phone sends with it is no part of the call.
    const begun = await r.call("session.uploadBegin", { size: bytes.length, sha256: sha256(bytes), mime: "video/mp4", uploadId: "../../Library/evil", name: "../../evil.mp4" });
    expect(begun).toMatchObject({ ok: true });
    const uploadId = (begun as { result: { uploadId: string } }).result.uploadId;
    expect(uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(uploadId).not.toBe(await r.begin(bytes, "other-phone"));
    expect(r.listed(r.uploads).filter((n) => n.startsWith(uploadId))).toEqual([`${uploadId}.json`, `${uploadId}.part`]);
    // THE MUTANT: take any id the phone names, and a path through it reaches the upload's file.
    for (const named of [`zz/../${uploadId}`, `../uploads/${uploadId}`, uploadId.toUpperCase()]) {
      expect(await r.chunk(named, bytes, 0), named).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    // THE MUTANT: find an upload by its id alone, and another phone writes into it.
    expect(await r.chunk(uploadId, bytes, 0, "other-phone")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await r.status(uploadId, "other-phone")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await r.status(uploadId)).toMatchObject({ ok: true, result: { received: 0 } });
    expect(existsSync(join(r.home, "Library"))).toBe(false);
    expect(existsSync(join(r.home, "tmp", "evil.mp4"))).toBe(false);
  });

  it("takes only the chunk that starts where the Mac's bytes end, and none past the size it was said to be, staying resumable", async () => {
    const r = rig();
    const bytes = movie(2 * CHUNK + 10);
    const uploadId = await r.begin(bytes);
    // THE MUTANT: no chunk size, and one call writes the whole video. One byte over, which its base64
    // alone does not show, and well inside the size declared.
    expect(await r.call("session.uploadChunk", { uploadId, offset: 0, data: base64(bytes.subarray(0, CHUNK + 1)) })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.chunk(uploadId, bytes, 0)).toEqual({ ok: true, result: { received: CHUNK } });
    // THE MUTANT: write wherever the phone says, and a gap or a chunk sent twice corrupts the file.
    for (const offset of [0, CHUNK - 1, CHUNK + 1, 2 * CHUNK]) {
      expect(await r.chunk(uploadId, bytes, offset), `at ${offset}`).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    // THE MUTANT: no bound, and a chunk takes the file past what was declared and its hash checked against.
    await r.chunk(uploadId, bytes, CHUNK);
    expect(await r.call("session.uploadChunk", { uploadId, offset: 2 * CHUNK, data: base64(Buffer.concat([bytes.subarray(2 * CHUNK), Buffer.alloc(1)])) }))
      .toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.call("session.uploadChunk", { uploadId, offset: CHUNK, data: "aGVs bG8=" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.status(uploadId)).toMatchObject({ ok: true, result: { received: 2 * CHUNK } });
    await r.sendAll(uploadId, bytes, 2 * CHUNK);
    expect(await r.call("session.uploadFinish", { uploadId })).toMatchObject({ ok: true });
  });

  it("finishes only whole, only as the MP4 it was said to be, and deletes one that is not", async () => {
    const r = rig();
    const bytes = movie(CHUNK + 99);
    const short = await r.begin(bytes);
    await r.chunk(short, bytes, 0);
    // Bytes still to come: refused, and still there to go on with.
    expect(await r.call("session.uploadFinish", { uploadId: short })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.status(short)).toMatchObject({ ok: true, result: { received: CHUNK, finished: false } });
    await r.call("session.uploadAbort", { uploadId: short });

    // THE MUTANT: no `ftyp` check, and any file the phone hashed becomes an attachment.
    const notMp4 = Buffer.from(bytes);
    notMp4.write("moov", 4, "latin1");
    const fake = await r.begin(notMp4);
    await r.sendAll(fake, notMp4);
    expect(await r.call("session.uploadFinish", { uploadId: fake })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.status(fake)).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // What arrived is not what left the phone.
    const declared = await r.call("session.uploadBegin", { size: bytes.length, sha256: sha256(movie(bytes.length + 1)), mime: "video/mp4" });
    const wrong = (declared as { result: { uploadId: string } }).result.uploadId;
    await r.sendAll(wrong, bytes);
    expect(await r.call("session.uploadFinish", { uploadId: wrong })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await r.status(wrong)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(r.listed(r.uploads)).toEqual([]);
    expect(r.listed(r.attachments)).toEqual([]);
  });

  it("takes at most two unfinished uploads from a phone, and 200 MB among those not yet sent", async () => {
    const r = rig();
    const bytes = movie(CHUNK);
    await r.begin(bytes);
    const second = await r.begin(bytes);
    // THE MUTANT: no count, and a phone opens uploads without end.
    const third = await r.call("session.uploadBegin", { size: bytes.length, sha256: sha256(bytes), mime: "video/mp4" });
    expect(third).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect((third as { message: string }).message).toContain("2 videos");
    // Another phone's are its own.
    await r.begin(bytes, "other-phone");
    await r.call("session.uploadAbort", { uploadId: second });
    await r.begin(bytes);

    // Two finished videos of 100 MB, never sent: sparse on disk, so the test writes no 200 MB.
    const big = rig();
    const largest = Buffer.alloc(UPLOAD_LIMITS.maxBytes);
    FTYP.copy(largest);
    const finishedLargest = async () => {
      const uploadId = await big.begin(largest);
      const part = join(big.uploads, `${uploadId}.part`);
      writeFileSync(part, FTYP);
      truncateSync(part, UPLOAD_LIMITS.maxBytes);
      expect(await big.call("session.uploadFinish", { uploadId })).toMatchObject({ ok: true });
    };
    await finishedLargest();
    await finishedLargest();
    // THE MUTANT: count the unfinished alone, and finished videos the phone never sends fill the Mac.
    const over = await big.call("session.uploadBegin", { size: 1, sha256: sha256(Buffer.from("x")), mime: "video/mp4" });
    expect(over).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect((over as { message: string }).message).toContain("200 MB");
  });

  it("holds a phone to its caps when its begins all arrive at once", async () => {
    const r = rig();
    const bytes = movie(CHUNK);
    const beginOf = (size: number) => r.call("session.uploadBegin", { size, sha256: sha256(bytes), mime: "video/mp4" });
    // THE MUTANT: no line for a phone's begins, and each one reads the caps before any of the others is written.
    const answers = await Promise.all(Array.from({ length: 6 }, () => beginOf(bytes.length)));
    expect(answers.filter((a) => a.ok)).toHaveLength(UPLOAD_LIMITS.maxOpen);
    for (const refused of answers.filter((a) => !a.ok)) expect((refused as { message: string }).message).toContain("2 videos");
    expect(r.listed(r.uploads)).toHaveLength(2 * UPLOAD_LIMITS.maxOpen);

    // One finished video of 100 MB, never sent, then two of 60 MB at once: only one fits under 200 MB.
    const big = rig();
    const largest = Buffer.alloc(UPLOAD_LIMITS.maxBytes);
    FTYP.copy(largest);
    const uploadId = await big.begin(largest);
    const part = join(big.uploads, `${uploadId}.part`);
    writeFileSync(part, FTYP);
    truncateSync(part, UPLOAD_LIMITS.maxBytes);
    expect(await big.call("session.uploadFinish", { uploadId })).toMatchObject({ ok: true });
    const sixty = () => big.call("session.uploadBegin", { size: 60 * MB, sha256: "0".repeat(64), mime: "video/mp4" });
    const [first, second] = await Promise.all([sixty(), sixty()]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect((second as { message: string }).message).toContain("200 MB");
  });

  it("is refused when the Mac has less than twice its size and a gigabyte free", async () => {
    const size = 10 * MB;
    const at = (free: number) => rig({ free }).call("session.uploadBegin", { size, sha256: "0".repeat(64), mime: "video/mp4" });
    // THE MUTANT: check only that the video itself fits, and the Mac fills its disk taking it.
    const short = await at(2 * size + GB - 1);
    expect(short).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect((short as { message: string }).message).toMatch(/^This Mac has \d+ MB free, and needs 1044 MB to take this video\.$/);
    expect(await at(2 * size + GB)).toMatchObject({ ok: true });
  });

  it("sweeps an upload left a day, and drops one aborted at once", async () => {
    const r = rig();
    const bytes = movie(CHUNK);
    const old = await r.begin(bytes);
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    for (const name of [`${old}.part`, `${old}.json`]) utimesSync(join(r.uploads, name), dayAgo, dayAgo);
    const kept = await r.begin(bytes);
    expect(r.listed(r.uploads)).toEqual([`${kept}.json`, `${kept}.part`].sort());
    expect(await r.status(old)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await r.call("session.uploadAbort", { uploadId: kept })).toEqual({ ok: true, result: { ok: true } });
    expect(r.listed(r.uploads)).toEqual([]);
  });

  it("goes with its message only once finished, and counts toward the files a message takes", async () => {
    const r = rig();
    const bytes = movie(CHUNK);
    const uploadId = await r.begin(bytes);
    await r.sendAll(uploadId, bytes);
    expect(await r.call("session.send", { id: "s1", text: "look", uploads: [uploadId] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    await r.call("session.uploadFinish", { uploadId });
    const photo = { name: "a.txt", mime: "text/plain", data: base64(Buffer.from("x")) };
    const full = Array.from({ length: SEND_LIMITS.maxCount }, () => photo);
    expect(await r.call("session.send", { id: "s1", text: "look", attachments: full, uploads: [uploadId] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(r.sent).toEqual([]);
    expect(await r.call("session.send", { id: "s1", text: "look", attachments: [photo], uploads: [uploadId] })).toMatchObject({ ok: true });
    expect(r.sent[0]!.attachments.map((a) => a.mime)).toEqual(["text/plain", "video/mp4"]);
  });
});
