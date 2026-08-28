import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** §6's motion table and its "do NOT animate" list are enforceable only against the stylesheet
 *  itself — jsdom has no layout, no compositor and no CSSOM for a raw file, so nothing else in the
 *  suite can notice a stray `transition:` on a resize handle or a pop-in creeping back onto the
 *  command palette. These read the real `styles.css` and assert the values written by hand from the
 *  spec, so a one-line edit to a duration, an easing or a forbidden surface fails here. */
/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd instead
   (vitest may be invoked from the repo root or from apps/desktop). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
/* Comments are stripped first: they sit between rules and would otherwise be swallowed into the
   following selector, and prose about `transition: all` must not read as a use of it. */
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Flat (non-nested) rules: `selector { body }`. Bodies containing braces — @media, @keyframes —
 *  never match as a whole, so their inner rules are picked up with their own bare selectors instead. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
  body: m[2]!.replace(/\s+/g, " ").trim(),
}));

/** Every declaration block of every rule that lists `selector` as one of its comma-separated parts. */
const bodiesFor = (selector: string): string[] => {
  const hits = RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body);
  expect(hits.length, `no rule in styles.css targets \`${selector}\``).toBeGreaterThan(0);
  return hits;
};

/** Brace-balanced contents of every block introduced by `prelude` (an at-rule or keyframes header). */
function blocksAfter(prelude: string): string[] {
  const out: string[] = [];
  for (let at = css.indexOf(prelude); at >= 0; at = css.indexOf(prelude, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push(css.slice(open + 1, i)); break; }
    }
  }
  expect(out.length, `${prelude} is missing from styles.css`).toBeGreaterThan(0);
  return out;
}
const blockAfter = (prelude: string): string => blocksAfter(prelude).join("\n");

describe("§6 motion table", () => {
  it("sheets enter at 240ms ease-out-strong with a .96 scale — one rule for every sheet, no per-sheet carve-out", () => {
    expect(bodiesFor(".sheet").join(" ")).toContain("animation: rl-sheet-in 240ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-sheet-in")).toContain("scale(.96)");
    // W4b scoped 240ms to onboarding alone; W5's whole job was to hoist it. If the override comes
    // back, the shared sheet has silently regressed to something else.
    expect(bodiesFor(".sheet.onboarding").join(" ")).not.toContain("animation");
  });

  it("the sheet scrim fades on its own at 160ms", () => {
    expect(bodiesFor(".sheet-backdrop").join(" ")).toContain("animation: rl-fade-in 160ms");
  });

  it("menus enter at 140ms ease-out-strong, scale .97→1, from an origin the component supplies", () => {
    expect(bodiesFor(".menu").join(" ")).toContain("animation: rl-menu-in 140ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-menu-in")).toContain("scale(.97)");
  });

  it("transcript items enter at 180ms with a 6px rise, gated on the data-enter mark Transcript.tsx sets", () => {
    expect(bodiesFor(".transcript-col > [data-enter]").join(" ")).toContain("animation: rl-msg-in 180ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-msg-in")).toContain("translateY(6px)");
  });

  it("hover fills run 100ms on plain `ease` and touch background/colour only — never geometry", () => {
    const hover = bodiesFor(".item-row").join(" ");
    expect(hover).toContain("transition: background-color 100ms ease, color 100ms ease");
    expect(hover).not.toContain("transform");
  });

  it("pressables scale to .97 over 120ms", () => {
    const press = bodiesFor(".ghost-chip").join(" ");
    expect(press).toContain("transform 120ms var(--ease-out-strong)");
    for (const sel of [".btn:active:not(:disabled)", ".icon-btn:active:not(:disabled)", ".composer-send:active:not(:disabled)"])
      expect(bodiesFor(sel).join(" "), sel).toContain("transform: scale(.97)");
  });

  it("the send↔stop icon swap cross-fades over 160ms with opacity, scale and blur", () => {
    const swap = bodiesFor(".composer-send svg").join(" ");
    for (const prop of ["opacity 160ms", "transform 160ms", "filter 160ms"]) expect(swap, prop).toContain(prop);
    expect(bodiesFor('.composer-send[data-state="send"] .stop-icon').join(" ")).toContain("blur(4px)");
  });

  it("the tool row expands by animating grid-template-rows over 200ms, with the content fading at 120ms", () => {
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain("transition: grid-template-rows 200ms var(--ease-in-out-strong)");
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain("grid-template-rows: 0fr");
    expect(bodiesFor(".tool-card[data-open] .tool-body-wrap").join(" ")).toContain("grid-template-rows: 1fr");
    expect(bodiesFor(".tool-body").join(" ")).toContain("transition: opacity 120ms ease");
  });

  it("the copy ✓ swap uses the same 160ms opacity/scale/blur cross-fade as send↔stop", () => {
    const swap = bodiesFor(".tool-copy .copy-icon").join(" ");
    for (const prop of ["opacity 160ms", "transform 160ms", "filter 160ms"]) expect(swap, prop).toContain(prop);
    expect(bodiesFor(".tool-copy:not([data-copied]) .copied-icon").join(" ")).toContain("blur(4px)");
  });

  it("W2's prompter hero→docked move keeps its 320ms ease-in-out-strong (§6 assigns that easing to on-screen movement)", () => {
    expect(bodiesFor(".composer-dock").join(" ")).toContain("transition: transform 320ms var(--ease-in-out-strong)");
  });

  it("W2's suggestion-chip stagger keeps §6's 220ms / 40ms steps / 8px rise", () => {
    const stagger = bodiesFor(".suggestions[data-animate] .suggestion-chip").join(" ");
    expect(stagger).toContain("rl-chip-in 220ms var(--ease-out-strong)");
    expect(stagger).toContain("calc(var(--i) * 40ms)");
    expect(blockAfter("@keyframes rl-chip-in")).toContain("translateY(8px)");
  });

  it("the waiting status dot keeps the 0.9s pulse — §6's only looping motion at rest", () => {
    expect(bodiesFor('.status-dot[data-status="waiting_permission"]').join(" ")).toContain("rl-pulse 0.9s ease-in-out infinite");
  });

  it("`will-change` is reserved for the swiper track (§6 performance note)", () => {
    const owners = RULES.filter((r) => r.body.includes("will-change")).flatMap((r) => r.selectors);
    expect(owners).toEqual([".swiper-track"]);
  });
});

describe("§6 do-NOT-animate list", () => {
  it("never uses `transition: all` anywhere", () => {
    expect(css).not.toMatch(/transition:\s*all\b/);
    expect(css).not.toMatch(/transition-property:\s*all\b/);
  });

  it("the command palette and its scrim are instant — ⌘K is a 100×/day action (Raycast rule)", () => {
    for (const sel of [".palette", ".palette-backdrop"]) {
      for (const body of bodiesFor(sel)) {
        expect(body.match(/animation:\s*([^;]*)/)?.[1]?.trim() ?? "none", `${sel} { ${body} }`).toBe("none");
        expect(body, `${sel} { ${body} }`).not.toContain("transition");
      }
    }
  });

  it("resize handles carry no transition or animation — a drag must track the pointer exactly", () => {
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.startsWith(".resize-handle")))) {
      expect(r.body, r.selectors.join(",")).not.toContain("transition");
      expect(r.body, r.selectors.join(",")).not.toContain("animation");
    }
  });

  it("the focused-pane marks are instant — §6 does not animate pane focus switching", () => {
    // The underline, the inked header icon and the empty-leaf top rule all move when focus moves.
    const focusRules = RULES.filter((x) => x.selectors.some((s) => /^\.panel(\[data-focused\]|-title|-icon)/.test(s)));
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const r of focusRules) expect(r.body, r.selectors.join(",")).not.toContain("transition");
  });

  it("a theme swap is fenced by a root mark that kills every transition (useTheme sets it)", () => {
    expect(bodiesFor(":root[data-theme-switching] *").join(" ")).toContain("transition: none !important");
  });

  it("prefers-reduced-motion strips every animation and transition, and hides the spinner", () => {
    const reduced = blockAfter("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain(".spin { display: none; }");
  });
});
