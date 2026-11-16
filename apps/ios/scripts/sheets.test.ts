import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A sheet closes and commits one way (the audit's SHEET-04): the way out of a sheet's bar is the X,
 *  whatever VoiceOver calls it ("Close", "Cancel", "Not now"), and what a bar commits is its word
 *  ("Save", "Create", "Pair"), never a glyph alone. Foot buttons on a fitted confirm are words too. */
const views = new URL("../Realm/", import.meta.url);
const sources = readdirSync(views, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".swift"))
  .map((path) => ({ path, text: readFileSync(new URL(path, views), "utf8") }));

/** Each `ToolbarItem(...) { ... }` in a file, with its placement, cut at the next item or the toolbar's end. */
function toolbarItems(text: string) {
  return [...text.matchAll(/ToolbarItem\(placement: \.(\w+)\) \{([\s\S]*?)\n\s*\}\n\s*\.sharedBackgroundVisibility/g)]
    .map((m) => ({ placement: m[1]!, body: m[2]! }));
}

describe("a sheet's bar", () => {
  it("leaves by the X", () => {
    const words = sources.flatMap(({ path, text }) => toolbarItems(text)
      .filter(({ body }) => /Button\("(Cancel|Close|Not now|Done)"/.test(body) && !/systemImage: "xmark"/.test(body))
      .map(({ body }) => `${path}: ${body.trim().split("\n")[0]}`));
    expect(words).toEqual([]);
  });

  it("commits with a word, never a check alone", () => {
    const checks = sources.flatMap(({ path, text }) => toolbarItems(text)
      .filter(({ body }) => /Button\([^)]*systemImage: "checkmark"\)/.test(body))
      .map(({ body }) => `${path}: ${body.trim().split("\n")[0]}`));
    expect(checks).toEqual([]);
  });

  it("finds the bars it checks", () => {
    // The two above pass on a file they cannot parse; this one fails when the pattern stops matching.
    expect(sources.flatMap(({ text }) => toolbarItems(text)).length).toBeGreaterThan(40);
  });
});
