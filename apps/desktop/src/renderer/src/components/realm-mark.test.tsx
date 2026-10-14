import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrowserConnecting, BrowserErrorPage } from "../panes/browser/BrowserErrorPage";
import { REALM_MARK_PATH, REALM_MARK_VIEWBOX } from "./RealmMark";

const here = dirname(new URL(import.meta.url).pathname);
const flatSvg = readFileSync(join(here, "../../../../../../resources/icon-src/mark-flat.svg"), "utf8");
/** The spiral the browser pane used to wear: Realm's old hexagon wound in on itself. */
const OLD_SPIRAL = "M18.99 20.48";

describe("Realm's flat mark in the window", () => {
  /* A copy, because a glyph inside a component cannot fetch its geometry — and a copy that drifts from
     resources/icon-src/mark.mjs is a second logo. */
  it("is resources/icon-src/mark-flat.svg's path, cropped to the silhouette", () => {
    expect(flatSvg).toContain(`d="${REALM_MARK_PATH}"`);
    expect(flatSvg).toContain('fill-rule="evenodd"');
    expect(REALM_MARK_VIEWBOX).toBe("0 6.6795 40 34.641");
  });

  it("is what a page that did not load wears, in place of the spiral", () => {
    const { container } = render(
      <BrowserErrorPage error={{ code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" }} busy={false} onReload={() => {}} />,
    );
    const mark = container.querySelector("svg.reach-mark")!;
    expect(mark.getAttribute("viewBox")).toBe(REALM_MARK_VIEWBOX);
    expect(mark.querySelector("path.reach-mark-shape")?.getAttribute("d")).toBe(REALM_MARK_PATH);
    expect(mark.querySelector("path.reach-mark-shape")?.getAttribute("fill-rule")).toBe("evenodd");
    expect(mark).not.toHaveAttribute("data-busy");
    expect(container.innerHTML).not.toContain(OLD_SPIRAL);
  });

  it("clips its glint to the mark's own shape, the doorway cut out, and says busy while a page loads", () => {
    const { container } = render(<BrowserConnecting />);
    const mark = container.querySelector("svg.reach-mark")!;
    expect(mark).toHaveAttribute("data-busy");
    const clip = mark.querySelector("clipPath")!;
    expect(clip.querySelector("path")?.getAttribute("d")).toBe(REALM_MARK_PATH);
    expect(clip.querySelector("path")?.getAttribute("clip-rule")).toBe("evenodd");
    // The glint is drawn inside that clip, and the clip's id is one url(#…) can name.
    expect(mark.querySelector("g")?.getAttribute("clip-path")).toBe(`url(#${clip.id})`);
    expect(clip.id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(mark.querySelector("g > rect.reach-mark-glint")).not.toBeNull();
    expect(container.innerHTML).not.toContain(OLD_SPIRAL);
  });

  it("sweeps a shimmer, not a wipe: the band's middle is the shine, between the accent on both sides", () => {
    const { container } = render(<BrowserConnecting />);
    const band = container.querySelector("svg.reach-mark linearGradient")!;
    const rect = container.querySelector("rect.reach-mark-glint")!;
    expect(rect.getAttribute("fill")).toBe(`url(#${band.id})`);
    const stops = [...band.querySelectorAll("stop")].map((s) => ({ at: s.getAttribute("offset"), shine: s.classList.contains("reach-mark-shine"), color: s.getAttribute("stop-color") }));
    expect(stops.filter((s) => s.shine).map((s) => s.at)).toEqual([".5"]);
    // The shine takes its colour from the stylesheet, per face; everything else is the mark's accent.
    expect(stops.filter((s) => !s.shine).every((s) => s.color === "currentColor")).toBe(true);
    expect(stops.find((s) => s.shine)?.color).toBeNull();
  });
});
