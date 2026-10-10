import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PALETTES, Realmite, realmiteFromSeed, type RealmiteSpec } from "@realm/ui";
import { useState } from "react";
import { balancedColumns, RealmiteMaker } from "./RealmiteMaker";

afterEach(cleanup);

function Harness({ start, seen }: { start: RealmiteSpec; seen: RealmiteSpec[] }) {
  const [spec, setSpec] = useState(start);
  return <RealmiteMaker spec={spec} name="Creator Manager" onChange={(s) => { seen.push(s); setSpec(s); }} />;
}

const hero = () => screen.getByRole("img", { name: "Creator Manager's Realmite" });

describe("Realmite", () => {
  it("draws inline SVG, decorative unless named, and hoists one stylesheet however many are drawn", () => {
    const spec = realmiteFromSeed("a");
    const { container } = render(<div><Realmite spec={spec} size={24} /><Realmite spec={spec} size={48} title="Growth Analyst" /></div>);
    const svgs = container.querySelectorAll("svg.rmt");
    expect(svgs).toHaveLength(2);
    expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("img", { name: "Growth Analyst" })).toBe(svgs[1]);
    expect(document.querySelectorAll('style[data-href="realm-realmite"], style[href="realm-realmite"]').length).toBe(1);
    // two on one page must not share a clip path
    const ids = [...container.querySelectorAll("clipPath")].map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(container.querySelector("img, image, use[href]")).toBeNull();
  });

  it("marks only a large enough drawing to move", () => {
    const spec = realmiteFromSeed("b");
    const { container } = render(<div><Realmite spec={spec} size={16} state="working" /><Realmite spec={spec} size={160} state="working" /></div>);
    const [row, page] = container.querySelectorAll("svg.rmt");
    expect(row!.hasAttribute("data-animate")).toBe(false);
    expect(page!.hasAttribute("data-animate")).toBe(true);
  });
});

describe("RealmiteMaker", () => {
  it("previews every choice as the creature with that part on, and a pick changes the hero", () => {
    const seen: RealmiteSpec[] = [];
    const start = { ...realmiteFromSeed("maker"), body: "cube" as const };
    render(<Harness start={start} seen={seen} />);
    const bodies = screen.getByRole("radiogroup", { name: "Body" });
    const options = within(bodies).getAllByRole("radio");
    expect(options).toHaveLength(7);
    expect(within(bodies).getByRole("radio", { name: "Cube" }).getAttribute("aria-checked")).toBe("true");
    for (const o of options) expect(o.querySelector("svg.rmt")).not.toBeNull();
    const heroBefore = hero().innerHTML;
    fireEvent.click(within(bodies).getByRole("radio", { name: "Mochi" }));
    expect(seen.at(-1)).toEqual({ ...start, body: "mochi" });
    expect(hero().innerHTML).not.toBe(heroBefore);
    expect(within(bodies).getByRole("radio", { name: "Mochi" }).getAttribute("aria-checked")).toBe("true");
  });

  it("has a row for every part, colour included, and the arrows move the choice", () => {
    const seen: RealmiteSpec[] = [];
    const start = { ...realmiteFromSeed("keys"), palette: "rose" as const };
    render(<Harness start={start} seen={seen} />);
    for (const name of ["Body", "Colour", "Eyes", "Mouth", "Wears", "Pattern"]) screen.getByRole("radiogroup", { name });
    const colours = screen.getByRole("radiogroup", { name: "Colour" });
    expect(within(colours).getAllByRole("radio")).toHaveLength(Object.keys(PALETTES).length);
    const rose = within(colours).getByRole("radio", { name: "Rose" });
    expect(rose.tabIndex).toBe(0);
    fireEvent.keyDown(rose, { key: "ArrowRight" });
    expect(seen.at(-1)!.palette).toBe("clay");
    expect(document.activeElement).toBe(within(colours).getByRole("radio", { name: "Clay" }));
  });

  it("toggles cheeks", () => {
    const seen: RealmiteSpec[] = [];
    const start = { ...realmiteFromSeed("cheeks"), cheeks: false };
    render(<Harness start={start} seen={seen} />);
    fireEvent.click(screen.getByRole("switch", { name: "Cheeks" }));
    expect(seen.at(-1)).toEqual({ ...start, cheeks: true });
  });

  it("shuffles to a new creature, and Undo brings the last one back once", () => {
    const seen: RealmiteSpec[] = [];
    const start = realmiteFromSeed("shuffle");
    render(<Harness start={start} seen={seen} />);
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Shuffle/ }));
    expect(seen.at(-1)!.seed).not.toBe(start.seed);
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(seen.at(-1)).toEqual(start);
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("shows the four states it will be seen in", () => {
    render(<Harness start={realmiteFromSeed("states")} seen={[]} />);
    const list = screen.getByRole("list", { name: "How it looks in each state" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Idle", "Working", "Needs you", "Asleep"]);
  });
});

describe("RealmiteMaker's rows of choices", () => {
  it("spread a row that needs a second line evenly over both, never one choice alone below", () => {
    // THE mutant: greedy filling — nine choices where eight fit left Wears with one on its own line.
    expect(balancedColumns(9, 8)).toBe(5);
    expect(balancedColumns(12, 8)).toBe(6);
    expect(balancedColumns(7, 8)).toBe(7);
    expect(balancedColumns(12, 5)).toBe(4);
  });

  it("caps each row at its balanced width, read off the width of the column the rows are in", () => {
    // jsdom has no layout: the column is staged at 412px, where eight 40px choices fit beside a name.
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("rmt-maker-parts") ? 412 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      render(<RealmiteMaker spec={realmiteFromSeed("a")} onChange={() => {}} />);
      const row = (name: string) => screen.getByRole("radiogroup", { name }) as HTMLElement;
      expect(row("Wears").style.maxWidth).toBe(`${5 * 42 - 2}px`);
      expect(row("Colour").style.maxWidth).toBe(`${6 * 42 - 2}px`);
    } finally { spy.mockRestore(); }
  });
});
