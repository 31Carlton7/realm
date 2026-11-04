import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** design.md: the phone draws no Liquid Glass and no material anywhere. A bar over scrolling content
 *  takes the Photos edge (`softEdges`), and a bar's buttons sit on Realm's ground. iOS 26 puts glass
 *  under every toolbar button by default, so each one has to say otherwise. */
const views = new URL("../Realm/", import.meta.url);
const sources = readdirSync(views, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".swift"))
  .map((path) => ({ path, text: readFileSync(new URL(path, views), "utf8") }));

describe("the iPhone's chrome", () => {
  it("draws no glass and no material", () => {
    const glass = /glassEffect|GlassEffectContainer|\.buttonStyle\(\.glass|Material\b|\.toolbarBackground\(|\.searchable\(/;
    expect(sources.filter(({ text }) => glass.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it("hides the glass under every toolbar button but a title", () => {
    const counts = sources.map(({ path, text }) => {
      const items = [...text.matchAll(/^\s*ToolbarItem(?:Group)?\((.*)$/gm)].filter((m) => !m[1]!.includes(".principal")).length;
      const hidden = text.match(/\.sharedBackgroundVisibility\(\.hidden\)/g)?.length ?? 0;
      return { path, items, hidden };
    });
    expect(counts.filter(({ items, hidden }) => items !== hidden)).toEqual([]);
  });

  it("softens the edges of every list a bar sits over", () => {
    const lists = sources.filter(({ text }) => /\.scrollContentBackground\(\.hidden\)/.test(text));
    expect(lists.filter(({ text }) => !text.includes(".softEdges(")).map(({ path }) => path)).toEqual([]);
  });

  it("keeps what is pinned over the list on the ground, so no row reads through it", () => {
    const text = (name: string) => sources.find(({ path }) => path.endsWith(name))!.text;
    expect(text("HomeChips.swift")).toMatch(/\.background\(Ground\.transcript\)/);
    const head = text("HomeView.swift").match(/struct SectionHead<[\s\S]*?\n}\n/)![0];
    expect(head).toContain(".pinnedOnGround()");
    // Beside another view in a stack, a head takes the list's header insets and its ground stops short.
    const stacked = sources.filter(({ text }) => /HStack[^{]*\{\s*SectionHead\(/.test(text)).map(({ path }) => path);
    expect(stacked).toEqual([]);
  });
});
