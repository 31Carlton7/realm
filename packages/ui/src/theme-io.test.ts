import { describe, expect, it } from "vitest";
import { THEME_DOC_VERSION, exportTheme, importTheme } from "./theme-io";
import { REALM_SEED, THEMES, deriveVars, seedFor } from "./themes";

const one = seedFor("one", "dark")!;
const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ realmTheme: 1, name: "One", mode: "dark", seed: one, ...over });

describe("what a theme travels as", () => {
  it("round-trips every palette in the app, in every face it has", () => {
    // THE derived-document mutant: export the ninety derived properties instead of the twelve seeds.
    // It reads back into the same window today and goes stale the moment a ramp constant moves — and
    // it arrives as raw colours the contrast floors never got to look at.
    for (const theme of THEMES) {
      for (const mode of ["dark", "light"] as const) {
        const seed = seedFor(theme.name, mode) ?? (theme.name === "realm" ? REALM_SEED[mode] : null);
        if (!seed) continue;
        const back = importTheme(exportTheme(theme.label, mode, seed), mode);
        expect(back.ok, `${theme.name}/${mode}`).toBe(true);
        if (!back.ok) return;
        expect(back.doc.seed).toEqual(seed);
        // ...and through the machinery, which is the claim that matters: the same twelve values give
        // the same palette wherever they land.
        expect(deriveVars(back.doc.seed, mode)).toEqual(deriveVars(seed, mode));
      }
    }
  });

  it("is JSON a person can read and edit, not an opaque blob", () => {
    const text = exportTheme("One", "dark", one);
    expect(text).toContain('"realmTheme": 1');
    expect(text).toContain('"mode": "dark"');
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).seed.accent).toBe(one.accent);
  });
});

describe("a blob that is not a theme is refused, and told why", () => {
  const reason = (text: string, face: "dark" | "light" = "dark") => {
    const r = importTheme(text, face);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.reason;
  };

  it("names what is wrong with the thing that was pasted", () => {
    // THE catch-all mutant: one "invalid theme" for every failure. It sends someone back to a JSON
    // blob with no idea which of ninety characters to look at, which is the same as no message.
    expect(reason("not json at all")).toMatch(/not JSON/);
    expect(reason("[1,2,3]")).toMatch(/JSON object/);
    expect(reason('{"hello":"world"}')).toMatch(/realmTheme/);
    expect(reason(doc({ mode: "sepia" }))).toMatch(/light or a dark/);
    expect(reason(doc({ seed: undefined }))).toMatch(/carry a seed/);
    // Every one is different, or the messages are decoration.
    const all = ["not json", "[1]", "{}", doc({ mode: 3 }), doc({ seed: 7 })].map((t) => reason(t));
    expect(new Set(all).size).toBe(all.length);
  });

  it("refuses a seed that is short a colour, and says which ones", () => {
    // THE partial-import mutant: accept whatever roles are present and merge them over the current
    // palette. A document missing its syntax block would silently become an edit to three colours of
    // whatever happened to be selected, presented as having imported a theme.
    const { syntax, ...noSyntax } = one;
    expect(reason(doc({ seed: { ...noSyntax, bg: undefined } }))).toMatch(/bg, syntax\.comment/);
    expect(reason(doc({ seed: { ...one, accent: "cornflowerblue" } }))).toMatch(/not hex colours: accent/);
    expect(reason(doc({ seed: { ...one, syntax: { ...syntax, keyword: "#12345" } } }))).toMatch(/syntax\.keyword/);
  });

  it("refuses a face it was not written for rather than producing a broken one", () => {
    // A dark seed in the light slot is not a dark light theme — the light ramp SINKS its surfaces
    // below the page, so the ladder inverts, and `color-scheme: light` puts light scrollbars on it.
    // THE any-face mutant: drop the check. It imports, it looks catastrophic, and nothing said so.
    expect(reason(doc(), "light")).toMatch(/dark theme.*Dark theme row/s);
    expect(importTheme(doc({ mode: "light" }), "light").ok).toBe(true);
  });

  it("refuses a format from a newer build rather than reading the fields it happens to share", () => {
    // A version bump is how a later format says the old reading of it is wrong.
    expect(reason(doc({ realmTheme: THEME_DOC_VERSION + 1 }))).toMatch(/newer version/);
    expect(importTheme(doc({ realmTheme: THEME_DOC_VERSION }), "dark").ok).toBe(true);
  });

  it("keeps only the twelve, so nothing else in the document reaches the derivation", () => {
    // THE cast mutant: take `d.seed` as a ThemeSeed. A document carrying `bg: "#101014", __proto__:
    // …` or an extra hundred keys would be stored and re-exported forever.
    const r = importTheme(doc({ seed: { ...one, extra: "#ffffff", nested: { a: 1 } } }), "dark");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.doc.seed).sort()).toEqual(["accent", "bg", "green", "ink", "orange", "red", "syntax"]);
    expect(Object.keys(r.doc.seed.syntax).sort()).toEqual(["attr", "comment", "keyword", "number", "string", "title", "type"]);
  });

  it("survives a document with no usable name", () => {
    for (const name of [undefined, "", "   ", 7]) {
      const r = importTheme(doc({ name }), "dark");
      expect(r.ok, String(name)).toBe(true);
      if (r.ok) expect(r.doc.name.length).toBeGreaterThan(0);
    }
    expect(importTheme(doc({ name: "x".repeat(500) }), "dark")).toMatchObject({ doc: { name: "x".repeat(60) } });
  });
});
