import { describe, expect, it } from "vitest";
import { contrast, GUARD_SPARE } from "../panes/session/hero-backdrop-color";
import type { Rgb } from "../panes/session/hero-backdrop";
import { GLASS_DIM_MAX, GLASS_DIM_TAIL, glassDim, toned } from "./glass-dim";

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
