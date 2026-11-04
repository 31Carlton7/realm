// Draws one block at a time onto #stage for BlockDrawer to photograph, and answers with where it is.
//
// TeX is set by KaTeX the way the desktop sets it (rich/math.ts): no \href, no \url, no pictures, and
// the raw source when it will not parse. A diagram is Mermaid in the desktop's strict configuration
// (rich/mermaid.ts) with the desktop's theme (rich/block-theme.ts), built here from the handful of
// Realm colours the app resolves for the face on screen.

const LABEL_PX = 14;
const DIAGRAM_TIMEOUT_MS = 8000;
const FONT = "-apple-system, system-ui, sans-serif";
/** Config keys a diagram may not change from inside itself. */
const SECURE = [
  "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels",
  "theme", "themeVariables", "themeCSS", "fontFamily", "altFontFamily", "fontSize", "look", "darkMode", "handDrawnSeed",
  "dompurifyConfig", "deterministicIds", "deterministicIDSeed", "arrowMarkerAbsolute", "legacyMathML", "forceLegacyMathML", "logLevel",
];

/** Two frames, so what was just set is painted — or a moment, where a hidden view gets no frames. */
const settle = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, 80);
});

function stage(ground, ink) {
  document.documentElement.style.background = ground;
  const el = document.getElementById("stage");
  el.style.color = ink;
  el.replaceChildren();
  return el;
}

/** What an expression covers: its bases, each as tall as its strut, and an equation's tag. KaTeX's
 *  stacking struts inside a fraction reach far above what is drawn, so its descendants will not do. */
function extent(html) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of html.querySelectorAll(":scope > .base, :scope > .tag")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left); top = Math.min(top, r.top);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  return { left, top, right, bottom };
}

/** One expression, white on black (the app keeps its coverage as a mask and tints it). `depth` is
 *  how far it hangs below the baseline, which is where an inline one sits on the sentence's. */
async function math(tex, display, px) {
  const el = stage("#000", "#fff");
  el.style.fontSize = `${px}px`;
  try {
    el.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "html" });
  } catch {
    return { ok: false };
  }
  const base = document.createElement("span");
  base.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  (el.querySelector(".katex-html") ?? el).append(base);
  el.getBoundingClientRect();
  await document.fonts.ready;
  await settle();
  const box = extent(el.querySelector(".katex-html") ?? el);
  // A hair of room: a glyph's ink can overhang its box (an italic f, a radical's hook).
  box.left -= 1; box.top -= 1; box.right += 1; box.bottom += 1;
  const baseline = base.getBoundingClientRect().bottom;
  base.remove();
  if (!Number.isFinite(box.left)) return { ok: false };
  const x = Math.floor(box.left), y = Math.floor(box.top);
  return { ok: true, x, y, width: Math.ceil(box.right) - x, height: Math.ceil(box.bottom) - y, depth: Math.max(0, box.bottom - baseline) };
}

/* ─────────────────────────────── diagrams ─────────────────────────────── */

let mermaidLoad = null;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/mermaid.min.js";
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => { mermaidLoad = null; reject(new Error("the diagram drawer did not load")); };
    document.head.append(script);
  });
  return mermaidLoad;
}

/** Black or white, whichever reads on `hex` — for a label Mermaid sets on a series-coloured fill. */
function onFill(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return y > 0.179 ? "#111111" : "#ffffff";
}

/** The desktop's themeVariables, from the tokens resolved over the block's ground. */
function themeVariables(t) {
  const { dark, ground, ink, ink2, ink3, node, raised, edge, quiet, well, series } = t;
  const vars = {
    darkMode: dark, background: ground, fontFamily: FONT, fontSize: `${LABEL_PX}px`,
    primaryColor: node, primaryTextColor: ink, primaryBorderColor: edge,
    secondaryColor: raised, secondaryTextColor: ink, secondaryBorderColor: edge,
    tertiaryColor: well, tertiaryTextColor: ink, tertiaryBorderColor: quiet,
    mainBkg: node, nodeBorder: edge, nodeTextColor: ink, textColor: ink, titleColor: ink,
    lineColor: ink3, arrowheadColor: ink3, defaultLinkColor: ink3,
    clusterBkg: well, clusterBorder: quiet, edgeLabelBackground: ground,
    noteBkgColor: raised, noteTextColor: ink, noteBorderColor: edge,
    actorBkg: node, actorBorder: edge, actorTextColor: ink, actorLineColor: ink3,
    signalColor: ink2, signalTextColor: ink, labelBoxBkgColor: node, labelBoxBorderColor: edge, labelTextColor: ink, loopTextColor: ink2,
    activationBkgColor: raised, activationBorderColor: edge, sequenceNumberColor: onFill(ink2),
    useGradient: false, dropShadow: "none",
    attributeBackgroundColorOdd: node, attributeBackgroundColorEven: well, relationColor: ink3, relationLabelBackground: ground, relationLabelColor: ink,
    stateBkg: node, stateLabelColor: ink, compositeBackground: well, compositeTitleBackground: node, transitionColor: ink3, transitionLabelColor: ink2,
    classText: ink,
  };
  series.forEach((c, i) => {
    vars[`cScale${i}`] = c; vars[`cScaleLabel${i}`] = onFill(c); vars[`cScalePeer${i}`] = edge; vars[`fillType${i}`] = c;
  });
  return vars;
}

function config(tokens) {
  return {
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true, logLevel: "fatal",
    theme: "base", look: "classic", darkMode: tokens.dark, fontFamily: FONT, themeVariables: themeVariables(tokens), fontSize: LABEL_PX,
    flowchart: { diagramPadding: 4, padding: 12, nodeSpacing: 40, rankSpacing: 44 },
    sequence: { diagramMarginX: 4, diagramMarginY: 4, actorMargin: 36, width: 120, height: 44, boxMargin: 8, noteMargin: 8, messageMargin: 30,
      mirrorActors: false, actorFontSize: LABEL_PX, messageFontSize: LABEL_PX, noteFontSize: LABEL_PX,
      actorFontFamily: FONT, messageFontFamily: FONT, noteFontFamily: FONT },
    maxTextSize: 20000, maxEdges: 200, deterministicIds: true, secure: SECURE,
  };
}

/** Mermaid's error, as one line a reader can act on. */
function reasonFor(e) {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String(e?.str ?? e);
  const first = msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "Mermaid could not draw it";
  if (/no diagram type detected|UnknownDiagramError/i.test(msg)) return "Mermaid does not know this kind of diagram";
  if (/not drawn on the phone/.test(msg)) return "this kind of diagram is drawn on the Mac, not the phone";
  if (/edge limit|maxEdges|too many edges/i.test(msg)) return "more than 200 edges, past what Realm lays out";
  return first.replace(/:$/, "");
}

let drawn = 0;

/** One diagram at its own size on the block's ground. */
async function diagram(source, tokens) {
  let mermaid;
  try { mermaid = await loadMermaid(); } catch (e) { return { ok: false, reason: e.message }; }
  mermaid.initialize(config(tokens));
  const scratch = document.getElementById("scratch");
  let timer;
  try {
    const out = await Promise.race([
      mermaid.render(`rlmmd-${++drawn}`, source, scratch),
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), DIAGRAM_TIMEOUT_MS); }),
    ]);
    if (out === "timeout") return { ok: false, reason: `took longer than ${DIAGRAM_TIMEOUT_MS / 1000} seconds to lay out` };
    const el = stage(tokens.ground, tokens.ink);
    el.innerHTML = out.svg;
    const svg = el.querySelector("svg");
    const vb = (svg?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    if (!svg || !(vb[2] > 0) || !(vb[3] > 0)) return { ok: false, reason: "Mermaid drew nothing Realm can show" };
    svg.removeAttribute("style");
    svg.setAttribute("width", String(vb[2]));
    svg.setAttribute("height", String(vb[3]));
    svg.style.display = "block";
    const title = svg.querySelector(":scope > title")?.textContent?.trim() || null;
    await settle();
    return { ok: true, x: 0, y: 0, width: Math.ceil(vb[2]), height: Math.ceil(vb[3]), type: out.diagramType, title };
  } catch (e) {
    return { ok: false, reason: reasonFor(e) };
  } finally {
    clearTimeout(timer);
    scratch.replaceChildren();
  }
}

window.realmBlocks = { math, diagram };
