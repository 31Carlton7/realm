import { deflateSync } from "node:zlib";

/**
 * A guest's pixels, from the wire to something a model can look at (Plan 25 W4).
 *
 * Pure, and built out of `node:zlib` and arithmetic rather than an image library, for a reason worth
 * stating: adding a native image dependency to realm-server to turn four bytes per pixel into a PNG
 * would be a build-time cost, a platform matrix and a supply-chain surface, for an encoder that is
 * forty lines when the input is already uncompressed RGBA. PNG rather than JPEG for the same kind of
 * reason — a JPEG encoder is not forty lines, and a screen full of text is exactly the content JPEG
 * is worst at.
 */

/** The pixel format the driver ASKS the server for, so decoding is one shape rather than sixteen.
 *  RFB lets a client name its own, and the whole point of doing so is to never have to handle a
 *  server's native one — 8-bit palettes, big-endian, 16bpp 565 and the rest all exist in the wild. */
export const DRIVER_PIXEL_FORMAT = {
  bitsPerPixel: 32, depth: 24, bigEndian: 0, trueColour: 1,
  redMax: 255, greenMax: 255, blueMax: 255,
  redShift: 16, greenShift: 8, blueShift: 0,
} as const;

/** `SetPixelFormat`, ready to write. */
export function setPixelFormatMessage(): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0;                                   // message type
  const f = DRIVER_PIXEL_FORMAT;
  b[4] = f.bitsPerPixel; b[5] = f.depth; b[6] = f.bigEndian; b[7] = f.trueColour;
  b.writeUInt16BE(f.redMax, 8); b.writeUInt16BE(f.greenMax, 10); b.writeUInt16BE(f.blueMax, 12);
  b[14] = f.redShift; b[15] = f.greenShift; b[16] = f.blueShift;
  return b;
}

/** `SetEncodings`, offering Raw only.
 *
 *  Raw is the one encoding every RFB server must implement, and the only one whose decoder is a
 *  memcpy. The agent's channel is a still frame every few seconds, not a video stream — the bandwidth
 *  a better encoding would save is not a cost anybody is paying, and each one Realm claimed to speak
 *  would be a decoder to get right against servers it cannot test. */
export function setEncodingsMessage(): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 2; b.writeUInt16BE(1, 2); b.writeInt32BE(0, 4);
  return b;
}

/** `FramebufferUpdateRequest`. `incremental = 0` asks for the WHOLE screen — which is what a
 *  screenshot means, and what an agent that has been away for a minute needs. */
export function updateRequestMessage(width: number, height: number, incremental = false): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 3; b[1] = incremental ? 1 : 0;
  b.writeUInt16BE(0, 2); b.writeUInt16BE(0, 4);
  b.writeUInt16BE(width, 6); b.writeUInt16BE(height, 8);
  return b;
}

export function pointerEventMessage(x: number, y: number, buttonMask: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 5; b[1] = buttonMask;
  b.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(x))), 2);
  b.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(y))), 4);
  return b;
}

export function keyEventMessage(keysym: number, down: boolean): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 4; b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym >>> 0, 4);
  return b;
}

/** An RGBA image, top row first — the shape everything below speaks. */
export type Frame = { width: number; height: number; rgba: Buffer };

export const blankFrame = (width: number, height: number): Frame =>
  ({ width, height, rgba: Buffer.alloc(width * height * 4, 0) });

/**
 * One `FramebufferUpdate` message, applied onto a frame — or `null` when the buffer holds only part
 * of it and more has to arrive.
 *
 * Written as "decide from what is here, or say wait" for the same reason `handshakeStep` is: TCP
 * delivers bytes rather than messages, and a full-screen Raw update at 1440×900 is five megabytes
 * that will certainly arrive in pieces. Every rectangle is bounds-checked against the frame rather
 * than trusted — a server that claims a rectangle past the edge of its own screen is either broken
 * or hostile, and either way it must not write outside the buffer.
 */
export function applyUpdate(frame: Frame, buf: Buffer): { consumed: number; rects: number } | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0) return null;                   // not a FramebufferUpdate; the caller filters
  const count = buf.readUInt16BE(2);
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (buf.length < at + 12) return null;
    const x = buf.readUInt16BE(at), y = buf.readUInt16BE(at + 2);
    const w = buf.readUInt16BE(at + 4), h = buf.readUInt16BE(at + 6);
    const encoding = buf.readInt32BE(at + 8);
    at += 12;
    // Raw only, because Raw only is what was offered. A server sending something else has ignored
    // `SetEncodings`, and guessing at the length of an encoding we did not ask for would
    // desynchronise the stream for good — so this stops rather than skipping.
    if (encoding !== 0) return null;
    const bytes = w * h * 4;
    if (buf.length < at + bytes) return null;
    for (let row = 0; row < h; row++) {
      const dy = y + row;
      if (dy < 0 || dy >= frame.height) { at += w * 4; continue; }
      for (let col = 0; col < w; col++) {
        const dx = x + col;
        const src = at + col * 4;
        if (dx < 0 || dx >= frame.width) continue;
        const dst = (dy * frame.width + dx) * 4;
        // The wire word is little-endian in the format we asked for: byte0 blue, byte1 green,
        // byte2 red. Written out as RGBA, which is what every consumer below expects.
        frame.rgba[dst] = buf[src + 2]!;
        frame.rgba[dst + 1] = buf[src + 1]!;
        frame.rgba[dst + 2] = buf[src]!;
        frame.rgba[dst + 3] = 255;
      }
      at += w * 4;
    }
  }
  return { consumed: at, rects: count };
}

/**
 * Down to fit inside `max` on its longer side, by a box filter.
 *
 * A box filter rather than nearest-neighbour, and it matters more here than it would for a
 * photograph: the thing being downscaled is a screen full of TEXT, and nearest-neighbour drops
 * whole strokes — a model reading the result sees words with letters missing and reports them as
 * what the screen said. Averaging keeps the stroke as grey, which is legible and, more to the point,
 * honest about being small.
 */
export function downscale(frame: Frame, max: number): Frame {
  const longest = Math.max(frame.width, frame.height);
  if (longest <= max || max <= 0) return frame;
  const scale = max / longest;
  const w = Math.max(1, Math.round(frame.width * scale));
  const h = Math.max(1, Math.round(frame.height * scale));
  const out = Buffer.alloc(w * h * 4);
  const bx = frame.width / w, by = frame.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * by), y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < Math.min(y1, frame.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, frame.width); sx++) {
          const i = (sy * frame.width + sx) * 4;
          r += frame.rgba[i]!; g += frame.rgba[i + 1]!; b += frame.rgba[i + 2]!; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = n ? Math.round(r / n) : 0;
      out[o + 1] = n ? Math.round(g / n) : 0;
      out[o + 2] = n ? Math.round(b / n) : 0;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba: out };
}

/* ------------------------------------ PNG ------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * RGBA → PNG, 8-bit truecolour without alpha.
 *
 * Alpha is dropped rather than carried: a framebuffer has none — every pixel this ever sees is
 * opaque — and a colour type with an alpha channel would be a third more bytes to say so on every
 * one of them.
 *
 * Every row is filtered `None` (0). Choosing per-row filters is what a real encoder does and it is
 * worth roughly a third of the size on photographic content; on a screen full of flat panels the
 * deflate pass behind it already finds the same runs, and a filter heuristic here would be code with
 * a bug budget in exchange for bytes nobody is counting.
 */
export function encodePng(frame: Frame): Buffer {
  const { width, height, rgba } = frame;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = row + 1 + x * 3;
      raw[d] = rgba[s]!; raw[d + 1] = rgba[s + 1]!; raw[d + 2] = rgba[s + 2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
