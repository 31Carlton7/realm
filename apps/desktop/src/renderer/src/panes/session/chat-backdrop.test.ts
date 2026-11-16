import { describe, expect, it } from "vitest";
import { hush, readableRange } from "./chat-backdrop";
import { contrast } from "./hero-backdrop-color";
import type { Rgb } from "./hero-backdrop";

const picture = (...rgbs: [number, number, number][]) => {
  const px = new Uint8ClampedArray(rgbs.length * 4);
  rgbs.forEach((c, i) => px.set([...c, 255], i * 4));
  return px;
};
const pixels = (px: Uint8ClampedArray): Rgb[] =>
  Array.from({ length: px.length / 4 }, (_, i) => [px[i * 4]! / 255, px[i * 4 + 1]! / 255, px[i * 4 + 2]! / 255]);

// The faces' own inks, as measured in the built app.
const rgb = (...c: number[]) => c.map((v) => v / 255) as Rgb;
const light = { ground: rgb(255, 255, 255), inks: [rgb(26, 28, 31), rgb(96, 97, 99), rgb(58, 131, 247)] };
const dark = { ground: rgb(28, 29, 31), inks: [rgb(242, 243, 244), rgb(165, 168, 173), rgb(61, 154, 255)] };

describe("hush", () => {
  it("brings a bright cloud down until every ink still reads over it, in the dark face", () => {
    const px = picture([250, 220, 200], [120, 140, 230], [235, 240, 250]);
    hush(px, dark.ground, readableRange(dark.ground, dark.inks));
    for (const p of pixels(px)) {
      expect(contrast(dark.inks[0]!, p)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.inks[1]!, p)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every pixel that already lets the words read exactly as it was", () => {
    const night: [number, number, number][] = [[10, 12, 30], [20, 22, 40], [40, 20, 60]];
    const px = picture(...night);
    hush(px, dark.ground, readableRange(dark.ground, dark.inks));
    expect(Array.from(px)).toEqual(Array.from(picture(...night)));
  });

  it("takes a pixel only as far as it must: a step more of it and an ink misses", () => {
    const [cloud] = pixels(picture([250, 220, 200]));
    const px = picture([250, 220, 200]);
    hush(px, dark.ground, readableRange(dark.ground, dark.inks));
    const [kept] = pixels(px);
    const share = (kept![0] - dark.ground[0]) / (cloud![0] - dark.ground[0]);
    expect(share).toBeGreaterThan(0);
    const more = [0, 1, 2].map((k) => dark.ground[k]! + (cloud![k]! - dark.ground[k]!) * Math.min(1, share + 0.06)) as Rgb;
    expect(Math.min(...dark.inks.map((ink) => contrast(ink, more)))).toBeLessThan(4.8);
  });

  it("leaves the light face a picture although its link blue misses 4.5:1 on the plain ground", () => {
    expect(contrast(light.inks[2]!, light.ground)).toBeLessThan(4.5);
    const px = picture([92, 128, 237], [150, 180, 240], [200, 210, 230]);
    hush(px, light.ground, readableRange(light.ground, light.inks));
    for (const p of pixels(px)) {
      expect(p.some((v) => v < 0.97)).toBe(true);
      expect(contrast(light.inks[1]!, p)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light.inks[2]!, p)).toBeGreaterThanOrEqual(3);
    }
  });

  it("leaves a bright sky more of itself in the light face once its quiet ink and links go a step deeper", () => {
    // The light face over a picture: quiet text halfway to body ink, links in the deeper accent
    // (styles.css), with the links held to 3:1. THE MUTANTS: the hush still reading the root's inks,
    // or the deeper link held to 4.5:1, which takes the sky back to white.
    const deeper = { quiet: rgb(61, 62, 65), link: rgb(28, 103, 212) };
    const sky = [120, 170, 235] as [number, number, number];
    const today = picture(sky);
    hush(today, light.ground, readableRange(light.ground, light.inks));
    const moved = picture(sky);
    hush(moved, light.ground, readableRange(light.ground, [light.inks[0]!, deeper.quiet], [deeper.link]));
    const [was] = pixels(today), [now] = pixels(moved);
    const distance = (p: Rgb) => Math.hypot(...p.map((v, k) => v - sky[k]! / 255));
    expect(distance(now!)).toBeLessThan(distance(was!) * 0.6);
    expect(contrast(light.inks[0]!, now!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(deeper.quiet, now!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(deeper.link, now!)).toBeGreaterThanOrEqual(3);
  });
});
