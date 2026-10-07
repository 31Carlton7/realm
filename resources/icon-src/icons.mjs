// Realm's app icon and the eight Dock alternates Settings offers, as vector artwork: the source every
// size of every one of them is rendered from (render.mjs).
//
// One drawing in nine colourings: the mark (mark.mjs) on a body on the macOS icon grid, and the shadow
// the grid gives it. The body and the shadow are macOS's own, measured on this Mac (macOS 27) rather
// than remembered from an older template; shape.swift is the measurement and says how to repeat it.
//
// The finish is calm on purpose. The set used to be generated pictures (GPT Image, through Codex) —
// puffy bodies under a bright bevel, marks in chrome and candy plastic — that outshone every icon
// beside them. Now: a body graded top to bottom, the mark's three matte faces, and one short shadow.
// macOS lays its own glass edge over every app icon it draws from a bundle, so the bundle's artwork
// carries none; a picture handed straight to the Dock or drawn in Settings gets a copy of that edge
// (`glass`), so it sits in the Dock the way the bundle's icon does.
import { MARK, MARK_BOX, markLayer } from "./mark.mjs";

/** The grid: a 1024 canvas, the body 824 px square at (100, 100). Apple's macOS app icon template, and
 *  where macOS itself draws every app's body (measured on Finder, Mail, Terminal and the rest). */
const CANVAS = 1024;
const BODY = 824;
const ORIGIN = (CANVAS - BODY) / 2;

/**
 * The body's corner: Apple's continuous corner — the curve UIKit and SwiftUI draw for
 * `RoundedRectangle(cornerRadius:style: .continuous)` — at the radius macOS 27 draws app icons with.
 *
 * Neither a circular radius nor a superellipse: those miss the system's own edge by up to 55 and 21 px
 * at 1024. The curve's control points are SwiftUI's, read off `Path(roundedRect:cornerRadius:style:)`
 * on this Mac (shape.swift prints it). The radius is fitted to the body macOS renders for its own
 * apps: at 214.5 px the two edges lie within 0.15 px of each other along their whole length.
 */
const RADIUS = 214.5;
/** One corner of the continuous rounded rectangle, in multiples of the radius from the corner: where
 *  it leaves the straight edge, then three cubics as [control, control, end]. */
const CONTINUOUS = {
  start: [0, 1.528665],
  curves: [
    [[0, 1.08849], [0, 0.868407], [0.074911, 0.631494]],
    [[0.16906, 0.372824], [0.372824, 0.16906], [0.631494, 0.074911]],
    [[0.868407, 0], [1.08849, 0], [1.528665, 0]],
  ],
};

/** macOS's own icon shadow, fitted at 1024 to every pixel outside the body it draws for Finder: 24.8%
 *  black, 8 px down, a Gaussian of 14.75 px. macOS draws it again over a bundle's icon, so here it
 *  matters to the pictures handed straight to the Dock and to Settings. */
const SHADOW = { opacity: 0.248, dy: 8, blur: 14.75 };
/**
 * macOS's glass edge, for the pictures it does not draw itself: a specular line just inside the body,
 * strongest along the top, a little less along the bottom, and a faint shade down the sides. Fitted by
 * eye and by profile to what macOS does to a plain grey body (it is not a linear blend, so a vector can
 * only come close: within 7/255 rms along the edge).
 */
const GLASS = { width: 12, blur: 2.5, top: 1, bottom: 0.72, tail: 0.08, side: 0.16 };
/** Grid px per mark unit: the mark is its box's full 40 units across, so 560 px, 68% of the body. */
const MARK_SCALE = 14;
/** The mark's own shadow, in mark units: enough to lift it off the body, not to float it. */
const LIFT = { dy: 0.55, blur: 0.8 };
/** A sticker's die-cut margin round the mark, in mark units (the stroke is half outside). */
const OUTLINE = 3.4;

/**
 * Every icon, in the order Settings offers them; `default` is also the bundle's own. `ground` runs top
 * to bottom (`angle` turns it); each of the mark's faces runs between two tones, `lit` is the
 * doorway's lit back, and `lift` is the colour and strength of the shadow the mark casts on the body.
 */
export const ICONS = [
  {
    id: "default",
    ground: ["#33353a", "#151619"],
    mark: { top: ["#fbfbfc", "#eceef0"], left: ["#c3c7cc", "#aeb2b8"], right: ["#7d828a", "#676b73"], lit: ["#ffffff", "#f3f4f6"] },
    lift: ["#000000", 0.45],
  },
  {
    id: "indigo",
    ground: ["#544bf3", "#331cb2"],
    mark: { top: ["#f1f0fb", "#e1e0f4"], left: ["#b9b6e0", "#a4a1d4"], right: ["#6c68a8", "#5a5698"], lit: ["#ffffff", "#f4f3fd"] },
    lift: ["#140a5c", 0.45],
  },
  {
    id: "clay",
    ground: ["#f8f8f6", "#e5e5e1"],
    mark: { top: ["#ff9c8f", "#ff8576"], left: ["#6f8fff", "#5a7bfb"], right: ["#4560ee", "#3a50dc"], lit: ["#ffffff", "#fff4f2"] },
    lift: ["#6e6a62", 0.3],
  },
  {
    id: "frost",
    ground: ["#f3f7fd", "#d8e3f3"],
    mark: { top: ["#b9c8ff", "#a6b6ff"], left: ["#8e9fff", "#7b8cf8"], right: ["#5a52e0", "#4d45d4"], lit: ["#ffffff", "#f2f4ff"] },
    lift: ["#3d4f86", 0.3],
  },
  {
    id: "smoke",
    ground: ["#28344b", "#0c1322"],
    mark: { top: ["#ffffff", "#f1f5fb"], left: ["#ccd6e6", "#b9c5d9"], right: ["#8796b2", "#74839f"], lit: ["#ffffff", "#eef3fb"] },
    lift: ["#000000", 0.5],
  },
  {
    id: "sticker",
    ground: ["#ff7f8e", "#c03ee6", "#6b35ea"], angle: 45,
    mark: { top: ["#ffc4d6", "#ffb0c8"], left: ["#c69bff", "#b386fb"], right: ["#8a4fee", "#7a42e2"], lit: ["#ffffff", "#fff2f7"] },
    outline: "#ffffff",
    lift: ["#43106b", 0.4],
  },
  {
    id: "ocean",
    ground: ["#4ad9ee", "#1a90de", "#0d4fbd"],
    mark: { top: ["#ffffff", "#f1fbfe"], left: ["#cbeaf5", "#b8e0ef"], right: ["#86bedb", "#74b0d0"], lit: ["#ffffff", "#f6fdff"] },
    lift: ["#06306e", 0.4],
  },
  {
    id: "ember",
    ground: ["#ffb12e", "#ff5b3b", "#e81f72"],
    mark: { top: ["#fffaf2", "#fff1de"], left: ["#fdd9b7", "#f8caa3"], right: ["#eda985", "#e29672"], lit: ["#ffffff", "#fff8ef"] },
    lift: ["#7a0d36", 0.35],
  },
  {
    id: "mint",
    ground: ["#d6f6e0", "#ade8c2"],
    mark: { top: ["#fff38f", "#ffe86c"], left: ["#9ce8b8", "#86dea6"], right: ["#55c785", "#47b876"], lit: ["#ffffff", "#fbfff4"] },
    lift: ["#2f7a4c", 0.36],
  },
];

const num = (n) => (Math.abs(n) < 5e-5 ? "0" : n.toFixed(4).replace(/\.?0+$/, ""));

/**
 * The body's outline: Apple's continuous rounded rectangle on the grid. Each corner is the same curve
 * turned a quarter at a time — written for the top left, mapped through the corner's own frame.
 */
export function bodyPath() {
  const lo = ORIGIN, hi = ORIGIN + BODY, r = RADIUS;
  const corners = [
    ([x, y]) => [lo + x * r, lo + y * r], // top left: leaves the left edge, joins the top
    ([x, y]) => [hi - y * r, lo + x * r], // top right
    ([x, y]) => [hi - x * r, hi - y * r], // bottom right
    ([x, y]) => [lo + y * r, hi - x * r], // bottom left
  ];
  const at = (p) => `${num(p[0])} ${num(p[1])}`;
  return corners.map((place, i) =>
    `${i === 0 ? "M" : "L"}${at(place(CONTINUOUS.start))}${CONTINUOUS.curves.map((c) => `C${c.map((p) => at(place(p))).join(" ")}`).join("")}`,
  ).join("") + "Z";
}

const stops = (colors) => colors.map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`).join("");

/** The ground's gradient line across the body: straight down, or turned clockwise by `angle`. */
function groundLine(angle = 0) {
  const a = (angle * Math.PI) / 180, c = CANVAS / 2, h = BODY / 2;
  const dx = Math.sin(a) * h, dy = Math.cos(a) * h;
  return `x1="${num(c - dx)}" y1="${num(c - dy)}" x2="${num(c + dx)}" y2="${num(c + dy)}"`;
}

/** The glass edge's three strokes, inside the body. */
function glassEdge() {
  const lo = ORIGIN, hi = ORIGIN + BODY;
  const y = `x1="0" y1="${lo}" x2="0" y2="${hi}" gradientUnits="userSpaceOnUse"`;
  return {
    defs: [
      `<clipPath id="inside"><use href="#body"/></clipPath>`,
      `<linearGradient id="glass-light" ${y}><stop offset="0" stop-color="#fff" stop-opacity="${GLASS.top}"/><stop offset=".2" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="${GLASS.bottom}"/></linearGradient>`,
      `<linearGradient id="glass-shade" ${y}><stop offset=".18" stop-color="#000" stop-opacity="0"/><stop offset=".3" stop-color="#000" stop-opacity="${GLASS.side}"/><stop offset=".7" stop-color="#000" stop-opacity="${GLASS.side}"/><stop offset=".82" stop-color="#000" stop-opacity="0"/></linearGradient>`,
      `<filter id="glass-line" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${GLASS.blur}"/></filter>`,
      `<filter id="glass-tail" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="5"/></filter>`,
    ],
    body: `<g clip-path="url(#inside)">`
      + `<use href="#body" fill="none" stroke="url(#glass-light)" stroke-width="${GLASS.width}" filter="url(#glass-line)"/>`
      + `<use href="#body" fill="none" stroke="url(#glass-light)" stroke-opacity="${GLASS.tail}" stroke-width="28" filter="url(#glass-tail)"/>`
      + `<use href="#body" fill="none" stroke="url(#glass-shade)" stroke-width="10" filter="url(#glass-line)"/></g>`,
  };
}

/** One icon as a 1024 px SVG on the macOS grid; `glass` adds the edge macOS gives a bundle's icon. */
export function iconSvg(icon, { glass = false } = {}) {
  const tx = CANVAS / 2 - (MARK_BOX.width / 2) * MARK_SCALE;
  const ty = CANVAS / 2 - (MARK_BOX.height / 2) * MARK_SCALE;
  const mark = markLayer(icon.mark, "mark-");
  const [liftColor, liftOpacity] = icon.lift;
  const edge = glass ? glassEdge() : { defs: [], body: "" };
  // A die-cut outline is the silhouette grown by a stroke, and the shadow is cast by the cut sticker.
  const cut = (color) => (icon.outline ? ` stroke="${color}" stroke-width="${OUTLINE}" stroke-linejoin="round"` : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<defs>
<path id="body" d="${bodyPath()}"/>
<linearGradient id="ground" ${groundLine(icon.angle)} gradientUnits="userSpaceOnUse">${stops(icon.ground)}</linearGradient>
<filter id="shadow" x="-15%" y="-15%" width="130%" height="135%"><feGaussianBlur stdDeviation="${SHADOW.blur}"/></filter>
<filter id="lift" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${LIFT.blur}"/></filter>
${mark.defs.join("\n")}
${edge.defs.join("\n")}
</defs>
<use href="#body" fill="#000000" fill-opacity="${SHADOW.opacity}" transform="translate(0 ${SHADOW.dy})" filter="url(#shadow)"/>
<use href="#body" fill="url(#ground)"/>
<g transform="translate(${num(tx)} ${num(ty)}) scale(${MARK_SCALE})">
<path d="${MARK.silhouette}" fill="${liftColor}" fill-opacity="${liftOpacity}"${cut(liftColor)} transform="translate(0 ${LIFT.dy})" filter="url(#lift)"/>
${icon.outline ? `<path d="${MARK.silhouette}" fill="${icon.outline}"${cut(icon.outline)}/>` : ""}
${mark.body.join("\n")}
</g>
${edge.body}
</svg>
`;
}
