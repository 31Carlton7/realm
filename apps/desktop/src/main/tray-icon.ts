import { join } from "node:path";

/**
 * The menu-bar item's picture: Realm's flat mark as a template image (resources/icon-src/render.mjs
 * draws it). macOS reads a template's alpha alone and paints it in the menu bar's own ink, so one file
 * is right on a light bar, a dark one and a tinted one. The `Template` suffix is what tells it so, and
 * the `@2x` beside it is found by name — so both names are load-bearing, and stage-pack copies both.
 */
export const TRAY_ICON = "trayTemplate.png";
export const TRAY_ICON_2X = "trayTemplate@2x.png";

/** Where the picture is: beside the app's own resources when packaged, in apps/desktop/resources in
 *  development (where `appPath` is apps/desktop). */
export function trayIconPath(d: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  return d.packaged ? join(d.resourcesPath, TRAY_ICON) : join(d.appPath, "resources", TRAY_ICON);
}
