import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveVars, REALM_SEED, seedFor, THEMES, themeModes, type Mode } from "@realm/ui";
import { CONTRAST_FLOOR } from "@realm/ui/src/themes";
import { parseOklch, srgb, srgbLuminance, type Oklch } from "@realm/contracts";

/** The quick chat panel's shapes show the app behind them through their ground, and that app is a
 *  desktop nobody chose, as a pane's is (`pane-ground.test.ts`, whose pessimistic model this is: the
 *  material under the shapes is assumed to do nothing, as it does when it cannot be cut). So Plain's
 *  body ink, and Glass's wherever it has no material, has to hold over a white window and a black one
 *  in every face, at the alpha the stylesheet gives it. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const styles = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
/** Main's numbers for the window, read from its source: the renderer's program cannot import main. */
const mainPanel = readFileSync(repoFile("apps/desktop/src/main/quick-chat-panel.ts"), "utf8");
const QUICK_CHAT_PANEL_INSET = Number(/QUICK_CHAT_PANEL_INSET = (\d+);/.exec(mainPanel)?.[1]);
const QUICK_CHAT_BAR = { height: Number(/QUICK_CHAT_BAR = \{ width: \d+, height: (\d+) \}/.exec(mainPanel)?.[1]) };

/** The panel's ground's opacity for a face, read from its rule. */
function groundAlpha(mode: Mode): number {
  const light = /:root\[data-surface="quick-chat"\]\[data-mode="light"\] \{ --panel-ground: color-mix\(in srgb, var\(--surface\) (\d+)%, transparent\); \}/.exec(styles);
  const dark = /:root\[data-surface="quick-chat"\] \{[^}]*--panel-ground: color-mix\(in srgb, var\(--surface\) (\d+)%, transparent\);/.exec(styles);
  const rule = mode === "light" ? light ?? dark : dark;
  if (!rule) throw new Error("no ground for the quick chat panel in styles.css");
  return Number(rule[1]) / 100;
}

/** A panel rule's declarations, by its exact selector. */
function rule(selector: string): string {
  const at = styles.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return styles.slice(at, styles.indexOf("}", at));
}

const over = (ground: Oklch, behind: 0 | 1, alpha: number): number =>
  srgbLuminance(srgb(ground).map((c) => c * alpha + behind * (1 - alpha)));
const ratio = (ink: Oklch, groundLuminance: number): number => {
  const a = srgbLuminance(srgb(ink));
  return (Math.max(a, groundLuminance) + 0.05) / (Math.min(a, groundLuminance) + 0.05);
};

function misses(alphaFor: (mode: Mode) => number) {
  const out: { face: string; behind: string; ratio: number }[] = [];
  for (const t of THEMES) for (const mode of themeModes(t.name)) {
    const vars = deriveVars(seedFor(t.name, mode, {}) ?? REALM_SEED[mode], mode) as Record<string, string>;
    const surface = parseOklch(vars["--surface"]!);
    for (const behind of [0, 1] as const) {
      const r = ratio(parseOklch(vars["--ink"]!), over(surface, behind, alphaFor(mode)));
      if (r < CONTRAST_FLOOR.ink) out.push({ face: `${t.name}/${mode}`, behind: behind ? "white" : "black", ratio: +r.toFixed(2) });
    }
  }
  return out;
}

describe("the quick chat panel's ground", () => {
  it("keeps body text above WCAG AA on every face, over a white window and a black one", () => {
    expect(misses(groundAlpha)).toEqual([]);
  });

  it("was thinner than that before: the 62% it first had put dark body text under AA over white", () => {
    expect(misses(() => 0.62).some((m) => m.face === "realm/dark" && m.behind === "white")).toBe(true);
  });

  it("puts the capsule and the card on the one ground, in both the painted and the plain path", () => {
    expect(rule(':root[data-surface="quick-chat"] .quick-chat .composer')).toContain("background: var(--panel-ground);");
    expect(rule(':root[data-surface="quick-chat"] .quick-chat-card')).toContain("background: var(--panel-ground);");
    expect(rule(':root[data-surface="quick-chat"][data-squircle] .quick-chat-card')).toContain("--sq-fill: var(--panel-ground);");
    expect(styles).toMatch(/:root\[data-surface="quick-chat"\]\[data-squircle\] \.quick-chat \.composer:focus-within \{[^}]*background: var\(--panel-ground\);/);
  });

  it("lays no fill in Glass where the material is cut under the shapes, and Plain's ground where it is not", () => {
    expect(rule(':root[data-surface="quick-chat"][data-glass][data-panel-material]')).toContain("--panel-ground: transparent;");
    expect(rule(':root[data-surface="quick-chat"][data-glass]')).not.toContain("--panel-ground");
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*:root\[data-surface="quick-chat"\] \{ --panel-ground: var\(--surface\); \}/);
  });

  it("puts the answer and the toolbar on the same ground as the bar", () => {
    expect(rule(".quick-chat-answer")).toContain("background: var(--panel-ground);");
    expect(rule(".quick-chat-tools")).toContain("background: var(--panel-ground);");
  });

  it("shows the light face's window less than the dark one's, as the panes do", () => {
    expect(groundAlpha("light")).toBeGreaterThan(groundAlpha("dark"));
    expect(groundAlpha("dark")).toBeLessThan(1);
  });
});

describe("the quick chat panel's frame", () => {
  it("leaves the margin main sizes the window with, so the shadow is not cut off", () => {
    expect(rule(':root[data-surface="quick-chat"]')).toContain(`--panel-inset: ${QUICK_CHAT_PANEL_INSET}px;`);
  });

  it("draws the bar as a capsule of main's bar height, painted path and plain", () => {
    const composer = rule(':root[data-surface="quick-chat"] .quick-chat .composer');
    expect(composer).toContain(`min-height: ${QUICK_CHAT_BAR.height}px;`);
    expect(composer).toContain("border-radius: var(--r-pill);");
    expect(styles).toMatch(/:root\[data-surface="quick-chat"\]\[data-squircle\] \.quick-chat \.composer:focus-within \{[^}]*border-radius: var\(--r-pill\);/);
    // The card's painted corner is the capsule's end: half the bar's height.
    expect(/--r-squircle-card: (\d+)px;/.exec(styles)?.[1]).toBe(String(QUICK_CHAT_BAR.height / 2));
    expect(rule(".quick-chat-tools")).toContain(`height: ${QUICK_CHAT_BAR.height}px;`);
    expect(styles).not.toContain(".quick-chat-side");
  });

  it("shows no card until it is expanded", () => {
    expect(rule(':root[data-surface="quick-chat"] .quick-chat:not([data-expanded]) .quick-chat-card')).toContain("display: none;");
  });
});
