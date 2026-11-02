/** The eight silhouettes, on a 64-unit square, and where on each the eyes sit.
 *
 *  A shape is flat primitives in one fill — circles and closed paths — so a union of them is drawn by
 *  simply overlapping them: a cloud is its bumps, a flower its petals. Each is sized by eye for the same
 *  optical mass as the circle, not to the same box: a triangle filling the square would read twice as
 *  heavy as the pill beside it. `face` is the point the pair of eyes is centred on, set up and to the
 *  right of the mass's middle, where the recipe puts it. */
export const TEAMMATE_SHAPES = {
  circle: "Circle",
  flower: "Flower",
  squircle: "Rounded square",
  pill: "Pill",
  triangle: "Triangle",
  hexagon: "Hexagon",
  cloud: "Cloud",
  drop: "Drop",
} as const;

export type TeammateShape = keyof typeof TEAMMATE_SHAPES;

export type Prim = { circle: [cx: number, cy: number, r: number] } | { d: string };
export type ShapeGeo = { prims: Prim[]; face: [number, number] };

type Pt = [number, number];
const f = (n: number) => Number(n.toFixed(2));
const C = 32;

function rotate([x, y]: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [C + (x - C) * c - (y - C) * s, C + (x - C) * s + (y - C) * c];
}

/** A polygon with every corner rounded by a true arc of radius `r`. */
function roundedPolygon(v: Pt[], r: number): string {
  const n = v.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = v[(i + n - 1) % n]!, q = v[i]!, nx = v[(i + 1) % n]!;
    const u1 = [p[0] - q[0], p[1] - q[1]], u2 = [nx[0] - q[0], nx[1] - q[1]];
    const l1 = Math.hypot(u1[0]!, u1[1]!), l2 = Math.hypot(u2[0]!, u2[1]!);
    const angle = Math.acos((u1[0]! * u2[0]! + u1[1]! * u2[1]!) / (l1 * l2));
    const t = r / Math.tan(angle / 2);
    const a: Pt = [q[0] + (u1[0]! / l1) * t, q[1] + (u1[1]! / l1) * t];
    const b: Pt = [q[0] + (u2[0]! / l2) * t, q[1] + (u2[1]! / l2) * t];
    const sweep = u1[0]! * u2[1]! - u1[1]! * u2[0]! < 0 ? 1 : 0;
    d += `${i === 0 ? "M" : "L"}${f(a[0])} ${f(a[1])}A${r} ${r} 0 0 ${sweep} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d}Z`;
}

function regular(sides: number, radius: number, startDeg: number, cy = C): Pt[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = ((startDeg + (360 / sides) * i) * Math.PI) / 180;
    return [C + radius * Math.cos(a), cy + radius * Math.sin(a)] as Pt;
  });
}

/** A superellipse, sampled finely enough that no facet survives at 64px. */
function squircle(half: number, n: number, deg: number): string {
  const pts: Pt[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    pts.push(rotate([C + half * Math.sign(c) * Math.abs(c) ** (2 / n), C + half * Math.sign(s) * Math.abs(s) ** (2 / n)], deg));
  }
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
}

/** A capsule from its two cap centres. */
function capsule(a: Pt, b: Pt, r: number): string {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  return `M${f(a[0] + nx)} ${f(a[1] + ny)}L${f(b[0] + nx)} ${f(b[1] + ny)}A${r} ${r} 0 0 0 ${f(b[0] - nx)} ${f(b[1] - ny)}`
    + `L${f(a[0] - nx)} ${f(a[1] - ny)}A${r} ${r} 0 0 0 ${f(a[0] + nx)} ${f(a[1] + ny)}Z`;
}

/** A drop: a round belly and two straight sides tangent to it, meeting at a softened tip. */
function drop(tip: Pt, centre: Pt, r: number, tipR: number): string {
  const dx = centre[0] - tip[0], dy = centre[1] - tip[1], dist = Math.hypot(dx, dy);
  const half = Math.asin(r / dist), base = Math.atan2(dy, dx), reach = Math.sqrt(dist * dist - r * r);
  const along = (a: number, d: number): Pt => [tip[0] + Math.cos(a) * d, tip[1] + Math.sin(a) * d];
  const right = along(base - half, reach), left = along(base + half, reach);
  const t = tipR / Math.tan(half);
  const a = along(base + half, t), b = along(base - half, t);
  return `M${f(a[0])} ${f(a[1])}A${tipR} ${tipR} 0 0 1 ${f(b[0])} ${f(b[1])}L${f(right[0])} ${f(right[1])}`
    + `A${r} ${r} 0 1 1 ${f(left[0])} ${f(left[1])}Z`;
}

export const SHAPE_GEO: Record<TeammateShape, ShapeGeo> = {
  circle: { prims: [{ circle: [32, 32, 27] }], face: [34, 29] },
  flower: {
    prims: [
      { circle: [32, 32, 17] },
      ...regular(5, 15.5, -90).map(([x, y]) => ({ circle: [f(x), f(y), 12.5] as [number, number, number] })),
    ],
    face: [33.5, 30.5],
  },
  squircle: { prims: [{ d: squircle(25, 4.6, -8) }], face: [34, 29.5] },
  pill: { prims: [{ d: capsule(rotate([20, 32], -12), rotate([44, 32], -12), 17.5) }], face: [33, 30] },
  triangle: { prims: [{ d: roundedPolygon(regular(3, 38, -90 - 6, 38), 10) }], face: [31.5, 36.5] },
  hexagon: { prims: [{ d: roundedPolygon(regular(6, 29, -90 + 8), 7) }], face: [34, 30] },
  cloud: {
    prims: [
      { d: capsule([17, 41], [47, 41], 14) },
      { circle: [23, 31, 12] },
      { circle: [37.5, 26.5, 15.5] },
      { circle: [49, 37, 10] },
    ],
    face: [35, 35],
  },
  drop: { prims: [{ d: drop(rotate([32, 4], -18), rotate([32, 39], -18), 21, 4) }], face: [32.5, 36.5] },
};
