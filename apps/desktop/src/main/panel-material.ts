import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The quick chat panel's material: macOS's frosted vibrancy behind each of the panel's shapes, cut to
 * its outline (native/PanelMaterial.m).
 *
 * The page measures its shapes and sends them here; this turns them into the module's terms and
 * holds them to the window. Electron-free apart from the loader, so the sizing is a unit test's.
 */

/** A shape as the page measures it, in CSS pixels from the viewport's top-left. */
export type PageShape = { x: number; y: number; width: number; height: number; radius: number; squircle?: boolean; alpha?: number };

/** A shape as the module takes it: points from the view's left and bottom edges. */
type MaterialShape = { x: number; bottom: number; width: number; height: number; radius: number; squircle: boolean; alpha: number };

/** The panel draws four shapes at most (the card, the answer, the bar, the toolbar). A longer list is a
 *  page bug, and is cut rather than drawn. */
const MOST_SHAPES = 8;

/**
 * The shapes to cut, from what the page measured in a viewport `viewportHeight` tall. Each is measured
 * from the BOTTOM, because main grows the window upward with its bottom edge held, and the module
 * keeps a shape's distance from the bottom when the window changes size: a shape sent before a resize
 * lands where the page will lay it after. Edges go to whole points (the rim the page draws sits on
 * them), nothing pokes past the window, a radius never passes half the short side, and a shape with
 * no area or a non-finite number is dropped rather than drawn as a sliver.
 */
export function materialShapes(shapes: readonly PageShape[], viewportHeight: number, viewportWidth: number): MaterialShape[] {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(viewportWidth) || viewportHeight <= 0 || viewportWidth <= 0) return [];
  const out: MaterialShape[] = [];
  for (const s of shapes.slice(0, MOST_SHAPES)) {
    if (![s.x, s.y, s.width, s.height, s.radius].every(Number.isFinite)) continue;
    const left = Math.max(0, Math.round(s.x));
    const top = Math.max(0, Math.round(s.y));
    const right = Math.min(viewportWidth, Math.round(s.x + s.width));
    const bottomEdge = Math.min(viewportHeight, Math.round(s.y + s.height));
    const width = right - left;
    const height = bottomEdge - top;
    if (width <= 0 || height <= 0) continue;
    const alpha = s.alpha === undefined || !Number.isFinite(s.alpha) ? 1 : Math.min(1, Math.max(0, s.alpha));
    if (alpha === 0) continue;
    out.push({
      x: left, bottom: viewportHeight - bottomEdge, width, height,
      radius: Math.min(Math.max(0, s.radius), width / 2, height / 2),
      squircle: s.squircle === true, alpha,
    });
  }
  return out;
}

type Module = { setShapes(handle: Buffer, shapes: MaterialShape[], material: string): boolean };

let loaded: Module | null | undefined;

/** The module, beside the source in a dev build or a live check, else in the app's Resources. Null off
 *  macOS or where it was not built, and then the panel's shapes stand on the page's ground alone. */
export function panelMaterial(): Module | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "darwin") return loaded;
  const candidates = [join(__dirname, "../../native/bin/panelmaterial.node"), join(process.resourcesPath ?? "", "panelmaterial.node")];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return loaded;
  try {
    const module = { exports: {} as Module };
    process.dlopen(module, path);
    loaded = module.exports;
  } catch (e) {
    console.warn("[panel-material] failed to load:", (e as Error).message);
  }
  return loaded;
}
