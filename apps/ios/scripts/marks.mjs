// Realm's marks for the iPhone, written into the asset catalog from the files the Mac draws them from,
// and a Swift file naming them.
//
//   node apps/ios/scripts/marks.mjs            # write the image sets and Marks.swift
//   node apps/ios/scripts/marks.mjs --check    # exit 1 if what is on disk has drifted
//
// - The Realm mark, flat and shaded: resources/icon-src/mark.mjs, the source of every drawing of it.
// - Each agent's mark: AGENT_META's icon (packages/contracts/src/presets.ts), drawn from the vendor's
//   vector in packages/ui/src/brand-icons.ts, or from the Hugeicons pack for the two agents with no
//   vendor vector (Hermes' caduceus, the scripted agent's bot).
// - Every glyph a space can wear: SPACE_ICONS, through the name map in packages/ui/src/Icon.tsx, from
//   the Hugeicons pack the desktop draws them with.
//
// Each is an SVG the catalog keeps as a vector, so it is sharp at every Dynamic Type size. The agent and
// space glyphs are templates: they take the colour of the text beside them, as `currentColor` does on
// the Mac. A stroke glyph is drawn at the weight the desktop's `iconStroke` gives the size it is shown
// at here, so it holds the weight of the text beside it rather than thinning as it shrinks.
// marks.test.ts holds the files on disk to this.
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "../../..");
export const CATALOG = join(repoRoot, "apps/ios/Realm/Assets.xcassets/Marks");
export const SWIFT = join(repoRoot, "apps/ios/Realm/Theme/Marks.swift");
const ICON_TSX = join(repoRoot, "packages/ui/src/Icon.tsx");

/** The size a space's or an agent's glyph is shown at, in points: the 20 pt of a row's leading glyph.
 *  The desktop's `iconStroke` for that size is its 1.5 px ceiling. */
export const GLYPH_POINTS = 20;
const iconStroke = (size) => Math.min(1.5, Math.max(1.125, size / 12));

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const folder = (namespace) => json({ info: { author: "xcode", version: 1 }, ...(namespace ? { properties: { "provides-namespace": true } } : {}) });
const imageSet = (file, template) => json({
  images: [{ filename: file, idiom: "universal" }],
  info: { author: "xcode", version: 1 },
  properties: { "preserves-vector-representation": true, "template-rendering-intent": template ? "template" : "original" },
});

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));

/** A vendor's mark as a filled SVG. Its height is the glyph's; its width follows the mark's aspect. */
export function brandSvg(mark) {
  const viewBox = mark.viewBox ?? "0 0 24 24";
  const [, , w, h] = viewBox.split(/[\s,]+/).map(Number);
  const paths = typeof mark.d === "string" ? [mark.d] : mark.d;
  const rule = mark.evenOdd ? ` fill-rule="evenodd"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num((GLYPH_POINTS * w) / h)}" height="${GLYPH_POINTS}" viewBox="${viewBox}">`,
    ...paths.map((d) => `<path fill="#000000"${rule} d="${d}"/>`),
    "</svg>",
    "",
  ].join("\n");
}

/** A Hugeicons glyph as a stroked SVG, at the stroke the desktop gives a glyph of this size. */
export function strokeSvg(icon) {
  const scale = (iconStroke(GLYPH_POINTS) * 24) / GLYPH_POINTS / 1.5;
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const parts = icon.map(([tag, attrs]) => {
    const list = Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => {
      if (k === "strokeWidth") return `stroke-width="${num(Number(v) * scale)}"`;
      if (v === "currentColor") return `${kebab(k)}="#000000"`;
      return `${kebab(k)}="${v}"`;
    });
    // A part that names no fill is a line, not a shape: SVG would otherwise fill it black.
    if (!("fill" in attrs)) list.push(`fill="none"`);
    return `<${tag} ${list.join(" ")}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GLYPH_POINTS}" height="${GLYPH_POINTS}" viewBox="0 0 24 24" fill="none">`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}

/** Icon.tsx's name → the Hugeicons export it draws, for the names asked for. */
export function hugeiconExports(names, source = readFileSync(ICON_TSX, "utf8")) {
  const map = source.slice(source.indexOf("export const icons = {"));
  const found = new Map();
  for (const name of names) {
    const match = map.match(new RegExp(`[\\s{,]${name}:\\s*(\\w+Icon)\\b`));
    if (!match) throw new Error(`Icon.tsx draws no glyph called ${name}`);
    found.set(name, match[1]);
  }
  return found;
}

/** Everything the script reads, loaded once. */
export async function sources() {
  const { flatMarkSvg, markSvg } = await import(pathToFileURL(join(repoRoot, "resources/icon-src/mark.mjs")).href);
  const { brandMarks } = await import(pathToFileURL(join(repoRoot, "packages/ui/src/brand-icons.ts")).href);
  const { AGENT_META, SPACE_ICONS } = await import(pathToFileURL(join(repoRoot, "packages/contracts/src/presets.ts")).href);
  const require = createRequire(join(repoRoot, "packages/ui/package.json"));
  const packIndex = require.resolve("@hugeicons-pro/core-stroke-rounded").replace(/\/cjs\/index\.js$/, "/esm/index.js");
  const pack = await import(pathToFileURL(packIndex).href);
  return { flatMarkSvg, markSvg, brandMarks, AGENT_META, SPACE_ICONS, pack, iconTsx: readFileSync(ICON_TSX, "utf8") };
}

/** Every file the script owns, path → contents. */
export function build(s) {
  const files = new Map();
  const put = (path, contents) => files.set(join(CATALOG, path), contents);
  put("Contents.json", folder(false));

  // The mark: flat for a glyph beside text, shaded where it stands on its own.
  put("RealmMark.imageset/Contents.json", imageSet("realm-mark.svg", true));
  put("RealmMark.imageset/realm-mark.svg", s.flatMarkSvg("#000000"));
  put("RealmMarkShaded.imageset/Contents.json", imageSet("realm-mark-shaded.svg", false));
  put("RealmMarkShaded.imageset/realm-mark-shaded.svg", s.markSvg());

  // Agents: one image per distinct icon AGENT_META names.
  const agentIcons = [...new Set(Object.values(s.AGENT_META).map((m) => m.icon))].sort();
  const strokeAgents = agentIcons.filter((icon) => !(icon in s.brandMarks));
  const agentStrokes = hugeiconExports(strokeAgents, s.iconTsx);
  put("Agents/Contents.json", folder(true));
  for (const icon of agentIcons) {
    const svg = icon in s.brandMarks ? brandSvg(s.brandMarks[icon]) : strokeSvg(s.pack[agentStrokes.get(icon)]);
    put(`Agents/${icon}.imageset/Contents.json`, imageSet(`${icon}.svg`, true));
    put(`Agents/${icon}.imageset/${icon}.svg`, svg);
  }

  // Spaces: every glyph the picker offers.
  const spaceStrokes = hugeiconExports(s.SPACE_ICONS, s.iconTsx);
  put("Spaces/Contents.json", folder(true));
  for (const name of s.SPACE_ICONS) {
    const icon = s.pack[spaceStrokes.get(name)];
    if (!icon) throw new Error(`the Hugeicons pack has no ${spaceStrokes.get(name)}`);
    put(`Spaces/${name}.imageset/Contents.json`, imageSet(`${name}.svg`, true));
    put(`Spaces/${name}.imageset/${name}.svg`, strokeSvg(icon));
  }

  files.set(SWIFT, swift(s, agentIcons));
  return files;
}

function swift(s, agentIcons) {
  const quote = (v) => JSON.stringify(v);
  const kinds = Object.entries(s.AGENT_META).sort(([a], [b]) => a.localeCompare(b));
  const colours = agentIcons.filter((icon) => s.brandMarks[icon]?.color).map((icon) => [icon, s.brandMarks[icon].color]);
  return [
    "// Generated by apps/ios/scripts/marks.mjs from presets.ts, brand-icons.ts and Icon.tsx. Do not edit;",
    "// run the script. marks.test.ts fails when this or the image sets drift from those files.",
    "",
    "/// The marks in the catalog's Marks folder, by what names them on the Mac.",
    "enum Marks {",
    "    /// Each agent kind's mark (AGENT_META's `icon`), drawn from `Agents/<icon>`.",
    "    static let agents: [String: String] = [",
    ...kinds.map(([kind, meta]) => `        ${quote(kind)}: ${quote(meta.icon)},`),
    "    ]",
    "",
    "    /// The one colour a vendor draws its mark in, where the agent's identity is the point.",
    "    static let agentColors: [String: String] = [",
    ...colours.map(([icon, colour]) => `        ${quote(icon)}: ${quote(colour)},`),
    "    ]",
    "",
    "    /// Every glyph a space's icon picker offers (SPACE_ICONS), drawn from `Spaces/<name>`.",
    "    static let spaces: Set<String> = [",
    ...s.SPACE_ICONS.map((name) => `        ${quote(name)},`),
    "    ]",
    "}",
    "",
  ].join("\n");
}

/** Every file on disk that differs from what the sources say, or should not be there. */
export function drift(files) {
  const problems = [];
  for (const [path, contents] of files) {
    const rel = relative(repoRoot, path);
    if (!existsSync(path)) problems.push(`${rel} is missing`);
    else if (readFileSync(path, "utf8") !== contents) problems.push(`${rel} differs from its source`);
  }
  for (const path of walk(CATALOG)) {
    if (!files.has(path)) problems.push(`${relative(repoRoot, path)} is not written by marks.mjs`);
  }
  return problems;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = build(await sources());
  if (process.argv.includes("--check")) {
    const problems = drift(files);
    for (const problem of problems) console.error(problem);
    process.exit(problems.length ? 1 : 0);
  }
  rmSync(CATALOG, { recursive: true, force: true });
  for (const [path, contents] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  console.log(`wrote ${files.size} files under ${relative(repoRoot, CATALOG)} and ${relative(repoRoot, SWIFT)}`);
}
