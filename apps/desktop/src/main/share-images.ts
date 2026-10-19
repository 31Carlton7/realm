import { nativeImage } from "electron";
import { isImageMime, mimeForPath } from "@realm/contracts";
import { statFile } from "./attachments";

/** The longest edge a picture keeps inside a shared page: sharp across a reading column on a
 *  retina screen, and a fraction of what a full-size screenshot weighs. */
export const SHARE_IMAGE_EDGE = 1600;
/** A PNG past this is re-encoded as JPEG. Screenshots of text stay PNG, where JPEG would smear the
 *  letters; a photo or a busy capture becomes a JPEG a tenth of its PNG's size. */
export const SHARE_PNG_BUDGET = 700 * 1024;

/**
 * A picture for a shared page, as a data: URL Realm encoded itself — never the file's own bytes.
 *
 * Re-encoding is the point as much as the size: whatever was on disk (an SVG that could carry
 * script, a HEIC no browser draws, a 9000px original), what reaches the page is a PNG or a JPEG
 * decoded and drawn again here. Null for anything that is not a readable image file.
 */
export async function shareImage(path: unknown): Promise<string | null> {
  const file = await statFile(path);
  if (!file || !isImageMime(mimeForPath(file.path))) return null;
  const img = nativeImage.createFromPath(file.path);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = SHARE_IMAGE_EDGE / Math.max(width, height);
  // Down, never up: a small picture drawn larger only weighs more.
  const fitted = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" }) : img;
  const png = fitted.toPNG();
  if (png.length <= SHARE_PNG_BUDGET) return `data:image/png;base64,${png.toString("base64")}`;
  return `data:image/jpeg;base64,${fitted.toJPEG(82).toString("base64")}`;
}
