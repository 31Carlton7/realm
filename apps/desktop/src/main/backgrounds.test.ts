import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import {
  MAX_BYTES, MAX_EDGE, MAX_VIDEO_BYTES, THUMB_EDGE, addBackgrounds, backgroundImageUrl, backgroundLoopFile, gifFrames, listBackgrounds, removeBackground, setBackgroundPoster, updateBackground,
  type FirstFrame, type Reencode,
} from "./backgrounds";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Stands in for nativeImage: every "picture" is 6400×3200, scaled to the edge it is asked for, and
 *  the output names the edge so a test can see which copy went where. */
const asked: number[] = [];
const reencode: Reencode = (bytes, maxEdge) => {
  asked.push(maxEdge);
  const scale = Math.min(1, maxEdge / 6400);
  return { jpeg: Buffer.from(`jpeg@${maxEdge}`), width: Math.round(6400 * scale), height: Math.round(3200 * scale) };
};

/** Stands in for QuickLook: a video's first frame, read off the file's own bytes so a test can tell
 *  which file it came from; null for one whose bytes say BAD!. */
const frames: string[] = [];
const firstFrame: FirstFrame = async (path) => {
  frames.push(path);
  const b = await readFile(path);
  return b.includes("BAD!") ? null : PNG;
};

/** An ISO media file's first box, and WebM's magic. */
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

/** A GIF89a of `n` 1×1 pictures, with a global colour table and a graphic control block each. */
function gif(n: number): Buffer {
  const head = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]);
  const frame = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]);
  return Buffer.concat([head, ...Array.from({ length: n }, () => frame), Buffer.from([0x3b])]);
}

let home: string;
let src: string;
beforeEach(() => { home = tempDir("realm-bg-home-"); src = tempDir("realm-bg-src-"); asked.length = 0; frames.length = 0; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); });

const file = async (name: string, bytes: Buffer) => { const p = join(src, name); await writeFile(p, bytes); return p; };

describe("your images", () => {
  it("adds, renames, re-treats and removes a picture, and keeps only Realm's copies", async () => {
    const path = await file("Beach day.png", PNG);
    const { added, refused } = await addBackgrounds(home, [path], reencode, firstFrame, () => 1234);
    expect(refused).toEqual([]);
    expect(added).toHaveLength(1);
    const [img] = added;
    expect(img).toMatchObject({ name: "Beach day", added: 1234, effect: "dither-color", asIs: false, width: MAX_EDGE, height: MAX_EDGE / 2 });
    // Downscaled to the cap, and a thumbnail made from that copy.
    expect(asked).toEqual([MAX_EDGE, THUMB_EDGE]);
    expect(await readdir(join(home, "backgrounds"))).toEqual(expect.arrayContaining([`${img!.id}.jpg`, `${img!.id}.thumb.jpg`, "index.json"]));
    expect(await listBackgrounds(home)).toEqual(added);

    const full = await backgroundImageUrl(home, img!.id, "full");
    expect(Buffer.from(full!.split(",")[1]!, "base64").toString()).toBe(`jpeg@${MAX_EDGE}`);
    const thumb = await backgroundImageUrl(home, img!.id, "thumb");
    expect(Buffer.from(thumb!.split(",")[1]!, "base64").toString()).toBe(`jpeg@${THUMB_EDGE}`);

    expect(await updateBackground(home, img!.id, { name: "  Beach  " })).toMatchObject({ name: "Beach" });
    expect(await updateBackground(home, img!.id, { name: "   " })).toMatchObject({ name: "Beach" });
    expect(await updateBackground(home, img!.id, { asIs: true, effect: "halftone" })).toMatchObject({ asIs: true, effect: "halftone" });
    expect(await updateBackground(home, img!.id, { effect: "sepia" })).toMatchObject({ effect: "halftone" });
    expect((await listBackgrounds(home))[0]).toMatchObject({ name: "Beach", asIs: true, effect: "halftone" });

    expect(await removeBackground(home, img!.id)).toBe(true);
    expect(await listBackgrounds(home)).toEqual([]);
    expect(await readdir(join(home, "backgrounds"))).toEqual(["index.json"]);
    expect(await backgroundImageUrl(home, img!.id, "full")).toBeNull();
    // The original is left where it was.
    expect(await readFile(path)).toEqual(PNG);
  });

  it("refuses what the renderer cannot draw, before reading it, and adds the rest", async () => {
    const big = await file("huge.jpg", JPEG);
    await truncate(big, MAX_BYTES + 1);
    const paths = [
      await file("notes.txt", Buffer.from("hello")),
      await file("photo.heic", JPEG),
      await file("liar.png", JPEG),
      big,
      await file("broken.png", Buffer.concat([PNG.subarray(0, 8), Buffer.from("BAD!")])),
      join(src, "gone.png"),
      await file("ok.jpg", JPEG),
    ];
    // A broken picture with the right first bytes only fails once it is decoded.
    const r = await addBackgrounds(home, paths, (b, e) => (b.subarray(8, 12).toString() === "BAD!" ? null : reencode(b, e)), firstFrame);
    expect(r.added.map((a) => a.name)).toEqual(["ok"]);
    expect(Object.fromEntries(r.refused.map((f) => [f.name, f.reason]))).toEqual({
      "notes.txt": "Realm can show PNG, JPEG, GIF and WebP pictures, and MP4, MOV and WebM videos.",
      "photo.heic": "Realm can show PNG, JPEG, GIF and WebP pictures, and MP4, MOV and WebM videos.",
      "liar.png": "The file is not the picture its name says it is.",
      "huge.jpg": "It is over 25 MB.",
      "broken.png": "Realm could not read it as a picture.",
      "gone.png": "The file is no longer there.",
    });
  });

  it("keeps a video as its loop, with its first frame as the picture, and serves and removes it by id", async () => {
    const clip = await file("Waves.mp4", MP4);
    const { added, refused } = await addBackgrounds(home, [clip], reencode, firstFrame);
    expect(refused).toEqual([]);
    const [v] = added;
    expect(v).toMatchObject({ name: "Waves", loop: "mp4", effect: "dither-color" });
    // The picture is the frame QuickLook drew, re-encoded as every picture is.
    expect(frames).toEqual([clip]);
    expect(asked).toEqual([MAX_EDGE, THUMB_EDGE]);
    const kept = await backgroundLoopFile(home, v!.id);
    expect(kept).toEqual({ path: join(home, "backgrounds", `${v!.id}.mp4`), loop: "mp4" });
    expect(await readFile(kept!.path)).toEqual(MP4);
    expect(await listBackgrounds(home)).toEqual(added);
    expect(await removeBackground(home, v!.id)).toBe(true);
    expect(await readdir(join(home, "backgrounds"))).toEqual(["index.json"]);
    expect(await backgroundLoopFile(home, v!.id)).toBeNull();
  });

  it("makes a video's picture again from the first frame the renderer decoded, and nothing else's", async () => {
    const { added } = await addBackgrounds(home, [await file("v.mp4", MP4), await file("p.png", PNG), await file("g.gif", gif(2))], reencode, firstFrame);
    const [v, p, g] = added;
    asked.length = 0;
    expect(await setBackgroundPoster(home, v!.id, PNG, reencode)).toMatchObject({ id: v!.id, loop: "mp4", width: MAX_EDGE });
    expect(asked).toEqual([MAX_EDGE, THUMB_EDGE]);
    for (const other of [p!.id, g!.id, "nope"]) expect(await setBackgroundPoster(home, other, PNG, reencode)).toBeNull();
    expect(await setBackgroundPoster(home, v!.id, PNG, () => null)).toBeNull();
  });

  it("refuses a video that will not decode, or that is not what its name says", async () => {
    const r = await addBackgrounds(home, [
      await file("broken.mp4", Buffer.concat([MP4, Buffer.from("BAD!")])),
      await file("liar.webm", MP4),
      await file("ok.webm", WEBM),
    ], reencode, firstFrame);
    expect(r.added.map((a) => [a.name, a.loop])).toEqual([["ok", "webm"]]);
    expect(Object.fromEntries(r.refused.map((f) => [f.name, f.reason]))).toEqual({
      "broken.mp4": "Realm could not read it as a video.",
      "liar.webm": "The file is not the video its name says it is.",
    });
    const big = await file("long.mov", MP4);
    await truncate(big, MAX_VIDEO_BYTES + 1);
    expect((await addBackgrounds(home, [big], reencode, firstFrame)).refused[0]?.reason).toBe("It is over 512 MB.");
  });

  it("keeps a GIF that moves as its loop, and a still GIF as a picture alone", async () => {
    expect([gif(1), gif(3), gif(3).subarray(0, 50), Buffer.alloc(4)].map(gifFrames)).toEqual([1, 3, 1, 0]);
    const { added } = await addBackgrounds(home, [await file("spin.gif", gif(3)), await file("dot.gif", gif(1))], reencode, firstFrame);
    expect(added.map((a) => [a.name, a.loop])).toEqual([["spin", "gif"], ["dot", null]]);
    // A GIF's picture is decoded as any picture is: QuickLook is for videos only.
    expect(frames).toEqual([]);
    expect(await backgroundLoopFile(home, added[1]!.id)).toBeNull();
    expect(await readFile((await backgroundLoopFile(home, added[0]!.id))!.path)).toEqual(gif(3));
  });

  it("refuses a link whose name says picture and whose target is not one", async () => {
    const secret = await file("id_rsa", Buffer.from("-----BEGIN PRIVATE KEY-----"));
    const link = join(src, "evil.png");
    await symlink(secret, link);
    const r = await addBackgrounds(home, [link], reencode, firstFrame);
    expect(r.added).toEqual([]);
    expect(r.refused[0]?.reason).toBe("The file is not the picture its name says it is.");
  });

  it("serves only ids the index holds", async () => {
    const { added } = await addBackgrounds(home, [await file("a.png", PNG)], reencode, firstFrame);
    await writeFile(join(home, "secret.jpg"), "x");
    for (const id of ["../secret", "../../etc/passwd", "", 42, null]) {
      expect(await backgroundImageUrl(home, id, "full")).toBeNull();
      expect(await backgroundLoopFile(home, id)).toBeNull();
    }
    expect(await backgroundImageUrl(home, added[0]!.id, "full")).toMatch(/^data:image\/jpeg;base64,/);
    expect(await updateBackground(home, "nope", { name: "x" })).toBeNull();
    expect(await removeBackground(home, "nope")).toBe(false);
  });

  it("reads a damaged index as empty, and drops entries it cannot use", async () => {
    expect(await listBackgrounds(home)).toEqual([]);
    const { added } = await addBackgrounds(home, [await file("a.png", PNG)], reencode, firstFrame);
    const index = join(home, "backgrounds", "index.json");
    const raw = JSON.parse(await readFile(index, "utf8"));
    raw.images.push({ id: "../x", name: "bad", added: 1 }, { name: "no id" }, null);
    await writeFile(index, JSON.stringify(raw));
    expect((await listBackgrounds(home)).map((e) => e.id)).toEqual([added[0]!.id]);
    await writeFile(index, "{ not json");
    expect(await listBackgrounds(home)).toEqual([]);
  });
});
