import { describe, expect, it } from "vitest";
import { SCREEN_PICTURE_MAX_BYTES, SCREEN_PICTURE_MAX_SIDE, checkScreenPicture } from "./screen-picture";

/** A PNG's signature and IHDR chunk, then `pad` bytes: all the check reads. */
function png(width: number, height: number, pad = 0): string {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString("base64");
}

/** A JPEG with an EXIF segment and a quantisation table before its start of frame, as a camera or
 *  a screenshot tool writes one. */
function jpeg(width: number, height: number, sof = 0xc0): string {
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from("Exif\0\0padding!!", "latin1").subarray(0, 14)]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]);
  const frame = Buffer.alloc(19);
  frame.writeUInt8(0xff, 0); frame.writeUInt8(sof, 1); frame.writeUInt16BE(17, 2); frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, dqt, frame, Buffer.from([0xff, 0xd9])]).toString("base64");
}

describe("checkScreenPicture", () => {
  it("reads a PNG's size from its header", () => {
    expect(checkScreenPicture({ mediaType: "image/png", data: png(2_880, 1_800) })).toEqual({ bytes: 33, width: 2_880, height: 1_800 });
  });

  it("reads a JPEG's size from its start of frame, past the segments before it", () => {
    expect(checkScreenPicture({ mediaType: "image/jpeg", data: jpeg(1_920, 1_080) })).toMatchObject({ width: 1_920, height: 1_080 });
    // A progressive JPEG's frame is SOF2.
    expect(checkScreenPicture({ mediaType: "image/jpeg", data: jpeg(1_440, 900, 0xc2) })).toMatchObject({ width: 1_440, height: 900 });
  });

  it("takes a picture at the API's limits, and refuses one a byte or a pixel over, saying what to do", () => {
    const atLimit = png(SCREEN_PICTURE_MAX_SIDE, SCREEN_PICTURE_MAX_SIDE, SCREEN_PICTURE_MAX_BYTES - 33);
    expect(checkScreenPicture({ mediaType: "image/png", data: atLimit }).bytes).toBe(SCREEN_PICTURE_MAX_BYTES);
    const over = png(100, 100, SCREEN_PICTURE_MAX_BYTES - 32);
    expect(() => checkScreenPicture({ mediaType: "image/png", data: over })).toThrow("The screen picture is 7.6 MB, and the Claude API takes pictures up to 7.5 MB (10 MB once base64-encoded). Scale it down or send it as a JPEG, then ask again.");
    expect(() => checkScreenPicture({ mediaType: "image/png", data: png(SCREEN_PICTURE_MAX_SIDE + 1, 1_000) })).toThrow("The screen picture is 8001×1000 pixels, and the Claude API takes pictures up to 8000 pixels on a side. Scale it down, then ask again.");
    expect(() => checkScreenPicture({ mediaType: "image/jpeg", data: jpeg(1_000, SCREEN_PICTURE_MAX_SIDE + 1) })).toThrow("1000×8001 pixels");
  });

  it("refuses what is not a PNG or a JPEG, or is sent as the other", () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
    expect(() => checkScreenPicture({ mediaType: "image/png", data: gif })).toThrow("The screen picture is not a PNG or a JPEG. Send the capture as one of those.");
    expect(() => checkScreenPicture({ mediaType: "image/jpeg", data: png(10, 10) })).toThrow("The screen picture is sent as image/jpeg, but it is a PNG. Send it as image/png.");
    expect(() => checkScreenPicture({ mediaType: "image/png", data: jpeg(10, 10) })).toThrow("but it is a JPEG. Send it as image/jpeg.");
  });

  it("refuses what is not base64", () => {
    for (const data of [png(10, 10).slice(0, -1), `${png(10, 10)}\n`, png(10, 10).replace(/A/, "*")]) {
      expect(() => checkScreenPicture({ mediaType: "image/png", data })).toThrow("The screen picture is not base64. Send its bytes base64-encoded, with no line breaks.");
    }
  });

  it("refuses a picture whose header is cut short", () => {
    expect(() => checkScreenPicture({ mediaType: "image/png", data: png(10, 10).slice(0, 20) })).toThrow("cut short");
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
    expect(() => checkScreenPicture({ mediaType: "image/jpeg", data: noFrame })).toThrow("cut short");
  });

  it("puts none of the picture in what it says", () => {
    const data = png(9_000, 9_000);
    for (const picture of [{ mediaType: "image/jpeg" as const, data }, { mediaType: "image/png" as const, data }]) {
      try { checkScreenPicture(picture); } catch (e) { expect((e as Error).message).not.toContain(data.slice(0, 12)); continue; }
      throw new Error("expected a refusal");
    }
  });
});
