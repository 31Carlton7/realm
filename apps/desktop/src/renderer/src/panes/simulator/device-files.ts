/**
 * What a file dropped on a simulator IS, and therefore where it goes.
 *
 * A drop is one gesture. Asking afterwards which of three things the user meant would be a second
 * gesture for a question the extension has already answered: a `.app` is something to install, a
 * picture is something to put in Photos, and a spreadsheet is neither.
 *
 * Pure, and by NAME rather than by MIME: Chromium reports an empty type for a `.app` (it is a
 * directory) and for plenty of video containers, so the extension is the only thing that is always
 * there. A file with no on-disk path — a paste, a drag out of a browser — is unusable here whatever
 * it is called: every one of these commands takes a path.
 */

/** Bundles `simctl install` accepts. `.app` is what Xcode builds; `.ipa` is what a build service
 *  hands you. */
const APP_EXTENSIONS = [".app", ".ipa"];

/** What `simctl addmedia` puts in the Photos library. Live Photos arrive as a pair of files and are
 *  added as two, which is what the command itself does with them. */
const MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".heic", ".heif", ".webp", ".tiff", ".bmp",
  ".mov", ".mp4", ".m4v", ".avi", ".hevc",
];

export type DroppedFile = { name: string; path: string };
export type SortedDrop = {
  /** Paths to install. */
  apps: string[];
  /** Paths for the Photos library. */
  media: string[];
  /** The NAMES of everything that is neither, for a sentence that says which files were refused. */
  unusable: string[];
};

const extensionOf = (name: string): string => {
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
};

export function sortForDevice(files: readonly DroppedFile[]): SortedDrop {
  const out: SortedDrop = { apps: [], media: [], unusable: [] };
  for (const f of files) {
    const ext = extensionOf(f.name);
    // No path, nothing to hand a CLI. Named in `unusable` rather than dropped silently, so a drag
    // out of a browser says why it did nothing instead of looking like a target that missed.
    if (!f.path) { out.unusable.push(f.name); continue; }
    if (APP_EXTENSIONS.includes(ext)) out.apps.push(f.path);
    else if (MEDIA_EXTENSIONS.includes(ext)) out.media.push(f.path);
    else out.unusable.push(f.name);
  }
  return out;
}
