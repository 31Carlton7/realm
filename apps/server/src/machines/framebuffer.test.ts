import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  applyUpdate, blankFrame, downscale, encodePng, keyEventMessage, pointerEventMessage,
  setEncodingsMessage, setPixelFormatMessage, updateRequestMessage, DRIVER_PIXEL_FORMAT, type Frame,
} from "./framebuffer";

/** A Raw FramebufferUpdate carrying one rect of a solid colour, in the format the driver asked for. */
function rawRect(x: number, y: number, w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const head = Buffer.alloc(16);
  head[0] = 0; head.writeUInt16BE(1, 2);
  head.writeUInt16BE(x, 4); head.writeUInt16BE(y, 6);
  head.writeUInt16BE(w, 8); head.writeUInt16BE(h, 10);
  head.writeInt32BE(0, 12);
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // Little-endian in the requested shifts: byte0 blue, byte1 green, byte2 red.
    px[i * 4] = b; px[i * 4 + 1] = g; px[i * 4 + 2] = r; px[i * 4 + 3] = 0;
  }
  return Buffer.concat([head, px]);
}

const at = (f: Frame, x: number, y: number) => [...f.rgba.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)];

describe("the messages the driver sends", () => {
  it("asks for one pixel format, so decoding is one shape rather than sixteen", () => {
    const m = setPixelFormatMessage();
    expect(m).toHaveLength(20);
    expect(m[0]).toBe(0);
    expect(m[4]).toBe(32);   // bpp
    expect(m[6]).toBe(0);    // little-endian — the whole reason `applyUpdate` can index bytes directly
    expect(m[7]).toBe(1);    // true colour, so there is no palette to track
    expect([m[14], m[15], m[16]]).toEqual([DRIVER_PIXEL_FORMAT.redShift, DRIVER_PIXEL_FORMAT.greenShift, DRIVER_PIXEL_FORMAT.blueShift]);
  });

  it("offers Raw and nothing else, because Raw is the one every server must implement", () => {
    const m = setEncodingsMessage();
    expect(m[0]).toBe(2);
    expect(m.readUInt16BE(2)).toBe(1);
    expect(m.readInt32BE(4)).toBe(0);
  });

  /* `incremental = 0` is the difference between a SCREENSHOT and a diff. An agent that has been away
     for a minute asking incrementally gets the handful of rectangles that changed since a frame it
     never saw, composited onto a buffer it does not have. */
  it("asks for the whole screen, not a difference against a frame it never saw", () => {
    const m = updateRequestMessage(1440, 900);
    expect(m[0]).toBe(3);
    expect(m[1]).toBe(0);
    expect(m.readUInt16BE(6)).toBe(1440);
    expect(m.readUInt16BE(8)).toBe(900);
    expect(updateRequestMessage(1440, 900, true)[1]).toBe(1);
  });

  it("packs a pointer event at the framebuffer coordinate, clamped into the wire's range", () => {
    expect([...pointerEventMessage(412, 300, 1)]).toEqual([5, 1, 1, 156, 1, 44]);
    // A coordinate past the u16 range is clamped rather than wrapped: 70000 & 0xffff is 4464, which
    // is a real point somewhere else on the screen and would be a click nobody asked for.
    expect(pointerEventMessage(70000, -5, 0).readUInt16BE(2)).toBe(0xffff);
    expect(pointerEventMessage(70000, -5, 0).readUInt16BE(4)).toBe(0);
  });

  it("packs a key event with its keysym", () => {
    expect([...keyEventMessage(0xff0d, true)]).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
    expect(keyEventMessage(0xff0d, false)[1]).toBe(0);
  });
});

describe("decoding a framebuffer update", () => {
  it("writes a Raw rect into the frame, in the byte order the format declared", () => {
    const f = blankFrame(8, 4);
    const r = applyUpdate(f, rawRect(2, 1, 3, 2, [255, 128, 0]));
    expect(r).toMatchObject({ rects: 1 });
    expect(at(f, 2, 1)).toEqual([255, 128, 0, 255]);
    expect(at(f, 4, 2)).toEqual([255, 128, 0, 255]);
    // Outside the rect is untouched, which is what makes a partial update a partial update.
    expect(at(f, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  /* TCP delivers bytes, and a full-screen Raw update at 1440x900 is five megabytes that will
     certainly arrive in pieces. Every hand-rolled decoder's bugs are in the partial reads. */
  it("says WAIT for a message that has not fully arrived, at every truncation", () => {
    const whole = rawRect(0, 0, 4, 4, [10, 20, 30]);
    for (let n = 0; n < whole.length; n++) {
      expect(applyUpdate(blankFrame(4, 4), whole.subarray(0, n)), `truncated at ${n}`).toBeNull();
    }
    expect(applyUpdate(blankFrame(4, 4), whole)).not.toBeNull();
  });

  it("reports exactly the bytes it consumed, so the rest of the stream survives", () => {
    const f = blankFrame(4, 4);
    const msg = rawRect(0, 0, 2, 2, [1, 2, 3]);
    const trailing = Buffer.from("later", "latin1");
    const r = applyUpdate(f, Buffer.concat([msg, trailing]))!;
    expect(r.consumed).toBe(msg.length);
  });

  /* A server claiming a rectangle past the edge of its own screen is either broken or hostile, and
     either way it must not write outside the buffer. Clipped rather than refused: the rest of the
     frame is still a picture, and refusing would turn a wrong rectangle into no screenshot at all. */
  it("clips a rect that runs off the edge instead of writing past the buffer", () => {
    const f = blankFrame(4, 4);
    expect(() => applyUpdate(f, rawRect(3, 3, 4, 4, [9, 9, 9]))).not.toThrow();
    expect(at(f, 3, 3)).toEqual([9, 9, 9, 255]);
    expect(f.rgba).toHaveLength(4 * 4 * 4);
  });

  /* An encoding that was never offered has an unknown length, so skipping it would desynchronise the
     stream for good — every later message read at the wrong offset, forever, with no error. */
  it("stops at an encoding it did not ask for rather than guessing its length", () => {
    const head = Buffer.alloc(16);
    head[0] = 0; head.writeUInt16BE(1, 2);
    head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
    head.writeInt32BE(16, 12);   // ZRLE, which was never offered
    expect(applyUpdate(blankFrame(4, 4), head)).toBeNull();
  });

  it("ignores a message that is not a framebuffer update at all", () => {
    expect(applyUpdate(blankFrame(4, 4), Buffer.from([1, 0, 0, 0]))).toBeNull();
  });
});

describe("downscaling", () => {
  it("fits the longer side and keeps the aspect ratio", () => {
    const f = blankFrame(1440, 900);
    const s = downscale(f, 720);
    expect(s.width).toBe(720);
    expect(s.height).toBe(450);
    expect(s.rgba).toHaveLength(720 * 450 * 4);
  });

  it("leaves a frame that already fits completely alone", () => {
    const f = blankFrame(400, 300);
    expect(downscale(f, 720)).toBe(f);
  });

  /**
   * A box filter, not nearest-neighbour, and the difference is the whole reason this function has a
   * body. What is being downscaled is a screen full of TEXT: nearest-neighbour drops whole strokes,
   * so a model reading the result sees words with letters missing and reports them as what the
   * screen said. Averaging turns a dropped stroke into grey — legible, and honest about being small.
   */
  it("averages rather than sampling, so a thin stroke survives as grey instead of vanishing", () => {
    // One-pixel white lines on black, every other column: nearest-neighbour at 1/2 keeps only the
    // even columns and can return an all-black image.
    const f = blankFrame(64, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 1; x < 64; x += 2) {
        const i = (y * 64 + x) * 4;
        f.rgba[i] = 255; f.rgba[i + 1] = 255; f.rgba[i + 2] = 255;
      }
    }
    const s = downscale(f, 32);
    const values = new Set<number>();
    for (let x = 0; x < s.width; x++) values.add(s.rgba[x * 4]!);
    expect([...values].every((v) => v > 60 && v < 200), `expected greys, got ${[...values]}`).toBe(true);
  });
});

describe("PNG", () => {
  it("writes a file a decoder would accept, header to trailer", () => {
    const png = encodePng(blankFrame(3, 2));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png[24]).toBe(8);   // bit depth
    expect(png[25]).toBe(2);   // truecolour, no alpha — a framebuffer has none to carry
    expect(png.subarray(png.length - 8, png.length - 4).toString("latin1")).toBe("IEND");
  });

  /* The bytes have to survive the round trip, or the model is looking at a picture of nothing. The
     IDAT is inflated and compared pixel for pixel rather than trusting the header. */
  it("round-trips the actual pixels through deflate", () => {
    const f = blankFrame(4, 3);
    for (let i = 0; i < 12; i++) {
      f.rgba[i * 4] = i * 20; f.rgba[i * 4 + 1] = 255 - i * 20; f.rgba[i * 4 + 2] = 128;
    }
    const png = encodePng(f);
    // Walk the chunks rather than assuming an offset, so a future chunk cannot break this quietly.
    let at = 8, idat: Buffer | null = null;
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      if (png.subarray(at + 4, at + 8).toString("latin1") === "IDAT") idat = png.subarray(at + 8, at + 8 + len);
      at += 12 + len;
    }
    const raw = inflateSync(idat!);
    for (let y = 0; y < 3; y++) {
      expect(raw[y * (1 + 4 * 3)], `row ${y} filter`).toBe(0);
      for (let x = 0; x < 4; x++) {
        const s = (y * 4 + x) * 4, d = y * (1 + 4 * 3) + 1 + x * 3;
        expect([raw[d], raw[d + 1], raw[d + 2]], `pixel ${x},${y}`).toEqual([f.rgba[s], f.rgba[s + 1], f.rgba[s + 2]]);
      }
    }
  });

  it("computes a CRC a decoder will agree with", () => {
    // A wrong CRC is the failure that produces "corrupt PNG" from every reader and nothing at all
    // from a hand-rolled check, so it is verified against the chunk's own bytes here.
    const png = encodePng(blankFrame(1, 1));
    const len = png.readUInt32BE(8);
    const body = png.subarray(12, 12 + 4 + len);
    const stated = png.readUInt32BE(12 + 4 + len);
    let c = ~0;
    for (const byte of body) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    expect(stated).toBe(~c >>> 0);
  });
});
