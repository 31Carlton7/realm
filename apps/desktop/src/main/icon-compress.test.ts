import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createFromPath } = vi.hoisted(() => ({ createFromPath: vi.fn() }));
vi.mock("electron", () => ({ nativeImage: { createFromPath } }));

const { compressIconIfNeeded, tempAttachmentDir } = await import("./attachments");
type PickedFile = Awaited<ReturnType<typeof compressIconIfNeeded>>;

/** A minimal stand-in for Electron's `NativeImage` — just enough of the surface
 *  `compressIconIfNeeded` calls. `resize` mutates the reported size, mirroring the real API. */
function fakeImage(opts: { width: number; height: number; png?: Buffer; jpeg?: Buffer; empty?: boolean }) {
  const png = opts.png ?? Buffer.alloc(1024, 1);
  const jpeg = opts.jpeg ?? Buffer.alloc(1024, 1);
  let size = { width: opts.width, height: opts.height };
  const img = {
    isEmpty: () => !!opts.empty,
    getSize: () => size,
    resize: ({ width, height }: { width: number; height: number }) => { size = { width, height }; return img; },
    toPNG: () => png,
    toJPEG: () => jpeg,
  };
  return img;
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "realm-icon-test-"));
  createFromPath.mockReset();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const file = async (name: string, mime: string, bytes: number): Promise<PickedFile> => {
  const path = join(home, name);
  await writeFile(path, Buffer.alloc(bytes, 1));
  return { path, mime, name, size: bytes };
};

describe("compressIconIfNeeded", () => {
  it("leaves an upload at or under the 10KB threshold untouched", async () => {
    const f = await file("small.png", "image/png", 10 * 1024);
    expect(await compressIconIfNeeded(home, f)).toEqual(f);
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("leaves an SVG untouched regardless of size — it's vector, not raster", async () => {
    const f = await file("big.svg", "image/svg+xml", 50 * 1024);
    expect(await compressIconIfNeeded(home, f)).toEqual(f);
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("downscales and re-encodes a large PNG into a smaller temp file", async () => {
    const f = await file("big.png", "image/png", 50 * 1024);
    const smaller = Buffer.alloc(2000, 2);
    createFromPath.mockReturnValue(fakeImage({ width: 1024, height: 1024, png: smaller }));

    const out = await compressIconIfNeeded(home, f);

    expect(createFromPath).toHaveBeenCalledWith(f.path);
    expect(out.path).not.toBe(f.path);
    expect(out.path.startsWith(tempAttachmentDir(home))).toBe(true);
    expect(out.mime).toBe("image/png");
    expect(out.size).toBe(2000);
    expect(await readFile(out.path)).toEqual(smaller);
  });

  it("re-encodes a JPEG as JPEG rather than converting it to PNG", async () => {
    const f = await file("big.jpg", "image/jpeg", 50 * 1024);
    const smaller = Buffer.alloc(3000, 3);
    createFromPath.mockReturnValue(fakeImage({ width: 800, height: 600, jpeg: smaller }));

    const out = await compressIconIfNeeded(home, f);
    expect(out.mime).toBe("image/jpeg");
    expect(out.size).toBe(3000);
  });

  it("does not resize an image that's already within the max icon dimension", async () => {
    const f = await file("big-but-small-dims.png", "image/png", 50 * 1024);
    const img = fakeImage({ width: 64, height: 64, png: Buffer.alloc(2000, 5) });
    const resizeSpy = vi.spyOn(img, "resize");
    createFromPath.mockReturnValue(img);

    await compressIconIfNeeded(home, f);
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it("falls back to the original file when the image can't be decoded", async () => {
    const f = await file("bad.png", "image/png", 50 * 1024);
    createFromPath.mockReturnValue(fakeImage({ width: 0, height: 0, empty: true }));
    expect(await compressIconIfNeeded(home, f)).toEqual(f);
  });

  it("falls back to the original file when re-encoding doesn't actually shrink it", async () => {
    const f = await file("already-tight.png", "image/png", 11 * 1024);
    const notSmaller = Buffer.alloc(20 * 1024, 4);
    createFromPath.mockReturnValue(fakeImage({ width: 100, height: 100, png: notSmaller }));
    expect(await compressIconIfNeeded(home, f)).toEqual(f);
  });
});
