import { useLayoutEffect, type RefObject } from "react";
import { bezelMap, type BezelShape } from "./bezel-lens";

/**
 * A lens fitted to one glass surface: its own displacement map (bezel-lens.ts) for its own size, held
 * as a `<filter>` in one hidden `<svg>` on the body, and named on the surface as `--glass-lens`, which
 * the stylesheet composes into its `backdrop-filter` (styles.css, "Glass"). How deep the bezel is, how
 * far it bends and how much it frosts are the surface's own tokens (`--glass-bezel`, `--glass-bend`,
 * `--glass-frost-px`), so each kind of surface is tuned in tokens.css rather than here.
 *
 * The frost is inside the filter, over the pane's ground, because Chromium lays a backdrop filter's
 * result OVER the backdrop rather than in place of it. On a see-through pane the backdrop is clear
 * between the words, so a CSS blur of it was a faint haze laid over the same words still sharp under
 * it: the transcript read straight through a 30px blur (measured 11-18). Flooding the pane's ground
 * under the backdrop first (`--glass-ground`, most of the way opaque) gives the blur something to
 * cover the words with; over a picture the canvas is opaque already and the flood changes nothing.
 *
 * Maps are cached by size and a filter lives while a surface uses it, so a picker opened twice draws
 * its map once and a closed one leaves nothing behind.
 */

const NS = "http://www.w3.org/2000/svg";
const MAPS_KEPT = 32;
const maps = new Map<string, string>();
const filters = new Map<string, { el: SVGFilterElement; users: number }>();
let defs: SVGSVGElement | null = null;

type Fit = BezelShape & { bend: number; frost: number };

function readFit(el: HTMLElement): Fit | null {
  const style = getComputedStyle(el);
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const bezel = parseFloat(style.getPropertyValue("--glass-bezel"));
  const bend = parseFloat(style.getPropertyValue("--glass-bend"));
  const frost = parseFloat(style.getPropertyValue("--glass-frost-px")) || 0;
  if (!(width > 0 && height > 0 && bezel > 0 && bend > 0)) return null;
  return { width, height, radius: parseFloat(style.borderTopLeftRadius) || 0, bezel, bend, frost };
}

const keyOf = (f: Fit) => `${f.width}x${f.height}r${f.radius}b${f.bezel}`;

function mapFor(f: Fit): string | null {
  const key = keyOf(f);
  const hit = maps.get(key);
  if (hit) { maps.delete(key); maps.set(key, hit); return hit; }
  const map = bezelMap(f);
  if (!map) return null;
  maps.set(key, map);
  if (maps.size > MAPS_KEPT) maps.delete(maps.keys().next().value!);
  return map;
}

function hold(f: Fit): string | null {
  const id = `rl-lens-${keyOf(f)}d${f.bend}f${f.frost}`.replace(/\./g, "_");
  const held = filters.get(id);
  if (held) { held.users += 1; return id; }
  const map = mapFor(f);
  if (!map) return null;
  if (!defs?.isConnected) {
    defs = document.createElementNS(NS, "svg");
    defs.setAttribute("class", "glass-defs");
    defs.setAttribute("aria-hidden", "true");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    document.body.append(defs);
  }
  const filter = document.createElementNS(NS, "filter");
  const set = (node: Element, attrs: Record<string, string | number>) => { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); };
  set(filter, { id, x: 0, y: 0, width: f.width, height: f.height, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
  const ground = document.createElementNS(NS, "feFlood");
  // The ground's colour and share are tokens, read as CSS so they follow the face without a redraw.
  ground.setAttribute("style", "flood-color: var(--glass-ground); flood-opacity: var(--glass-ground-alpha)");
  set(ground, { result: "ground" });
  const solid = document.createElementNS(NS, "feComposite");
  set(solid, { in: "SourceGraphic", in2: "ground", operator: "over", result: "solid" });
  filter.append(ground, solid);
  let bent = "solid";
  if (f.frost > 0) {
    const frost = document.createElementNS(NS, "feGaussianBlur");
    set(frost, { in: "solid", stdDeviation: f.frost, edgeMode: "duplicate", result: "frost" });
    filter.append(frost);
    bent = "frost";
  }
  const image = document.createElementNS(NS, "feImage");
  set(image, { href: map, x: 0, y: 0, width: f.width, height: f.height, preserveAspectRatio: "none", result: "map" });
  const bend = document.createElementNS(NS, "feDisplacementMap");
  // The map's full swing is ±127 of 255, so the scale is twice the bend at the rim.
  set(bend, { in: bent, in2: "map", scale: 2 * f.bend, xChannelSelector: "R", yChannelSelector: "G" });
  filter.append(image, bend);
  defs.append(filter);
  filters.set(id, { el: filter, users: 1 });
  return id;
}

function release(id: string) {
  const held = filters.get(id);
  if (!held) return;
  held.users -= 1;
  if (held.users > 0) return;
  held.el.remove();
  filters.delete(id);
}

/**
 * Fit a lens to `el` and keep it fitted as the box changes size. Until a map exists the surface names
 * none, and its `backdrop-filter` (which composes `var(--glass-lens, <frost>)`) falls back to a CSS frost.
 * Returns the cleanup.
 */
export function fitLens(el: HTMLElement): () => void {
  let id: string | null = null;
  const fit = () => {
    const f = readFit(el);
    const next = f ? hold(f) : null;
    if (id) release(id);
    id = next;
    if (id) el.style.setProperty("--glass-lens", `url(#${id})`);
    else el.style.removeProperty("--glass-lens");
  };
  fit();
  const watch = new ResizeObserver(fit);
  watch.observe(el);
  return () => {
    watch.disconnect();
    if (id) release(id);
    el.style.removeProperty("--glass-lens");
  };
}

/** `fitLens` for a component's surface, while `on` (glass is drawn). */
export function useFittedLens(ref: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    return fitLens(el);
  }, [ref, on]);
}

/** For tests: what the module holds. */
export const lensCache = { maps: () => maps.size, filters: () => filters.size };
