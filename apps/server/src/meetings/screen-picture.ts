import type { ScreenPicture } from "@realm/contracts";
import { RpcError } from "../store/rows";

/**
 * The Claude API's own limits on one image (platform.claude.com/docs/en/build-with-claude/vision,
 * "Image limits and costs"): 10 MB base64-encoded, which is 7.5 MB of picture, and 8000 px on a
 * side. A picture over either would only come back as the API's error after the wait, so it is
 * refused here with what to do. The server cannot scale it down without a native image library;
 * the app that took the picture scales it.
 */
export const SCREEN_PICTURE_MAX_BYTES = 7_500_000;
export const SCREEN_PICTURE_MAX_SIDE = 8_000;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The picture's size, from its header, or a BAD_REQUEST saying what is wrong with it. No message
 *  carries any of the picture itself. */
export function checkScreenPicture(picture: ScreenPicture): { bytes: number; width: number; height: number } {
  if (picture.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(picture.data)) {
    throw new RpcError("BAD_REQUEST", "The screen picture is not base64. Send its bytes base64-encoded, with no line breaks.");
  }
  const padding = picture.data.endsWith("==") ? 2 : picture.data.endsWith("=") ? 1 : 0;
  const bytes = (picture.data.length / 4) * 3 - padding;
  if (bytes > SCREEN_PICTURE_MAX_BYTES) {
    throw new RpcError("BAD_REQUEST", `The screen picture is ${megabytes(bytes)} MB, and the Claude API takes pictures up to ${SCREEN_PICTURE_MAX_BYTES / 1_000_000} MB (10 MB once base64-encoded). Scale it down or send it as a JPEG, then ask again.`);
  }
  const b = Buffer.from(picture.data, "base64");
  const kind = PNG.every((x, i) => b[i] === x) ? "image/png" : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" : null;
  if (!kind) throw new RpcError("BAD_REQUEST", "The screen picture is not a PNG or a JPEG. Send the capture as one of those.");
  if (kind !== picture.mediaType) throw new RpcError("BAD_REQUEST", `The screen picture is sent as ${picture.mediaType}, but it is a ${kind === "image/png" ? "PNG" : "JPEG"}. Send it as ${kind}.`);
  const size = kind === "image/png" ? pngSize(b) : jpegSize(b);
  if (!size) throw new RpcError("BAD_REQUEST", "The screen picture's header is cut short, so its size cannot be read. Capture the screen again.");
  if (size.width > SCREEN_PICTURE_MAX_SIDE || size.height > SCREEN_PICTURE_MAX_SIDE) {
    throw new RpcError("BAD_REQUEST", `The screen picture is ${size.width}×${size.height} pixels, and the Claude API takes pictures up to ${SCREEN_PICTURE_MAX_SIDE} pixels on a side. Scale it down, then ask again.`);
  }
  return { bytes, ...size };
}

/** Rounded up, so a picture just over the limit does not read as at it. */
const megabytes = (bytes: number) => (Math.ceil(bytes / 100_000) / 10).toFixed(1);

/** The IHDR chunk, which a PNG must put first. */
function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** The first start-of-frame segment, past whatever EXIF or colour profile comes before it. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    // Markers with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
