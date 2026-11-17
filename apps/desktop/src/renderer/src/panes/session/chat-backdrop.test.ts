import { describe, expect, it } from "vitest";
import { TRACK, hush, hushTrack, readableRange, trackWeight, type Track } from "./chat-backdrop";
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

  it("keeps a picture in a dark theme whose link sits just over 4.5:1, by holding links to 3:1", () => {
    // His GitHub dark in a white space: links a mid grey at about 4.8:1. Held to 4.5 over the
    // picture, that alone pins every pixel to the ground. THE MUTANT: a link held to 4.5 again.
    const ground = rgb(19, 23, 28);
    const grey = rgb(132, 132, 132);
    expect(contrast(grey, ground)).toBeGreaterThan(4.5);
    const [lo, hi] = readableRange(ground, [rgb(232, 236, 240)], [grey]);
    expect(hi).toBeGreaterThan(0.03);
    expect(lo).toBeLessThanOrEqual(0.02);
  });

  it("is bound by the quiet ink where the quiet ink is the tightest, and moving it lifts the cap", () => {
    // A dark theme whose quiet text is the binding ink: halfway to body ink frees the picture, and the
    // quiet text still reads at 4.5 over it. THE MUTANT: the quiet ink ignored, so a pixel too bright
    // for it is let through.
    const ground = rgb(19, 23, 28), body = rgb(236, 239, 242), quiet = rgb(150, 156, 163), halfway = rgb(193, 197, 202);
    const [, before] = readableRange(ground, [body, quiet], []);
    const [, after] = readableRange(ground, [body, halfway], []);
    expect(after).toBeGreaterThan(before * 1.5);
    const px = picture([120, 140, 90]);
    hush(px, ground, readableRange(ground, [body, halfway], []));
    const [p] = pixels(px);
    expect(contrast(halfway, p!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(body, p!)).toBeGreaterThanOrEqual(4.5);
  });
});

/* The transcript's track (the owner, 11-17): the column the words sit in keeps the whole hush, a faint
   step toward the ground and the whole blur; past it the picture keeps most of its light. */
describe("the transcript's track", () => {
  // A row of 10 px, the column across px 3..6 and a 2 px feather: 0..2 outside, 3..6 in, 7..9 outside.
  const track: Track = { x0: 3, x1: 7, feather: 2 };
  const bright: [number, number, number] = [250, 236, 210];
  const row = (c: [number, number, number]) => picture(...Array.from({ length: 10 }, () => c));

  it("holds every ink over every pixel of the column, a faint step past the plain hush", () => {
    // THE mutant: the track's share of the hush lowered, so words over the column fall under 4.5:1.
    for (const face of [dark, light]) {
      const range = readableRange(face.ground, face.inks.slice(0, 2));
      const px = row(bright), sharp = row(bright);
      hushTrack(px, sharp, 10, face.ground, range, track);
      const plain = row(bright);
      hush(plain, face.ground, range);
      for (const i of [3, 4, 5, 6]) {
        const p = pixels(px)[i]!;
        for (const ink of face.inks.slice(0, 2)) expect(contrast(ink, p)).toBeGreaterThanOrEqual(4.5);
      }
      // The tint: a mid tone the hush alone leaves as it was comes a step toward the ground in the
      // column (darker in dark, lighter in light), and keeps itself past it.
      const mid: [number, number, number] = face === dark ? [40, 50, 70] : [236, 240, 246];
      const m = row(mid);
      hushTrack(m, row(mid), 10, face.ground, range, track);
      expect(contrast(face.ground, pixels(m)[4]!)).toBeLessThan(contrast(face.ground, pixels(row(mid))[4]!));
      expect(Array.from(m.slice(0, 4))).toEqual([...mid, 255]);
    }
  });

  it("leaves the picture far brighter past the column, easing there with no edge", () => {
    // THE mutants: the sides hushed whole again (the old darkening on send), or a hard step at the edge.
    const range = readableRange(dark.ground, dark.inks.slice(0, 2));
    const px = row(bright), sharp = row(bright);
    hushTrack(px, sharp, 10, dark.ground, range, track);
    const lum = (i: number) => { const [r, g, b] = pixels(px)[i]!; return r + g + b; };
    expect(lum(0)).toBeGreaterThan(lum(4) * 1.5);
    expect(lum(9)).toBeGreaterThan(lum(4) * 1.5);
    // Monotonic out of the column on both sides, through the feather.
    expect(lum(7)).toBeGreaterThanOrEqual(lum(6));
    expect(lum(8)).toBeGreaterThan(lum(7));
    expect(lum(2)).toBeGreaterThan(lum(3));
    expect(trackWeight(5, track)).toBe(1);
    expect(trackWeight(8, track)).toBeCloseTo(0.5, 5);
    expect(trackWeight(20, track)).toBe(0);
    // The sides keep `sideHush` of the hush, no more.
    expect(TRACK.sideHush).toBeLessThan(0.5);
  });

  it("takes the blur in the column and mostly the sharp picture past it", () => {
    const range: [number, number] = [0, 1]; // nothing to hush: only the blur's share shows
    const blurred = row([100, 100, 100]), sharp = row([200, 200, 200]);
    hushTrack(blurred, sharp, 10, dark.ground, range, { ...track });
    const at = (i: number) => pixels(blurred)[i]![0] * 255;
    expect(at(0)).toBeCloseTo(200 + (100 - 200) * TRACK.sideBlur, 0);
    // In the column the blurred picture, a tint toward the ground.
    expect(at(4)).toBeCloseTo(100 + (28 - 100) * TRACK.tint, 0);
  });

  it("is the plain hush everywhere when there is no column to find", () => {
    // THE mutant: the tint or the sharp mix applied with no track, which would move a pane with no transcript.
    const range = readableRange(dark.ground, dark.inks.slice(0, 2));
    const a = row(bright), b = row(bright);
    hushTrack(a, row([0, 0, 0]), 10, dark.ground, range);
    hush(b, dark.ground, range);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
