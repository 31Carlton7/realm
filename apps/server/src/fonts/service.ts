import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "../store/rows";

/**
 * Fonts fetched from Google Fonts, kept on this Mac.
 *
 * The whole design follows from one decision: a font is DOWNLOADED once and served from
 * `~/Realm/fonts`, never linked from `fonts.googleapis.com` at runtime. Realm's claim is that it runs
 * on your Mac, and an app that re-fetches its own typeface from Google on every launch does not — it
 * would also mean the window has no text the first time you open it on a plane. One network call, at
 * the moment you deliberately pick a family, and then never again.
 *
 * Fonts already installed on the Mac are not here at all. Those need no fetching and no storage: the
 * renderer reads them with `queryLocalFonts()` and CSS names them directly.
 */
export const fontsRoot = (home: string): string => join(home, "fonts");

/** One family the user has installed, as `fonts.list` answers. */
export type InstalledFont = {
  family: string;
  /** The weights actually downloaded. Realm needs 400 and 500 for chrome; a family that publishes
   *  neither gets whatever single weight it does publish, which is what a one-weight display face is. */
  weights: number[];
  bytes: number;
};

/** One family on offer, as `fonts.catalog` answers. Deliberately three fields: the catalog is two
 *  thousand entries and everything else in it is for a type specimen site, not a picker. */
export type CatalogFont = { family: string; category: string; mono: boolean };

const CATALOG_URL = "https://fonts.google.com/metadata/fonts";
const CSS_URL = "https://fonts.googleapis.com/css2";
/** A browser UA, because the `css2` endpoint serves by capability: ask as a generic client and it
 *  answers with TTF, which is three times the bytes of the woff2 every Chromium can read. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/** The two weights Realm's chrome is drawn against — `--fw-medium` through `--fw-strong` interpolate
 *  between them. A family with only one gets that one. */
const WANT_WEIGHTS = [400, 500];
/** How long a cached catalog is trusted. A day: the list grows by a handful of families a month, and
 *  the alternative is a 2.7MB download every time someone opens the font picker. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export class FontsService {
  readonly root: string;
  constructor(private d: { home: string; fetch?: typeof fetch }) { this.root = fontsRoot(d.home); }
  private get fetch(): typeof fetch { return this.d.fetch ?? globalThis.fetch; }

  /** Every family installed under the folder. A directory with no manifest is skipped rather than
   *  guessed at — it is a half-finished download, and offering it would offer a font with no files. */
  list(): InstalledFont[] {
    let dirs: string[];
    try { dirs = readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
    const out: InstalledFont[] = [];
    for (const dir of dirs) {
      try {
        const m = JSON.parse(readFileSync(join(this.root, dir, "font.json"), "utf8")) as InstalledFont;
        if (m?.family && Array.isArray(m.weights) && m.weights.length > 0) out.push(m);
      } catch { /* a half-written folder is not a font */ }
    }
    return out.sort((a, b) => a.family.localeCompare(b.family));
  }

  /**
   * The Google Fonts catalog, from a day-old cache when there is one.
   *
   * Cached to disk rather than in memory because the picker is opened from a fresh process as often
   * as not, and 2.7MB over the wire to draw a list is a cost the user pays for nothing. A failed
   * fetch falls back to the cache however old it is: a stale list of font names is worth far more
   * than an empty one.
   */
  async catalog(): Promise<CatalogFont[]> {
    const cache = join(this.root, "catalog.json");
    const fresh = (() => {
      try {
        const raw = JSON.parse(readFileSync(cache, "utf8")) as { at: number; fonts: CatalogFont[] };
        return Date.now() - raw.at < CATALOG_TTL_MS ? raw.fonts : null;
      } catch { return null; }
    })();
    if (fresh) return fresh;
    let fonts: CatalogFont[];
    try {
      const res = await this.fetch(CATALOG_URL, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(String(res.status));
      fonts = parseCatalog(await res.text());
    } catch (e) {
      // Stale beats empty. Only a first run with no network reaches the throw.
      try { return (JSON.parse(readFileSync(cache, "utf8")) as { fonts: CatalogFont[] }).fonts; }
      catch { throw new RpcError("UNAVAILABLE", `could not reach Google Fonts: ${e instanceof Error ? e.message : String(e)}`); }
    }
    mkdirSync(this.root, { recursive: true });
    writeFileSync(cache, JSON.stringify({ at: Date.now(), fonts }));
    return fonts;
  }

  /**
   * Fetch one family's files and keep them.
   *
   * The manifest is written LAST, after every file has landed, because `list` treats its presence as
   * "this family is complete" — a download interrupted halfway then leaves a folder that is skipped
   * rather than a font that renders as nothing.
   */
  async install(family: string): Promise<InstalledFont> {
    if (!FAMILY.test(family)) throw new RpcError("BAD_REQUEST", `${family} is not a font family name`);
    const spec = `${family.replace(/ /g, "+")}:wght@${WANT_WEIGHTS.join(";")}`;
    const css = await this.text(`${CSS_URL}?family=${encodeURIComponent(spec).replace(/%2B/g, "+").replace(/%3A/g, ":").replace(/%40/g, "@").replace(/%3B/g, ";")}&display=swap`)
      // A family with only one weight 400-rejects the two-weight request; ask again for whatever it has.
      .catch(() => this.text(`${CSS_URL}?family=${encodeURIComponent(family.replace(/ /g, "+")).replace(/%2B/g, "+")}&display=swap`));
    const faces = parseFaces(css);
    if (faces.length === 0) throw new RpcError("NOT_FOUND", `Google Fonts returned no files for ${family}`);
    const dir = join(this.root, slug(family));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let bytes = 0;
    const weights: number[] = [];
    for (const face of faces) {
      const res = await this.fetch(face.url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new RpcError("UNAVAILABLE", `could not download ${family} ${face.weight}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(join(dir, `${face.weight}.woff2`), buf);
      bytes += buf.byteLength;
      weights.push(face.weight);
    }
    const manifest: InstalledFont = { family, weights: [...new Set(weights)].sort((a, b) => a - b), bytes };
    writeFileSync(join(dir, "font.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /** One family's files as base64, for the renderer to make `@font-face` rules from.
   *
   *  Base64 over the existing RPC rather than a new HTTP route: a latin woff2 is tens of kilobytes,
   *  these are read once at boot, and a second way to serve bytes out of the Realm home is a second
   *  thing to get the path checks right on. */
  faces(family: string): { weight: number; base64: string }[] {
    const dir = join(this.root, slug(family));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".woff2"))
      .map((n) => ({ weight: Number(n.replace(".woff2", "")), base64: readFileSync(join(dir, n)).toString("base64") }))
      .filter((f) => Number.isFinite(f.weight))
      .sort((a, b) => a.weight - b.weight);
  }

  /** Remove a family's files. The preference naming it is not touched here — the renderer moves it,
   *  because only it knows which of the two roles was wearing it. */
  remove(family: string): void {
    try { rmSync(join(this.root, slug(family)), { recursive: true, force: true }); } catch { /* gone is the goal */ }
  }

  private async text(url: string): Promise<string> {
    const res = await this.fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new RpcError("UNAVAILABLE", `Google Fonts answered ${res.status}`);
    return res.text();
  }
}

/** The same charset the renderer's own `parseFontPref` vets, for the same reason: this one becomes a
 *  URL and a directory name. */
const FAMILY = /^[\w][\w .'+-]{0,62}$/;
/** `JetBrains Mono` → `jetbrains-mono`. A directory name, so it is the charset that decides. */
const slug = (family: string): string => family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The catalog, cut down to what a picker needs. `mono` is carried because the code-face picker must
 *  not offer a proportional family — a monospace layout in a display face is unreadable in a way the
 *  user cannot undo without finding this setting again. */
export function parseCatalog(text: string): CatalogFont[] {
  // Google prefixes the JSON with an anti-hijacking guard on some routes.
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, "")) as { familyMetadataList?: unknown };
  const list = Array.isArray(json.familyMetadataList) ? json.familyMetadataList : [];
  const out: CatalogFont[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { family?: unknown; category?: unknown };
    if (typeof e.family !== "string" || !FAMILY.test(e.family)) continue;
    const category = typeof e.category === "string" ? e.category : "";
    out.push({ family: e.family, category, mono: category.toLowerCase() === "monospace" });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * The `@font-face` blocks in a css2 response, as weight + file URL — one file per weight, and the
 * LATIN one.
 *
 * css2 repeats every weight once per unicode subset, each block preceded by a `/* subset *\/`
 * comment, and they are not in a helpful order: JetBrains Mono leads with `cyrillic-ext`. Taking the
 * first per weight — which this did — downloaded a 1.6KB slice of Cyrillic and called it the font,
 * so the app rendered the chosen face with a few dozen glyphs and the fallback stack for everything
 * else. Only a real download shows that; the byte count is what gave it away.
 *
 * Latin only, and that is a deliberate limit rather than an oversight: Realm would otherwise inline
 * every script's subset into the document at boot for a face nobody asked to read Greek in. Text
 * outside it falls through to the stack behind the family, which is exactly what already happens for
 * a glyph the bundled Inter does not have.
 */
export function parseFaces(css: string): { weight: number; url: string }[] {
  const best = new Map<number, { rank: number; url: string }>();
  // Split on the subset comment so each chunk carries the name of the subset it describes.
  for (const chunk of css.split(/\/\*\s*/).slice(1)) {
    const subset = /^([\w-]+)\s*\*\//.exec(chunk)?.[1] ?? "";
    const rank = SUBSET_RANK[subset] ?? (subset ? 99 : 50);
    for (const block of chunk.split("@font-face").slice(1)) {
      const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
      const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
      if (!Number.isFinite(weight) || !url) continue;
      const cur = best.get(weight);
      if (!cur || rank < cur.rank) best.set(weight, { rank, url: url.replace(/^['"]|['"]$/g, "") });
    }
  }
  /* A response with no subset comments at all — which is what the `css` endpoint answers for some
     families, and what a test fixture looks like — still has to produce faces, so the fall-through
     above ranks an unnamed chunk in the middle and the first of them wins. */
  if (best.size === 0) {
    for (const block of css.split("@font-face").slice(1)) {
      const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
      const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
      if (Number.isFinite(weight) && url && !best.has(weight)) best.set(weight, { rank: 50, url: url.replace(/^['"]|['"]$/g, "") });
    }
  }
  return [...best].map(([weight, v]) => ({ weight, url: v.url })).sort((a, b) => a.weight - b.weight);
}

/** Which subset to keep, lowest first. `latin` is the one the chrome is written in; `latin-ext` is
 *  the accented half of Western Europe and is the only other one worth the bytes at boot. */
const SUBSET_RANK: Record<string, number> = { latin: 0, "latin-ext": 1 };
