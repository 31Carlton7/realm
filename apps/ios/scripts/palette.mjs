// Realm's palette for the iPhone: the authored dark and light tokens in the desktop's tokens.css,
// written into the app's asset catalog as named colours, and a Swift file naming them.
//
//   node apps/ios/scripts/palette.mjs            # write the colour sets and Palette.swift
//   node apps/ios/scripts/palette.mjs --check    # exit 1 if what is on disk has drifted
//
// The values are read from the stylesheet the Mac app draws with — the top-level `:root` block (dark,
// Realm's primary face) and `:root[data-mode="light"]` over it — never copied by hand, so the phone
// cannot drift from the Mac. OKLCH is converted to Display P3, the space iPhones draw in, exactly as a
// browser on a wide-gamut screen would show it. palette.test.ts holds the files on disk to this.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "../../..");
export const TOKENS_CSS = join(repoRoot, "apps/desktop/src/renderer/src/theme/tokens.css");
export const CATALOG = join(repoRoot, "apps/ios/Realm/Assets.xcassets/Palette");
export const SWIFT = join(repoRoot, "apps/ios/Realm/Theme/Palette.swift");

/** The tokens the phone uses: [token, colour set, Swift name, what it is for]. AccentColor is the
 *  catalog's global accent, so system controls take Realm's blue. */
export const TOKENS = [
  ["page", "Page", "page", "Window and sidebar ground; the launch screen"],
  ["canvas", "Canvas", "canvas", "The working plane"],
  ["surface", "Surface", "surface", "Cards, sheets, the composer and other raised objects"],
  ["inset", "Inset", "inset", "Wells and recessed controls"],
  ["hover", "Hover", "hover", "A pressed row"],
  ["hover-2", "Hover2", "hover2", "A pressed control on a raised surface"],
  ["field", "Field", "field", "A text field's ground"],
  ["ink", "Ink", "ink", "Primary text"],
  ["ink-2", "Ink2", "ink2", "Secondary text"],
  ["ink-3", "Ink3", "ink3", "Quiet text a reader may skip: counts, timestamps"],
  ["accent", "AccentColor", "accent", "Focus, selection, links and the one primary action"],
  ["accent-ink", "AccentInk", "accentInk", "Accent text on a surface"],
  ["accent-tint", "AccentTint", "accentTint", "The wash behind an accent chip"],
  ["accent-fill", "AccentFill", "accentFill", "A filled control's ground: the accent solved for the white word on it"],
  ["accent-fill-press", "AccentFillPress", "accentFillPress", "A filled control, pressed"],
  ["danger-fill", "DangerFill", "dangerFill", "A filled destructive control's ground, solved the same way"],
  ["green", "Green", "green", "State: done, allowed"],
  ["green-tint", "GreenTint", "greenTint", "The wash behind a green chip"],
  ["orange", "Orange", "orange", "State: waiting on you"],
  ["orange-tint", "OrangeTint", "orangeTint", "The wash behind an orange chip"],
  ["red", "Red", "red", "State: failed, denied"],
  ["red-tint", "RedTint", "redTint", "The wash behind a red chip"],
  ["line", "Line", "line", "The ordinary hairline"],
  ["line-strong", "LineStrong", "lineStrong", "A hairline that carries more of a boundary"],
  ["divider", "Divider", "divider", "A hairline with no change of surface beside it"],
  ["mark", "Mark", "mark", "A fill that is not an edge: a track, an idle dot"],
];

/* ── reading the stylesheet ─────────────────────────────────────────────── */

/** Top-level rule blocks as [selector, body], in source order. Comments are removed first. */
export function topLevelBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let depth = 0, start = 0, selector = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) { selector = text.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) { blocks.push([selector, text.slice(start, i)]); start = i + 1; }
    } else if (ch === ";" && depth === 0) {
      start = i + 1; // an at-rule with no block, such as @import
    }
  }
  return blocks;
}

/** A block's custom properties, `--name` → value. Semicolons inside parentheses do not end one. */
export function declarations(body) {
  const out = new Map();
  let depth = 0, start = 0;
  const flush = (end) => {
    const decl = body.slice(start, end).trim();
    const colon = decl.indexOf(":");
    if (decl.startsWith("--") && colon > 0) out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === ";" && depth === 0) { flush(i); start = i + 1; }
  }
  flush(body.length);
  return out;
}

/** The two faces: dark is every top-level `:root` block in order; light is dark with every
 *  `:root[data-mode="light"]` block laid over it, as the cascade lays them. */
export function faces(css) {
  const dark = new Map(), lightOnly = new Map();
  for (const [selector, body] of topLevelBlocks(css)) {
    if (selector === ":root") for (const [k, v] of declarations(body)) dark.set(k, v);
    else if (selector === ':root[data-mode="light"]') for (const [k, v] of declarations(body)) lightOnly.set(k, v);
  }
  return { dark, light: new Map([...dark, ...lightOnly]) };
}

export function resolve(value, vars, seen = new Set()) {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    if (seen.has(name)) throw new Error(`${name} refers to itself`);
    const next = vars.get(name) ?? fallback;
    if (next === undefined) throw new Error(`${name} is not defined`);
    return resolve(next, vars, new Set([...seen, name]));
  });
}

/* ── colour ─────────────────────────────────────────────────────────────── */

const number = (s) => (s.trim().endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));

/** A colour as linear-light sRGB (which may fall outside 0…1 for a wide-gamut colour) and alpha. */
export function parseColor(value) {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) throw new Error(`not a colour: ${value}`);
    const byte = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { linear: [byte(0), byte(2), byte(4)].map(toLinear), alpha: h.length === 8 ? byte(6) : 1 };
  }
  const oklch = v.match(/^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+))?\s*\)$/);
  if (oklch) {
    const [L, C, H] = [number(oklch[1]), number(oklch[2]), parseFloat(oklch[3])];
    return { linear: oklchToLinearSrgb(L, C, H), alpha: oklch[4] === undefined ? 1 : number(oklch[4]) };
  }
  throw new Error(`not a colour this script reads: ${value}`);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** CSS Color 4's OKLab → linear sRGB. */
export function oklchToLinearSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB → Display P3 (same D65 white, same transfer curve), through XYZ. */
export function linearSrgbToP3([r, g, b]) {
  const X = 0.41239079926595934 * r + 0.357584339383878 * g + 0.1804807884018343 * b;
  const Y = 0.21263900587151027 * r + 0.715168678767756 * g + 0.07219231536073371 * b;
  const Z = 0.01933081871559182 * r + 0.11919477979462598 * g + 0.9505321522496607 * b;
  const p3 = [
    2.493496911941425 * X - 0.9313836179191239 * Y - 0.40271078445071684 * Z,
    -0.8294889695615747 * X + 1.7626640603183463 * Y + 0.023624685841943577 * Z,
    0.03584583024378447 * X - 0.07617238926804182 * Y + 0.9568845240076872 * Z,
  ];
  return p3.map((c) => toGamma(Math.min(1, Math.max(0, c))));
}

const component = (n) => n.toFixed(4);

function colorEntry(css, appearance) {
  const { linear, alpha } = parseColor(css);
  const [red, green, blue] = linearSrgbToP3(linear);
  return {
    ...(appearance ? { appearances: [{ appearance: "luminosity", value: appearance }] } : {}),
    color: { "color-space": "display-p3", components: { alpha: component(alpha), blue: component(blue), green: component(green), red: component(red) } },
    idiom: "universal",
  };
}

/* ── what gets written ──────────────────────────────────────────────────── */

const INFO = { author: "xcode", version: 1 };
const json = (object) => `${JSON.stringify(object, null, 2)}\n`;

/** Every file the palette owns, path → contents. */
export function build(css = readFileSync(TOKENS_CSS, "utf8")) {
  const { dark, light } = faces(css);
  const files = new Map();
  files.set(join(CATALOG, "Contents.json"), json({ info: INFO, properties: { "provides-namespace": false } }));
  const swift = [
    "// Generated by apps/ios/scripts/palette.mjs from the desktop's tokens.css. Do not edit; run the",
    "// script. palette.test.ts fails when this or the colour sets drift from the stylesheet.",
    "import SwiftUI",
    "",
    "/// Realm's palette: each colour is the token of the same name, dark and light, from tokens.css.",
    "enum Palette {",
  ];
  for (const [token, set, name, purpose] of TOKENS) {
    const name_ = `--${token}`;
    if (!dark.has(name_) || !light.has(name_)) throw new Error(`${name_} is not in tokens.css`);
    const darkValue = resolve(dark.get(name_), dark), lightValue = resolve(light.get(name_), light);
    files.set(join(CATALOG, `${set}.colorset`, "Contents.json"), json({
      colors: [colorEntry(lightValue), colorEntry(darkValue, "dark")],
      info: INFO,
    }));
    swift.push(`    /// \`--${token}\`: ${purpose}. Dark \`${darkValue}\`, light \`${lightValue}\`.`);
    swift.push(`    static let ${name} = Color("${set}")`);
  }
  swift.push("}", "");
  files.set(SWIFT, swift.join("\n"));
  return files;
}

/** Colour sets on disk that the palette no longer names. */
function strays(files) {
  let entries = [];
  try { entries = readdirSync(CATALOG); } catch { return []; }
  return entries.filter((e) => e.endsWith(".colorset") && !files.has(join(CATALOG, e, "Contents.json"))).map((e) => join(CATALOG, e));
}

/** What differs between the files on disk and what the stylesheet says they should be. */
export function drift(files = build()) {
  const problems = [];
  for (const [path, contents] of files) {
    let current = null;
    try { current = readFileSync(path, "utf8"); } catch { problems.push(`${relative(repoRoot, path)} is missing`); continue; }
    const same = path.endsWith(".json") ? JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(contents)) : current === contents;
    if (!same) problems.push(`${relative(repoRoot, path)} differs from tokens.css`);
  }
  for (const stray of strays(files)) problems.push(`${relative(repoRoot, stray)} is not in the palette`);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = build();
  if (process.argv.includes("--check")) {
    const problems = drift(files);
    for (const p of problems) console.error(p);
    if (problems.length) { console.error("Run: node apps/ios/scripts/palette.mjs"); process.exit(1); }
    console.log(`palette matches tokens.css (${TOKENS.length} colours)`);
  } else {
    for (const stray of strays(files)) rmSync(stray, { recursive: true, force: true });
    for (const [path, contents] of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    console.log(`wrote ${TOKENS.length} colour sets and ${relative(repoRoot, SWIFT)}`);
  }
}
