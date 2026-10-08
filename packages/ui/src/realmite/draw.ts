import { colours, type Colours, type Face } from "./parts";
import { hashSeed, type RealmiteSpec, type RealmiteState } from "./spec";

/** One drawing, two outputs. The geometry is built once as a small element tree; `Realmite.tsx`
 *  turns it into React elements and `realmiteSvg` into markup (for a gallery, a mock, or a test that
 *  runs without a DOM). Nothing here fetches or references an outside asset.
 *
 *  Everything is laid out on a 64-unit square: the ground line at y 58, the body centred on x 32,
 *  and the band above the body left for what it wears. */
export type SvgNode = { tag: string; attrs: Record<string, string | number>; children?: SvgNode[]; text?: string };

/** How much of the drawing survives at a size. A 16px row has room for a silhouette and two eyes;
 *  a mouth there is one pixel of noise, a pattern a smudge. Detail comes back in two steps. */
export type Detail = "tiny" | "small" | "full";
export const detailFor = (size: number): Detail => (size < 20 ? "tiny" : size < 40 ? "small" : "full");

/** Whether the creature moves at this size in this state. A row's status dot already animates
 *  beside a 16px Realmite, so at row size it holds still; working and needs-you move from 24px; idle
 *  — which is ambient and nothing else — only at 48 and up, where the creature is the subject. */
export function animatesAt(size: number, state: RealmiteState): boolean {
  if (size < 24) return false;
  return state === "idle" ? size >= 48 : true;
}

type Pt = [number, number];
type BodyGeo = { pts: Pt[]; d: string; cx: number; top: number; bottom: number; a: number; b: number; cy: number };
type FaceGeo = { y: number; gap: number; e: number };

const CX = 32;
const GROUND = 58;
const f = (n: number) => Number(n.toFixed(2));

function pathOf(pts: Pt[]): string {
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
}

/** A superellipse with its own exponent above and below the middle — round crown, flatter seat — and
 *  an optional narrowing toward the top. One formula covers six of the seven bodies. */
function blob(a: number, b: number, nTop: number, nBot: number, taper = 0): BodyGeo {
  const cy = GROUND - b;
  const pts: Pt[] = [];
  const N = 160;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const n = s < 0 ? nTop : nBot;
    let x = a * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = b * Math.sign(s) * Math.abs(s) ** (2 / n);
    if (s < 0) x *= 1 - taper * (-s) ** 1.5;
    pts.push([CX + x, cy + y]);
  }
  return { pts, d: pathOf(pts), cx: CX, top: cy - b, bottom: GROUND, a, b, cy };
}

/** The mark's own silhouette — a hexagon flat on its top and its seat — with its corners rounded
 *  for something that has to be held rather than read. */
function cube(): BodyGeo {
  const a = 23, b = 20, cy = GROUND - b;
  const v: Pt[] = [[CX - a, cy], [CX - a / 2, cy - b], [CX + a / 2, cy - b], [CX + a, cy], [CX + a / 2, cy + b], [CX - a / 2, cy + b]];
  const r = 7;
  const pts: Pt[] = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[(i + v.length - 1) % v.length]!, q = v[i]!, n = v[(i + 1) % v.length]!;
    const lp = Math.hypot(p[0] - q[0], p[1] - q[1]), ln = Math.hypot(n[0] - q[0], n[1] - q[1]);
    const t1: Pt = [q[0] + ((p[0] - q[0]) * r) / lp, q[1] + ((p[1] - q[1]) * r) / lp];
    const t2: Pt = [q[0] + ((n[0] - q[0]) * r) / ln, q[1] + ((n[1] - q[1]) * r) / ln];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      pts.push([
        (1 - t) ** 2 * t1[0] + 2 * (1 - t) * t * q[0] + t * t * t2[0],
        (1 - t) ** 2 * t1[1] + 2 * (1 - t) * t * q[1] + t * t * t2[1],
      ]);
    }
  }
  return { pts, d: pathOf(pts), cx: CX, top: cy - b, bottom: GROUND, a, b, cy };
}

const BODY_GEO: Record<RealmiteSpec["body"], () => BodyGeo> = {
  cube,
  squircle: () => blob(22, 20, 4, 4),
  gumdrop: () => blob(22, 22.5, 2.1, 4.5),
  bean: () => blob(17.5, 24, 2.6, 2.6),
  mochi: () => blob(25, 16.5, 2.3, 3.6),
  egg: () => blob(20.5, 23.5, 2.1, 2.3, 0.12),
  drop: () => blob(21, 23.5, 1.35, 2.2),
};

const geoCache = new Map<string, BodyGeo>();
function bodyGeo(id: RealmiteSpec["body"]): BodyGeo {
  let g = geoCache.get(id);
  if (!g) geoCache.set(id, (g = BODY_GEO[id]()));
  return g;
}

/** Half the body's width at a height — where an ear or a headphone cup has to sit. */
function halfWidthAt(g: BodyGeo, y: number): number {
  let best = 0;
  for (let i = 0; i < g.pts.length; i++) {
    const [x1, y1] = g.pts[i]!, [x2, y2] = g.pts[(i + 1) % g.pts.length]!;
    if ((y1 - y) * (y2 - y) > 0 || y1 === y2) continue;
    const x = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
    best = Math.max(best, Math.abs(x - g.cx));
  }
  return best;
}

/** Big eyes set below the middle and close together over a small mouth: the proportions that read
 *  as young and friendly (the baby schema), and the reason the face sits low on every body. */
function faceGeo(id: RealmiteSpec["body"], g: BodyGeo): FaceGeo {
  const e = id === "mochi" ? 3.2 : 3.4;
  const gap = Math.min(9.5, Math.max(6.8, g.a * 0.4));
  const lift = id === "mochi" ? 0.05 : id === "bean" || id === "egg" || id === "drop" ? 0.2 : 0.16;
  return { y: g.cy + g.b * lift, gap, e };
}

const el = (tag: string, attrs: Record<string, string | number>, children?: SvgNode[]): SvgNode =>
  children ? { tag, attrs, children } : { tag, attrs };

export type DrawOptions = {
  size: number;
  state?: RealmiteState;
  /** Unique within the document: it names the clip path. */
  uid: string;
  /** Force one face's colours. Left out, the drawing follows the nearest `[data-mode]`. */
  face?: Face;
  /** An accessible name. Left out, the drawing is decorative and hidden from assistive tech. */
  title?: string;
};

const COLOUR_KEYS = ["body", "shade", "light", "ink", "white", "blush", "wear", "wearLight", "leaf"] as const satisfies readonly (keyof Colours)[];

export function drawRealmite(spec: RealmiteSpec, opts: DrawOptions): SvgNode {
  const state = opts.state ?? "idle";
  const detail = detailFor(opts.size);
  const g = bodyGeo(spec.body);
  const face = faceGeo(spec.body, g);
  const clip = `${opts.uid}-clip`;
  const clipped = (children: SvgNode[]) => el("g", { "clip-path": `url(#${clip})` }, children);

  const behind: SvgNode[] = [];
  const over: SvgNode[] = [];
  drawAccessory(spec, g, face, detail, behind, over, clipped);

  const inside: SvgNode[] = [];
  if (detail !== "tiny") inside.push(...drawPattern(spec, g, face));
  if (detail === "full") {
    inside.push(el("ellipse", {
      class: "rmt-c-white", "fill-opacity": 0.22, cx: f(g.cx - g.a * 0.45), cy: f(g.cy - g.b * 0.52), rx: f(g.a * 0.17), ry: f(g.b * 0.09),
      transform: `rotate(-32 ${f(g.cx - g.a * 0.45)} ${f(g.cy - g.b * 0.52)})`,
    }));
  }

  const figure: SvgNode[] = [
    ...behind,
    el("path", { class: "rmt-c-body", d: g.d }),
    ...(inside.length ? [clipped(inside)] : []),
    ...drawFace(spec, face, detail, state, clipped),
    ...over,
  ];

  const pose = state === "working"
    ? `rotate(-3 ${CX} ${GROUND})`
    : state === "sleeping"
      ? `translate(${CX} ${GROUND}) scale(1.03 0.95) translate(${-CX} ${-GROUND})`
      : undefined;

  const marks: SvgNode[] = [];
  if (state === "needs-you" && detail !== "tiny") {
    marks.push(el("g", { class: "rmt-badge" }, [
      el("circle", { class: "rmt-c-wait", cx: 54, cy: 11, r: detail === "full" ? 7 : 8 }),
      ...(detail === "full" ? [
        el("rect", { class: "rmt-c-white", x: 53, y: 6.2, width: 2, height: 6.2, rx: 1 }),
        el("circle", { class: "rmt-c-white", cx: 54, cy: 15, r: 1.15 }),
      ] : []),
    ]));
  }
  if (state === "sleeping" && detail === "full") {
    marks.push(el("g", { class: "rmt-z" }, [
      el("path", { class: "rmt-s-quiet", d: "M47 9L53 9L47 16L53 16", "stroke-width": 1.8 }),
      el("path", { class: "rmt-s-quiet", d: "M56 2L60 2L56 6.6L60 6.6", "stroke-width": 1.4 }),
    ]));
  }

  const c = { dark: colours(spec.palette, "dark"), light: colours(spec.palette, "light") };
  const vars = COLOUR_KEYS.flatMap((k) => [`--rmt-${k}-d:${c.dark[k]}`, `--rmt-${k}-l:${c.light[k]}`]);
  const h = hashSeed(spec.seed);
  vars.push(`--rmt-eye-y:${f(face.y)}px`, `--rmt-blink:${f(4.2 + (h % 1000) / 385)}s`, `--rmt-phase:-${f(((h >>> 10) % 1000) / 160)}s`);

  const attrs: Record<string, string | number> = {
    xmlns: "http://www.w3.org/2000/svg",
    class: "rmt",
    viewBox: detail === "tiny" ? "6 5 52 52" : "0 0 64 64",
    width: opts.size,
    height: opts.size,
    "data-state": state,
    "data-detail": detail,
    style: vars.join(";"),
  };
  if (opts.face) attrs["data-face"] = opts.face;
  if (animatesAt(opts.size, state)) attrs["data-animate"] = "";
  if (opts.title) {
    attrs.role = "img";
    attrs["aria-label"] = opts.title;
  } else attrs["aria-hidden"] = "true";

  return el("svg", attrs, [
    el("defs", {}, [el("clipPath", { id: clip }, [el("path", { d: g.d })])]),
    el("g", { class: "rmt-fig" }, [el("g", pose ? { class: "rmt-pose", transform: pose } : { class: "rmt-pose" }, figure)]),
    ...marks,
  ]);
}

function drawPattern(spec: RealmiteSpec, g: BodyGeo, face: FaceGeo): SvgNode[] {
  const { cx, cy, a, b, top, bottom } = g;
  switch (spec.pattern) {
    case "none": return [];
    case "belly":
    {
      /* A chest the mouth sits on and the eyes sit just above, as a penguin's does. */
      const cyB = bottom + b * 0.15;
      return [el("ellipse", { class: "rmt-c-light", cx, cy: f(cyB), rx: f(a * 0.82), ry: f(cyB - (face.y + face.e * 1.35)) })];
    }
    case "facet": {
      /* The mark's wall: a plane a shade darker down the right side, its edge leaning as the cube's do. */
      const xt = cx + a * 0.42, xb = cx + a * 0.16;
      return [el("path", { class: "rmt-c-shade", d: `M${f(xt)} ${f(top - 4)}L${f(cx + a + 6)} ${f(top - 4)}L${f(cx + a + 6)} ${f(bottom + 4)}L${f(xb)} ${f(bottom + 4)}Z` })];
    }
    case "spots":
      return [
        el("circle", { class: "rmt-c-shade", cx: f(cx - a * 0.58), cy: f(cy - b * 0.5), r: 2.8 }),
        el("circle", { class: "rmt-c-shade", cx: f(cx + a * 0.5), cy: f(cy - b * 0.66), r: 3.4 }),
        el("circle", { class: "rmt-c-shade", cx: f(cx + a * 0.8), cy: f(cy + b * 0.38), r: 2.4 }),
        el("circle", { class: "rmt-c-shade", cx: f(cx - a * 0.78), cy: f(cy + b * 0.52), r: 2 }),
      ];
    case "stripes":
      return [-6.5, 0, 6.5].map((dx) => el("rect", {
        class: "rmt-c-shade", x: f(cx + dx - 1.4), y: f(top - 3), width: 2.8, height: dx === 0 ? 10.5 : 8, rx: 1.4,
      }));
    case "faceplate":
      return [el("rect", {
        class: "rmt-c-light", x: f(cx - face.gap - face.e * 2.3), y: f(face.y - face.e * 2.1),
        width: f(2 * (face.gap + face.e * 2.3)), height: f(face.e * 4.2), rx: f(face.e * 2.1),
      })];
  }
}

function drawFace(spec: RealmiteSpec, face: FaceGeo, detail: Detail, state: RealmiteState,
  clipped: (c: SvgNode[]) => SvgNode): SvgNode[] {
  const out: SvgNode[] = [];
  const { y, gap } = face;
  const e = face.e * (detail === "tiny" ? 1.32 : state === "needs-you" ? 1.1 : 1);
  const xs = spec.eyes === "cyclops" ? [CX] : [CX - gap, CX + gap];

  if (spec.cheeks && detail !== "tiny" && state !== "sleeping") {
    out.push(clipped([-1, 1].map((s) => el("ellipse", {
      class: "rmt-c-blush", cx: f(CX + s * (gap + face.e * 1.7)), cy: f(y + face.e * 1.35), rx: f(face.e * 1.2), ry: f(face.e * 0.72),
    }))));
  }

  const eyes: SvgNode[] = [];
  const sw = f(face.e * (detail === "full" ? 0.6 : 0.8));
  if (state === "sleeping") {
    const w = spec.eyes === "cyclops" ? e * 1.9 : e * 1.15;
    for (const x of xs) {
      eyes.push(el("path", { class: "rmt-s-ink", "stroke-width": sw, d: `M${f(x - w)} ${f(y)}Q${f(x)} ${f(y + w * 0.85)} ${f(x + w)} ${f(y)}` }));
    }
    out.push(el("g", { class: "rmt-eyes" }, eyes));
  } else {
    const look: [number, number] = state === "working" ? [e * 0.55, e * 0.22] : [0, 0];
    const shine = (x: number, cy: number, r: number) =>
      detail === "tiny" ? [] : [el("circle", { class: "rmt-c-white", cx: f(x - r * 0.32), cy: f(cy - r * 0.36), r: f(r * 0.36) })];
    if (spec.eyes === "cyclops") {
      const r = e * 2.25, cy = y - e * 0.3;
      eyes.push(el("circle", { class: "rmt-c-white", cx: CX, cy: f(cy), r: f(r) }));
      eyes.push(el("g", { class: "rmt-look", ...(look[0] ? { transform: `translate(${f(look[0] * 1.4)} ${f(look[1])})` } : {}) }, [
        el("circle", { class: "rmt-c-ink", cx: CX, cy: f(cy), r: f(r * 0.55) }),
        ...shine(CX, cy, r * 0.55),
      ]));
    } else {
      const shapes: SvgNode[] = [];
      for (const x of xs) {
        switch (spec.eyes) {
          case "dot": shapes.push(el("circle", { class: "rmt-c-ink", cx: f(x), cy: f(y), r: f(e) })); break;
          case "bean": shapes.push(el("ellipse", { class: "rmt-c-ink", cx: f(x), cy: f(y), rx: f(e * 0.78), ry: f(e * 1.3) })); break;
          case "shine":
            shapes.push(el("circle", { class: "rmt-c-ink", cx: f(x), cy: f(y), r: f(e * 1.2) }), ...shine(x, y, e * 1.2));
            break;
          case "lidded": {
            const r = e * 1.2, top = y - r * 0.2;
            shapes.push(el("path", { class: "rmt-c-ink", d: `M${f(x - r)} ${f(top)}A${f(r)} ${f(r)} 0 0 0 ${f(x + r)} ${f(top)}Z` }));
            break;
          }
        }
      }
      eyes.push(el("g", { class: "rmt-look", ...(look[0] ? { transform: `translate(${f(look[0])} ${f(look[1])})` } : {}) }, shapes));
    }
    out.push(el("g", { class: "rmt-eyes" }, eyes));
  }

  if (detail !== "tiny") out.push(...drawMouth(spec, face, sw, state));
  return out;
}

function drawMouth(spec: RealmiteSpec, face: FaceGeo, sw: number, state: RealmiteState): SvgNode[] {
  const e = face.e;
  const x = CX;
  const y = face.y + (spec.eyes === "cyclops" ? e * 2.75 : e * 1.9);
  const stroke = (d: string) => el("path", { class: "rmt-s-ink", "stroke-width": sw, d });
  /* Asleep, every mouth is the same small line: the open and fanged ones are awake expressions. */
  const mouth = state === "sleeping" && spec.mouth !== "none" ? "flat" : spec.mouth;
  switch (mouth) {
    case "none": return [];
    case "smile": return [stroke(`M${f(x - e * 0.85)} ${f(y)}Q${f(x)} ${f(y + e * 1.05)} ${f(x + e * 0.85)} ${f(y)}`)];
    case "cat": return [stroke(`M${f(x - e * 1.25)} ${f(y)}Q${f(x - e * 0.62)} ${f(y + e * 0.95)} ${f(x)} ${f(y)}Q${f(x + e * 0.62)} ${f(y + e * 0.95)} ${f(x + e * 1.25)} ${f(y)}`)];
    case "open": {
      const w = e * 0.85, h = e * 1.45;
      return [
        el("path", { class: "rmt-c-ink", d: `M${f(x - w)} ${f(y)}L${f(x + w)} ${f(y)}Q${f(x + w)} ${f(y + h)} ${f(x)} ${f(y + h)}Q${f(x - w)} ${f(y + h)} ${f(x - w)} ${f(y)}Z` }),
        el("ellipse", { class: "rmt-c-tongue", cx: f(x), cy: f(y + h * 0.72), rx: f(w * 0.55), ry: f(h * 0.24) }),
      ];
    }
    case "flat": return [stroke(`M${f(x - e * 0.7)} ${f(y + e * 0.3)}L${f(x + e * 0.7)} ${f(y + e * 0.3)}`)];
    case "fang": {
      const sx = e * 0.95;
      // the tooth hangs from the smile's own curve, a little right of centre
      const tx = x + e * 0.38, ty = y + e * 0.43;
      return [
        el("path", { class: "rmt-c-white", d: `M${f(tx - e * 0.32)} ${f(ty - 0.1)}L${f(tx + e * 0.36)} ${f(ty - e * 0.12)}L${f(tx + e * 0.06)} ${f(ty + e * 0.72)}Z` }),
        stroke(`M${f(x - sx)} ${f(y)}Q${f(x)} ${f(y + e * 1.0)} ${f(x + sx)} ${f(y)}`),
      ];
    }
  }
}

function drawAccessory(spec: RealmiteSpec, g: BodyGeo, face: FaceGeo, detail: Detail, behind: SvgNode[], over: SvgNode[],
  clipped: (c: SvgNode[]) => SvgNode) {
  const { cx, top } = g;
  const full = detail === "full";
  switch (spec.accessory) {
    case "none": return;
    case "sprout": {
      /* What stands on the crown is shortened on the tall bodies, so it stays inside the square. */
      const lift = Math.min(7.6, top - 3.5);
      behind.push(el("path", { class: "rmt-s-leaf", "stroke-width": 2.2, d: `M${cx} ${top + 3}L${cx} ${f(top - lift + 1.6)}` }));
      for (const s of [-1, 1]) {
        const lx = cx + s * 4.6, ly = top - lift - (s > 0 ? 1 : 0);
        over.push(el("ellipse", { class: "rmt-c-leaf", cx: f(lx), cy: f(ly), rx: 4.6, ry: 2.5, transform: `rotate(${s * 28} ${f(lx)} ${f(ly)})` }));
      }
      return;
    }
    case "bobble": {
      const lift = Math.min(10.5, top - 4.6);
      behind.push(el("path", { class: "rmt-s-wear", "stroke-width": 2, d: `M${cx} ${top + 3}Q${cx - 2.5} ${f(top - lift * 0.4)} ${cx + 1.5} ${f(top - lift + 2)}` }));
      over.push(el("circle", { class: "rmt-c-wear", cx: cx + 2.2, cy: f(top - lift), r: 3.8 }));
      if (full) over.push(el("circle", { class: "rmt-c-white", "fill-opacity": 0.45, cx: cx + 1.1, cy: f(top - lift - 1.2), r: 1.2 }));
      return;
    }
    case "beanie": {
      const edge = face.y - face.e * 2.1;
      over.push(clipped([
        el("rect", { class: "rmt-c-wear", x: 0, y: 0, width: 64, height: f(edge) }),
        el("rect", { class: "rmt-c-wearLight", x: 0, y: f(edge - 4.2), width: 64, height: 4.2 }),
      ]));
      over.push(el("circle", { class: "rmt-c-wearLight", cx, cy: f(top - 1.2), r: 3.9 }));
      return;
    }
    case "cap": {
      const edge = top + (face.y - face.e * 1.6 - top) * 0.62;
      const hw = halfWidthAt(g, edge);
      over.push(clipped([el("rect", { class: "rmt-c-wear", x: 0, y: 0, width: 64, height: f(edge) })]));
      /* The brim starts inside the crown and ends in a round nose, so it reads as attached at 24px. */
      const x0 = cx + hw * 0.2, x1 = cx + hw + 5;
      over.push(el("path", {
        class: "rmt-c-wearLight",
        d: `M${f(x0)} ${f(edge - 1.9)}L${f(x1)} ${f(edge - 1.9)}A1.9 1.9 0 0 1 ${f(x1)} ${f(edge + 1.9)}L${f(x0)} ${f(edge + 1.9)}Z`,
      }));
      over.push(el("circle", { class: "rmt-c-wearLight", cx, cy: f(top + 0.6), r: 1.7 }));
      return;
    }
    case "horns": {
      /* Short and curled outward, in the companion colour: never the body's, or they read as ears. */
      const hw = halfWidthAt(g, top + 3) * 0.5;
      for (const s of [-1, 1]) {
        const bx = cx + s * hw;
        behind.push(el("path", {
          class: "rmt-c-wearLight",
          d: `M${f(bx - 3.2 * s)} ${f(top + 5)}Q${f(bx - 2.6 * s)} ${f(top - 3.5)} ${f(bx + 5.6 * s)} ${f(top - 6.5)}Q${f(bx + 2.2 * s)} ${f(top - 1.5)} ${f(bx + 3.6 * s)} ${f(top + 5)}Z`,
        }));
      }
      return;
    }
    case "cat-ears":
    case "bear-ears": {
      const bear = spec.accessory === "bear-ears";
      const hw = halfWidthAt(g, top + 4) * (bear ? 0.72 : 0.6);
      for (const s of [-1, 1]) {
        const bx = cx + s * hw;
        if (bear) {
          behind.push(el("circle", { class: "rmt-c-body", cx: f(bx), cy: f(top + 2), r: 6.4 }));
          if (detail !== "tiny") behind.push(el("circle", { class: "rmt-c-shade", cx: f(bx), cy: f(top + 2.4), r: 3.3 }));
        } else {
          behind.push(el("path", { class: "rmt-c-body", d: `M${f(bx - 6.5)} ${f(top + 7)}L${f(bx + 1.2 * s - 1)} ${f(top - 9)}Q${f(bx + 1.4 * s)} ${f(top - 10)} ${f(bx + 2 * s)} ${f(top - 8.6)}L${f(bx + 6.5)} ${f(top + 7)}Z` }));
          if (detail !== "tiny") behind.push(el("path", { class: "rmt-c-shade", d: `M${f(bx - 3)} ${f(top + 3)}L${f(bx + 1.3 * s)} ${f(top - 5.2)}L${f(bx + 3.4)} ${f(top + 3)}Z` }));
        }
      }
      return;
    }
    case "headphones": {
      const ey = face.y - face.e * 0.4;
      const hw = halfWidthAt(g, ey);
      behind.push(el("path", {
        class: "rmt-s-wear", "stroke-width": 2.6,
        d: `M${f(cx - hw - 0.6)} ${f(ey)}C${f(cx - hw - 1)} ${f(top - 10)} ${f(cx + hw + 1)} ${f(top - 10)} ${f(cx + hw + 0.6)} ${f(ey)}`,
      }));
      for (const s of [-1, 1]) {
        over.push(el("rect", { class: "rmt-c-wear", x: f(cx + s * (hw + 0.4) - 3.2), y: f(ey - 5), width: 6.4, height: 10, rx: 3 }));
      }
      return;
    }
  }
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function serialize(node: SvgNode): string {
  const attrs = Object.entries(node.attrs).map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${esc(String(v))}"`)).join("");
  const inner = (node.children ?? []).map(serialize).join("") + (node.text ? esc(node.text) : "");
  return inner ? `<${node.tag}${attrs}>${inner}</${node.tag}>` : `<${node.tag}${attrs}/>`;
}

/** The whole Realmite as an SVG string. Pair it with `REALMITE_CSS` once on the page. */
export function realmiteSvg(spec: RealmiteSpec, opts: DrawOptions): string {
  return serialize(drawRealmite(spec, opts));
}
