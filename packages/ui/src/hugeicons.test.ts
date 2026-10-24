import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as freePack from "./hugeicons";
import { HUGEICONS_PRO, hasHugeiconsPro } from "./hugeicons-pack";
import { icons } from "./Icon";

/** The export names `Icon.tsx` takes from `#hugeicons`, read from its import. */
function importedNames(): string[] {
  const source = readFileSync(new URL("./Icon.tsx", import.meta.url), "utf8");
  const list = /import \{([^}]*)\} from "#hugeicons";/.exec(source)?.[1] ?? "";
  return list.replace(/\/\/.*$/gm, "").split(",").map((name) => name.trim()).filter(Boolean);
}

const isGlyph = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((part) => Array.isArray(part) && typeof part[0] === "string");

/* `./hugeicons` is the free pack in either install: the config's alias swaps `#hugeicons`, not the file.
   The Pro pack is only here where the registry token installed it. */
const free: Record<string, unknown> = freePack;
const pro: Record<string, unknown> | null = hasHugeiconsPro() ? await import(HUGEICONS_PRO) : null;

describe("the glyphs, with the Pro pack and without it", () => {
  const names = importedNames();

  it("reads Icon.tsx's whole import", () => {
    expect(names.length).toBeGreaterThan(150);
    expect(names).toContain("Add01Icon");
    expect(names).toContain("DragDropVerticalIcon");
  });

  it("finds every name in the free pack, so a build without the Pro token draws them all", () => {
    expect(names.filter((name) => !isGlyph(free[name]))).toEqual([]);
  });

  it.skipIf(!pro)("finds every name in the Pro pack", () => {
    expect(names.filter((name) => !isGlyph(pro![name]))).toEqual([]);
  });

  /* By identity, not by drawing: at 1.2.1 the two packs draw the same paths, so only where a glyph
     came from tells them apart. */
  it(`draws the ${pro ? "Pro" : "free"} pack's own glyphs`, () => {
    const pack = pro ?? free;
    const own = new Set(Object.values(pack));
    const { shieldQuestion, shieldAlert, ...rest } = icons;
    expect(Object.entries(rest).filter(([, glyph]) => !own.has(glyph)).map(([name]) => name)).toEqual([]);
    // The permission control's asking and warning shields are drawn on the pack's own Shield01 outline.
    const outline = (pack.Shield01Icon as readonly unknown[])[0];
    expect(shieldQuestion[0]).toBe(outline);
    expect(shieldAlert[0]).toBe(outline);
  });
});
