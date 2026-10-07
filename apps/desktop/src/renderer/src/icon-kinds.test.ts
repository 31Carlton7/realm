import { describe, expect, it } from "vitest";
import { ItemKindSchema } from "@realm/contracts";
import { brandMarks, icons, isIconName } from "@realm/ui";

/**
 * Every item kind has a glyph.
 *
 * `ItemList` and `PanelBar` render `<Icon name={item.kind} />`, and `Icon` falls back to
 * `icons.folder` for a name it does not hold — silently, because a missing key is not a type error:
 * `name` is an `IconName | string` by the time it arrives from a schema. So a kind added without a
 * glyph does not crash, does not warn, and does not look obviously wrong. It looks like a folder.
 *
 * That is not a hypothetical. A destination page shipped without one and wore a folder in the sidebar
 * and in its own pane bar for as long as the page existed; nobody filed it, because a folder icon on a
 * page is a thing you assume was deliberate. This test is what turns that whole class of failure —
 * silent, permanent, invisible to types and to every rendered assertion that does not happen to
 * mount the offending row — into a red suite.
 *
 * It lives here rather than in `packages/ui` on purpose. The coupling being asserted is the
 * RENDERER'S: `@realm/ui` knows nothing about item kinds, and giving it a dependency on
 * `@realm/contracts` so a test could reach one would invent a package edge to hold a test. This app
 * already depends on both, and is the only place the two meet.
 */
describe("every item kind has an icon", () => {
  const kinds = ItemKindSchema.options;

  it("scans the real enum", () => {
    expect(kinds.length).toBeGreaterThan(10);
    expect(kinds).toContain("session");
    expect(kinds).toContain("machine");
  });

  it("maps every kind to a glyph of its own, with nothing falling through to the folder", () => {
    const missing = kinds.filter((k) => !Object.prototype.hasOwnProperty.call(icons, k));
    expect(missing, "item kinds with no `icons` key — they render as a folder and nothing says so").toEqual([]);
  });

  it("…and `isIconName` agrees, so a kind is a legal name everywhere one is taken", () => {
    expect(kinds.filter((k) => !isIconName(k))).toEqual([]);
  });

  /* The fallback itself stays, and stays tested: a name that genuinely is not a kind — a stored
     space icon from a build that had one this release does not — must still render something rather
     than throwing inside a list. What this test refuses is a KIND relying on it. */
  it("keeps the folder fallback for names that are not kinds at all", () => {
    expect(isIconName("a-glyph-from-some-future-release")).toBe(false);
  });
});

/**
 * No glyph shares a name with a brand mark.
 *
 * `Icon` asks the brand marks first, so a glyph whose key is also a brand's never draws: Settings'
 * "Computer use" page was given `cursor` for its pointer and rendered Cursor's cube, because the
 * Cursor editor is one of the agents with a mark. Nothing about that is a type error — the two maps
 * are one namespace by design — and it reads as a deliberate, if odd, choice of glyph.
 */
describe("glyph names and brand names never collide", () => {
  it("leaves every glyph reachable", () => {
    const shadowed = Object.keys(icons).filter((k) => Object.prototype.hasOwnProperty.call(brandMarks, k));
    expect(shadowed, "glyphs a brand mark of the same name draws over").toEqual([]);
  });
});
