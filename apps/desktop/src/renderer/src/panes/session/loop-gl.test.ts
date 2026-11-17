import { describe, expect, it } from "vitest";
import { hush, readableRange } from "./chat-backdrop";
import { gaussian, hushPixel } from "./loop-gl";
import type { Rgb } from "./hero-backdrop";

// The faces' own inks over a picture, as measured in the built app (chat-backdrop.test.ts).
const rgb = (...c: number[]) => c.map((v) => v / 255) as Rgb;
const faces = {
  light: { ground: rgb(255, 255, 255), inks: [rgb(26, 28, 31), rgb(61, 62, 64)], links: [rgb(27, 98, 214)] },
  dark: { ground: rgb(28, 29, 31), inks: [rgb(242, 243, 244), rgb(203, 205, 208)], links: [rgb(151, 199, 250)] },
};

/** Every 15th level of each channel: 5,832 colours, from black to white through every hue. */
const SAMPLES: [number, number, number][] = [];
for (let r = 0; r <= 255; r += 15) for (let g = 0; g <= 255; g += 15) for (let b = 0; b <= 255; b += 15) SAMPLES.push([r, g, b]);

describe("the loop's hush", () => {
  for (const [name, face] of Object.entries(faces)) {
    // The same search to the same share kept, in single precision as the GPU works: a mix that lands
    // on a half level may round the other way, so a channel may differ by one level and no more. The
    // ratios hold a guard's spare (GUARD_SPARE) over what they need, which a level does not reach.
    // On white the halves are common (2.4% of these samples), on the dark ground rare.
    it(`gives every sample pixel the colour hush() does, to a level, in the ${name} face`, () => {
      const range = readableRange(face.ground, face.inks, face.links);
      const px = new Uint8ClampedArray(SAMPLES.length * 4);
      SAMPLES.forEach((c, i) => px.set([...c, 255], i * 4));
      hush(px, face.ground, range);
      let moved = 0, exact = 0;
      SAMPLES.forEach((c, i) => {
        const out = hushPixel(c.map((v) => v / 255) as Rgb, face.ground, range[0], range[1]).map((v) => Math.round(v * 255));
        const want = [px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!];
        expect(Math.max(...out.map((v, k) => Math.abs(v - want[k]!))), `${c}`).toBeLessThanOrEqual(1);
        if (out.every((v, k) => v === want[k])) exact++;
        if (out.some((v, k) => v !== c[k])) moved++;
      });
      expect(exact / SAMPLES.length).toBeGreaterThan(0.95);
      // A sample set that hush() leaves alone would prove nothing.
      expect(moved).toBeGreaterThan(SAMPLES.length / 10);
    });
  }
});

describe("the chat loop's blur", () => {
  it("is a Gaussian of the edge blur's radius out to three sigma, weighing 1 in all", () => {
    const w = gaussian(3);
    expect(w).toHaveLength(10);
    expect(w[0]! + 2 * w.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(w[3]! / w[0]!).toBeCloseTo(Math.exp(-0.5), 10);
    expect(gaussian(0)).toEqual([1]);
  });
});
