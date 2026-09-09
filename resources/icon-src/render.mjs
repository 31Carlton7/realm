// Render the canonical SVG into every native macOS icon size, then package the iconset.
//
// The rasterizer is headless Chrome rather than qlmanage: Quick Look thumbnails are flattened onto
// white, which put an opaque white square around the icon's rounded shell. Chrome honours the
// SVG's transparency when asked for a transparent default background.
//
// Two Chrome quirks shape the code. It never finishes a screenshot of a window smaller than its
// minimum size (16 px hangs it outright), so every size is drawn into one 1024 px window and cropped
// from the top-left corner. And with a scratch profile it writes the screenshot and then never
// exits, so the render waits for a complete PNG and kills the process itself rather than using the
// user's real profile.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "..");
const source = join(here, "app-icon.svg");
const chrome =
  process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) {
  throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`);
}

const WINDOW = 1024;
const RENDER_TIMEOUT_MS = 60_000;
const scratch = mkdtempSync(join(tmpdir(), "realm-icon-"));
const iconset = join(scratch, "icon.iconset");
const profile = join(scratch, "chrome-profile");
mkdirSync(iconset);
mkdirSync(profile);

const entries = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
const rendered = new Map();

/** Reads a finished PNG, or undefined while the file is absent or still being written. */
function readComplete(path) {
  if (!existsSync(path)) return undefined;
  try {
    return PNG.sync.read(readFileSync(path));
  } catch {
    return undefined;
  }
}

/** Rasterizes the SVG at exactly `size` px, transparent around the shell. */
async function render(size) {
  const page = join(scratch, `${size}.html`);
  const shot = join(scratch, `${size}-window.png`);
  const out = join(scratch, `${size}.png`);
  writeFileSync(
    page,
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="${pathToFileURL(source).href}" style="display:block;width:${size}px;height:${size}px"></body></html>`,
  );
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${WINDOW},${WINDOW}`,
      `--screenshot=${shot}`,
      pathToFileURL(page).href,
    ],
    { stdio: "ignore" },
  );

  let full;
  try {
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    while (!(full = readComplete(shot))) {
      if (child.exitCode !== null && !existsSync(shot)) {
        throw new Error(`Chrome exited with ${child.exitCode} before writing ${shot}`);
      }
      if (Date.now() > deadline) throw new Error(`Chrome did not write ${shot} within ${RENDER_TIMEOUT_MS} ms`);
      await sleep(100);
    }
  } finally {
    child.kill("SIGKILL");
  }

  const cropped = new PNG({ width: size, height: size });
  PNG.bitblt(full, cropped, 0, 0, size, size, 0, 0);
  writeFileSync(out, PNG.sync.write(cropped));
  return out;
}

try {
  for (const [pt, scale] of entries) {
    const size = pt * scale;
    if (!rendered.has(size)) rendered.set(size, await render(size));
    copyFileSync(rendered.get(size), join(iconset, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`));
  }

  copyFileSync(rendered.get(1024), join(resources, "icon.png"));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);
  console.log("wrote resources/icon.png and resources/icon.icns");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
