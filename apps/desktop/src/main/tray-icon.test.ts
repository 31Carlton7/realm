import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRgbaPng } from "./png.test-util";
import { TRAY_ICON, TRAY_ICON_2X, TRAY_ICON_COLOUR, trayIconPath } from "./tray-icon";

const desktop = join(__dirname, "../..");

describe("the menu-bar item's picture", () => {
  it("is named as a template, with its @2x beside it, so macOS tints it and finds the sharp one", () => {
    expect(TRAY_ICON).toMatch(/Template\.png$/);
    expect(TRAY_ICON_2X).toBe(TRAY_ICON.replace(/\.png$/, "@2x.png"));
  });

  it("is looked for beside the packaged app's resources, and in apps/desktop/resources in development", () => {
    expect(trayIconPath({ packaged: true, appPath: "/A/app.asar", resourcesPath: "/A" }, "darwin")).toBe("/A/trayTemplate.png");
    expect(trayIconPath({ packaged: false, appPath: desktop, resourcesPath: "/electron" }, "darwin")).toBe(join(desktop, "resources", TRAY_ICON));
    expect(existsSync(trayIconPath({ packaged: false, appPath: desktop, resourcesPath: "/electron" }, "darwin"))).toBe(true);
  });

  it("is the app icon in colour on Linux and Windows, where a template would be black on a dark panel", () => {
    for (const platform of ["linux", "win32"]) {
      expect(trayIconPath({ packaged: true, appPath: "/A/app.asar", resourcesPath: "/A" }, platform)).toBe(join("/A", TRAY_ICON_COLOUR));
      expect(existsSync(trayIconPath({ packaged: false, appPath: desktop, resourcesPath: "/electron" }, platform))).toBe(true);
    }
    expect(readFileSync(join(desktop, "scripts/stage-pack.mjs"), "utf8")).toContain(TRAY_ICON_COLOUR);
  });

  it("is staged into the packaged app's resources, both scales", () => {
    const stage = readFileSync(join(desktop, "scripts/stage-pack.mjs"), "utf8");
    for (const name of [TRAY_ICON, TRAY_ICON_2X]) expect(stage).toContain(name);
  });

  /* A template is read for its alpha alone; any colour in it is a sign it was drawn as something else.
     And it is the flat mark: a hexagon with the doorway knocked out, so the doorway is clear. */
  it.each([[TRAY_ICON, 1], [TRAY_ICON_2X, 2]] as const)("%s is the flat mark in black on transparent", (name, scale) => {
    const png = decodeRgbaPng(readFileSync(join(desktop, "resources", name)));
    expect([png.width, png.height]).toEqual([18 * scale, 16 * scale]);
    let inked = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3]! === 0) continue;
      inked++;
      expect([png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]).toEqual([0, 0, 0]);
    }
    expect(inked).toBeGreaterThan(png.width * png.height * 0.4);
    // The viewBox is the silhouette's box (0 6.68 40 34.64) spread over the picture.
    const at = (x: number, y: number) => png.pixel((x / 40) * png.width, ((y - 6.6795) / 34.641) * png.height)[3];
    expect(at(12, 24)).toBe(255); // the left of the cube: solid
    expect(at(30.15, 24.26)).toBe(0); // the doorway: clear
    expect(at(0.5, 8)).toBe(0); // outside the hexagon's corner
  });
});
