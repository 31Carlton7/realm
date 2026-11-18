import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bendAt, bezelField } from "./bezel-lens";
import { fitLens, lensCache } from "./fitted-lens";

/** A box jsdom can measure: its size, its corner and its lens tokens. */
function box(width: number, height: number, { radius = 12, bezel = 16, bend = 12, frost = 10 } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => height });
  el.style.borderRadius = `${radius}px`;
  el.style.setProperty("--glass-bezel", `${bezel}px`);
  el.style.setProperty("--glass-bend", `${bend}px`);
  el.style.setProperty("--glass-frost-px", `${frost}px`);
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
    const a = box(320, 480);
    const stop = fitLens(a.el);
    const filter = document.getElementById(lensOf(a.el)!)!;
    const steps = [...filter.children].map((n) => n.tagName);
    expect(steps).toEqual(["feFlood", "feComposite", "feGaussianBlur", "feImage", "feDisplacementMap"]);
    expect(filter.querySelector("feFlood")!.getAttribute("style")).toContain("var(--glass-ground)");
    const over = filter.querySelector("feComposite")!;
    expect([over.getAttribute("in"), over.getAttribute("in2"), over.getAttribute("operator")]).toEqual(["SourceGraphic", "ground", "over"]);
    const frost = filter.querySelector("feGaussianBlur")!;
    expect([frost.getAttribute("in"), frost.getAttribute("stdDeviation")]).toEqual([over.getAttribute("result"), "10"]);
    expect(filter.querySelector("feDisplacementMap")!.getAttribute("in")).toBe(frost.getAttribute("result"));
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

describe("the surfaces that wear one", () => {
  it("every glass picker and the selection bar fit a lens to their own box while glass is drawn", () => {
    for (const name of ["ModelPicker", "MentionPicker", "SlashPicker", "SkillPicker", "SelectionBar"]) {
      const src = readFileSync(join(__dirname, "../panes/session", `${name}.tsx`), "utf8");
      expect(src, name).toMatch(/useFittedLens\((ref|bar), useGlassDrawn\(\)\)/);
    }
  });
});
