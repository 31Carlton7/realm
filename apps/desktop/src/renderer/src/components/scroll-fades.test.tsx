import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { ScrollFades, ScrollFadesX, useScrollEdges } from "./ScrollFades";

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
  render(<Harness />);
  act(() => { sized(scroller, metrics); scroller.dispatchEvent(new Event("scroll")); });
  /* What there is to read is the SCROLLER's own marking: the dissolve is a mask on it, so the ends
     that are live are the ones named in `data-dissolve`. `start`/`end` are the attribute's own
     words; "top" and "bottom" are what the vertical pair mean. */
  const on = (edge: string) => {
    const key = axis === "y" ? "dissolve" : "dissolveX";
    const named = (scroller.dataset[key] ?? "").split(" ");
    return named.includes(edge === "top" ? "start" : edge === "bottom" ? "end" : edge);
  };
  const scrollTo = (n: number) => act(() => {
    if (axis === "y") scroller.scrollTop = n; else scroller.scrollLeft = n;
    scroller.dispatchEvent(new Event("scroll"));
  });
  return { on, scrollTo };
}

describe("the dissolve is gated on there being something under it", () => {
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

  it("leaves the scroller's owner alone while a scroll changes neither end", () => {
    // The owner of the transcript's scroller is the whole transcript: re-rendered on every scroll
    // event, a log of three hundred turns spent most of each frame drawing itself again.
    let renders = 0;
    let scroller!: HTMLDivElement;
    function Owner() {
      const ref = useRef<HTMLDivElement>(null);
      renders++;
      useScrollEdges(ref);
      return <div ref={(n) => { ref.current = n; if (n) scroller = n; }} />;
    }
    const scrollTo = (top: number) => act(() => { scroller.scrollTop = top; scroller.dispatchEvent(new Event("scroll")); });
    render(<Owner />);
    act(() => { sized(scroller, { scrollHeight: 2000, clientHeight: 100 }); scroller.dispatchEvent(new Event("scroll")); });
    scrollTo(300); // both ends lit from here on
    const settled = renders;
    for (let top = 400; top <= 1300; top += 100) scrollTo(top);
    // React may call a component once more before it bails out of an equal state; never once a scroll.
    expect(renders - settled).toBeLessThanOrEqual(1);
  });
});
