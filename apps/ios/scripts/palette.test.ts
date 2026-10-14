import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script with no type declarations
import { CATALOG, TOKENS, TOKENS_CSS, build, drift, faces, parseColor, resolve } from "./palette.mjs";

const css = readFileSync(TOKENS_CSS, "utf8");
const colorSet = (files: Map<string, string>, name: string) => JSON.parse(files.get(join(CATALOG, `${name}.colorset`, "Contents.json"))!);
const components = (set: { colors: { appearances?: unknown[]; color: { components: Record<string, string> } }[] }, dark: boolean) =>
  set.colors.find((c) => Boolean(c.appearances) === dark)!.color.components;

describe("the iPhone's palette", () => {
  it("is the desktop's tokens.css, colour for colour", () => {
    // Fails when tokens.css changes and the colour sets were not regenerated, or the other way round.
    expect(drift(), "run: node apps/ios/scripts/palette.mjs").toEqual([]);
  });

  it("notices a token that moves", () => {
    const moved = css.replace("--page: oklch(0.209 0.004 264.477);", "--page: oklch(0.25 0.004 264.477);");
    expect(moved).not.toBe(css);
    expect(drift(build(moved))).toContain("apps/ios/Realm/Assets.xcassets/Palette/Page.colorset/Contents.json differs from tokens.css");
  });

  it("reads both faces, light laid over dark", () => {
    const { dark, light } = faces(css);
    for (const [token] of TOKENS) {
      expect(() => parseColor(resolve(dark.get(`--${token}`), dark)), `--${token} (dark)`).not.toThrow();
      expect(() => parseColor(resolve(light.get(`--${token}`), light)), `--${token} (light)`).not.toThrow();
    }
    // The ordinary line is an overlay, white over the dark ground and black over the light one.
    const files = build();
    const line = colorSet(files, "Line");
    expect(components(line, true)).toMatchObject({ red: "1.0000", alpha: "0.0588" });
    expect(components(line, false)).toMatchObject({ red: "0.0000", alpha: "0.0392" });
  });

  it("converts OKLCH to Display P3 as a wide-gamut browser shows it", () => {
    const files = build();
    expect(components(colorSet(files, "Surface"), false)).toEqual({ alpha: "1.0000", red: "1.0000", green: "1.0000", blue: "1.0000" });
    // The dark accent is just outside sRGB; Display P3 holds it.
    expect(components(colorSet(files, "AccentColor"), true)).toEqual({ alpha: "1.0000", red: "0.3412", green: "0.5957", blue: "0.9709" });
    expect(components(colorSet(files, "Page"), true)).toEqual({ alpha: "1.0000", red: "0.0913", green: "0.0942", blue: "0.1010" });
  });

  it("names every colour once, in Swift too", () => {
    const swift = [...build().entries()].find(([path]) => path.endsWith("Theme/Palette.swift"))![1];
    for (const [, set, name] of TOKENS) expect(swift).toContain(`static let ${name} = Color("${set}")`);
    expect(new Set(TOKENS.map(([, set]: string[]) => set)).size).toBe(TOKENS.length);
  });
});
