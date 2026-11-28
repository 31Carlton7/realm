import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { PageScroll } from "./ScrollFades";
import { attachEdgeBlur, buildEdgeBlur, radiiFor, radiusAt, weightAt } from "./edge-blur";

const NEAR = 2, FAR = 6;
const NS = "http://www.w3.org/2000/svg";

/** jsdom draws no canvas; this one is enough for the ramps to be made. */
function canvases() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
}
const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null))); };

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("the blur down a band", () => {
  it("is none at the band's inner edge and grows to the near radius, then the far one at the bar", () => {
    expect(radiusAt(0, NEAR, FAR)).toBe(0);
    expect(radiusAt(0.6, NEAR, FAR)).toBeCloseTo(NEAR);
    expect(radiusAt(1, NEAR, FAR)).toBeCloseTo(FAR);
    for (let t = 0; t < 1; t += 0.01) expect(radiusAt(t + 0.01, NEAR, FAR)).toBeGreaterThanOrEqual(radiusAt(t, NEAR, FAR));
  });

  it("only ever cross-fades a radius into its neighbour, so no point is a sharp glyph under a soft one", () => {
    const levels = radiiFor(NEAR, FAR);
    expect(levels[0]).toBe(0);
    expect(levels.at(-1)).toBe(FAR);
    // Neighbours a short step apart: a sharp line faded straight into a 6px blur is the doubling.
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(NEAR);
    for (let t = 0; t <= 1; t += 0.005) {
      const w = levels.slice(1).map((_, k) => weightAt(t, levels, k + 1, NEAR, FAR));
      // Partly taken: at most one step at a time. Fully taken steps are all below it.
      expect(w.filter((x) => x > 0 && x < 1).length, `t=${t}`).toBeLessThanOrEqual(1);
      for (let i = 1; i < w.length; i++) if (w[i]! > 0) expect(w[i - 1], `t=${t}`).toBe(1);
    }
  });
});

describe("the filter", () => {
  const make = () => document.createElementNS(NS, "filter") as SVGFilterElement;
  const shape = { width: 700, height: 800, top: 24, bottom: 68, near: NEAR, far: FAR };

  it("is not drawn at all where no ramp can be made", () => {
    expect(buildEdgeBlur(make(), shape)).toBeNull();
  });

  it("blurs only the content itself, in each band alone and clear of the scrollbar, and lays nothing over it", () => {
    canvases();
    const f = make();
    const images = buildEdgeBlur(f, shape)!;
    const blurs = [...f.querySelectorAll("feGaussianBlur")];
    expect(blurs.map((b) => b.getAttribute("in"))).toEqual(Array(10).fill("SourceGraphic"));
    expect(blurs.slice(0, 5).map((b) => +b.getAttribute("stdDeviation")!)).toEqual(radiiFor(NEAR, FAR).slice(1));
    for (const b of blurs) expect(+b.getAttribute("width")!).toBe(690);
    expect(+blurs[0]!.getAttribute("y")! + +blurs[0]!.getAttribute("height")!).toBeLessThanOrEqual(24 + FAR * 3);
    expect(+blurs[5]!.getAttribute("y")!).toBeGreaterThanOrEqual(800 - 68 - FAR * 3);
    // The weights cover each band and nothing past it.
    expect(images.top.map((i) => [i.getAttribute("y"), i.getAttribute("height")])).toEqual(Array(5).fill(["0", "24"]));
    expect(images.bottom.map((i) => [i.getAttribute("y"), i.getAttribute("height")])).toEqual(Array(5).fill(["732", "68"]));
    // A blurred copy laid OVER the sharp one is the doubling this replaced: every mix is a weighted sum.
    const ops = [...f.querySelectorAll("feComposite")].map((c) => c.getAttribute("operator"));
    expect(ops).not.toContain("over");
    expect(f.querySelector("feMerge, feFlood")).toBeNull();
    expect(ops.filter((o) => o === "arithmetic")).toHaveLength(10);
    for (const c of f.querySelectorAll('feComposite[operator="arithmetic"]')) {
      expect([c.getAttribute("k1"), c.getAttribute("k2"), c.getAttribute("k3"), c.getAttribute("k4")]).toEqual(["0", "1", "1", "0"]);
    }
    // The bottom band starts from the top band's result, and the last result is the filter's.
    const last = f.lastElementChild!;
    expect(last.getAttribute("result")).toBe("bottom-f1");
    expect(f.querySelector('[result="bottom-b1"]')!.getAttribute("in")).toBe("top-f1");
    expect(f.querySelector('[result="top-b1"]')!.getAttribute("in")).toBe("SourceGraphic");
  });
});

describe("a scroller wearing it", () => {
  /** A scroller 800px tall over 3000px of content, `at` from its top: both ends open past a band. */
  const scroller = (at = 1000) => {
    const el = document.createElement("div");
    Object.defineProperties(el, { clientWidth: { value: 700 }, clientHeight: { value: 800 }, scrollHeight: { value: 3000 },
      scrollTop: { value: at, writable: true } });
    document.body.append(el);
    return el;
  };

  it("names its filter only while an end is open, and slides the blur in from the bar", async () => {
    canvases();
    const el = scroller();
    const blur = attachEdgeBlur(el);
    expect(el.style.getPropertyValue("--edge-blur")).toBe("");
    blur.set(true, false);
    await frames();
    const id = el.style.getPropertyValue("--edge-blur");
    expect(id).toMatch(/^url\(#rl-edge-blur-\d+\)$/);
    const filter = document.getElementById(id.slice(5, -1))!;
    expect([...filter.querySelectorAll('feImage[result^="top-"]')].map((i) => i.getAttribute("y"))).toEqual(Array(5).fill("0"));
    // The bottom band is still out past the foot.
    expect([...filter.querySelectorAll('feImage[result^="bottom-"]')].map((i) => +i.getAttribute("y")!)).toEqual(Array(5).fill(800));
    blur.set(false, false);
    await frames();
    expect(el.style.getPropertyValue("--edge-blur")).toBe("");
    blur.stop();
    expect(document.getElementById(id.slice(5, -1))).toBeNull();
  });

  it("writes nothing when a render asks for the ends it already shows", async () => {
    canvases();
    const el = scroller();
    const blur = attachEdgeBlur(el);
    blur.set(true, false);
    await frames();
    const writes: MutationRecord[] = [];
    const watch = new MutationObserver((records) => writes.push(...records));
    watch.observe(document.body, { subtree: true, attributes: true });
    watch.observe(el, { attributes: true });
    blur.set(true, false);
    await frames();
    expect(watch.takeRecords().concat(writes)).toEqual([]);
    watch.disconnect();
    blur.stop();
  });

  it("is half way in, not all at once, part way through the fade", async () => {
    canvases();
    const el = scroller();
    el.style.setProperty("--dur-fast", "1000ms");
    el.style.setProperty("--fade-top-h", "24px");
    const blur = attachEdgeBlur(el);
    blur.set(true, false);
    await frames(3);
    const id = el.style.getPropertyValue("--edge-blur").slice(5, -1);
    const y = +document.getElementById(id)!.querySelector('feImage[result^="top-"]')!.getAttribute("y")!;
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-24);
    blur.stop();
  });

  it("is only as far in as its end is open, all the way once the content runs a band past the bar", async () => {
    // THE mutant: a band at full strength the moment its end opens, which smudged the last line
    // with the scroll 34px short of the end and nothing passing under the prompter.
    canvases();
    const el = scroller(3000 - 800 - 34);
    el.style.setProperty("--fade-h", "68px");
    const blur = attachEdgeBlur(el);
    blur.set(true, true);
    await frames(30);
    const id = el.style.getPropertyValue("--edge-blur").slice(5, -1);
    const foot = () => +document.getElementById(id)!.querySelector('feImage[result^="bottom-"]')!.getAttribute("y")!;
    // Half the band's depth is open, so it stands half way in from the foot.
    expect(foot()).toBeCloseTo(800 - 68 * 0.5);
    // At the end it is out past the foot, and once a band's depth is open it is all the way in.
    el.scrollTop = 3000 - 800;
    fireEvent.scroll(el);
    expect(foot()).toBe(800);
    el.scrollTop = 3000 - 800 - 200;
    fireEvent.scroll(el);
    expect(foot()).toBe(800 - 68);
    blur.stop();
  });

  it("comes in as content grows past the bar, with no scroll", async () => {
    // THE mutant: the share left as it was until the next scroll, so content that grew under a column
    // held 10px short of its end ran on past the bar with the foot band 15% in.
    canvases();
    const observers: { fire: () => void; targets: Element[] }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      targets: Element[] = [];
      constructor(cb: () => void) { observers.push({ fire: cb, targets: this.targets }); }
      observe(t: Element) { this.targets.push(t); }
      unobserve() {}
      disconnect() { this.targets.length = 0; }
    });
    const el = document.createElement("div");
    const content = el.appendChild(document.createElement("div"));
    let height = 3000;
    Object.defineProperties(el, { clientWidth: { value: 700 }, clientHeight: { value: 800 }, scrollHeight: { get: () => height },
      scrollTop: { value: 3000 - 800 - 10 } });
    document.body.append(el);
    el.style.setProperty("--fade-h", "68px");
    el.style.setProperty("--dur-fast", "0ms");
    const blur = attachEdgeBlur(el);
    blur.set(true, true);
    await frames(4);
    const id = el.style.getPropertyValue("--edge-blur").slice(5, -1);
    const foot = () => +document.getElementById(id)!.querySelector('feImage[result^="bottom-"]')!.getAttribute("y")!;
    expect(foot()).toBeCloseTo(800 - 10);
    height = 3400;
    for (const o of observers) if (o.targets.includes(content)) o.fire();
    expect(foot()).toBe(800 - 68);
    blur.stop();
    vi.unstubAllGlobals();
  });

  it("comes in as a section mounts past the bar, with no scroll", async () => {
    // THE mutant: only the children there at attach watched, so a Settings section that mounted under
    // a column held 10px short of its end grew it with nothing observed and the foot band left 15% in.
    canvases();
    // Like the real one, it reports a target once on being asked to watch it.
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) {}
      observe() { queueMicrotask(() => this.cb()); }
      unobserve() {}
      disconnect() {}
    });
    const el = document.createElement("div");
    el.appendChild(document.createElement("div"));
    let height = 3000;
    Object.defineProperties(el, { clientWidth: { value: 700 }, clientHeight: { value: 800 }, scrollHeight: { get: () => height },
      scrollTop: { value: 3000 - 800 - 10 } });
    document.body.append(el);
    el.style.setProperty("--fade-h", "68px");
    el.style.setProperty("--dur-fast", "0ms");
    const blur = attachEdgeBlur(el);
    blur.set(true, true);
    await frames(4);
    const id = el.style.getPropertyValue("--edge-blur").slice(5, -1);
    const foot = () => +document.getElementById(id)!.querySelector('feImage[result^="bottom-"]')!.getAttribute("y")!;
    expect(foot()).toBeCloseTo(800 - 10);
    height = 3400;
    el.appendChild(document.createElement("section"));
    await frames(2);
    expect(foot()).toBe(800 - 68);
    blur.stop();
    vi.unstubAllGlobals();
  });

  it("follows the scroll at once, without easing after it", async () => {
    // THE mutant: the scroll left to the slide, which lags a band behind the content under it.
    canvases();
    const el = scroller(10);
    el.style.setProperty("--dur-fast", "1000ms");
    el.style.setProperty("--fade-top-h", "40px");
    const blur = attachEdgeBlur(el);
    blur.set(true, true);
    await frames(2);
    // Let the slide finish under a short duration, then scroll and read the very next value.
    el.style.setProperty("--dur-fast", "0ms");
    await frames(3);
    const id = el.style.getPropertyValue("--edge-blur").slice(5, -1);
    const head = () => +document.getElementById(id)!.querySelector('feImage[result^="top-"]')!.getAttribute("y")!;
    expect(head()).toBeCloseTo(-40 * (1 - 10 / 40));
    el.scrollTop = 30;
    fireEvent.scroll(el);
    expect(head()).toBeCloseTo(-40 * (1 - 30 / 40));
    // THE mutant: the listener kept past stop, which named a removed filter again on the next scroll.
    blur.stop();
    fireEvent.scroll(el);
    expect(el.style.getPropertyValue("--edge-blur")).toBe("");
  });

  it("wears none where no ramp can be drawn", async () => {
    const el = scroller();
    // Depths no other test drew, so nothing is already kept for them.
    el.style.setProperty("--fade-top-h", "31px");
    el.style.setProperty("--fade-h", "33px");
    const blur = attachEdgeBlur(el);
    blur.set(true, true);
    await frames();
    expect(el.style.getPropertyValue("--edge-blur")).toBe("");
    blur.stop();
  });
});

describe("where it is worn", () => {
  it("on a page's column once it has scrolled", async () => {
    canvases();
    const { container } = render(<PageScroll><p>Words</p></PageScroll>);
    const col = container.querySelector<HTMLElement>(".page-content")!;
    Object.defineProperties(col, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 }, clientWidth: { value: 700 } });
    expect(col.style.getPropertyValue("--edge-blur")).toBe("");
    Object.defineProperty(col, "scrollTop", { value: 300 });
    act(() => { fireEvent.scroll(col); });
    await frames();
    expect(col.dataset.dissolve).toBe("start end");
    expect(col.style.getPropertyValue("--edge-blur")).toMatch(/^url\(#rl-edge-blur-\d+\)$/);
  });

  it("on the transcript's scroller, from the dissolve's own ends", () => {
    const src = readFileSync(join(__dirname, "../panes/session/Transcript.tsx"), "utf8");
    expect(src).toMatch(/useEdgeBlur\(ref, useDissolve\(ref\)\)/);
    expect(src).toMatch(/<div className="transcript" ref=\{ref\}/);
  });
});
