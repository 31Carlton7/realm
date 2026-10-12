import { inflateSync } from "node:zlib";

/** An 8-bit RGBA, non-interlaced PNG — what resources/icon-src/render.mjs writes — decoded far enough
 *  to read a pixel. For tests that check what a rendered picture shows rather than how it was made. */
export function decodeRgbaPng(png: Buffer) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error("not an 8-bit RGBA, non-interlaced PNG");
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4]! : 0, b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      px[y * stride + x] = (line[x]! + pred) & 0xff;
    }
  }
  const pixel = (x: number, y: number): [number, number, number, number] => {
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
  };
  return { width, height, pixel, data: px };
}

export const hex = ([r, g, b]: number[]) => `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
