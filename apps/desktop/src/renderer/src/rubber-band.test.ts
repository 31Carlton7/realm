import { describe, expect, it } from "vitest";
import { IDLE_RELEASE_MS, RubberBand, installRubberBand, rubberband, unrubberband } from "./rubber-band";

type El = { clientHeight: number; scrollTop: number; scrollHeight: number };
const scroller = (scrollTop = 0): El => ({ clientHeight: 600, scrollTop, scrollHeight: 2000 });
const machine = () => {
  const drawn: number[] = [];
  const band = new RubberBand<El>((_el, offset) => drawn.push(offset));
  const run = () => { let frames = 0; while (band.frame(1 / 60) && frames < 600) frames++; return frames; };
  return { band, drawn, run, last: () => drawn.at(-1) };
};

describe("the resistance curve", () => {
  it("gives less the further it is pulled, and never as far as the pull", () => {
    expect(rubberband(0, 600)).toBe(0);
    expect(rubberband(100, 600)).toBeLessThan(100);
    expect(rubberband(400, 600) - rubberband(300, 600)).toBeLessThan(rubberband(100, 600) - rubberband(0, 600));
    expect(rubberband(-100, 600)).toBe(-rubberband(100, 600));
    expect(rubberband(1e6, 600)).toBeLessThan(600);
  });
  it("can be read backwards, so a gesture can take hold of content mid-spring", () => {
    for (const o of [5, 80, 400, -250]) expect(unrubberband(rubberband(o, 600), 600)).toBeCloseTo(o, 6);
  });
});

describe("the rubber band", () => {
  it("does nothing mid-list: the scroller is scrolling, not stretching", () => {
    const { band, drawn } = machine();
    band.wheel(scroller(300), -20, 0);
    band.wheel(scroller(300), 20, 16);
    expect(drawn).toEqual([]);
    expect(band.active).toBe(false);
  });

  it("follows a pull past the top with rising resistance, and springs home on lift", () => {
    const { band, drawn, run, last } = machine();
    const el = scroller(0);
    for (let i = 0; i < 10; i++) band.wheel(el, -20, i * 16);
    const stretched = last()!;
    expect(stretched).toBeGreaterThan(0);
    expect(stretched).toBeLessThan(200);
    // Ten equal pulls: each later one moves the content less than the first did.
    expect(drawn[9]! - drawn[8]!).toBeLessThan(drawn[0]!);
    band.phase({ phase: "ended", momentum: "none" });
    const frames = run();
    expect(last()).toBe(0);
    // AppKit's pace: home well inside half a second, and it never swings through to the other side.
    expect(frames).toBeLessThan(40);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(0);
  });

  it("stretches the other way past the bottom", () => {
    const { band, last } = machine();
    const el = { clientHeight: 600, scrollTop: 1400, scrollHeight: 2000 };
    band.wheel(el, 30, 0);
    expect(last()).toBeLessThan(0);
  });

  it("hands back to the scroller when the pull is reversed through the end", () => {
    const { band, last } = machine();
    const el = scroller(0);
    band.wheel(el, -40, 0);
    band.wheel(el, 100, 16);
    expect(last()).toBe(0);
    expect(band.active).toBe(false);
  });

  /* THE mutant: a coast that keeps stretching for as long as momentum lasts — the content would sit
     pulled out for a second after every flick to the top. */
  it("bounces a coast once, by the speed it arrived with, and the rest of the coast is spent", () => {
    const { band, drawn, run, last } = machine();
    const el = scroller(0);
    band.phase({ phase: "none", momentum: "began" });
    band.wheel(el, -40, 0);
    band.wheel(el, -30, 16);
    run();
    const peak = Math.max(...drawn);
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(120);
    expect(last()).toBe(0);
    const count = drawn.length;
    band.wheel(el, -20, 500);
    expect(drawn.length).toBe(count);
    // A faster arrival carries further.
    const fast = machine();
    fast.band.phase({ phase: "none", momentum: "began" });
    fast.band.wheel(scroller(0), -90, 0);
    fast.run();
    expect(Math.max(...fast.drawn)).toBeGreaterThan(peak);
  });

  it("lets a new gesture grab the content mid-spring from where it is", () => {
    const { band, drawn, last } = machine();
    const el = scroller(0);
    for (let i = 0; i < 10; i++) band.wheel(el, -20, i * 16);
    band.phase({ phase: "ended", momentum: "none" });
    for (let i = 0; i < 4; i++) band.frame(1 / 60);
    const mid = last()!;
    band.phase({ phase: "began", momentum: "none" });
    band.wheel(el, -1, 300);
    expect(Math.abs(last()! - mid)).toBeLessThan(2);
    expect(drawn.length).toBeGreaterThan(0);
  });

  it("without the phase stream, a quiet wheel stands in for the lift", () => {
    const { band, run, last } = machine();
    const el = scroller(0);
    band.wheel(el, -30, 0);
    band.idle(IDLE_RELEASE_MS - 10);
    expect(band.frame(1 / 60)).toBe(false);
    band.idle(IDLE_RELEASE_MS);
    run();
    expect(last()).toBe(0);
  });
});

describe("installed on a document", () => {
  const mount = () => {
    document.body.innerHTML = '<div class="space-body"><div id="row">row</div></div>';
    const el = document.querySelector<HTMLElement>(".space-body")!;
    Object.defineProperty(el, "clientHeight", { value: 600 });
    Object.defineProperty(el, "scrollHeight", { value: 2000 });
    let push: (p: { phase: string; momentum: string }) => void = () => {};
    const off = installRubberBand(document, { onPhase: (cb) => { push = cb; return () => {}; }, reducedMotion: () => false });
    const wheel = (deltaY: number) => document.getElementById("row")!.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
    return { el, off, push: (phase: string, momentum = "none") => push({ phase, momentum }), wheel };
  };

  /* THE mutant: stretching for a mouse wheel. A Mac mouse wheel has no gesture phases, and that is
     the exact signal; without it, a mouse would make every list bounce at its ends. */
  it("stretches only while fingers are on the pad, never for a mouse wheel", () => {
    const { el, off, push, wheel } = mount();
    push("none");                 // the stream is live, and nothing is touching the pad
    wheel(-30);
    expect(el.hasAttribute("data-rubber")).toBe(false);
    push("began");
    wheel(-30);
    expect(el.hasAttribute("data-rubber")).toBe(true);
    expect(parseFloat(el.style.getPropertyValue("--rubber"))).toBeGreaterThan(0);
    off();
    expect(el.hasAttribute("data-rubber")).toBe(false);
  });

  it("does nothing at all under reduced motion", () => {
    document.body.innerHTML = '<div class="space-body"><div id="row">row</div></div>';
    const el = document.querySelector<HTMLElement>(".space-body")!;
    Object.defineProperty(el, "clientHeight", { value: 600 });
    const off = installRubberBand(document, { reducedMotion: () => true });
    document.getElementById("row")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }));
    expect(el.hasAttribute("data-rubber")).toBe(false);
    off();
  });
});
