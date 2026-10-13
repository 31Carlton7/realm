import { describe, expect, it } from "vitest";
import { contrast, oklchToHex, parseOklch } from "@realm/contracts";
import { CODEX_LIGHT_SEED, codexContrast, deriveCodex } from "./codex-theme";
import { CONTRAST_RANGE, DEFAULT_SELECTION, THEMES, THEME_EXTRA_VARS, THEME_VARS, allThemes, contrastMisses, derivationFor,
  paletteFor, themeModes, themeVars } from "./themes";
import { applyTheme } from "./theme";

/** A derived value as the pixel it paints. Opaque tokens are `oklch(...)`; the ramps are `rgba(...)`. */
const px = (v: string): string => (v.startsWith("oklch") ? oklchToHex(parseOklch(v)) : v);

/** Codex's light palette as Chromium resolves it: the three app-shell stylesheets of ChatGPT.app
 *  (com.openai.codex) with its theme engine's output for its own light seed applied to
 *  `<html data-theme=light data-codex-window-type=electron>`, read back with getComputedStyle.
 *  Recorded in .verify/backlog-oct12/codex-theme/codex-light.json; the source token is beside each. */
const CODEX_RESOLVED: Record<string, string> = {
  "--page": "#f6f6f6", // --app-color-background-surface-under (window, title bar, sidebar ground)
  "--canvas": "#ffffff", // --color-surface (main area)
  "--surface": "#ffffff", // --color-background-composer-surface = elevated-primary-opaque
  "--field": "#ffffff", // --color-background-control-opaque
  "--stripe-bg": "#fafafa", // --color-surface-canvas
  "--ink": "#1a1c1f", // --app-color-text-foreground
  "--accent": "#3a83f7", // --app-color-border-focus / accent-blue (ChatGPT account blue-400)
  "--accent-ink": "#2c67c5", // --app-color-text-accent (blue-500)
  "--accent-tint": "#e8f3fe", // --app-color-background-accent (blue-50)
  "--rl-accent-contrast": "#000000", // --app-color-text-on-accent
  "--green": "#00a240", "--orange": "#e25507", "--red": "#e02e2a", // --color-text-success / -warning / -danger
  "--green-tint": "#edf8f1", "--orange-tint": "#ffe7d9", "--red-tint": "#ffd9d9", // --app-color-background-status-*
  "--tooltip-bg": "#1a1c1f", "--tooltip-fg": "#ffffff", // --color-background-tooltip / --color-text-tooltip
  "--syn-fg": "#1a1c1f", "--syn-keyword": "#0169cc", "--syn-string": "#008635", "--syn-number": "#8046d9",
  "--syn-title": "#c0660d", "--syn-type": "#e04c91", "--syn-attr": "#e04c91", // --codeblock-syntax-1..5
  "--line": "rgba(26, 28, 31, 0.078)", // --app-color-border
  "--line-strong": "rgba(26, 28, 31, 0.117)", // --app-color-border-heavy
  "--line-soft": "rgba(26, 28, 31, 0.049)", // --app-color-border-light
  "--rl-active": "rgba(26, 28, 31, 0.053)", // --color-token-list-hover-background
  "--scrim": "rgba(0, 0, 0, 0.098)", // --app-color-simple-scrim
};

describe("Codex is a built-in light theme", () => {
  it("is listed, by name, with a light face and no dark one", () => {
    const def = THEMES.find((t) => t.name === "codex");
    expect(def?.label).toBe("Codex");
    expect(allThemes().some((t) => t.name === "codex")).toBe(true);
    expect(themeModes("codex")).toEqual(["light"]);
    // A dark slot naming it falls back rather than conjuring a dark Codex.
    expect(paletteFor({ light: "codex", dark: "codex" }, "dark")).toBe("realm");
  });

  it("resolves every token a theme must set, and its extra ramps, and nothing else", () => {
    const v = themeVars("codex", "light");
    for (const k of THEME_VARS) expect(v[k], k).toBeTruthy();
    for (const k of THEME_EXTRA_VARS) expect(v[k], k).toBeTruthy();
    expect(Object.keys(v).sort()).toEqual([...THEME_VARS, ...THEME_EXTRA_VARS].sort());
  });

  it("reproduces Codex's own light palette exactly", () => {
    // THE realm-ramp mutant: drop `derive` from the Codex entry. Realm's ramp on the same seed caps
    // the paper at L .986, sinks the page by .017 and solves its own ink tiers — every ground and
    // tier moves, and this table is what notices.
    const v = themeVars("codex", "light");
    for (const [token, want] of Object.entries(CODEX_RESOLVED)) expect(px(v[token]!), token).toBe(want);
  });

  it("derives the way Codex does from any seed — the owner's screenshot is Codex on One Light's colours", () => {
    // Codex builds a chrome theme from a code theme's editor background and foreground. On One
    // Light's (#fafafa, #383a42) its engine paints the title bar #f2f2f3, the main area #fafafa and
    // the composer #fbfbfb — the three grounds sampled off the owner's screenshot. Realm's colour
    // fields feed this same derivation, so those two hexes reproduce it.
    const v = deriveCodex({ ...CODEX_LIGHT_SEED, bg: "#fafafa", ink: "#383a42" }, CONTRAST_RANGE.default);
    expect(px(v["--page"]!)).toBe("#f2f2f3");
    expect(px(v["--canvas"]!)).toBe("#fafafa");
    expect(px(v["--surface"]!)).toBe("#fbfbfb");
    expect(px(v["--ink"]!)).toBe("#383a42");
  });

  it("maps Realm's contrast default onto Codex's, and moves its ramps with the control", () => {
    expect(codexContrast(CONTRAST_RANGE.default)).toBe(45);
    expect(codexContrast(0)).toBe(0);
    expect(codexContrast(100)).toBe(100);
    const lo = deriveCodex(CODEX_LIGHT_SEED, 20), hi = deriveCodex(CODEX_LIGHT_SEED, 90);
    const ground = parseOklch(lo["--canvas"]!);
    // Higher contrast pulls the secondary tier towards the ink, as Codex's slider does.
    expect(contrast(parseOklch(hi["--ink-2"]!), ground)).toBeGreaterThan(contrast(parseOklch(lo["--ink-2"]!), ground));
  });

  it("clears every floor Realm holds a palette to, at the default contrast", () => {
    // Codex's own values, unmoved: the floor suite in themes.test.ts holds them to the same numbers.
    expect(contrastMisses(CODEX_LIGHT_SEED, "light", CONTRAST_RANGE.default, derivationFor("codex"))).toEqual([]);
  });

  it("leaves nothing behind when the window switches to another palette", () => {
    const props: Record<string, string> = {};
    const root = {
      style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; } },
      dataset: {},
    } as unknown as HTMLElement;
    applyTheme({ space: "#7c6cff", mode: "light", theme: "codex" }, root);
    expect(props["--line"]).toBe("rgba(26, 28, 31, 0.078)");
    applyTheme({ space: "#7c6cff", mode: "light", theme: "one" }, root);
    // THE stranded-ramp mutant: clear only THEME_VARS. One would wear Codex's borders.
    for (const k of THEME_EXTRA_VARS) expect(props[k], k).toBeUndefined();
  });
});

describe("Codex is the light default", () => {
  it("is what a home with no saved light choice wears; dark keeps Realm", () => {
    expect(DEFAULT_SELECTION).toEqual({ light: "codex", dark: "realm" });
    expect(paletteFor(DEFAULT_SELECTION, "light")).toBe("codex");
  });
});
