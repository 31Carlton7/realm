// Render the canonical SVG into every native macOS icon size, then package the iconset.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "..");
const source = join(here, "app-icon.svg");
const scratch = mkdtempSync(join(tmpdir(), "realm-icon-"));
const iconset = join(scratch, "icon.iconset");
mkdirSync(iconset);

const entries = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
const rendered = new Map();

try {
  for (const [pt, scale] of entries) {
    const size = pt * scale;
    if (!rendered.has(size)) {
      const out = join(scratch, String(size));
      mkdirSync(out);
      execFileSync("qlmanage", ["-t", "-s", String(size), "-o", out, source], { stdio: "ignore" });
      rendered.set(size, join(out, "app-icon.svg.png"));
    }
    copyFileSync(rendered.get(size), join(iconset, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`));
  }

  copyFileSync(rendered.get(1024), join(resources, "icon.png"));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);
  console.log("wrote resources/icon.png and resources/icon.icns");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
