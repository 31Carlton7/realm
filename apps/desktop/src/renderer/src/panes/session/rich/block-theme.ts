import { useSyncExternalStore } from "react";
import { oklchToHex, parseOklch } from "@realm/contracts";

/**
 * Realm's tokens as a diagram's colours, in whichever face is on screen.
 *
 * A chart is drawn by Realm in SVG and reads `var(--series-n)` straight from the stylesheet, so it
 * changes face with everything else. A Mermaid diagram cannot: Mermaid derives a dozen shades from
 * the handful it is given with its own colour maths, which reads hex and nothing else — not OKLCH,
 * not a translucent overlay, not a variable. So the tokens are RESOLVED here, each one composited
 * over the block's own ground the way the screen composites it, and the diagram is drawn again when
 * the face changes (`key`).
 *
 * Every shade Mermaid would otherwise invent is stated: its defaults turn the second and third node
 * colours 120° round the wheel and wash a pie at 70% opacity, and neither is Realm's palette.
 */

export type DiagramTheme = {
  /** Changes whenever anything the drawing reads does — the cache key for a drawn diagram. */
  key: string;
  dark: boolean;
  fontFamily: string;
  /** Mermaid's `themeVariables`, for its `base` theme. */
  vars: Record<string, unknown>;
  /** The block's ground, for an exported picture that has to carry its own. */
  ground: string;
};

/** What each face resolves to when no stylesheet has loaded (a component test). */
const FALLBACK = {
  dark: { "--surface": "#232427", "--ink": "#f2f3f5", "--ink-2": "#a9adb4", "--ink-3": "#71757d" },
  light: { "--surface": "#ffffff", "--ink": "#1d1f24", "--ink-2": "#5a5e66", "--ink-3": "#6c7079" },
} as const;

let scratch: OffscreenCanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as `#rrggbb`, laid over `ground` first when it is translucent.
 *
 * Drawn rather than parsed: the canvas accepts every form the stylesheet writes, and compositing an
 * overlay is exactly what it is for. Where there is no canvas (jsdom), a hex or an OKLCH token is
 * read directly and anything else falls back.
 */
function resolve(value: string, ground: string | null, fallback: string): string {
  const v = value.trim();
  if (!v) return fallback;
  if (scratch === undefined) scratch = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  if (scratch) {
    scratch.clearRect(0, 0, 1, 1);
    scratch.fillStyle = ground ?? "#000";
    scratch.fillRect(0, 0, 1, 1);
    scratch.fillStyle = fallback;
    scratch.fillStyle = v; // an unparseable value leaves the fallback set, which is the answer for it
    scratch.fillRect(0, 0, 1, 1);
    const [r, g, b] = scratch.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
  }
  if (/^#[\da-f]{6}$/i.test(v)) return v.toLowerCase();
  try { return oklchToHex(parseOklch(v)); } catch { return fallback; }
}

/** Black or white, whichever reads on `hex` — for a label Mermaid sets on a series-coloured fill. */
function onFill(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // The crossover where black and white have equal contrast against the fill.
  return y > 0.179 ? "#111111" : "#ffffff";
}

export function diagramTheme(doc: Document = document): DiagramTheme {
  const root = doc.documentElement;
  const dark = root.getAttribute("data-mode") !== "light";
  const style = doc.defaultView?.getComputedStyle(root);
  const raw = (name: string) => style?.getPropertyValue(name) ?? "";
  const fb = FALLBACK[dark ? "dark" : "light"];
  const ground = resolve(raw("--surface"), null, fb["--surface"]);
  const on = (name: string, over = ground, fallback: string = (fb as Record<string, string>)[name] ?? fb["--ink-3"]) => resolve(raw(name), over, fallback);
  const ink = on("--ink"), ink2 = on("--ink-2"), ink3 = on("--ink-3");
  // A node is one step off the block's ground: up in the dark face, down in the light one, which is
  // what the hover rung already is on each.
  const node = on("--hover", ground, ground);
  const raised = on("--hover-2", ground, node);
  const edge = on("--line-strong", node, ink3);
  const quiet = on("--line", ground, ink3);
  const well = on("--inset", ground, ground);
  const series = Array.from({ length: 8 }, (_, i) => on(`--series-${i + 1}`, ground, ink2));
  // The UI face, which Settings may have changed: a diagram's labels are the app's, like a chart's.
  const fontFamily = raw("--font-ui").trim() || "Inter, ui-sans-serif, system-ui, sans-serif";

  const vars: Record<string, unknown> = {
    darkMode: dark, background: ground, fontFamily,
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
    // The neo look's shadow and gradient, which `look` (locked to classic) never reaches anyway.
    useGradient: false, dropShadow: "none",
    pieOpacity: "1", pieStrokeColor: ground, pieOuterStrokeColor: ground, pieStrokeWidth: "2px", pieOuterStrokeWidth: "0px",
    pieTitleTextColor: ink, pieSectionTextColor: dark ? ink : "#ffffff", pieLegendTextColor: ink2,
    xyChart: { backgroundColor: ground, titleColor: ink, dataLabelColor: ink, legendTextColor: ink2,
      xAxisTitleColor: ink2, xAxisLabelColor: ink2, xAxisTickColor: quiet, xAxisLineColor: quiet,
      yAxisTitleColor: ink2, yAxisLabelColor: ink2, yAxisTickColor: quiet, yAxisLineColor: quiet, plotColorPalette: series.join(",") },
    gridColor: quiet, todayLineColor: series[1], critBkgColor: series[7], critBorderColor: series[7],
    taskBkgColor: node, taskBorderColor: edge, taskTextColor: ink, taskTextOutsideColor: ink, taskTextLightColor: ink, taskTextDarkColor: ink,
    activeTaskBkgColor: raised, activeTaskBorderColor: series[0], doneTaskBkgColor: well, doneTaskBorderColor: quiet,
    sectionBkgColor: well, altSectionBkgColor: ground, sectionBkgColor2: well, excludeBkgColor: well,
    attributeBackgroundColorOdd: node, attributeBackgroundColorEven: well, relationColor: ink3, relationLabelBackground: ground, relationLabelColor: ink,
    stateBkg: node, stateLabelColor: ink, compositeBackground: well, compositeTitleBackground: node, transitionColor: ink3, transitionLabelColor: ink2,
    classText: ink, personBkg: node, personBorder: edge, requirementBackground: node, requirementBorderColor: edge, requirementTextColor: ink,
    quadrantPointFill: series[0], quadrantTitleFill: ink, quadrantXAxisTextFill: ink2, quadrantYAxisTextFill: ink2,
    quadrantInternalBorderStrokeFill: quiet, quadrantExternalBorderStrokeFill: edge,
    commitLabelColor: ink, commitLabelBackground: node, tagLabelColor: ink, tagLabelBackground: node, tagLabelBorder: edge,
  };
  // The categorical slots, in order, wherever Mermaid colours by category.
  series.forEach((c, i) => {
    vars[`pie${i + 1}`] = c; vars[`venn${i + 1}`] = c; vars[`git${i}`] = c; vars[`gitBranchLabel${i}`] = onFill(c); vars[`gitInv${i}`] = onFill(c);
    vars[`cScale${i}`] = c; vars[`cScaleLabel${i}`] = onFill(c); vars[`cScalePeer${i}`] = edge; vars[`fillType${i}`] = c;
  });
  for (let i = 8; i < 12; i++) { vars[`cScale${i}`] = series[i - 8]; vars[`cScaleLabel${i}`] = onFill(series[i - 8]!); }
  const key = JSON.stringify([dark, fontFamily, ground, ink, ink2, ink3, node, raised, edge, quiet, well, series]);
  return { key, dark, fontFamily, vars, ground };
}

/* One theme for every diagram on screen, re-read when `:root` changes — `applyTheme` writes the mode
   and the palette there — and only while a diagram is mounted to want it. */
let current: DiagramTheme | null = null;
let observer: MutationObserver | null = null;
let frame = 0;
const listeners = new Set<() => void>();

function reread() {
  frame = 0;
  const next = diagramTheme();
  if (next.key === current?.key) return;
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!observer && typeof MutationObserver !== "undefined") {
    // Once a frame at most: `applyTheme` writes a palette as a run of properties, not as one.
    observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(reread); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme", "style", "class"] });
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) { observer?.disconnect(); observer = null; current = null; if (frame) cancelAnimationFrame(frame); frame = 0; }
  };
}

const snapshot = (): DiagramTheme => (current ??= diagramTheme());
const noSubscribe = () => () => {};
const none = (): null => null;

/** The face on screen, for a block that draws or exports in it — null for one that does not (`on`),
 *  so a chart's head does not keep an observer on `:root` it has no use for. */
export function useDiagramTheme(on: boolean): DiagramTheme | null {
  return useSyncExternalStore(on ? subscribe : noSubscribe, on ? snapshot : none);
}
