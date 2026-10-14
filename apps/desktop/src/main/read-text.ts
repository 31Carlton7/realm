import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DOCUMENT_MAX_BYTES } from "@realm/contracts";

/** What the media viewer is told about a file it wants to show as text. */
export type TextRead =
  | { ok: true; text: string }
  /** `large`: past the documents pane's own ceiling. `binary`: a NUL in its head, so not text. */
  | { ok: false; reason: "large" | "binary" };

/** How much of the head is sniffed for a NUL — the same window the documents server reads. */
const SNIFF_BYTES = 8192;

/**
 * A file's text, for the media viewer to draw with the documents pane's own renderers — the
 * highlighted source, the rendered Markdown — where it used to show macOS's picture of the page.
 *
 * Read in MAIN for the reason `files:stat` and `files:preview` are: the file is one a list is already
 * showing (a Library tile, a prompter chip), no session owns the look, and `files:preview` already
 * hands QuickLook's render of the same page to the window. The gate is the same as theirs — an
 * absolute path to a regular file — and the ceiling is the documents pane's, checked by `stat` before
 * anything is read.
 *
 * Nothing here writes, so bytes that are not UTF-8 are decoded with replacements rather than refused:
 * the documents server refuses them because ITS next save would rewrite the file, and this view never
 * saves. Null for a path that is not there.
 */
export async function readTextFile(path: unknown, max = DOCUMENT_MAX_BYTES): Promise<TextRead | null> {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const abs = resolve(path);
  let size: number;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
    size = s.size;
  } catch { return null; }
  if (size > max) return { ok: false, reason: "large" };
  const handle = await open(abs, "r").catch(() => null);
  if (!handle) return null;
  try {
    const bytes = await handle.readFile();
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, reason: "binary" };
    return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
