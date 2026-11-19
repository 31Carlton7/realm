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
 * under the backdrop first (`--glass-ground`) gives the blur something to cover the words with; over
 * a picture the canvas is opaque already and the flood changes nothing.
 *
 * How much ground goes under is the surface's too (`--glass-ground-share`): a picker over a pane of
 * words floods all the way, because whatever share of the result is clear shows the words through it
 * sharp; a segment or a knob over its own track floods none.
 *
 * Chromium 156 reads the blur's `stdDeviation` in device pixels inside a backdrop filter, while the
 * region and the bend are in CSS px (measured 11-18 on a 2x screen with bars under three boxes). So
 * the frost is scaled by the device pixel ratio here, or a 10px frost draws 5px on a Retina screen.
 *
 * Maps are cached by size and a filter lives while a surface uses it, so a picker opened twice draws
 * its map once and a closed one leaves nothing behind.
 */

const NS = "http://www.w3.org/2000/svg";
const MAPS_KEPT = 32;
const maps = new Map<string, string>();
const filters = new Map<string, { el: SVGFilterElement; users: number }>();
let defs: SVGSVGElement | null = null;

type Fit = BezelShape & { bend: number; frost: number; ground: number; dpr: number };

/** `pseudo` fits the lens to a pseudo-element's box (a switch's knob is its `::after`). */
function readFit(el: HTMLElement, pseudo?: string): Fit | null {
  const style = getComputedStyle(el);
  const box = pseudo ? getComputedStyle(el, pseudo) : style;
  const width = pseudo ? Math.round(parseFloat(box.width)) : el.offsetWidth;
  const height = pseudo ? Math.round(parseFloat(box.height)) : el.offsetHeight;
  const bezel = parseFloat(style.getPropertyValue("--glass-bezel"));
  const bend = parseFloat(style.getPropertyValue("--glass-bend"));
  const frost = parseFloat(style.getPropertyValue("--glass-frost-px")) || 0;
  const share = parseFloat(style.getPropertyValue("--glass-ground-share"));
  const ground = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  if (!(width > 0 && height > 0 && bezel > 0 && bend > 0)) return null;
  return { width, height, radius: Math.min(parseFloat(box.borderTopLeftRadius) || 0, width / 2, height / 2), bezel, bend, frost, ground, dpr: window.devicePixelRatio || 1 };
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
  const id = `rl-lens-${keyOf(f)}d${f.bend}f${f.frost}g${f.ground}x${f.dpr}`.replace(/\./g, "_");
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
  let bent = "SourceGraphic";
  if (f.ground > 0) {
    const ground = document.createElementNS(NS, "feFlood");
    // The ground's colour is a token, read as CSS so it follows the face without a redraw.
    ground.setAttribute("style", `flood-color: var(--glass-ground); flood-opacity: ${f.ground}`);
    set(ground, { result: "ground" });
    const solid = document.createElementNS(NS, "feComposite");
    set(solid, { in: "SourceGraphic", in2: "ground", operator: "over", result: "solid" });
    filter.append(ground, solid);
    bent = "solid";
  }
  if (f.frost > 0) {
    const frost = document.createElementNS(NS, "feGaussianBlur");
    set(frost, { in: bent, stdDeviation: f.frost * f.dpr, edgeMode: "duplicate", result: "frost" });
    filter.append(frost);
    bent = "frost";
  }
  const image = document.createElementNS(NS, "feImage");
  set(image, { href: map, x: 0, y: 0, width: f.width, height: f.height, preserveAspectRatio: "none", result: "map" });
  const bend = document.createElementNS(NS, "feDisplacementMap");
  // The map's full swing is ±127 of 255, so the scale is twice the bend at the rim.
  set(bend, { in: bent, in2: "map", scale: 2 * f.bend, xChannelSelector: "R", yChannelSelector: "G", result: "bent" });
  filter.append(image, bend);
  if (f.ground > 0) {
    // The blur and the bend both read past the box's edge, where the backdrop is clear, so the rim of
    // the result thins and the sharp words show through it; laid over the ground once more, it holds.
    const sealed = document.createElementNS(NS, "feComposite");
    set(sealed, { in: "bent", in2: "ground", operator: "over" });
    filter.append(sealed);
  }
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
 * Fit a lens to `el` (or to its `pseudo`-element's box) and keep it fitted as the box changes size,
 * the face changes (its tokens are per mode) or the window moves to a screen of another density.
 * Until a map exists the surface names none, and its `backdrop-filter` (which composes
 * `var(--glass-lens, <frost>)`) falls back to a CSS frost. Returns the cleanup.
 */
export function fitLens(el: HTMLElement, pseudo?: string): () => void {
  let id: string | null = null;
  let density: MediaQueryList | null = null;
  const fit = () => {
    const f = readFit(el, pseudo);
    const next = f ? hold(f) : null;
    if (id) release(id);
    id = next;
    if (id) el.style.setProperty("--glass-lens", `url(#${id})`);
    else el.style.removeProperty("--glass-lens");
    density?.removeEventListener?.("change", fit);
    density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
    density?.addEventListener?.("change", fit);
  };
  fit();
  const sized = new ResizeObserver(fit);
  sized.observe(el);
  const face = new MutationObserver(fit);
  face.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-clear-over-picture"] });
  return () => {
    sized.disconnect();
    face.disconnect();
    density?.removeEventListener?.("change", fit);
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

/**
 * The pressed controls that wear glass, which every page draws on its own (a segment, a switch), so
 * they are fitted from one place rather than in each of the components that draws one: each box
 * matching `controls` gets its lens, and loses it once it stops matching (a segment no longer
 * selected) or leaves the page. `pseudo` names the controls whose glass is a pseudo-element.
 *
 * Only element additions and the attributes that select a control are looked at, so a streamed reply
 * (text into a paragraph) never sets off a pass. Returns the cleanup.
 */
export function fitControls(controls: { selector: string; pseudo?: string }[]): () => void {
  const fitted = new Map<Element, () => void>();
  const all = controls.map((c) => c.selector).join(", ");
  let queued = 0;
  const pass = () => {
    queued = 0;
    const want = new Map<Element, string | undefined>();
    for (const c of controls) for (const el of document.querySelectorAll<HTMLElement>(c.selector)) want.set(el, c.pseudo);
    for (const [el, stop] of fitted) if (!want.has(el)) { stop(); fitted.delete(el); }
    for (const [el, pseudo] of want) if (!fitted.has(el)) fitted.set(el, fitLens(el as HTMLElement, pseudo));
  };
  const schedule = () => { queued ||= requestAnimationFrame(pass); };
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") return schedule();
      for (const n of r.addedNodes) if (n instanceof Element && (n.matches(all) || n.querySelector(all))) return schedule();
      for (const n of r.removedNodes) if (n instanceof Element && [...fitted.keys()].some((el) => n === el || n.contains(el))) return schedule();
    }
  });
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-selected", "aria-pressed", "class"] });
  pass();
  return () => {
    watch.disconnect();
    if (queued) cancelAnimationFrame(queued);
    for (const stop of fitted.values()) stop();
    fitted.clear();
  };
}

/** For tests: what the module holds. */
export const lensCache = { filters: () => filters.size };
