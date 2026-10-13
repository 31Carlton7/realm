import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { filePreview, PREVIEW_MAX_PX, sipsDownscale } from "./preview";

/**
 * The picture half of `session.file`, against macOS's own `sips` rather than a stand-in: what a
 * phone is sent is a JPEG it can draw, never larger than PREVIEW_MAX_PX on its longer side, and a
 * small picture is not blown up on the way.
 */

const sips = existsSync("/usr/bin/sips");
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sizeOf = (path: string): [number, number] => {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  return [Number(/pixelWidth:\s*(\d+)/.exec(out)![1]), Number(/pixelHeight:\s*(\d+)/.exec(out)![1])];
};

describe.runIf(sips)("a picture a turn made, as a phone is sent it", () => {
  it("is a JPEG no wider or taller than the cap", async () => {
    const dir = tempDir("realm-preview-");
    const small = join(dir, "dot.png");
    writeFileSync(small, Buffer.from(ONE_PIXEL_PNG, "base64"));
    const big = join(dir, "wide.png");
    execFileSync("sips", ["-z", "1000", "2400", small, "--out", big], { stdio: "ignore" });

    const preview = await filePreview(big);
    expect(preview).toMatchObject({ name: "wide.png", mime: "image/png", preview: { kind: "image", mime: "image/jpeg" } });
    const jpeg = Buffer.from((preview.preview as { data: string }).data, "base64");
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const out = join(dir, "sent.jpg");
    writeFileSync(out, jpeg);
    const [w, h] = sizeOf(out);
    expect(w).toBe(PREVIEW_MAX_PX);
    expect(Math.abs(h - (1000 * PREVIEW_MAX_PX) / 2400)).toBeLessThan(1);
  });

  it("leaves a small picture its own size", async () => {
    const dir = tempDir("realm-preview-");
    const small = join(dir, "dot.png");
    writeFileSync(small, Buffer.from(ONE_PIXEL_PNG, "base64"));
    const out = join(dir, "sent.jpg");
    writeFileSync(out, await sipsDownscale(small, PREVIEW_MAX_PX, 70));
    expect(sizeOf(out)).toEqual([1, 1]);
  });

  it("says so, rather than failing, when the picture does not open", async () => {
    const dir = tempDir("realm-preview-");
    writeFileSync(join(dir, "broken.png"), "not a picture at all");
    expect(await filePreview(join(dir, "broken.png"))).toMatchObject({ preview: { kind: "none" } });
  });
});
