import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { DEFAULT_BACKGROUND, shufflePick } from "@realm/contracts";
import { MobileApi } from "./api";
import { channel, fakeRpc } from "./api.test-fakes";
import { readGallery, readMine, resolveLook, stillPath, STILL_SIDE, type GalleryEntry, type MineEntry } from "./backgrounds";

const MINE = "0123456789abcdef";
const S = "01JSESSION00000000000000000";

/** A gallery of three looks, one of which has a loop for its light face, and a home holding one picture
 *  of the person's own. */
function fixture() {
  const gallery = tempDir("realm-gallery-");
  for (const f of ["sky-day.jpg", "space-webb.jpg", "dunes.jpg", "glow-light.jpg", "glow-light.mp4", "glow-dark.jpg"]) writeFileSync(join(gallery, f), "x");
  writeFileSync(join(gallery, "gallery.json"), JSON.stringify([
    { id: DEFAULT_BACKGROUND, name: "Sky and Cliffs", light: "sky-day.jpg", dark: "space-webb.jpg", effect: "dither-color" },
    { id: "dunes", name: "Dunes", light: "dunes.jpg", dark: "dunes.jpg", effect: "halftone" },
    { id: "glow", name: "Glow", light: "glow-dark.jpg", dark: "glow-dark.jpg", effect: "dither-color", motion: true, loop: { light: "glow-light.mp4" } },
    { id: "gone", name: "Gone", light: "missing.jpg", dark: "missing.jpg", effect: "dither" },
  ]));
  const home = tempDir("realm-home-");
  mkdirSync(join(home, "backgrounds"));
  writeFileSync(join(home, "backgrounds", `${MINE}.jpg`), "x");
  writeFileSync(join(home, "backgrounds", "index.json"), JSON.stringify({ images: [{ id: MINE, name: "Our cabin", added: 1, effect: "dither", asIs: true }] }));
  return { gallery, home };
}

describe("a session's look, resolved on the Mac", () => {
  const gallery: GalleryEntry[] = [
    { id: DEFAULT_BACKGROUND, effect: "dither-color", light: "sky-day.jpg", dark: "space-webb.jpg" },
    { id: "dunes", effect: "halftone", light: "dunes.jpg", dark: "dunes.jpg" },
  ];
  const mine: MineEntry[] = [{ id: MINE, effect: "dither", asIs: true }];

  it("is none when pictures are off", () => {
    expect(resolveLook("off", S, gallery, mine)).toBeNull();
  });

  it("is the gallery look named, each face its still", () => {
    expect(resolveLook("dunes", S, gallery, mine)).toEqual({ id: "dunes", effect: "halftone", asIs: false, faces: { light: "gallery:dunes.jpg", dark: "gallery:dunes.jpg" } });
  });

  it("is one of the person's own, printed as they chose", () => {
    expect(resolveLook(`mine:${MINE}`, S, gallery, mine)).toEqual({ id: `mine:${MINE}`, effect: "dither", asIs: true, faces: { light: `mine:${MINE}`, dark: `mine:${MINE}` } });
  });

  it("shuffles per session among every look and picture, the same one each time", () => {
    const pool = ["sky-and-cliffs", "dunes", `mine:${MINE}`];
    for (const id of [S, "01JOTHER0000000000000000000", "01JTHIRD0000000000000000000"]) {
      expect(resolveLook("shuffle", id, gallery, mine)?.id).toBe(shufflePick(pool, id));
    }
  });

  it("is the default look for a choice that names nothing there", () => {
    expect(resolveLook("a-look-a-newer-build-shipped", S, gallery, mine)?.id).toBe(DEFAULT_BACKGROUND);
    expect(resolveLook("mine:ffffffffffffffff", S, gallery, mine)?.id).toBe(DEFAULT_BACKGROUND);
  });

  it("reads the gallery's drawable looks, a loop's face as its poster", async () => {
    const { gallery: dir } = fixture();
    expect(await readGallery(dir)).toEqual([
      { id: DEFAULT_BACKGROUND, effect: "dither-color", light: "sky-day.jpg", dark: "space-webb.jpg" },
      { id: "dunes", effect: "halftone", light: "dunes.jpg", dark: "dunes.jpg" },
      { id: "glow", effect: "dither-color", light: "glow-light.jpg", dark: "glow-dark.jpg" },
    ]);
  });

  it("finds a still only among the pictures there, never a path as given", async () => {
    const { gallery: dir, home } = fixture();
    const [g, m] = [await readGallery(dir), await readMine(home)];
    expect(stillPath("gallery:dunes.jpg", dir, g, home, m)).toBe(join(dir, "dunes.jpg"));
    expect(stillPath(`mine:${MINE}`, dir, g, home, m)).toBe(join(home, "backgrounds", `${MINE}.jpg`));
    expect(stillPath("gallery:../../etc/passwd", dir, g, home, m)).toBeNull();
    expect(stillPath("gallery:gallery.json", dir, g, home, m)).toBeNull();
    expect(stillPath("mine:../index", dir, g, home, m)).toBeNull();
  });
});

describe("backgrounds over mobile.v1", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers the look the Mac's setting names", async () => {
    const { gallery, home } = fixture();
    const api = new MobileApi({ macName: () => "Mac", reportsDir: "/nonexistent", dev: false, realmHome: home, galleryDir: gallery });
    const rpc = fakeRpc({ sessions: [], items: [], settings: { "ui.background": "dunes" } });
    expect(await api.handle(channel(rpc), "backgrounds.look", { sessionId: S })).toEqual({ look: { id: "dunes", effect: "halftone", asIs: false, faces: { light: "gallery:dunes.jpg", dark: "gallery:dunes.jpg" } } });
    const unset = fakeRpc({ sessions: [], items: [] });
    expect(await api.handle(channel(unset), "backgrounds.look", { sessionId: S })).toMatchObject({ look: { id: DEFAULT_BACKGROUND } });
  });

  it("sends a still made small on the Mac", async () => {
    const { gallery, home } = fixture();
    const downscale = vi.fn(async () => Buffer.from("jpeg"));
    const api = new MobileApi({ macName: () => "Mac", reportsDir: "/nonexistent", dev: false, realmHome: home, galleryDir: gallery, downscale });
    expect(await api.handle(channel(fakeRpc({ sessions: [], items: [] })), "backgrounds.still", { key: "gallery:sky-day.jpg" }))
      .toEqual({ mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") });
    expect(downscale).toHaveBeenCalledWith(join(gallery, "sky-day.jpg"), STILL_SIDE, expect.any(Number));
    await expect(api.handle(channel(fakeRpc({ sessions: [], items: [] })), "backgrounds.still", { key: "gallery:nope.jpg" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sends the person's own picture to their phone and writes nothing of it anywhere", async () => {
    const { gallery, home } = fixture();
    const bytes = Buffer.from("their own picture");
    const api = new MobileApi({ macName: () => "Mac", reportsDir: "/nonexistent", dev: false, realmHome: home, galleryDir: gallery, downscale: async () => bytes });
    const said: string[] = [];
    const keep = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, level).mockImplementation(keep);
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { said.push(String(c)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { said.push(String(c)); return true; });
    const rpc = fakeRpc({ sessions: [], items: [], settings: { "ui.background": `mine:${MINE}` } });
    const look = await api.handle(channel(rpc), "backgrounds.look", { sessionId: S }) as { look: { faces: { light: string } } };
    const still = await api.handle(channel(rpc), "backgrounds.still", { key: look.look.faces.light });
    // A picture that will not read fails without its path.
    const broken = new MobileApi({ macName: () => "Mac", reportsDir: "/nonexistent", dev: false, realmHome: home, galleryDir: gallery, downscale: async () => { throw new Error(`sips failed on ${home}`); } });
    const refusal = await broken.handle(channel(rpc), "backgrounds.still", { key: `mine:${MINE}` }).catch((e: Error) => e);
    vi.restoreAllMocks();
    expect(still).toEqual({ mime: "image/jpeg", data: bytes.toString("base64") });
    expect(said).toEqual([]);
    expect((refusal as Error).message).not.toContain(home);
    expect((refusal as Error).message).not.toContain(MINE);
  });
});
