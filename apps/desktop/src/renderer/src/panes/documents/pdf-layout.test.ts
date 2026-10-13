import { describe, expect, it } from "vitest";
import {
  MAX_FIT_WIDTH, PAD_X, PAD_Y, PAGE_GAP, anchorZoom, currentPage, layoutPages, pagesInReach, placeOf, scaleFor, scrollTopFor,
} from "./pdf-layout";
import { findInPage, findLabel } from "./pdf-find";

const LETTER = { w: 816, h: 1056 };
const SLIDE = { w: 1056, h: 816 };
const pages = (n: number, size = LETTER) => Array.from({ length: n }, () => size);

describe("the column of pages", () => {
  it("stacks pages under the top padding, spaced by the gap, with the padding under the last", () => {
    const l = layoutPages(pages(3), 0.5);
    expect(l.tops).toEqual([PAD_Y, PAD_Y + 528 + PAGE_GAP, PAD_Y + 2 * (528 + PAGE_GAP)]);
    expect(l.height).toBe(PAD_Y + 3 * 528 + 2 * PAGE_GAP + PAD_Y);
    expect(l.width).toBe(408 + 2 * PAD_X);
  });

  it("the page being read is the one under the 40% line, a gap belonging to the page above", () => {
    const l = layoutPages(pages(5), 0.5); // pages 528 tall, a page every 544
    // The line at 0 + 1000 * 0.4 = 400: still page 1.
    expect(currentPage(l, 0, 1000)).toBe(0);
    // The line at 300 + 400 = 700 is past page 2's top (568).
    expect(currentPage(l, 300, 1000)).toBe(1);
    // In the gap under page 2 (ends at 1096, next top 1112): still page 2.
    expect(currentPage(l, 1100 - 400, 1000)).toBe(1);
  });
});

describe("fit", () => {
  it("fits the width but caps a page at 900px, so a wide pane never draws a poster", () => {
    expect(scaleFor("width", pages(2), { w: 600, h: 800 })).toBeCloseTo((600 - 2 * PAD_X) / 816);
    expect(scaleFor("width", pages(2), { w: 2400, h: 800 }) * 816).toBeCloseTo(MAX_FIT_WIDTH);
  });

  it("fits to the WIDEST page, so a slide in a portrait deck never runs off the side", () => {
    expect(scaleFor("width", [LETTER, SLIDE], { w: 700, h: 800 }) * SLIDE.w).toBeCloseTo(700 - 2 * PAD_X);
  });

  it("fit page shows a whole page in the box, whichever way is shorter", () => {
    const s = scaleFor("page", pages(2), { w: 2000, h: 600 });
    expect(s * LETTER.h).toBeCloseTo(600 - 2 * PAD_Y);
    expect(scaleFor("page", pages(2), { w: 400, h: 2000 }) * LETTER.w).toBeCloseTo(400 - 2 * PAD_X);
  });

  it("a number is the scale itself", () => {
    expect(scaleFor(1.5, pages(2), { w: 10, h: 10 })).toBe(1.5);
  });
});

describe("the reader's place", () => {
  it("is a page and a fraction, and lands on the same line at another zoom", () => {
    const small = layoutPages(pages(10), 0.5), big = layoutPages(pages(10), 2);
    const top = small.tops[6]! + 0.25 * small.sizes[6]!.h;
    const place = placeOf(small, top);
    expect(place.page).toBe(6);
    expect(place.fraction).toBeCloseTo(0.25);
    expect(scrollTopFor(big, place)).toBe(Math.round(big.tops[6]! + 0.25 * big.sizes[6]!.h));
  });

  it("a rewrite that made the file shorter lands on its last page, not past the end", () => {
    const l = layoutPages(pages(4), 1);
    expect(scrollTopFor(l, { page: 21, fraction: 0.6 })).toBe(l.tops[3]);
  });

  it("only pages within two viewports either way are worth a bitmap", () => {
    const l = layoutPages(pages(300), 1); // pages a 1072 pitch apart
    const r = pagesInReach(l, 100 * 1072, 800);
    expect(r.first).toBeGreaterThanOrEqual(97);
    expect(r.last).toBeLessThanOrEqual(103);
    expect(r.last - r.first).toBeLessThanOrEqual(6);
  });

  it("a zoom round the pointer keeps the line under it", () => {
    const from = layoutPages(pages(10), 1), to = layoutPages(pages(10), 2);
    const box = { w: 900, h: 800 };
    const at = { x: 450, y: 300 };
    const scroll = { left: 0, top: from.tops[3]! + 200 };
    const next = anchorZoom({ from, to, at, scroll, box });
    const before = placeOf(from, scroll.top + at.y), after = placeOf(to, next.top + at.y);
    expect(after.page).toBe(before.page);
    expect(after.fraction).toBeCloseTo(before.fraction, 2);
  });
});

describe("find", () => {
  const runs = [
    { str: "The Lighthouse stands", eol: true },
    { str: "on the cape; a light", eol: false },
    { str: "house is not.", eol: true },
  ];

  it("finds a word whatever its case, as pieces of the runs the text layer draws", () => {
    expect(findInPage(4, runs, "lighthouse")).toEqual([
      { page: 4, pieces: [{ run: 0, start: 4, end: 14 }] },
      { page: 4, pieces: [{ run: 1, start: 15, end: 20 }, { run: 2, start: 0, end: 5 }] },
    ]);
  });

  it("finds a phrase across the end of a line and across two runs", () => {
    expect(findInPage(0, runs, "stands on")).toEqual([{ page: 0, pieces: [{ run: 0, start: 15, end: 21 }, { run: 1, start: 0, end: 2 }] }]);
    expect(findInPage(0, runs, "light house")).toEqual([]);
    expect(findInPage(0, runs, "a lighthouse")).toEqual([{ page: 0, pieces: [{ run: 1, start: 13, end: 20 }, { run: 2, start: 0, end: 5 }] }]);
  });

  it("counts every hit, and says so as a reader expects", () => {
    expect(findInPage(0, [{ str: "a a  a", eol: false }], "a")).toHaveLength(3);
    expect(findInPage(0, runs, "   ")).toEqual([]);
    expect(findLabel(1, 17, false)).toBe("2 of 17");
    expect(findLabel(0, 0, true)).toBe("Searching…");
    expect(findLabel(0, 0, false)).toBe("No matches");
  });
});
