import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The icon Realm wears in the Dock, chosen in Settings ▸ App.
 *
 * The pictures ship in the renderer's assets (Settings draws them anyway), so the renderer sends the
 * chosen one's bytes and main keeps a copy in userData. That copy is what puts the icon back at the
 * next launch, before any window exists, without main having to know where the renderer's bundle
 * put its assets.
 *
 * What it cannot change: the icon macOS draws from the bundle — the Finder, Launchpad, and the Dock
 * while Realm is NOT running. That is the signed .icns, and rewriting a signed bundle breaks its
 * signature. A running app can only replace its own Dock tile, so that is all this promises, and
 * Settings says so under the picker.
 */
export const APP_ICON_IDS = ["default", "indigo", "clay", "frost", "smoke", "sticker", "ocean", "ember", "mint"] as const;
export type AppIconId = (typeof APP_ICON_IDS)[number];

/** A 256 px icon is ~60 KB; anything near this cap is not one of ours. */
const MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isAppIconId = (v: unknown): v is AppIconId => typeof v === "string" && (APP_ICON_IDS as readonly string[]).includes(v);

/** Bytes that are a PNG of a size an icon could be — they came from the renderer, so they are checked. */
export function isIconPng(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array && v.byteLength > PNG_SIGNATURE.length && v.byteLength <= MAX_BYTES
    && PNG_SIGNATURE.every((b, i) => v[i] === b);
}

export type IconFs = {
  read: (path: string) => Buffer;
  write: (path: string, data: Uint8Array | string) => void;
  remove: (path: string) => void;
};
const realFs: IconFs = {
  read: (p) => readFileSync(p),
  write: (p, d) => writeFileSync(p, d),
  remove: (p) => rmSync(p, { force: true }),
};

export class AppIconStore {
  private readonly png: string;
  private readonly meta: string;
  constructor(dir: string, private readonly fs: IconFs = realFs) {
    this.png = join(dir, "app-icon.png");
    this.meta = join(dir, "app-icon.json");
  }

  /** The chosen icon, or the default when nothing was chosen or the record is unreadable. */
  current(): AppIconId {
    try {
      const raw = JSON.parse(this.fs.read(this.meta).toString("utf8")) as { id?: unknown };
      return isAppIconId(raw.id) ? raw.id : "default";
    } catch {
      return "default";
    }
  }

  /** The saved picture to put on the Dock at launch, or null for the bundle's own icon. */
  saved(): Buffer | null {
    if (this.current() === "default") return null;
    try { return this.fs.read(this.png); } catch { return null; }
  }

  /**
   * Remember a choice. The default is remembered by FORGETTING: with no file, the next launch leaves
   * the bundle's icon alone, which is the only way the Dock and the Finder agree again.
   */
  choose(id: AppIconId, png: Uint8Array): void {
    if (id === "default") {
      this.fs.remove(this.png);
      this.fs.remove(this.meta);
      return;
    }
    this.fs.write(this.png, png);
    this.fs.write(this.meta, JSON.stringify({ id }));
  }
}

export type Dock = { setIcon(png: Buffer | Uint8Array): void };

/**
 * `app-icon:get` and `app-icon:set`. A set changes the Dock at once — the default included, since
 * the running app's tile only reverts to the bundle icon at the next launch — and then persists.
 */
export function registerAppIcon(deps: {
  handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => void;
  store: AppIconStore;
  dock: Dock | null;
}): void {
  const { handle, store, dock } = deps;
  handle("app-icon:get", () => store.current());
  handle("app-icon:set", (_e, id, png) => {
    if (!isAppIconId(id) || !isIconPng(png)) return false;
    dock?.setIcon(png);
    try { store.choose(id, png); } catch { /* a read-only userData costs only the memory */ }
    return true;
  });
}
