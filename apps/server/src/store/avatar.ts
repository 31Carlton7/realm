import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { newId } from "@realm/contracts";
import { RpcError } from "./rows";
import type { SettingsStore } from "./settings";

/** The settings row naming the copy. It holds a FILE NAME inside `avatarDir`, never a path: a row
 *  that could name any path would make the page show whatever file a hand-edited row pointed at. */
export const AVATAR_SETTING = "avatar.file";

/** The picker's own filter (`pick-icon-image` in main), so nothing the dialog offers is refused here. */
export const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;

/** Far more than a picture of a face needs. Main downscales a raster pick before it gets here; this
 *  is the ceiling for the copy that was not downscaled (an SVG, or a decode that failed). */
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

export const avatarDir = (home: string): string => join(home, "avatar");

/**
 * The picture on the page about you.
 *
 * Kept as a COPY under the Realm home. The file the user picked stays theirs — they may move it,
 * edit it or delete it, and none of that should change or break the face Realm shows — and nothing
 * outside the home is read again after the one copy. The stored setting names the copy alone.
 *
 * Every pick gets a new file name, and the old copy goes once the new one is in place. The name
 * changing is what makes the renderer draw the new picture: an `<img>` pointed at the same URL keeps
 * the bytes it already decoded.
 */
export class AvatarStore {
  constructor(private home: string, private settings: SettingsStore) {}

  get(): string | null {
    const raw = this.settings.get(AVATAR_SETTING);
    const file = typeof raw === "string" ? raw : null;
    // A name with a separator in it is not one this store wrote, and following it would leave the folder.
    if (!file || basename(file) !== file) return null;
    const path = join(avatarDir(this.home), file);
    return existsSync(path) ? path : null;
  }

  set(source: string): string {
    if (!isAbsolute(source)) throw new RpcError("INVALID_PARAMS", "The picture's path must be absolute.");
    const ext = extname(source).slice(1).toLowerCase();
    if (!(AVATAR_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new RpcError("AVATAR_UNSUPPORTED", "Choose a PNG, JPEG, GIF, WebP or SVG picture.");
    }
    let size: number;
    try {
      const st = statSync(source);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      throw new RpcError("AVATAR_UNREADABLE", "That picture could not be read.");
    }
    if (size > AVATAR_MAX_BYTES) throw new RpcError("AVATAR_TOO_LARGE", "That picture is larger than 10 MB.");

    const dir = avatarDir(this.home);
    mkdirSync(dir, { recursive: true });
    const file = `${newId()}.${ext === "jpeg" ? "jpg" : ext}`;
    const previous = this.get();
    copyFileSync(source, join(dir, file));
    this.settings.set(AVATAR_SETTING, file);
    if (previous) rmSync(previous, { force: true });
    return join(dir, file);
  }

  clear(): void {
    const previous = this.get();
    this.settings.set(AVATAR_SETTING, null);
    if (previous) rmSync(previous, { force: true });
  }
}
