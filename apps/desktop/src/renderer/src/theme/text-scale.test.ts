import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaleTextSizes } from "./text-scale";

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

const one = (css: string) => scaleTextSizes(css).replace(/\s+/g, " ").trim();

describe("scaling the stylesheet's text sizes", () => {
  it("multiplies a px size by the element's scale, floored at 11px", () => {
    // THE literal mutant: leave the size alone, and the preference reaches nothing.
    expect(one(".a { font-size: 13px; }")).toBe(".a { font-size: max(11px, calc(13px * var(--text-scale, 1))); }");
  });

  it("leaves a size under the floor as written, with the line-height it was boxed against", () => {
    // The named exceptions — text in a box whose height is fixed by something else. THE mutant:
    // scale them, and a 12px calendar cell holds 13px of weekday.
    expect(one(".cal { height: 12px; font-size: 10px; line-height: 12px; }")).toBe(".cal { height: 12px; font-size: 10px; line-height: 12px; }");
  });

  it("scales the size and px line-height of a font shorthand, and leaves relative units relative", () => {
    expect(one("html { font: var(--fw-body) 14px/20px var(--font-ui); }"))
      .toBe("html { --text-scale: var(--ui-text-scale, 1); font: var(--fw-body) max(11px, calc(14px * var(--text-scale, 1)))/calc(20px * var(--text-scale, 1)) var(--font-ui); }");
    expect(one(".x { font-size: 0.9em; line-height: 1.5; }")).toBe(".x { font-size: 0.9em; line-height: 1.5; }");
  });

  it("gives a rule that sets the code face the code scale, and one that sets the UI or content face the UI scale", () => {
    // THE one-scale mutant: every size on one multiplier, so "Code font size" moves the prose.
    expect(one(".md code { font: 12px var(--font-mono); }")).toContain("--text-scale: var(--code-text-scale, 1);");
    expect(one(".k { font-family: var(--font-mono); font-size: 11px; }")).toContain("--text-scale: var(--code-text-scale, 1);");
    expect(one(".p { font-family: var(--font-content); }")).toContain("--text-scale: var(--ui-text-scale, 1);");
    // A rule that sets no face declares nothing, and inherits the scale with the face.
    expect(one(".r { font-size: 12px; }")).not.toContain("--text-scale:");
  });

  it("rewrites rules inside at-rules, and never the comments that quote them", () => {
    expect(one("@container (max-width: 640px) { .e { font-size: 12px; } }")).toContain("max(11px, calc(12px * var(--text-scale, 1)))");
    const quoted = "/* `.x { font-size: 13px }` reads as one rule */ .y { color: red; }";
    expect(one(quoted)).toBe(quoted);
  });
});

describe("the real stylesheet, as the build serves it", () => {
  const source = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
  const built = scaleTextSizes(source);
  const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("keeps every block it was given — the shape is untouched", () => {
    expect((code(built).match(/\{/g) ?? []).length).toBe((code(source).match(/\{/g) ?? []).length);
    expect((code(built).match(/\}/g) ?? []).length).toBe((code(source).match(/\}/g) ?? []).length);
  });

  it("leaves no px text size at or over the floor unscaled", () => {
    /* Completeness, against the file rather than a sample: a size the transform's patterns miss is
       a size the preference silently does not reach. */
    const left = [...code(built).matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n >= 11);
    expect(left).toEqual([]);
    const shorthand = [...code(built).matchAll(/(?:^|[;\s{])font:\s*[^;]*?(?<!\()(\d+(?:\.\d+)?)px/g)]
      .map((m) => Number(m[1])).filter((n) => n >= 11);
    expect(shorthand).toEqual([]);
  });

  it("puts the window's base text on the UI scale and inline code on the code scale", () => {
    expect(code(built)).toMatch(/html, body, #root \{ --text-scale: var\(--ui-text-scale, 1\);/);
    expect(code(built)).toMatch(/\.md code \{ --text-scale: var\(--code-text-scale, 1\);/);
  });

  it("is wired into the renderer's build, ahead of the plugins that read the CSS after it", () => {
    // THE unwired mutant: the transform exists and nothing runs it, so both size controls are inert.
    const config = readFileSync(repoFile("apps/desktop/electron.vite.config.ts"), "utf8");
    expect(config).toMatch(/renderer: \{ plugins: \[[^\]]*textScale\(\)/);
  });
});
