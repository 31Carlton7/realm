import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { COMPUTER_FORBIDDEN_BUNDLE_IDS, type InstalledApp } from "@realm/contracts";

/**
 * The applications on this Mac, for the prompter's `@` list: the name the Finder shows, the bundle
 * id computer use is granted for, and the real icon.
 *
 * Read straight off the bundles, in process. The other icon path in main (`readAppIcon`) spawns
 * PlistBuddy and `sips` per bundle, which is right for the thirteen rows of the permissions page and
 * a lost minute for a list of a hundred and thirty apps typed into. Both of the things needed are
 * simple formats: `Info.plist` is XML or `bplist00`, and an `.icns` is a run of tagged chunks, the
 * ones that matter being plain PNG. `app.getFileIcon` is no help — it answers one generic pale
 * square for every bundle on the sealed system volume — and `nativeImage` cannot read an `.icns` at
 * all, so it is only handed the PNG once it has been cut out.
 *
 * Nothing here is Electron: main hands in the one step that is (PNG → data URL at a size), so the
 * parsing is tested against fixture bundles on disk rather than against this Mac.
 */

/** Where macOS keeps the applications a person launches: everyone's, the system's own, and theirs. */
export const applicationDirs = (home: string): string[] => ["/Applications", "/System/Applications", join(home, "Applications")];

export type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };
type PlistDict = { [key: string]: PlistValue };

const isDict = (v: PlistValue | undefined): v is PlistDict => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: PlistValue | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** A property list in either encoding macOS writes, or null for anything that is neither. */
export function parsePlist(bytes: Uint8Array): PlistValue {
  try {
    if (new TextDecoder().decode(bytes.subarray(0, 8)) === "bplist00") return parseBinaryPlist(bytes);
    return parseXmlPlist(new TextDecoder().decode(bytes));
  } catch { return null; }
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const unescapeXml = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, e: string) => {
  if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
  if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
  return ENTITY[e] ?? whole;
});

/**
 * An XML plist. Tolerant where the server's reader (`usbmux.ts`) is strict: that one reads what
 * usbmuxd writes, and this one reads what every app vendor's build tool ever wrote — dates, data,
 * comments, nesting this file has no use for. A value it does not know is skipped whole rather than
 * failing the bundle, because one odd key must not cost an app its place in the list.
 */
export function parseXmlPlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>|([^<]+)/g)];
  let i = 0;
  const isText = (t: RegExpMatchArray | undefined) => t !== undefined && t[2] === undefined;
  const skipText = () => { while (i < tokens.length && isText(tokens[i])) i++; };
  const textOf = (name: string): string => {
    let out = "";
    while (i < tokens.length && isText(tokens[i])) { if (!tokens[i]![0].startsWith("<!--")) out += tokens[i]![0]; i++; }
    const close = tokens[i];
    if (close && close[1] === "/" && close[2] === name) i++;
    return unescapeXml(out);
  };
  /** Past an element whose value this reader has no use for, nesting and all. */
  const skip = (name: string) => {
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      const t = tokens[i++]!;
      if (t[2] === name && !t[3]) depth += t[1] === "/" ? -1 : 1;
    }
  };
  const value = (): PlistValue | undefined => {
    skipText();
    const t = tokens[i++];
    if (!t || t[1] === "/") return undefined;
    const name = t[2]!;
    if (t[3]) return name === "true" ? true : name === "false" ? false : name === "dict" ? {} : name === "array" ? [] : name === "string" ? "" : null;
    switch (name) {
      case "dict": {
        const out: PlistDict = {};
        for (;;) {
          skipText();
          const k = tokens[i];
          if (!k) return out;
          if (k[1] === "/" && k[2] === "dict") { i++; return out; }
          if (k[2] !== "key") { i++; if (!k[1] && !k[3] && k[2]) skip(k[2]); continue; }
          i++;
          const key = textOf("key");
          const v = value();
          if (v !== undefined) out[key] = v;
        }
      }
      case "array": {
        const out: PlistValue[] = [];
        for (;;) {
          skipText();
          const k = tokens[i];
          if (!k) return out;
          if (k[1] === "/" && k[2] === "array") { i++; return out; }
          const v = value();
          if (v !== undefined) out.push(v);
        }
      }
      case "string": case "date": case "data": return textOf(name);
      case "integer": case "real": { const n = Number(textOf(name).trim()); return Number.isFinite(n) ? n : null; }
      case "true": textOf("true"); return true;
      case "false": textOf("false"); return false;
      default: skip(name); return null;
    }
  };
  while (i < tokens.length && tokens[i]![2] !== "plist") i++;
  if (i >= tokens.length) return null;
  i++;
  return value() ?? null;
}

/**
 * A binary plist (`bplist00`): a trailer naming the offset table, the table naming each object, and
 * objects addressed by number. App Store builds write their `Info.plist` this way (Keynote does),
 * and so does every preferences file — which is where the Dock keeps its apps.
 *
 * Objects are read on demand from the top one down, with a depth bound: the format can describe a
 * cycle, and a hostile file must cost a refusal rather than a stack.
 */
export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 40) return null;
  const t = bytes.length - 32;
  const offsetSize = bytes[t + 6]!, refSize = bytes[t + 7]!;
  const count = Number(view.getBigUint64(t + 8)), top = Number(view.getBigUint64(t + 16)), tableAt = Number(view.getBigUint64(t + 24));
  const uint = (at: number, size: number): number => {
    let n = 0;
    for (let k = 0; k < size; k++) n = n * 256 + bytes[at + k]!;
    return n;
  };
  const offsetOf = (ref: number): number => {
    if (ref >= count) throw new Error("plist: object out of range");
    return uint(tableAt + ref * offsetSize, offsetSize);
  };
  const read = (ref: number, depth: number): PlistValue => {
    if (depth > 32) throw new Error("plist: nested too deep");
    let at = offsetOf(ref);
    const marker = bytes[at]!;
    const kind = marker >> 4;
    let info = marker & 0x0f;
    at += 1;
    // A count of fifteen or more is spelled as an integer object right after the marker.
    const length = (): number => {
      if (info !== 0x0f) return info;
      const size = 1 << (bytes[at]! & 0x0f);
      const n = uint(at + 1, size);
      at += 1 + size;
      return n;
    };
    switch (kind) {
      case 0x0: return info === 0x08 ? false : info === 0x09 ? true : null;
      case 0x1: { const size = 1 << info; return size === 8 ? Number(view.getBigInt64(at)) : uint(at, size); }
      case 0x2: return info === 2 ? view.getFloat32(at) : view.getFloat64(at);
      case 0x3: return view.getFloat64(at); // a date, as seconds since 2001 — kept as the number
      case 0x4: { const n = length(); return `<${n} bytes>`; }
      case 0x5: { const n = length(); return Buffer.from(bytes.buffer, bytes.byteOffset + at, n).toString("latin1"); }
      case 0x6: {
        const n = length();
        let s = "";
        for (let k = 0; k < n; k++) s += String.fromCharCode(view.getUint16(at + k * 2));
        return s;
      }
      case 0x8: return uint(at, info + 1);
      case 0xa: {
        const n = length();
        const out: PlistValue[] = [];
        for (let k = 0; k < n; k++) out.push(read(uint(at + k * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const n = length();
        const out: PlistDict = {};
        for (let k = 0; k < n; k++) {
          const key = read(uint(at + k * refSize, refSize), depth + 1);
          if (typeof key === "string") out[key] = read(uint(at + (n + k) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default: return null;
    }
  };
  return read(top, 0);
}

/** The keys of an `Info.plist` the list needs, or null for a bundle that cannot be an app. */
export type BundleInfo = { bundleId: string; names: string[]; iconFile: string | null; iconName: string | null };

/**
 * Whether this bundle is an application a person launches, and what it calls itself.
 *
 * Not an app: no bundle id (nothing for computer use to be granted on), a package type other than
 * an application's, or `LSBackgroundOnly` — a daemon that happens to live in a `.app`. An
 * `LSUIElement` app is kept: menu-bar apps (Magnet, Raycast) are apps a person drives.
 */
export function bundleInfo(plist: PlistValue): BundleInfo | null {
  if (!isDict(plist)) return null;
  const bundleId = str(plist.CFBundleIdentifier);
  if (!bundleId) return null;
  const type = str(plist.CFBundlePackageType);
  if (type && type !== "APPL") return null;
  const bg = plist.LSBackgroundOnly;
  if (bg === true || bg === 1 || (typeof bg === "string" && /^(1|yes|true)$/i.test(bg))) return null;
  const names = [str(plist.CFBundleDisplayName), str(plist.CFBundleName)].filter((n): n is string => n !== null);
  return { bundleId, names, iconFile: str(plist.CFBundleIconFile), iconName: str(plist.CFBundleIconName) };
}

/**
 * The `.icns` a bundle names, as a path inside it, or null.
 *
 * `CFBundleIconFile` may carry its extension or not, and both spellings are in the wild. A bundle
 * that names only `CFBundleIconName` keeps its icon in an asset catalog, which nothing here reads —
 * but Xcode writes an `.icns` of the same name beside the catalog for older systems, so that is
 * looked for before giving up.
 */
export function iconFileFor(appPath: string, info: BundleInfo, exists: (p: string) => boolean): string | null {
  const resources = join(appPath, "Contents", "Resources");
  for (const name of [info.iconFile, info.iconName]) {
    if (!name) continue;
    const base = join(resources, name);
    if (name.endsWith(".icns") && exists(base)) return base;
    if (exists(`${base}.icns`)) return `${base}.icns`;
    if (exists(base)) return base;
  }
  return null;
}

/** Pixel size of each `.icns` chunk type a PNG can live in. The `@2x` types are their pixels. */
const ICNS_PX: Record<string, number> = {
  icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512,
};
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/**
 * The PNG an `.icns` holds nearest above `minPx` (the smallest that is big enough, else the biggest
 * there is), read without loading the rest of the file — Linear's runs to a megabyte and a half for
 * the 32 pixels a row draws. Null when the file holds no PNG at all (the RLE-only icons of the 2000s).
 */
export async function icnsPng(path: string, minPx: number): Promise<{ png: Uint8Array; px: number } | null> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(12);
    if ((await fh.read(head, 0, 8, 0)).bytesRead < 8 || head.toString("latin1", 0, 4) !== "icns") return null;
    const chunks: { at: number; len: number; px: number }[] = [];
    for (let at = 8; at + 12 <= size; ) {
      await fh.read(head, 0, 12, at);
      const len = head.readUInt32BE(4);
      if (len < 8 || at + len > size) break;
      const px = ICNS_PX[head.toString("latin1", 0, 4)];
      if (px !== undefined && PNG_MAGIC.every((b, k) => head[8 + k] === b)) chunks.push({ at, len, px });
      at += len;
    }
    if (chunks.length === 0) return null;
    const big = chunks.filter((c) => c.px >= minPx).sort((a, b) => a.px - b.px)[0];
    const pick = big ?? chunks.sort((a, b) => b.px - a.px)[0]!;
    const png = Buffer.alloc(pick.len - 8);
    await fh.read(png, 0, png.length, pick.at + 8);
    return { png, px: pick.px };
  } finally { await fh.close(); }
}

/** The bundle ids the Dock keeps, in its order. The Dock is where a person says which apps are
 *  theirs, which is the best order an `@` with nothing typed after it has to go on. */
export function dockBundleIds(plist: PlistValue): string[] {
  if (!isDict(plist) || !Array.isArray(plist["persistent-apps"])) return [];
  const out: string[] = [];
  for (const tile of plist["persistent-apps"]) {
    const data = isDict(tile) ? tile["tile-data"] : undefined;
    const id = isDict(data) ? str(data["bundle-identifier"]) : null;
    if (id) out.push(id);
  }
  return out;
}

const FORBIDDEN: ReadonlySet<string> = new Set(COMPUTER_FORBIDDEN_BUNDLE_IDS);
const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Every launchable app in `dirs`, one row per bundle id, sorted by name.
 *
 * One level of folder inside each (`Utilities`, a vendor's folder of apps), and never inside a
 * bundle: the helpers an app carries in its own `Contents` are not apps anyone mentions. The first
 * directory to hold a bundle id wins, which is the order macOS itself prefers them in.
 *
 * Apps no agent may ever drive (`COMPUTER_FORBIDDEN_BUNDLE_IDS` — Realm, System Settings, the
 * terminals) are left out: an `@Terminal` could only ever end in a refusal, and the list should not
 * offer what the grant behind it will not give.
 */
export async function scanApplications(dirs: readonly string[], dock: readonly string[] = []): Promise<(InstalledApp & { icon: string | null })[]> {
  const bundles: string[] = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.name.endsWith(".app")) { bundles.push(full); continue; }
      if (!e.isDirectory()) continue;
      let inner;
      try { inner = await readdir(full, { withFileTypes: true }); } catch { continue; }
      for (const f of inner) if (f.name.endsWith(".app") && !f.name.startsWith(".")) bundles.push(join(full, f.name));
    }
  }
  const read = await Promise.all(bundles.map(async (path) => {
    try {
      const info = bundleInfo(parsePlist(await readFile(join(path, "Contents", "Info.plist"))));
      if (!info || FORBIDDEN.has(info.bundleId)) return null;
      const present = new Set<string>();
      for (const name of [info.iconFile, info.iconName]) {
        if (!name) continue;
        const base = join(path, "Contents", "Resources", name);
        for (const p of [base, `${base}.icns`]) if (await exists(p)) present.add(p);
      }
      return { path, info, icon: iconFileFor(path, info, (p) => present.has(p)) };
    } catch { return null; }
  }));
  const seen = new Set<string>();
  const apps: (InstalledApp & { icon: string | null })[] = [];
  for (const r of read) {
    if (!r || seen.has(r.info.bundleId)) continue;
    seen.add(r.info.bundleId);
    const name = r.path.slice(r.path.lastIndexOf("/") + 1).replace(/\.app$/, "");
    const aliases = [...new Set(r.info.names.filter((n) => n.toLowerCase() !== name.toLowerCase()))];
    const at = dock.indexOf(r.info.bundleId);
    apps.push({ name, bundleId: r.info.bundleId, path: r.path, aliases, dock: at === -1 ? null : at, icon: r.icon });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/**
 * The scan, kept: listed once, and listed again only when one of the folders it read has changed —
 * an app installed or removed changes its folder's mtime, and checking a dozen mtimes costs nothing
 * next to reading a hundred bundles. Icons are cut out on first ask and kept for the life of the
 * process; an app's icon does not change under a running Realm.
 *
 * `icons` answers only for paths its own scan found. The renderer names the bundle, and a path it
 * could name freely would let it point the reader at any file on disk — the same guard
 * `mac:app-icon` keeps by taking a capability id instead of a path.
 */
/** How long a scan is trusted without even looking at the folders: one `@` asks for the list and
 *  then for a page of icons, and the second ask should not stat the folders again. */
const FRESH_MS = 2_000;

export class InstalledApps {
  private scan: { stamp: string; at: number; apps: (InstalledApp & { icon: string | null })[] } | null = null;
  private scanning: Promise<(InstalledApp & { icon: string | null })[]> | null = null;
  private readonly iconCache = new Map<string, string | null>();

  constructor(private readonly d: {
    dirs: () => string[];
    /** The Dock's preferences file, or null to keep no Dock order. */
    dockPlist: () => string | null;
    /** A PNG cut from an `.icns` as a data URL, scaled down if it is larger than a row needs. */
    toDataUrl: (png: Uint8Array, px: number) => string | null;
    /** The icon of a bundle with no `.icns` to cut one from — its asset catalog, asked of the system. */
    fallbackIcon?: (appPath: string) => Promise<string | null>;
    now?: () => number;
  }) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }

  async list(): Promise<InstalledApp[]> {
    return (await this.current()).map(({ icon: _icon, ...app }) => app);
  }

  async icons(paths: readonly string[]): Promise<Record<string, string | null>> {
    const apps = await this.current();
    const byPath = new Map(apps.map((a) => [a.path, a]));
    const out: Record<string, string | null> = {};
    await Promise.all(paths.map(async (path) => {
      const app = byPath.get(path);
      if (!app) return;
      if (!this.iconCache.has(path)) this.iconCache.set(path, await this.readIcon(app.path, app.icon));
      out[path] = this.iconCache.get(path) ?? null;
    }));
    return out;
  }

  private async readIcon(appPath: string, icns: string | null): Promise<string | null> {
    try {
      const cut = icns ? await icnsPng(icns, 32) : null;
      if (cut) return this.d.toDataUrl(cut.png, cut.px);
      return (await this.d.fallbackIcon?.(appPath)) ?? null;
    } catch { return null; }
  }

  private async stamp(dirs: readonly string[]): Promise<string> {
    const parts = await Promise.all(dirs.map(async (dir) => {
      const top = await stat(dir).then((s) => s.mtimeMs, () => -1);
      // The one level of folders inside counts too: an app dropped into Utilities touches Utilities.
      const inner = await readdir(dir, { withFileTypes: true }).then(
        (es) => Promise.all(es.filter((e) => e.isDirectory() && !e.name.endsWith(".app")).map((e) => stat(join(dir, e.name)).then((s) => s.mtimeMs, () => -1))),
        () => [] as number[]);
      return `${dir}:${top}:${inner.join(",")}`;
    }));
    return parts.join("|");
  }

  private async current(): Promise<(InstalledApp & { icon: string | null })[]> {
    if (this.scan && this.now() - this.scan.at < FRESH_MS) return this.scan.apps;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const dirs = this.d.dirs();
      const stamp = await this.stamp(dirs);
      if (this.scan?.stamp === stamp) { this.scan.at = this.now(); return this.scan.apps; }
      const dockPath = this.d.dockPlist();
      const dock = dockPath ? dockBundleIds(parsePlist(await readFile(dockPath).catch(() => new Uint8Array()))) : [];
      const apps = await scanApplications(dirs, dock);
      this.scan = { stamp, at: this.now(), apps };
      return apps;
    })();
    try { return await this.scanning; } finally { this.scanning = null; }
  }
}
