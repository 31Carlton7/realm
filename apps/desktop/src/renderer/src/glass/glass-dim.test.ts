import { afterEach, describe, expect, it, vi } from "vitest";
import { contrast, GUARD_SPARE } from "../panes/session/hero-backdrop-color";
import type { Rgb } from "../panes/session/hero-backdrop";
import { GLASS_DIM_MAX, GLASS_DIM_TAIL, glassDim, PLAIN_DIM, setGlassDim, toned } from "./glass-dim";

/** A colour from its 8-bit channels, as `resolveColor` gives it. */
const rgb = (r: number, g: number, b: number): Rgb => [r / 255, g / 255, b / 255];
/** Realm dark's `--ink` and `--ink-2`, as the pane resolves them. */
const INK = rgb(243, 244, 246);
const INK_2 = rgb(158, 161, 166);
const INKS = [{ color: INK, need: 4.5, onTint: true }, { color: INK_2, need: 3, onTint: true }];
const fill = (c: Rgb, n = 400): Rgb[] => Array.from({ length: n }, () => c);
const dimmed = (c: Rgb, d: number) => toned(toned(c, 1.5, 1), 1, 1 - d);

describe("dark glass's dim", () => {
  it("is nothing over a dark picture, so the glass keeps its light and colour", () => {
    // THE mutant: a floor under the dim (the old fixed 0.4), which takes a night sky to navy.
    expect(glassDim(fill(rgb(40, 14, 70)), INKS, 1.5)).toBe(0);
  });

  it("is the least that keeps every ink at its ratio over a bright picture", () => {
    // Synth Coast's sun, a warm orange.
    const sun = rgb(236, 120, 60);
    const d = glassDim(fill(sun), INKS, 1.5);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(GLASS_DIM_MAX);
    expect(contrast(INK_2, dimmed(sun, d))).toBeGreaterThanOrEqual(3 + GUARD_SPARE - 0.01);
    expect(contrast(INK, dimmed(sun, d))).toBeGreaterThanOrEqual(4.5 + GUARD_SPARE - 0.01);
    // The least: a hair less and the secondary ink misses.
    expect(contrast(INK_2, dimmed(sun, d - 0.02))).toBeLessThan(3 + GUARD_SPARE);
  });

  it("is held by the brightest part of the picture, not its average", () => {
    // THE mutant: the mean or the median, which leave the words over the bright tenth unreadable.
    const mostlyDark = [...fill(rgb(20, 10, 40), 900), ...fill(rgb(250, 250, 250), 100)];
    expect(glassDim(mostlyDark, INKS, 1.5)).toBeGreaterThan(0.5);
    // A glint the frost spreads to nothing is let past.
    const glint = [...fill(rgb(20, 10, 40), 1000), ...fill(rgb(255, 255, 255), Math.floor(1000 * GLASS_DIM_TAIL / 2))];
    expect(glassDim(glint, INKS, 1.5)).toBe(0);
  });

  it("holds the inks over a picture as white as paper, under its ceiling", () => {
    const d = glassDim(fill(rgb(255, 255, 255)), INKS, 1.5);
    expect(d).toBeLessThan(GLASS_DIM_MAX);
    expect(contrast(INK_2, dimmed(rgb(255, 255, 255), d))).toBeGreaterThanOrEqual(3 + GUARD_SPARE - 0.01);
  });

  it("stops at its ceiling for an ink no dim could hold", () => {
    expect(glassDim(fill(rgb(255, 255, 255)), [{ color: rgb(60, 60, 60), need: 4.5 }], 1.5)).toBe(GLASS_DIM_MAX);
  });

  it("counts the lit row's tint, the lightest thing a word on the glass stands on", () => {
    // THE mutant: the tint left out, which over a white sky left the account's email at 2.6:1.
    const sky = fill(rgb(240, 244, 252));
    const row = { color: rgb(255, 255, 255), alpha: 0.1 };
    const d = glassDim(sky, INKS, 1.5, row);
    expect(d).toBeGreaterThan(glassDim(sky, INKS, 1.5));
    const lit = dimmed(rgb(240, 244, 252), d).map((v) => v * 0.9 + 0.1) as Rgb;
    expect(contrast(INK_2, lit)).toBeGreaterThanOrEqual(3 + GUARD_SPARE - 0.01);
  });

  it("lays the tint only under the words that stand on it", () => {
    // THE mutant: the tint under every ink, which held the accent level to a tint it never stands on.
    const sky = fill(rgb(240, 244, 252));
    const row = { color: rgb(255, 255, 255), alpha: 0.1 };
    const accent = { color: rgb(80, 160, 255), need: 3 };
    expect(glassDim(sky, [accent], 1.5, row)).toBe(glassDim(sky, [accent], 1.5));
    expect(glassDim(sky, [{ ...accent, onTint: true }], 1.5, row)).toBeGreaterThan(glassDim(sky, [accent], 1.5));
  });

  it("counts the glass's saturation, which lifts a saturated colour's brightest channel", () => {
    const teal = rgb(40, 170, 190);
    expect(glassDim(fill(teal), INKS, 1.5)).toBeGreaterThan(glassDim(fill(teal), INKS, 1));
  });

  it("draws saturate and brightness as CSS does: grey is unmoved by saturation, and brightness scales", () => {
    expect(toned([0.5, 0.5, 0.5], 1.5, 1).map((c) => +c.toFixed(6))).toEqual([0.5, 0.5, 0.5]);
    expect(toned([0.8, 0.4, 0.2], 1, 0.5).map((c) => +c.toFixed(6))).toEqual([0.4, 0.2, 0.1]);
    // A saturated channel clips at white, as the screen does, before brightness takes its share.
    expect(toned([1, 0.4, 0.2], 1.5, 0.5)[0]).toBe(0.5);
  });
});

/** Realm light's `--ink` and `--ink-2`, near enough. */
const LIGHT_INKS = [{ color: rgb(28, 29, 33), need: 4.5, onTint: true }, { color: rgb(88, 90, 96), need: 3, onTint: true }];
/** Toward white by `d`, as light's `--picture-tone` draws it. */
const whitened = (c: Rgb, d: number) => c.map((v) => v * (1 - d) + d) as Rgb;

describe("light's dim", () => {
  it("is nothing over a pale picture, whose dark words already stand", () => {
    expect(glassDim(fill(rgb(240, 244, 252)), LIGHT_INKS, 1, null, true)).toBe(0);
  });

  it("goes toward white, as the least that keeps the dark words at their ratios over a dark picture", () => {
    // Arcade's night, where the picker's quiet words stood at 1.42:1 on the fixed share.
    const night = rgb(40, 20, 70);
    const d = glassDim(fill(night), LIGHT_INKS, 1, null, true);
    expect(d).toBeGreaterThan(0.4);
    expect(d).toBeLessThan(GLASS_DIM_MAX);
    expect(contrast(rgb(88, 90, 96), whitened(night, d))).toBeGreaterThanOrEqual(3 + GUARD_SPARE - 0.01);
    expect(contrast(rgb(28, 29, 33), whitened(night, d))).toBeGreaterThanOrEqual(4.5 + GUARD_SPARE - 0.01);
    // THE mutant: the dark face's solve, toward black, which never meets a dark word's ratio.
    expect(contrast(rgb(88, 90, 96), whitened(night, d - 0.02))).toBeLessThan(3 + GUARD_SPARE);
  });

  it("is held by the darkest part of the picture, not its brightest", () => {
    // THE mutant: the samples sorted as in dark, which reads the pale sky and lets the dark ridge pass.
    const ridge = [...fill(rgb(245, 245, 245), 900), ...fill(rgb(20, 20, 30), 100)];
    expect(glassDim(ridge, LIGHT_INKS, 1, null, true)).toBeGreaterThan(0.4);
  });
});

describe("the pane's dims", () => {
  const light = () => document.documentElement.getAttribute("data-mode") === "light";
  /** A pane with its dock, over a picture every pixel of which is `pixel`, and the picture's own dim. */
  const paneOver = (pixel: number | readonly number[], own: string) => {
    const [r, g, b] = typeof pixel === "number" ? [pixel, pixel, pixel] : pixel;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      fillRect() {}, drawImage() {},
      // The one-pixel read is the lit row's tint (glassTint), here the face's own extreme (black in
      // dark, white in light), which every ink in these tests clears; the rest is the picture.
      getImageData: (_x: number, _y: number, w: number, h: number) =>
        ({ data: w * h === 1 ? new Uint8ClampedArray(light() ? [255, 255, 255, 255] : [0, 0, 0, 255]) : Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => [r, g, b, 255][i % 4]!) }),
    }) as unknown as CanvasRenderingContext2D);
    const pane = document.createElement("div");
    const dock = pane.appendChild(document.createElement("div"));
    dock.className = "composer-dock";
    pane.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    dock.getBoundingClientRect = () => new DOMRect(100, 480, 600, 100);
    pane.style.setProperty("--picture-dim", own);
    const source = document.createElement("canvas");
    source.width = 800;
    return { pane, source };
  };
  afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute("data-mode"); });

  it("never takes Plain under the picture's own dim, even where the picture needs none", () => {
    // THE mutant: Plain's number left unfloored, which undims a picture its fixed dim had held.
    const { pane, source } = paneOver(0, "0.3");
    setGlassDim(pane, source, [0, 0, 0], () => INK);
    expect(pane.style.getPropertyValue(PLAIN_DIM)).toBe("0.300");
    expect(pane.style.getPropertyValue("--glass-dim")).toBe("0.000");
  });

  it("measures Plain without the glass's saturation, which only the glass lays on the picture", () => {
    // THE mutant: Plain solved with the glass's saturation, dimming a coloured picture more than it needs.
    const { pane, source } = paneOver([230, 150, 40], "0");
    pane.style.setProperty("--glass-saturate", "1.8");
    setGlassDim(pane, source, [0, 0, 0], () => INK);
    const plain = parseFloat(pane.style.getPropertyValue(PLAIN_DIM)), glass = parseFloat(pane.style.getPropertyValue("--glass-dim"));
    expect(plain).toBeGreaterThan(0);
    expect(glass).toBeGreaterThan(plain);
  });

  it("never takes light glass under the picture's own dim", () => {
    // THE mutant: light glass's number left unfloored, as dark glass's is.
    document.documentElement.setAttribute("data-mode", "light");
    const { pane, source } = paneOver(255, "0.3");
    setGlassDim(pane, source, [1, 1, 1], () => rgb(28, 29, 33));
    expect(pane.style.getPropertyValue("--glass-dim")).toBe("0.300");
    expect(pane.style.getPropertyValue(PLAIN_DIM)).toBe("0.300");
  });
});
