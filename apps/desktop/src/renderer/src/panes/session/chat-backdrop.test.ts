import { describe, expect, it } from "vitest";
import { readableShare } from "./chat-backdrop";
import { contrast } from "./hero-backdrop-color";
import type { Rgb } from "./hero-backdrop";

const picture = (...rgbs: [number, number, number][]) => {
  const px = new Uint8ClampedArray(rgbs.length * 4);
  rgbs.forEach((c, i) => px.set([...c, 255], i * 4));
  return px;
};
const over = (pixel: [number, number, number], ground: Rgb, share: number): Rgb =>
  [0, 1, 2].map((k) => ground[k]! * (1 - share) + (pixel[k]! / 255) * share) as Rgb;

describe("readableShare", () => {
  const light: Rgb = [0.98, 0.98, 0.99], body: Rgb = [0.1, 0.1, 0.12], quiet: Rgb = [0.4, 0.4, 0.43];
  const dark: Rgb = [0.13, 0.13, 0.14], darkBody: Rgb = [0.93, 0.93, 0.95], darkQuiet: Rgb = [0.68, 0.68, 0.71];

  it("lowers a mid-tone sky until the quiet ink still reads at 4.5:1 against its worst pixel", () => {
    const sky: [number, number, number][] = [[92, 128, 237], [150, 180, 240], [235, 240, 250]];
    const share = readableShare(picture(...sky), light, [body, quiet]);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    for (const px of sky) expect(contrast(quiet, over(px, light, share))).toBeGreaterThanOrEqual(4.5);
    // The least dim that does it: a step more picture and the bluest pixel no longer reads.
    expect(contrast(quiet, over(sky[0]!, light, Math.min(1, share + 0.05)))).toBeLessThan(4.8);
  });

  it("keeps a picture that is already darker than the dark face's ground whole", () => {
    expect(readableShare(picture([10, 12, 30], [20, 22, 40]), dark, [darkBody, darkQuiet])).toBe(1);
  });

  it("takes the picture down further for a brighter one", () => {
    const dim = readableShare(picture([90, 90, 90]), dark, [darkBody, darkQuiet]);
    const bright = readableShare(picture([220, 200, 160]), dark, [darkBody, darkQuiet]);
    expect(bright).toBeLessThan(dim);
  });
});
