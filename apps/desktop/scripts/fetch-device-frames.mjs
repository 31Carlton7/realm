/**
 * Fetches the device art the simulator pane frames a stream with, and writes the table that says
 * where each one's screen is (run with: node apps/desktop/scripts/fetch-device-frames.mjs).
 *
 * The art comes from MockUPhone (github.com/oursky/mockuphone.com, Apache-2.0), pinned to a commit
 * so a re-run produces the same files. Its own `device_info.json` carries each frame's screen
 * rectangle in the art's pixels, which is why nothing here measures alpha: the coordinates are the
 * generator's, not a guess made by looking at the picture.
 *
 * Provenance is per FRAME and is not all the same — see `assets/devices/CREDITS.md`, which this
 * script writes from the credits field of that same file rather than from anything typed here.
 *
 * Run it when a frame should be added, replaced, or re-pinned. The output is committed; the app
 * never fetches anything.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../src/renderer/src/assets/devices");
const table = path.resolve(here, "../src/renderer/src/panes/simulator/device-art.generated.ts");

/** MockUPhone at a fixed commit. A moving `main` would re-download different art on a re-run. */
const REPO = "oursky/mockuphone.com";
const COMMIT = "7e570f420ad91d895df926214c206d0833fb53a5";
const raw = (p) => `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${p}`;

/**
 * The frames Realm ships, and which device each one stands in for.
 *
 * One per FAMILY rather than one per model, which is the whole point: every iPhone since the 14 Pro
 * is the same black slab with the same island at the sizes a pane draws, and a table with a row per
 * product is a table that is out of date the September after it is written. A device whose screen is
 * not the shape of the art it would be given falls back to the frame Realm draws itself — that is
 * the check in `device-art.ts`, not here.
 */
const FRAMES = [
  { key: "iosPhone", device: "apple-iphone-15-pro-black-titanium", file: "iphone.png" },
  { key: "iosTablet", device: "apple-ipadpro11-spacegrey", file: "ipad.png" },
  { key: "androidPhone", device: "google-pixel-8-obsidian", file: "android-phone.png" },
];

/** The art is drawn at most this tall. A pane is under a thousand CSS pixels on any Mac, so 2400
 *  device pixels is already more than a Retina screen can show — the rest is download size. */
const MAX_EDGE = 2400;

const get = async (url, binary = false) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
};

/** `sips` reports the pixel size of a file on disk; it ships with macOS, which this app is. */
function sizeOf(file) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!width || !height) throw new Error(`could not read the size of ${file}`);
  return { width, height };
}

const info = JSON.parse(await get(raw("src/scripts/device_info.json")));
fs.mkdirSync(assets, { recursive: true });

const rows = [];
const credits = [];
for (const frame of FRAMES) {
  const device = info.devices.find((d) => d.device_id === frame.device);
  if (!device) throw new Error(`${frame.device} is not in this commit's device_info.json`);
  const portrait = device.orientations.find((o) => o.name === "portrait");
  if (!portrait) throw new Error(`${frame.device} has no portrait frame`);

  const out = path.join(assets, frame.file);
  fs.writeFileSync(out, await get(raw(`public/images/mockup_templates/${frame.device}-portrait.png`), true));
  const original = sizeOf(out);
  /* Scaled on the way in, so the table's coordinates and the file always agree — a frame resized
     later by hand would put the stream through the wrong part of the picture. */
  if (Math.max(original.width, original.height) > MAX_EDGE) {
    execFileSync("sips", ["-Z", String(MAX_EDGE), out], { stdio: "ignore" });
  }
  const size = sizeOf(out);
  const k = size.width / original.width;

  /* The screen hole. `coords` is four corners, and for a portrait frame they are the rectangle's —
     read as min/max rather than by index, because the corners are not wound the same way on every
     device in that file. */
  const xs = portrait.coords.map((c) => c[0]);
  const ys = portrait.coords.map((c) => c[1]);
  const screen = {
    x: Math.round(Math.min(...xs) * k),
    y: Math.round(Math.min(...ys) * k),
    width: Math.round((Math.max(...xs) - Math.min(...xs)) * k),
    height: Math.round((Math.max(...ys) - Math.min(...ys)) * k),
  };

  rows.push({ key: frame.key, file: frame.file, name: device.name, ...size, screen });
  credits.push({
    file: frame.file,
    name: `${device.name}${device.color_str ? ` (${device.color_str})` : ""}`,
    credit: String(device.credits ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  });
}

const ts = `/* Generated by apps/desktop/scripts/fetch-device-frames.mjs — do not edit.
 *
 * The device art in \`assets/devices\` and where each frame's screen is, in that file's own pixels.
 * Both come from MockUPhone (github.com/oursky/mockuphone.com) at commit ${COMMIT.slice(0, 12)};
 * see assets/devices/CREDITS.md for who drew each one. */

${rows.map((r) => `import ${r.key}Src from "../../assets/devices/${r.file}";`).join("\n")}

export type DeviceArt = {
  /** The device this frame stands in for. */
  name: string;
  /** The art's own pixel size. */
  width: number;
  height: number;
  /** The screen hole, in those same pixels. */
  screen: { x: number; y: number; width: number; height: number };
};

export const DEVICE_ART = {
${rows.map((r) => `  ${r.key}: { src: ${r.key}Src, name: ${JSON.stringify(r.name)}, width: ${r.width}, height: ${r.height},
    screen: { x: ${r.screen.x}, y: ${r.screen.y}, width: ${r.screen.width}, height: ${r.screen.height} } },`).join("\n")}
} satisfies Record<string, DeviceArt & { src: string }>;

export type DeviceArtKey = keyof typeof DEVICE_ART;
`;
fs.writeFileSync(table, ts);

fs.writeFileSync(path.join(assets, "CREDITS.md"), `# Device art

The frames the simulator pane draws around a stream. Fetched by
\`apps/desktop/scripts/fetch-device-frames.mjs\` from
[MockUPhone](https://github.com/oursky/mockuphone.com) at commit \`${COMMIT.slice(0, 12)}\`
(the project is Apache-2.0; each frame's own credit is below, taken from that repo's
\`device_info.json\`).

${credits.map((c) => `- \`${c.file}\` — ${c.name} — ${c.credit}`).join("\n")}

The Apple frames are credited to Apple Design Resources, whose terms cover designing apps for Apple
platforms and do not grant redistribution inside another product. Anything shipped from here is a
call for whoever ships Realm, and it is deliberately one directory and one table wide: delete the
file, drop its row, and the pane falls back to the frame Realm draws itself.
`);

console.log(`${rows.length} frames → ${path.relative(process.cwd(), assets)}`);
for (const r of rows) console.log(`  ${r.file}  ${r.width}×${r.height}  screen ${r.screen.width}×${r.screen.height} at ${r.screen.x},${r.screen.y}`);
