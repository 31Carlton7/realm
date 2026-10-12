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
  it("is Apple's: x·d·c / (d + c·x), with c = 0.55 and d the scroller's height", () => {
    expect(rubberband(0, 600)).toBe(0);
    expect(rubberband(100, 600)).toBeCloseTo((100 * 600 * 0.55) / (600 + 0.55 * 100), 9);
    // Its slope at the end is c: the first pixel past the end moves the content 0.55px.
    expect(rubberband(0.01, 600) / 0.01).toBeCloseTo(0.55, 3);
  });
  it("gives less the further it is pulled, and never as far as the pull", () => {
    expect(rubberband(100, 600)).toBeLessThan(100);
    expect(rubberband(400, 600) - rubberband(300, 600)).toBeLessThan(rubberband(100, 600) - rubberband(0, 600));
    expect(rubberband(-100, 600)).toBe(-rubberband(100, 600));
    expect(rubberband(1e6, 600)).toBeLessThan(600);
  });
  it("can be read backwards", () => {
    for (const o of [5, 80, 400, -250]) expect(unrubberband(rubberband(o, 600), 600)).toBeCloseTo(o, 6);
  });
});

/** Feeds a coast of `frames` deltas starting at `speed` px per 16ms, decaying as AppKit's does, into a
 *  scroller that reaches its top after `toEdge` of them. Times in ms. */
function coast(band: RubberBand<El>, el: El, speed: number, toEdge: number, t0 = 0, frames = 40) {
  let v = speed;
  for (let i = 0; i < frames; i++) {
    if (i === toEdge) el.scrollTop = 0;
    band.wheel(el, -Math.round(v), t0 + i * 16);
    v *= 0.95;
  }
}

describe("the rubber band", () => {
  it("does nothing mid-list: the scroller is scrolling, not stretching", () => {
    const { band, drawn } = machine();
    band.wheel(scroller(300), -20, 0);
    band.wheel(scroller(300), 20, 16);
    expect(drawn).toEqual([]);
    expect(band.active).toBe(false);
  });

  it("follows a pull past the top with rising resistance", () => {
    const { band, drawn, last } = machine();
    const el = scroller(0);
    band.phase({ phase: "began", momentum: "none" }, 0);
    for (let i = 0; i < 10; i++) band.wheel(el, -20, i * 16);
    expect(last()).toBeCloseTo(rubberband(200, 600), 6);
    // Ten equal pulls: each later one moves the content less than the first did.
    expect(drawn[9]! - drawn[8]!).toBeLessThan(drawn[0]!);
  });

  /* Mutant: a stiffer or a looser spring (OMEGA 30 or 7) — home in a blink, or a lazy drift. */
  it("springs home on lift, critically damped, in AppKit's time: still out at 0.1s, within a pixel by 0.5s", () => {
    const { band, drawn, last } = machine();
    const el = scroller(0);
    band.phase({ phase: "began", momentum: "none" }, 0);
    for (let i = 0; i < 20; i++) band.wheel(el, -20, i * 16);
    const stretched = last()!;
    band.phase({ phase: "ended", momentum: "none" }, 400);
    const at = (s: number) => { const n = drawn.length; for (let i = 0; i < Math.round(s * 60); i++) band.frame(1 / 60); return drawn.length > n ? last()! : 0; };
    const tenth = at(0.1);
    expect(tenth).toBeGreaterThan(stretched * 0.25);
    expect(tenth).toBeLessThan(stretched * 0.85);
    at(0.2);
    expect(last()!).toBeLessThan(stretched * 0.2);
    // Under a pixel by half a second, and the spring done altogether soon after.
    expect(at(0.2)).toBeLessThan(1);
    let t = 0.5;
    while (band.frame(1 / 60)) t += 1 / 60;
    expect(t).toBeLessThan(0.7);
    expect(last()).toBe(0);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(0);
  });

  it("stretches the other way past the bottom", () => {
    const { band, last } = machine();
    const el = { clientHeight: 600, scrollTop: 1400, scrollHeight: 2000 };
    band.phase({ phase: "began", momentum: "none" }, 0);
    band.wheel(el, 30, 0);
    expect(last()).toBeLessThan(0);
  });

  it("hands back to the scroller when the pull is reversed through the end", () => {
    const { band, last } = machine();
    const el = scroller(0);
    band.phase({ phase: "began", momentum: "none" }, 0);
    band.wheel(el, -40, 0);
    band.wheel(el, 100, 16);
    expect(last()).toBe(0);
    expect(band.active).toBe(false);
  });

  /* THE mutant for "stops on a dime": the bounce starting from rest, or at a fraction of the speed the
     coast had. The content must leave the end at the speed it arrived with. */
  it("carries a coast on past the end at the speed it arrived with", () => {
    const { band, drawn, run } = machine();
    const el = scroller(400);
    band.phase({ phase: "ended", momentum: "none" }, 0);
    band.phase({ phase: "none", momentum: "began" }, 0);
    coast(band, el, 40, 6);
    // 40·0.95⁵ ≈ 31px a frame when it reached the end; the first frame past it covers about that much.
    band.frame(1 / 60);
    expect(drawn[0]!).toBeGreaterThan(22);
    expect(drawn[0]!).toBeLessThan(34);
    run();
    const peak = Math.max(...drawn);
    expect(peak).toBeGreaterThan(30);
    expect(peak).toBeLessThan(150);
    expect(drawn.at(-1)).toBe(0);
    // A faster arrival carries further, and the curve still keeps it well inside the pane.
    const fast = machine();
    fast.band.phase({ phase: "none", momentum: "began" }, 0);
    coast(fast.band, scroller(800), 120, 3);
    fast.run();
    expect(Math.max(...fast.drawn)).toBeGreaterThan(peak);
    expect(Math.max(...fast.drawn)).toBeLessThan(300);
  });

  /* Mutant: the coast going on stretching for as long as momentum lasts — the content would sit pulled
     out for a second after every flick to the top. */
  it("bounces a coast once, back within ~0.6s, and the rest of the coast is spent", () => {
    const { band, drawn, run } = machine();
    const el = scroller(400);
    band.phase({ phase: "none", momentum: "began" }, 0);
    coast(band, el, 40, 6, 0, 8);
    const frames = run();
    expect(frames / 60).toBeLessThan(0.65);
    const count = drawn.length;
    coast(band, el, 10, 0, 200, 30);
    expect(drawn.length).toBe(count);
    expect(band.active).toBe(false);
  });

  /* Mutant: dropping LIFT_GRACE_MS. The stream's "momentum began" can reach the renderer after the
     coast's first wheel events; a flick near the end would then meet it with nothing and stop dead. */
  it("bounces a coast that reaches the end before the stream has said momentum", () => {
    const { band, drawn, run } = machine();
    const el = scroller(60);
    band.phase({ phase: "ended", momentum: "none" }, 0);
    coast(band, el, 40, 2, 10, 4);
    run();
    expect(Math.max(...drawn)).toBeGreaterThan(30);
  });

  it("takes hold of a spring mid-flight from where the content is", () => {
    const { band, drawn, last } = machine();
    const el = scroller(0);
    band.phase({ phase: "began", momentum: "none" }, 0);
    for (let i = 0; i < 10; i++) band.wheel(el, -20, i * 16);
    band.phase({ phase: "ended", momentum: "none" }, 160);
    for (let i = 0; i < 4; i++) band.frame(1 / 60);
    const mid = last()!;
    band.phase({ phase: "began", momentum: "none" }, 300);
    band.wheel(el, -1, 300);
    expect(Math.abs(last()! - mid)).toBeLessThan(2);
    expect(drawn.length).toBeGreaterThan(0);
  });

  describe("without the phase stream", () => {
    it("a quiet wheel stands in for the lift", () => {
      const { band, run, last } = machine();
      const el = scroller(0);
      band.wheel(el, -30, 0);
      band.idle(IDLE_RELEASE_MS - 10);
      expect(band.frame(1 / 60)).toBe(false);
      band.idle(IDLE_RELEASE_MS);
      run();
      expect(last()).toBe(0);
    });

    /* Mutant: treating an arrival like a pull (the old fallback) — the stretch then grows with every
       momentum delta and holds until the coast's last pixel, two seconds after a flick. */
    it("content that arrives at an end moving bounces, and does not hang there for the coast", () => {
      const { band, drawn, run } = machine();
      const el = scroller(400);
      coast(band, el, 40, 6, 0, 8);
      const frames = run();
      expect(Math.max(...drawn)).toBeGreaterThan(30);
      expect(frames / 60).toBeLessThan(0.65);
      const count = drawn.length;
      coast(band, el, 10, 0, 136, 20);
      expect(drawn.length).toBe(count);
    });
  });
});

describe("installed on a document", () => {
  const mount = () => {
    document.body.innerHTML = '<div class="space-body"><div id="row">row</div></div>';
    const el = document.querySelector<HTMLElement>(".space-body")!;
    Object.defineProperty(el, "clientHeight", { value: 600 });
    Object.defineProperty(el, "scrollHeight", { value: 2000 });
    let push: (p: { phase: string; momentum: string }) => void = () => {};
    const off = installRubberBand(document, { onPhase: (cb) => { push = cb; return () => {}; } });
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
    const row = document.getElementById("row")!;
    expect(parseFloat(row.style.getPropertyValue("--rubber"))).toBeGreaterThan(0);
    off();
    expect(el.hasAttribute("data-rubber")).toBe(false);
    expect(row.style.getPropertyValue("--rubber")).toBe("");
  });

  /* THE mutant: the offset written on the scroller again. `--rubber` would inherit into every row of
     the list, and each frame of a stretch restyles the whole of it. */
  it("writes the offset on the children it moves, never on the scroller", () => {
    const { el, off, push, wheel } = mount();
    push("began");
    wheel(-30);
    expect(el.style.getPropertyValue("--rubber")).toBe("");
    expect(parseFloat(document.getElementById("row")!.style.getPropertyValue("--rubber"))).toBeGreaterThan(0);
    off();
  });
});
