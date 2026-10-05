// Realm's app icon and the eight Dock alternates Settings offers, as vector artwork: the source every
// size of every one of them is rendered from (render.mjs).
//
// One drawing in nine colourings. The mark is mark.svg's own geometry, read from it rather than
// copied, so the icon and the logo cannot drift; what an icon adds is a body on the macOS grid (an
// 824 px continuous-corner square at (100, 100) of 1024), the light that falls on it, and the shadow
// the grid gives it.
//
// The light is the one macOS gives its own Dock icons, measured from Terminal, Mail, Messages and
// Finder: a body graded top to bottom, a soft glass edge just inside the rim, and one short, light
// shadow under it. Beyond that the set keeps a little light from above on the body and a glint on the
// mark's top edge, and nothing else shines. It used to be generated pictures (GPT Image, through
// Codex): puffy bodies under a bright bevel, marks in chrome and candy plastic, which in a Dock read
// louder than every icon beside them. Each colouring keeps its picture's identity, lit flat.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The grid: a 1024 canvas, the body 824 px square at (100, 100). */
const CANVAS = 1024;
const BODY = 824;
const ORIGIN = (CANVAS - BODY) / 2;
/** The body's corner: a superellipse |x|^n + |y|^n = 1. At n = 5 the edge sits within half a pixel of
 *  Terminal's (macOS's own shape, at 256 px) everywhere but the first few rows of the flat top. */
const N = 5;
/** Grid px per mark.svg unit: the mark is the viewBox's full 40 units across, so 560 px, 68% of the
 *  body, which is where the generated set's marks sat. */
const MARK_SCALE = 14;

/** macOS's own icon shadow, fitted to Terminal's alpha above and below its body. */
const SHADOW = { opacity: 0.23, dy: 9, blur: 17 };
/** The glass edge: a white line just inside the rim, blurred inward. macOS's fades out over about
 *  16 grid px; each icon says how strong its own is, since the same white reads differently on
 *  graphite and on clay. */
const RIM = { width: 12, blur: 5 };
/** A little light on the body from above, the one sheen the set keeps — and a glint along the
 *  mark's top edge, which shows only where that face is not already white. */
const SHEEN = 0.1;
const GLINT = 0.5;
/** The mark's own shadow, in mark units: enough to lift it off the body, not to float it. */
const LIFT = { dy: 0.55, blur: 0.8 };
/** A sticker's die-cut margin round the mark, in mark units (the stroke is half outside). */
const OUTLINE = 3.4;

/** mark.svg's faces by where each sits in the mark — the names its gradients carry say nothing. */
const FACES = {
  "face-b": "top", "joint-b": "upperJoint", "face-d": "middleLeft",
  "face-c": "middleRight", "joint-a": "lowerJoint", "face-a": "bottom",
};

/**
 * Every icon, in the order Settings offers them; `default` is also the bundle's own. `ground` runs
 * top to bottom (`angle` turns it), each face of the mark runs from its first colour to its second
 * along mark.svg's own gradient for that face, and `lift` is the colour and strength of the shadow
 * the mark casts on the body.
 */
export const ICONS = [
  {
    id: "default",
    ground: ["#33353a", "#151619"], rim: 0.4,
    mark: {
      top: ["#fbfbfc", "#eceef0"], middleLeft: ["#d7dadf", "#c6cad0"], lowerJoint: ["#cbcfd4", "#b8bcc2"],
      middleRight: ["#959aa1", "#83878f"], upperJoint: ["#71757d", "#62666e"], bottom: ["#62666d", "#53575e"],
    },
    lift: ["#000000", 0.45],
  },
  {
    id: "indigo",
    ground: ["#544bf3", "#331cb2"], rim: 0.3,
    mark: {
      top: ["#f1f0fb", "#e1e0f4"], middleLeft: ["#c4c2e4", "#b3b1da"], lowerJoint: ["#b8b6dc", "#a5a3d0"],
      middleRight: ["#8683b8", "#7673ab"], upperJoint: ["#646196", "#57538a"], bottom: ["#55518a", "#48447c"],
    },
    lift: ["#140a5c", 0.45],
  },
  {
    id: "clay",
    ground: ["#f8f8f6", "#e5e5e1"], rim: 0.7,
    mark: {
      top: ["#ff9c8f", "#ff8576"], upperJoint: ["#e4524a", "#d6463f"],
      middleLeft: ["#ff7d6e", "#d861ae", "#5f7dff"], middleRight: ["#f2636a", "#b75ad0", "#4b64f2"],
      lowerJoint: ["#6a8bff", "#5577fb"], bottom: ["#4560ee", "#3b52df"],
    },
    lift: ["#6e6a62", 0.3],
  },
  {
    id: "frost",
    ground: ["#f3f7fd", "#d8e3f3"], rim: 0.75,
    mark: {
      top: ["#b9c8ff", "#a6b6ff"], upperJoint: ["#5a52e0", "#4d45d4"],
      middleLeft: ["#8e9fff", "#7b84f7"], middleRight: ["#6f68ea", "#625ae0"],
      lowerJoint: ["#9db0ff", "#8a9cfb"], bottom: ["#5c55dd", "#5049d0"],
    },
    lift: ["#3d4f86", 0.3],
  },
  {
    id: "smoke",
    ground: ["#28344b", "#0c1322"], rim: 0.38,
    mark: {
      top: ["#ffffff", "#f1f5fb"], middleLeft: ["#dde5f1", "#ccd6e6"], lowerJoint: ["#d3dcea", "#c2cde0"],
      middleRight: ["#a5b3ca", "#93a2bd"], upperJoint: ["#8796b2", "#7988a6"], bottom: ["#7887a5", "#6b7a98"],
    },
    lift: ["#000000", 0.5],
  },
  {
    id: "sticker",
    ground: ["#ff7f8e", "#c03ee6", "#6b35ea"], angle: 45, rim: 0.32,
    mark: {
      top: ["#ffc4d6", "#ffb0c8"], upperJoint: ["#e0489f", "#d43c97"],
      middleLeft: ["#ff8fbb", "#b06cf5"], middleRight: ["#e861b4", "#9a52ee"],
      lowerJoint: ["#c69bff", "#b386fb"], bottom: ["#8a4fee", "#7a42e2"],
    },
    outline: "#ffffff",
    lift: ["#43106b", 0.4],
  },
  {
    id: "ocean",
    ground: ["#4ad9ee", "#1a90de", "#0d4fbd"], rim: 0.32,
    mark: {
      top: ["#ffffff", "#f1fbfe"], middleLeft: ["#dcf3fa", "#cbeaf5"], lowerJoint: ["#d3eef8", "#c0e4f2"],
      middleRight: ["#a9d9ec", "#97cde5"], upperJoint: ["#8fc6e0", "#80bad8"], bottom: ["#86bedb", "#78b1d2"],
    },
    lift: ["#06306e", 0.4],
  },
  {
    id: "ember",
    ground: ["#ffb12e", "#ff5b3b", "#e81f72"], rim: 0.34,
    mark: {
      top: ["#fffaf2", "#fff1de"], middleLeft: ["#ffe6cb", "#fdd9b7"], lowerJoint: ["#ffdfc2", "#fbd0ab"],
      middleRight: ["#f9c8a3", "#f4b994"], upperJoint: ["#f1b28c", "#eba47f"], bottom: ["#eda985", "#e69b78"],
    },
    lift: ["#7a0d36", 0.35],
  },
  {
    id: "mint",
    ground: ["#d6f6e0", "#ade8c2"], rim: 0.6,
    mark: {
      top: ["#fff38f", "#ffe86c"], upperJoint: ["#f2cf38", "#e9c52b"],
      middleLeft: ["#a3ebbe", "#8be0aa"], middleRight: ["#64d293", "#55c785"],
      lowerJoint: ["#9ce8b8", "#86dea6"], bottom: ["#f7d94b", "#edcb37"],
    },
    lift: ["#2f7a4c", 0.36],
  },
];

/** mark.svg, as the paths and gradient vectors an icon is built from. */
function readMark() {
  const svg = readFileSync(join(here, "mark.svg"), "utf8");
  const [, vw, vh] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
  const vectors = new Map();
  for (const m of svg.matchAll(/<linearGradient id="([\w-]+)" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)) {
    vectors.set(m[1], m.slice(2, 6).map(Number));
  }
  const faces = [...svg.matchAll(/<path fill="url\(#([\w-]+)\)" d="([^"]+)"/g)].map((m) => {
    const face = FACES[m[1]];
    if (!face || !vectors.has(m[1])) throw new Error(`mark.svg: no face or gradient for ${m[1]}`);
    return { face, d: m[2], vector: vectors.get(m[1]) };
  });
  if (!vw || faces.length !== Object.keys(FACES).length) throw new Error("mark.svg: not the mark this file was written for");
  return { width: Number(vw), height: Number(vh), faces };
}

/** The body's outline as a path, sampled finely enough that no facet shows at 1024. */
function bodyPath() {
  const r = BODY / 2, c = CANVAS / 2, steps = 720;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const x = c + r * Math.sign(Math.cos(t)) * Math.abs(Math.cos(t)) ** (2 / N);
    const y = c + r * Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** (2 / N);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** A path whose opening `m` is pinned to where it already starts. It is absolute only because nothing
 *  came before it: joined after another path it would be relative to that path's end. Any pairs
 *  after it were relative line-tos, and stay so. */
const pinned = (d) => d.replace(/^m\s*(-?[\d.]+)[\s,]*(-?[\d.]+)\s*(?=([-\d.])?)/, (_, x, y, more) => `M${x} ${y}${more ? "l" : ""}`);

const stops = (colors) => colors.map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`).join("");

/** The ground's gradient line across the body: straight down, or turned clockwise by `angle`. */
function groundLine(angle = 0) {
  const a = (angle * Math.PI) / 180, c = CANVAS / 2, h = BODY / 2;
  const dx = Math.sin(a) * h, dy = Math.cos(a) * h;
  return `x1="${(c - dx).toFixed(1)}" y1="${(c - dy).toFixed(1)}" x2="${(c + dx).toFixed(1)}" y2="${(c + dy).toFixed(1)}"`;
}

/** One icon as a 1024 px SVG on the macOS grid. */
export function iconSvg(icon) {
  const mark = readMark();
  const silhouette = mark.faces.map((f) => pinned(f.d)).join("");
  const top = mark.faces.find((f) => f.face === "top");
  const tx = CANVAS / 2 - (mark.width / 2) * MARK_SCALE;
  const ty = CANVAS / 2 - (mark.height / 2) * MARK_SCALE;
  const faces = mark.faces.map((f) => {
    const colors = icon.mark[f.face];
    if (!colors) throw new Error(`${icon.id}: no colours for the ${f.face} face`);
    const [x1, y1, x2, y2] = f.vector;
    return {
      gradient: `<linearGradient id="${f.face}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">${stops(colors)}</linearGradient>`,
      path: `<path fill="url(#${f.face})" d="${f.d}"/>`,
    };
  });
  // The colour under the faces, so a seam between two of them shows the mark rather than the body.
  const under = icon.mark.middleLeft[0];
  const [liftColor, liftOpacity] = icon.lift;
  // A die-cut outline is the silhouette grown by a stroke, and the shadow is cast by the cut sticker.
  const cut = (color) => (icon.outline ? ` stroke="${color}" stroke-width="${OUTLINE}" stroke-linejoin="round"` : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<defs>
<path id="body" d="${bodyPath()}"/>
<clipPath id="inside"><use href="#body"/></clipPath>
<linearGradient id="ground" ${groundLine(icon.angle)} gradientUnits="userSpaceOnUse">${stops(icon.ground)}</linearGradient>
<filter id="shadow" x="-15%" y="-15%" width="130%" height="135%"><feGaussianBlur stdDeviation="${SHADOW.blur}"/></filter>
<filter id="rim" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${RIM.blur}"/></filter>
<filter id="lift" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${LIFT.blur}"/></filter>
${faces.map((f) => f.gradient).join("\n")}
<radialGradient id="sheen"><stop offset="0" stop-color="#ffffff" stop-opacity="${SHEEN}"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="glint" x1="0" y1="0" x2="0" y2="0.16"><stop offset="0" stop-color="#ffffff" stop-opacity="${GLINT}"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
</defs>
<use href="#body" fill="#000000" fill-opacity="${SHADOW.opacity}" transform="translate(0 ${SHADOW.dy})" filter="url(#shadow)"/>
<use href="#body" fill="url(#ground)"/>
<ellipse cx="${CANVAS / 2}" cy="${ORIGIN}" rx="${BODY * 0.68}" ry="${BODY * 0.44}" fill="url(#sheen)" clip-path="url(#inside)"/>
<g clip-path="url(#inside)"><use href="#body" fill="none" stroke="#ffffff" stroke-opacity="${icon.rim}" stroke-width="${RIM.width}" filter="url(#rim)"/></g>
<g transform="translate(${tx} ${ty}) scale(${MARK_SCALE})">
<path d="${silhouette}" fill="${liftColor}" fill-opacity="${liftOpacity}"${cut(liftColor)} transform="translate(0 ${LIFT.dy})" filter="url(#lift)"/>
${icon.outline ? `<path d="${silhouette}" fill="${icon.outline}"${cut(icon.outline)}/>` : ""}
<path d="${silhouette}" fill="${under}"/>
${faces.map((f) => f.path).join("\n")}
<path fill="url(#glint)" d="${top.d}"/>
</g>
</svg>
`;
}
