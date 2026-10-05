import createDOMPurify, { type DOMPurify } from "dompurify";
import type { MermaidConfig } from "mermaid";
import { DIAGRAM_EDGES_MAX, UI_BLOCK_SOURCE_MAX } from "@realm/contracts";
import type { DiagramTheme } from "./block-theme";

/**
 * A ```mermaid block, drawn — as data, never as a program.
 *
 * Mermaid is a lazy chunk: it costs the renderer nothing until a diagram is on screen, which in most
 * sessions is never. It runs in strict mode with HTML labels off, so a label is text and a `click`
 * binds nothing, and the keys that decide any of that — and every colour — are ones a diagram's own
 * `%%{init}%%` or front matter cannot reach (`SECURE`).
 *
 * What it draws then goes through DOMPurify's SVG profile here, and that is the gate that matters:
 * Mermaid is a large parser fed agent text, and the drawing is checked on the way out rather than
 * trusted on the way in. Links are unwrapped to their text, pictures and embedded HTML removed, and
 * every reference that would leave the drawing — an `href`, a `url()` in an attribute or a style
 * sheet, an `@import` — is cut, so drawing a diagram fetches nothing. Nor does it move: an animated
 * edge is decoration on a loop, and Realm's motion rules have no say over Mermaid's stylesheet.
 */

/** How long one diagram may take to draw before it is left as its source. Counted from after the
 *  chunk has loaded — the first diagram of a session is not penalised for the download. */
export const DIAGRAM_TIMEOUT_MS = 8_000;

/** The id Mermaid draws under, swapped for a fresh one per mounted copy (`placeDiagram`): the same
 *  diagram in two places would otherwise put every marker and gradient id in the document twice, and
 *  an arrowhead resolves to whichever comes first — even one in a pane that is hidden. */
const ID_TOKEN = "rlmmdsvg";

/** Config keys a diagram may not change from inside itself. */
const SECURE = [
  "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels",
  "theme", "themeVariables", "themeCSS", "fontFamily", "altFontFamily", "fontSize", "look", "darkMode", "handDrawnSeed",
  "dompurifyConfig", "deterministicIds", "deterministicIDSeed", "arrowMarkerAbsolute", "legacyMathML", "forceLegacyMathML", "logLevel",
];

export type DrawnDiagram = { ok: true; svg: string; width: number; height: number; type: string; title: string | null };
export type DiagramResult = DrawnDiagram | { ok: false; reason: string };

type Mermaid = (typeof import("mermaid"))["default"];
let mermaidChunk: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> => (mermaidChunk ??= import("mermaid").then((m) => m.default));

function config(theme: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true, logLevel: "fatal",
    theme: "base", look: "classic", darkMode: theme.dark, fontFamily: theme.fontFamily, themeVariables: theme.vars,
    maxTextSize: UI_BLOCK_SOURCE_MAX, maxEdges: DIAGRAM_EDGES_MAX, deterministicIds: true, secure: SECURE,
  };
}

/* ─────────────────────────────── the gate ─────────────────────────────── */

let purifier: DOMPurify | null = null;

/** CSS escapes, decoded — `u\72 l(` is `url(` to the browser, so it has to be `url(` to the check.
 *  What is written back is the DECODED text, which the browser reads again: so an escaped escape
 *  (`\5c 72`) is decoded until none is left, and a stray backslash is dropped rather than left to be
 *  read as a fresh escape the check never saw. */
function unescapeCss(css: string): string {
  let out = css;
  for (let i = 0; i < 4 && out.includes("\\"); i++) {
    out = out.replace(/\\([0-9a-f]{1,6})[ \t\n]?|\\(.)/gi, (_, hex: string | undefined, ch: string | undefined) =>
      (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : ch ?? ""));
  }
  return out.replace(/\\/g, "");
}

/** A style sheet or a style attribute with everything that could fetch or move taken out. */
export function scrubCss(css: string): string {
  return unescapeCss(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/gi, "")
    .replace(/(^|[;{\s])(?:-webkit-)?animation(?:-[a-z-]+)?\s*:[^;}]*;?/gi, "$1")
    // Only a reference into the drawing itself — a marker, a gradient — survives.
    .replace(/url\(\s*(?!['"]?\s*#)[^)]*\)/gi, "none")
    .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, "none")
    .replace(/expression\s*\(|behavior\s*:|-moz-binding/gi, "");
}

function gate(): DOMPurify {
  if (purifier) return purifier;
  // An instance of its own, so these hooks never run on the transcript's prose (Markdown.tsx's
  // purifier has a hook of its own, and Mermaid adds and removes its own on the shared one).
  const p = createDOMPurify(window);
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) node.textContent = scrubCss(node.textContent);
  });
  p.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName;
    if (name === "href" || name === "xlink:href") { if (!data.attrValue.trim().startsWith("#")) data.keepAttr = false; return; }
    if (name === "style" || /url\s*\(/i.test(data.attrValue)) data.attrValue = scrubCss(data.attrValue);
  });
  return (purifier = p);
}

/**
 * Mermaid's SVG, as Realm will put it on screen: the SVG profile, minus what links, embeds, fetches
 * or animates. Returns the cleaned `<svg>` element, or null when nothing drawable is left.
 */
export function sanitizeDiagram(svg: string): SVGSVGElement | null {
  const frag = gate().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `a` keeps its content — a linked node is still a node, just not a link. The rest go whole.
    FORBID_TAGS: ["a", "image", "feImage", "foreignObject", "use", "script", "iframe", "animate", "set", "animateMotion", "animateTransform", "animateColor"],
    RETURN_DOM_FRAGMENT: true,
  });
  const root = frag.firstElementChild;
  return root instanceof SVGSVGElement ? root : null;
}

/** The drawing's own size, read off its viewBox — Mermaid sets a max-width style and a 100% width on
 *  the root, and the block owns both decisions (`.ui-diagram`). */
function finish(raw: string, type: string): DiagramResult {
  const svg = sanitizeDiagram(raw);
  if (!svg) return { ok: false, reason: "Mermaid drew nothing Realm can show" };
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = Number.isFinite(vb[2]) && vb[2]! > 0 ? vb[2]! : 0;
  const height = Number.isFinite(vb[3]) && vb[3]! > 0 ? vb[3]! : 0;
  if (!width || !height) return { ok: false, reason: "Mermaid drew nothing Realm can show" };
  for (const attr of ["style", "width", "height"]) svg.removeAttribute(attr);
  const title = svg.querySelector(":scope > title")?.textContent?.trim() || null;
  return { ok: true, svg: svg.outerHTML, width, height, type, title };
}

/** Mermaid's error, as one line a reader can act on: "Parse error on line 3", not its ASCII caret art. */
function reasonFor(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { str?: string })?.str ?? e);
  const first = msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "Mermaid could not draw it";
  if (/no diagram type detected|UnknownDiagramError/i.test(msg)) return "Mermaid does not know this kind of diagram";
  if (/edge limit|maxEdges|too many edges/i.test(msg)) return `more than ${DIAGRAM_EDGES_MAX} edges, past what Realm lays out`;
  return first.replace(/:$/, "");
}

/* ─────────────────────────────── drawing, once per diagram and face ─────────────────────────────── */

const settled = new Map<string, DiagramResult>();
const inFlight = new Map<string, Promise<DiagramResult>>();
/** Drawn diagrams kept. A message re-renders on every streamed delta and remounts its blocks, and a
 *  diagram drawn a second time for that would flicker; the cap is only so a long session cannot keep
 *  every face of every diagram forever. */
const KEEP = 64;
/** One at a time: `initialize` is global, and two draws in different faces must not share it. */
let queue: Promise<unknown> = Promise.resolve();

const keyOf = (source: string, theme: DiagramTheme) => `${theme.key}\n${source}`;

/** A diagram already drawn in this face, synchronously — what lets a remount paint it on its first frame. */
export function peekDiagram(source: string, theme: DiagramTheme): DiagramResult | undefined {
  return settled.get(keyOf(source, theme));
}

export function drawDiagram(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  const key = keyOf(source, theme);
  const done = settled.get(key);
  if (done) return Promise.resolve(done);
  const running = inFlight.get(key);
  if (running) return running;
  const job = queue.then(() => drawNow(source, theme)).then((result) => {
    inFlight.delete(key);
    settled.set(key, result);
    while (settled.size > KEEP) settled.delete(settled.keys().next().value!);
    return result;
  });
  // The queue waits for this draw or its timeout, whichever comes first — never for a hung one.
  queue = job.catch(() => undefined);
  inFlight.set(key, job);
  return job;
}

async function drawNow(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  let mermaid: Mermaid;
  try { mermaid = await loadMermaid(); } catch { return { ok: false, reason: "the diagram drawer did not load" }; }
  mermaid.initialize(config(theme));
  // Mermaid measures text by laying it out, so it draws into the document — here, off to one side,
  // in a host of its own that goes when the draw does, finished or not.
  const host = document.createElement("div");
  host.className = "ui-diagram-scratch";
  host.setAttribute("aria-hidden", "true");
  document.body.appendChild(host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      mermaid.render(ID_TOKEN, source, host),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), DIAGRAM_TIMEOUT_MS); }),
    ]);
    if (out === "timeout") return { ok: false, reason: `took longer than ${DIAGRAM_TIMEOUT_MS / 1000} seconds to lay out` };
    return finish(out.svg, out.diagramType);
  } catch (e) {
    return { ok: false, reason: reasonFor(e) };
  } finally {
    clearTimeout(timer);
    host.remove();
  }
}

let placed = 0;

/** A drawn diagram's markup for one mounted copy, under ids no other copy shares. */
export function placeDiagram(svg: string): string {
  return svg.replaceAll(ID_TOKEN, `rlmmd-${++placed}`);
}

/** The markup to hand someone who copies the diagram: the same drawing, under a plain id. */
export const exportedDiagram = (svg: string): string => svg.replaceAll(ID_TOKEN, "realm-diagram");

/** What kind of diagram Mermaid says it drew, as a reader would name it. */
const NAMES: Record<string, string> = {
  flowchart: "Flowchart", "flowchart-v2": "Flowchart", "flowchart-elk": "Flowchart", graph: "Flowchart",
  sequence: "Sequence diagram", classDiagram: "Class diagram", class: "Class diagram",
  stateDiagram: "State diagram", state: "State diagram", er: "Entity relationship diagram", gantt: "Gantt chart",
  journey: "User journey", pie: "Pie chart", gitGraph: "Git graph", mindmap: "Mind map", timeline: "Timeline",
  quadrantChart: "Quadrant chart", xychart: "Chart", requirement: "Requirement diagram", sankey: "Sankey diagram",
  block: "Block diagram", packet: "Packet diagram", architecture: "Architecture diagram", kanban: "Kanban board",
  radar: "Radar chart", treemap: "Treemap", c4: "C4 diagram",
};
export const diagramName = (type: string): string => NAMES[type] ?? NAMES[type.replace(/-v\d+$|-beta$/, "")] ?? "Diagram";
