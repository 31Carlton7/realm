import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { ScrollFades, ScrollFadesX } from "./ScrollFades";

/** jsdom lays nothing out, so a scroller's metrics have to be stated. These are the four numbers the
 *  hook reads — the point of the test is that the horizontal band reads the OTHER two. */
function sized(el: HTMLElement, m: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number }) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(el, k, { configurable: true, value: v });
}

function mount(axis: "y" | "x", metrics: Parameters<typeof sized>[1]) {
  let scroller!: HTMLDivElement;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        {axis === "y" ? <ScrollFades scroller={ref} /> : <ScrollFadesX scroller={ref} />}
        <div ref={(n) => { ref.current = n; if (n) scroller = n; }} />
      </div>
    );
  }
  const r = render(<Harness />);
  act(() => { sized(scroller, metrics); scroller.dispatchEvent(new Event("scroll")); });
  const band = (edge: string) => r.container.querySelector(`.edge-fade[data-edge="${edge}"]`)
    ?? r.container.querySelector(".edge-fade:not([data-edge])");
  const on = (edge: string) => band(edge)!.hasAttribute("data-on");
  const scrollTo = (n: number) => act(() => {
    if (axis === "y") scroller.scrollTop = n; else scroller.scrollLeft = n;
    scroller.dispatchEvent(new Event("scroll"));
  });
  return { on, scrollTo };
}

describe("the edge fades are gated on there being something under them", () => {
  it("shows the far band only while content runs past it, and the near band only once scrolled", () => {
    const { on, scrollTo } = mount("y", { scrollHeight: 500, clientHeight: 100 });
    expect(on("top")).toBe(false); // nothing above a list at rest
    expect(on("bottom")).toBe(true);
    scrollTo(400);
    expect(on("top")).toBe(true);
    expect(on("bottom")).toBe(false); // …and nothing below one scrolled to its end
  });

  it("reads the horizontal metrics for a sideways strip, not the vertical ones", () => {
    // THE mutant: leave `ScrollFadesX` reading scrollTop/scrollHeight. A strip whose content is
    // wider than its box has zero vertical slack, so both bands would stay dark forever — the
    // failure is silent, which is exactly how the model picker's hand-written bands never painted.
    const { on, scrollTo } = mount("x", { scrollWidth: 900, clientWidth: 300, scrollHeight: 30, clientHeight: 30 });
    expect(on("start")).toBe(false);
    expect(on("end")).toBe(true);
    scrollTo(600);
    expect(on("start")).toBe(true);
    expect(on("end")).toBe(false);
  });

  it("keeps both bands dark when everything already fits", () => {
    const { on } = mount("x", { scrollWidth: 300, clientWidth: 300, scrollHeight: 30, clientHeight: 30 });
    expect(on("start")).toBe(false);
    expect(on("end")).toBe(false);
  });
});
