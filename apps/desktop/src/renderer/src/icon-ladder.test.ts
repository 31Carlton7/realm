import { describe, expect, it } from "vitest";

/** The five rungs of Icon.tsx's ladder — card, tile, row, control, inline. */
const RUNGS = new Set([20, 18, 16, 14, 12]);

/* Every renderer component as source text. Read through Vite rather than off disk so the paths
   resolve against this module and the scan does not care whether vitest was invoked from the repo
   root or from apps/desktop. */
const SOURCES = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Opening `<Icon …>` / `<SpaceIcon …>` tags, with the `size` they pass. */
const ICON_TAG = /<(Icon|SpaceIcon)\b[^<>]*?\bsize=\{(\d+)\}/gs;

/**
 * The ladder is documented on `Icon` (packages/ui/src/Icon.tsx) and enforceable only here: `size` is
 * a plain number, so nothing in a type or a render can notice a call site quietly picking 15.
 * Scanning source is the whole point — a rendered assertion would only cover the components a test
 * happens to mount, and the drift this pins is in the ones nobody mounts.
 *
 * The scan reads the whole renderer, not one directory. While it covered only the sidebar, GroupBar
 * was written at 13 throughout and nothing noticed: a ladder that governs the folder it was born in
 * is a house style, not a rule.
 *
 * Only `Icon` and `SpaceIcon` are matched. `size` is an ordinary prop on other components (Spinner
 * takes one) and those are not on this ladder; catching them would make the scan fail for reasons it
 * cannot explain.
 */
describe("icon ladder", () => {
  const files = Object.entries(SOURCES).filter(([name]) => !name.includes(".test."));

  it("scans the whole renderer", () => {
    expect(files.length, "the source glob found nothing — the scan would pass vacuously").toBeGreaterThan(50);
    expect(files.map(([n]) => n)).toContain("./components/GroupBar.tsx");
    expect(files.map(([n]) => n)).toContain("./components/sidebar/ItemList.tsx");
  });

  it("every call site sits on a rung, or says at the call site why it cannot", () => {
    const offenders: string[] = [];
    for (const [name, src] of files) {
      for (const m of src.matchAll(ICON_TAG)) {
        if (RUNGS.has(Number(m[2]))) continue;
        // An off-ladder size is allowed only where the reason is written at the call site, which is
        // where the next reader stands. A list of blessed files kept in this test would spare them
        // the sentence and hide the exception from the code it applies to.
        const lines = src.slice(0, m.index).split("\n");
        const context = lines.slice(-4).join("\n");   // room for a two-line reason above the call
        if (context.includes("off-ladder:")) continue;
        offenders.push(`${name.replace("./", "")}:${lines.length}: size={${m[2]}}`);
      }
    }
    expect(offenders, "off-ladder icon sizes — pick a rung, or write `off-ladder:` and the reason above the call").toEqual([]);
  });
});
