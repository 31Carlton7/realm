import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bendAt, bezelField } from "./bezel-lens";
import { cornerExponent, fitControls, fitLens, lensCache } from "./fitted-lens";

/** A box jsdom can measure: its size, its corner and its lens tokens. */
function box(width: number, height: number, { radius = 12, bezel = 16, bend = 12, frost = 10, ground = 0.95 } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => height });
  el.style.borderRadius = `${radius}px`;
  el.style.setProperty("--glass-bezel", `${bezel}px`);
  el.style.setProperty("--glass-bend", `${bend}px`);
  el.style.setProperty("--glass-frost-px", `${frost}px`);
  el.style.setProperty("--glass-ground-share", String(ground));
  document.body.append(el);
  return {
    el,
    resize(w: number, h: number) { width = w; height = h; },
  };
}

let observers: (() => void)[] = [];
function canvasStub() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,map");
  vi.stubGlobal("ResizeObserver", class { constructor(private cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
}
const lensOf = (el: HTMLElement) => /^url\(#(.+)\)$/.exec(el.style.getPropertyValue("--glass-lens"))?.[1] ?? null;

afterEach(() => {
  vi.restoreAllMocks();
  window.devicePixelRatio = 1;
  vi.unstubAllGlobals();
  observers = [];
  document.body.innerHTML = "";
});

describe("the bezel's map", () => {
  const W = 200, H = 100;
  const shape = { width: W, height: H, radius: 12, bezel: 16 };
  const field = bezelField(shape, W, H);
  const at = (x: number, y: number) => { const i = (y * W + x) * 4; return [field[i]! - 128, field[i + 1]! - 128] as const; };

  it("leaves the face past the bezel alone", () => {
    expect(at(100, 50)).toEqual([0, 0]);
    expect(at(20, 50)).toEqual([0, 0]);
  });

  it("samples from further in at every rim, most at the rim itself", () => {
    expect(at(0, 50)[0]).toBeGreaterThan(100); // left rim reads from its right
    expect(at(W - 1, 50)[0]).toBeLessThan(-100); // right rim from its left
    expect(at(100, 0)[1]).toBeGreaterThan(100); // top rim from below
    expect(at(100, H - 1)[1]).toBeLessThan(-100); // foot from above
    expect(at(0, 50)[1]).toBe(0);
    expect(Math.abs(at(4, 50)[0])).toBeLessThan(Math.abs(at(0, 50)[0]));
    expect(Math.abs(at(12, 50)[0])).toBeLessThan(Math.abs(at(4, 50)[0]));
  });

  it("bends a corner toward its centre, along the curve's normal", () => {
    const [dx, dy] = at(5, 5);
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeGreaterThan(0);
    expect(Math.abs(dx - dy)).toBeLessThanOrEqual(1);
  });

  it("follows a superellipse corner out to its rim, where a circle's has already curved away", () => {
    // A chosen segment is cut on the control curve, so its bend has to reach the same corner: traced
    // on a circle, the glass stops bending a few pixels short of the edge at every corner.
    const sq = bezelField({ ...shape, n: 3 }, W, H);
    expect(at(2, 2)).toEqual([0, 0]);
    expect(sq[(2 * W + 2) * 4]! - 128).toBeGreaterThan(80); // 127 × cos 45° at the rim
    expect(bezelField({ ...shape, n: 2 }, W, H)).toEqual(field);
  });

  it("reads the corner's exponent off the box's own corner-shape", () => {
    const of = (shape: string) => cornerExponent({ getPropertyValue: () => shape } as unknown as CSSStyleDeclaration);
    expect(of("superellipse(1.58496)")).toBeCloseTo(3, 4);
    expect(of("squircle")).toBe(4);
    expect(of("superellipse(1)")).toBe(2);
    expect(of("round")).toBe(2);
    expect(of("")).toBe(2);
  });

  it("is steep at the rim and flat where it meets the face", () => {
    expect(bendAt(0)).toBe(1);
    expect(bendAt(1)).toBe(0);
    expect(bendAt(0.5)).toBeLessThan(0.5);
  });
});

describe("a fitted lens", () => {
  it("is drawn for the box's own size and named on it", () => {
    canvasStub();
    const a = box(320, 480);
    const stop = fitLens(a.el);
    const id = lensOf(a.el)!;
    const filter = document.getElementById(id)!;
    expect(filter.tagName.toLowerCase()).toBe("filter");
    expect(filter.getAttribute("width")).toBe("320");
    expect(filter.getAttribute("height")).toBe("480");
    expect(filter.getAttribute("filterUnits")).toBe("userSpaceOnUse");
    // The map swings ±127 of 255, so the scale is twice the bend at the rim.
    expect(filter.querySelector("feDisplacementMap")?.getAttribute("scale")).toBe("24");
    stop();
    expect(document.getElementById(id)).toBeNull();
  });

  it("floods the pane's ground under the backdrop, then frosts it, then bends the frost", () => {
    // A backdrop filter's result is laid OVER the backdrop: frosting a see-through pane without a
    // ground left the words behind sharp under a faint haze.
    canvasStub();
    const a = box(320, 480, { ground: 0.6 });
    const stop = fitLens(a.el);
    const filter = document.getElementById(lensOf(a.el)!)!;
    const steps = [...filter.children].map((n) => n.tagName);
    expect(steps).toEqual(["feFlood", "feComposite", "feGaussianBlur", "feImage", "feDisplacementMap", "feComposite"]);
    expect(filter.querySelector("feFlood")!.getAttribute("style")).toContain("var(--glass-ground)");
    expect(filter.querySelector("feFlood")!.getAttribute("style")).toContain("flood-opacity: 0.6");
    const over = filter.querySelector("feComposite")!;
    expect([over.getAttribute("in"), over.getAttribute("in2"), over.getAttribute("operator")]).toEqual(["SourceGraphic", "ground", "over"]);
    const frost = filter.querySelector("feGaussianBlur")!;
    expect([frost.getAttribute("in"), frost.getAttribute("stdDeviation")]).toEqual([over.getAttribute("result"), "10"]);
    expect(filter.querySelector("feDisplacementMap")!.getAttribute("in")).toBe(frost.getAttribute("result"));
    // The blur and the bend read clear backdrop past the box's edge; the result goes over the ground
    // again, or the words show through its rim sharp.
    const sealed = filter.lastElementChild!;
    expect([sealed.getAttribute("in"), sealed.getAttribute("in2"), sealed.getAttribute("operator")]).toEqual([filter.querySelector("feDisplacementMap")!.getAttribute("result"), "ground", "over"]);
    stop();
  });

  it("is a different filter for a different frost, and skips the blur at none", () => {
    canvasStub();
    const a = box(320, 480, { frost: 10 });
    const b = box(320, 480, { frost: 0 });
    const stops = [fitLens(a.el), fitLens(b.el)];
    expect(lensOf(a.el)).not.toBe(lensOf(b.el));
    const plain = document.getElementById(lensOf(b.el)!)!;
    expect(plain.querySelector("feGaussianBlur")).toBeNull();
    expect(plain.querySelector("feDisplacementMap")!.getAttribute("in")).toBe("solid");
    for (const stop of stops) stop();
    expect(lensCache.filters()).toBe(0);
  });

  it("is shared by boxes of one size, follows a resize, and goes with its last user", () => {
    canvasStub();
    const a = box(320, 480);
    const b = box(320, 480);
    const stopA = fitLens(a.el);
    const stopB = fitLens(b.el);
    expect(lensOf(a.el)).toBe(lensOf(b.el));
    expect(lensCache.filters()).toBe(1);
    b.resize(320, 300);
    observers[1]!();
    expect(lensOf(b.el)).not.toBe(lensOf(a.el));
    expect(document.getElementById(lensOf(b.el)!)?.getAttribute("height")).toBe("300");
    expect(lensCache.filters()).toBe(2);
    stopA();
    expect(a.el.style.getPropertyValue("--glass-lens")).toBe("");
    stopB();
    expect(lensCache.filters()).toBe(0);
    expect(document.querySelectorAll(".glass-defs filter")).toHaveLength(0);
  });

  it("names nothing where the box has no lens tokens or no size, so only the frost is drawn", () => {
    canvasStub();
    const flat = box(320, 480, { bend: 0 });
    fitLens(flat.el);
    expect(flat.el.style.getPropertyValue("--glass-lens")).toBe("");
    const empty = box(0, 0);
    fitLens(empty.el);
    expect(empty.el.style.getPropertyValue("--glass-lens")).toBe("");
  });
});

describe("a fitted lens on a dense screen", () => {
  it("frosts in CSS px: the blur, which Chromium reads in device px, is scaled by the density", () => {
    canvasStub();
    window.devicePixelRatio = 2;
    const a = box(320, 480, { frost: 10 });
    const stop = fitLens(a.el);
    const filter = document.getElementById(lensOf(a.el)!)!;
    expect(filter.querySelector("feGaussianBlur")!.getAttribute("stdDeviation")).toBe("20");
    // The bend and the region are CSS px already.
    expect(filter.querySelector("feDisplacementMap")!.getAttribute("scale")).toBe("24");
    expect(filter.getAttribute("width")).toBe("320");
    stop();
  });

  it("is a different filter at another density", () => {
    canvasStub();
    const a = box(320, 480);
    const stopA = fitLens(a.el);
    window.devicePixelRatio = 2;
    const b = box(320, 480);
    const stopB = fitLens(b.el);
    expect(lensOf(a.el)).not.toBe(lensOf(b.el));
    stopA(); stopB();
  });
});

describe("a fitted lens over its own track", () => {
  it("floods no ground where the surface asks for none, so the frost and bend read the track itself", () => {
    canvasStub();
    const seg = box(60, 22, { frost: 1, ground: 0 });
    const stop = fitLens(seg.el);
    const filter = document.getElementById(lensOf(seg.el)!)!;
    expect([...filter.children].map((n) => n.tagName)).toEqual(["feGaussianBlur", "feImage", "feDisplacementMap"]);
    expect(filter.querySelector("feGaussianBlur")!.getAttribute("in")).toBe("SourceGraphic");
    stop();
  });

  it("is fitted to a pseudo-element's box when it is one (a switch's knob)", () => {
    canvasStub();
    const sw = box(34, 20, { frost: 0, ground: 0, radius: 999 });
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const cs = real(el);
      if (pseudo !== "::after") return cs;
      return { ...cs, width: "16px", height: "16px", borderTopLeftRadius: "50%", getPropertyValue: cs.getPropertyValue.bind(cs) } as CSSStyleDeclaration;
    });
    const stop = fitLens(sw.el, "::after");
    const filter = document.getElementById(lensOf(sw.el)!)!;
    expect([filter.getAttribute("width"), filter.getAttribute("height")]).toEqual(["16", "16"]);
    stop();
  });

  it("is refitted when the face changes, since its tokens are per mode", () => {
    canvasStub();
    const a = box(320, 480, { frost: 10 });
    const stop = fitLens(a.el);
    const before = lensOf(a.el);
    a.el.style.setProperty("--glass-frost-px", "6px");
    document.documentElement.setAttribute("data-mode", "light");
    return Promise.resolve().then(() => {
      expect(lensOf(a.el)).not.toBe(before);
      expect(document.getElementById(lensOf(a.el)!)!.querySelector("feGaussianBlur")!.getAttribute("stdDeviation")).toBe("6");
      stop();
      document.documentElement.removeAttribute("data-mode");
    });
  });
});

describe("the pressed controls, fitted from one place", () => {
  const frame = () => new Promise((res) => requestAnimationFrame(() => res(null)));
  function segment(selected: boolean) {
    const { el } = box(60, 22, { frost: 1, ground: 0 });
    el.className = "seg-opt";
    el.toggleAttribute("data-selected", selected);
    return el;
  }

  it("follows the selection: the chosen segment wears a lens, the one left does not", async () => {
    canvasStub();
    const a = segment(true);
    const b = segment(false);
    const stop = fitControls([{ selector: ".seg-opt[data-selected]" }]);
    expect(lensOf(a)).not.toBeNull();
    expect(lensOf(b)).toBeNull();
    a.removeAttribute("data-selected");
    b.setAttribute("data-selected", "");
    await frame();
    expect(lensOf(a)).toBeNull();
    expect(lensOf(b)).not.toBeNull();
    stop();
    expect(lensOf(b)).toBeNull();
    expect(lensCache.filters()).toBe(0);
  });

  it("fits a control that arrives later, lets one that leaves go, and never passes over streamed text", async () => {
    canvasStub();
    const stop = fitControls([{ selector: ".seg-opt[data-selected]" }]);
    const pass = vi.spyOn(document, "querySelectorAll");
    const para = document.createElement("p");
    document.body.append(para);
    await frame();
    para.append(document.createTextNode("a streamed token"));
    await frame();
    expect(pass).not.toHaveBeenCalled();
    const later = segment(true);
    await frame();
    expect(lensOf(later)).not.toBeNull();
    later.remove();
    await frame();
    expect(lensCache.filters()).toBe(0);
    stop();
  });
});

describe("the surfaces that wear one", () => {
  it("every glass picker and the selection bar fit a lens to their own box while glass is drawn", () => {
    for (const name of ["ModelPicker", "MentionPicker", "SlashPicker", "SkillPicker", "SelectionBar"]) {
      const src = readFileSync(join(__dirname, "../panes/session", `${name}.tsx`), "utf8");
      expect(src, name).toMatch(/useFittedLens\((ref|bar), useGlassDrawn\(\)\)/);
    }
  });
});
