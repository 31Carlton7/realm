import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { readMode, vscodeToSeed, type SeedReport, type StoredTheme, type VsCodeTheme } from "@realm/contracts";
import { RpcError } from "../store/rows";

/**
 * Themes the user imported, as files they can open.
 *
 * `~/Realm/themes/<id>.json`, beside `~/Realm/skills` and for the same reasons: a theme is something
 * you might want to hand-edit, copy to another Mac, or delete in Finder, and a row in SQLite is none
 * of those. What is stored is the TRANSLATED palette — Realm's thirteen seeds — not the VS Code file
 * it came from, so the file on disk is the thing the app actually renders and a person reading it can
 * see exactly which colours their theme is made of.
 *
 * That choice has one real cost, stated here because it is the kind of thing that surprises later: a
 * later improvement to the translator does not reach a theme already imported. Re-importing the
 * original file is what picks it up. The alternative — storing the VS Code file and translating on
 * every read — makes the palette move under a user who never asked for it, which is worse.
 */
export const themesRoot = (home: string): string => join(home, "themes");

/** `Atomize Atom One Dark.json` → `atomize-atom-one-dark`. The id is the file name, so a theme can be
 *  found, edited and deleted by the name it was imported under. */
export const themeIdFor = (name: string): string =>
  name.replace(/\.jsonc?$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "theme";

/**
 * JSON with comments and trailing commas, which is what VS Code themes actually are.
 *
 * `JSON.parse` rejects both, and a large share of published themes carry at least one — refusing
 * them would mean refusing the files people are trying to import while telling them their theme is
 * malformed, which it is not. Strings are tracked so a `//` inside a colour name or a URL is not
 * mistaken for the start of a comment.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inString = false;
      i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  // Trailing commas, after the comments are gone so a comma before a commented-out line is caught.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * One theme file, with its `include` chain resolved.
 *
 * VS Code themes routinely `include` a base theme and state only their differences — the Dark+ family
 * is built this way — and a reader that ignored it would import the differences alone, which is a
 * theme with no background. Bounded to `INCLUDE_DEPTH` because the chain is relative paths on disk
 * and a cycle would otherwise be a hang.
 */
export function readThemeFile(path: string, depth = 0): VsCodeTheme {
  const raw = parseJsonc(readFileSync(path, "utf8"));
  // `Array.isArray` as well as the object check: an array passes `typeof x === "object"`, so a JSON
  // file holding a list would flow all the way through and import as a theme with nothing in it.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError("BAD_REQUEST", `${basename(path)} is not a colour theme`);
  }
  const theme = raw as VsCodeTheme & { include?: unknown };
  if (typeof theme.include !== "string" || depth >= INCLUDE_DEPTH) return theme;
  let base: VsCodeTheme;
  try { base = readThemeFile(resolve(dirname(path), theme.include), depth + 1); }
  catch { return theme; } // a broken include costs the base, never the import
  return {
    ...base, ...theme,
    colors: { ...base.colors, ...theme.colors },
    // Token rules CONCATENATE, base first, because the later rule wins in `scopeColour` — which is
    // exactly VS Code's own precedence for an included theme.
    tokenColors: [
      ...(Array.isArray(base.tokenColors) ? base.tokenColors : []),
      ...(Array.isArray(theme.tokenColors) ? theme.tokenColors : []),
    ],
  };
}

const INCLUDE_DEPTH = 4;

export class ThemesService {
  readonly root: string;
  constructor(private d: { home: string }) { this.root = themesRoot(d.home); }

  /** Every theme in the folder, newest name order. A file that will not parse is SKIPPED rather than
   *  failing the list: one bad theme must not cost the user the rest of them. */
  list(): StoredTheme[] {
    let names: string[];
    try { names = readdirSync(this.root).filter((n) => extname(n) === ".json").sort(); }
    catch { return []; }
    const out: StoredTheme[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.root, name), "utf8")) as StoredTheme;
        if (parsed?.seed?.bg && parsed.id) out.push(parsed);
      } catch { /* a theme that will not parse is one theme, not the list */ }
    }
    return out;
  }

  /** Translate a VS Code theme file and keep it. Re-importing the same name replaces it, which is
   *  what makes "fix the file and import it again" work. */
  import(path: string): StoredTheme {
    if (!existsSync(path)) throw new RpcError("NOT_FOUND", `no file at ${path}`);
    const theme = readThemeFile(path);
    const mode = readMode(theme);
    const { seed, report } = vscodeToSeed(theme, mode);
    const id = themeIdFor(basename(path));
    const stored: StoredTheme = {
      id,
      label: typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : prettyLabel(id),
      mode,
      seed,
      source: { file: path, derived: derivedRoles(report) },
    };
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, `${id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }

  /** Forget one. The file goes; nothing else does — a space still naming it falls back to `realm`,
   *  which is `paletteFor`'s own rule for a palette that has no such face. */
  remove(id: string): void {
    try { rmSync(join(this.root, `${sanitise(id)}.json`)); } catch { /* already gone is the goal state */ }
  }
}

/** Which of the thirteen Realm had to work out rather than read. */
const derivedRoles = (report: SeedReport): string[] =>
  Object.entries(report).filter(([, v]) => v !== "stated").map(([k]) => k);

/** `atomize-atom-one-dark` → `Atomize atom one dark`, for a file whose theme states no name. */
const prettyLabel = (id: string): string =>
  id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Ids come from the client, and this one becomes a path. Keeping it to the charset `themeIdFor`
 *  produces is what makes a `../` impossible rather than merely unlikely. */
const sanitise = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]/g, "");
