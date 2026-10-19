import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";

const { createFromPath } = vi.hoisted(() => ({ createFromPath: vi.fn() }));
vi.mock("electron", () => ({ nativeImage: { createFromPath } }));

const { SHARE_IMAGE_EDGE, SHARE_PNG_BUDGET, shareImage } = await import("./share-images");

/** Just enough of Electron's `NativeImage`: `resize` changes the reported size, as the real one does. */
function fakeImage(opts: { width: number; height: number; png?: number; empty?: boolean }) {
  let size = { width: opts.width, height: opts.height };
  const resized: { width: number; height: number }[] = [];
  const img = {
    isEmpty: () => !!opts.empty,
    getSize: () => size,
    resize: (to: { width: number; height: number }) => { resized.push(to); size = to; return img; },
    toPNG: () => Buffer.alloc(opts.png ?? 1024, 1),
    toJPEG: () => Buffer.alloc(512, 2),
    resized,
  };
  return img;
}

let home: string;
beforeEach(() => { home = tempDir("realm-share-image-"); createFromPath.mockReset(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const file = async (name: string) => { const path = join(home, name); await writeFile(path, "x"); return path; };

describe("shareImage", () => {
  it("brings a large picture down to the page's edge, keeping its shape", async () => {
    const img = fakeImage({ width: 3200, height: 2000 });
    createFromPath.mockReturnValue(img);
    expect(await shareImage(await file("shot.png"))).toMatch(/^data:image\/png;base64,/);
    expect(img.resized).toEqual([{ width: SHARE_IMAGE_EDGE, height: 1000, quality: "best" }]);
  });

  it("never draws a small picture larger than it is", async () => {
    const img = fakeImage({ width: 400, height: 300 });
    createFromPath.mockReturnValue(img);
    await shareImage(await file("small.png"));
    expect(img.resized).toEqual([]);
  });

  it("re-encodes as JPEG once a PNG would be too heavy", async () => {
    createFromPath.mockReturnValue(fakeImage({ width: 1600, height: 900, png: SHARE_PNG_BUDGET + 1 }));
    expect(await shareImage(await file("photo.png"))).toBe(`data:image/jpeg;base64,${Buffer.alloc(512, 2).toString("base64")}`);
  });

  it("answers null for what is not a readable picture", async () => {
    createFromPath.mockReturnValue(fakeImage({ width: 10, height: 10 }));
    expect(await shareImage(await file("notes.txt"))).toBeNull();
    expect(await shareImage(join(home, "gone.png"))).toBeNull();
    expect(await shareImage("relative/shot.png")).toBeNull();
    expect(await shareImage(42)).toBeNull();
    createFromPath.mockReturnValue(fakeImage({ width: 0, height: 0, empty: true }));
    expect(await shareImage(await file("broken.png"))).toBeNull();
  });
});
