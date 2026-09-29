import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { BENCHMARK_VERSION, bundledLayaDir, labelCopies, loadBenchmark, splitOf } from "./benchmark";

/**
 * The benchmark as data. What must die: a case counted as "not copying" that repeats the label, a
 * held-out app whose cases leak into another split, a rebuild that moves a case between splits, and
 * a benchmark read with a case pointing at nothing.
 */

describe("whether an intent copies its element's label", () => {
  it("counts a word of the label, inflected or not, as a copy", () => {
    expect(labelCopies("turn up the display brightness", "Display & Brightness")).toBe(true);
    expect(labelCopies("see who I'm sharing with", "Share with Someone")).toBe(true);
    expect(labelCopies("my photos", "Photo")).toBe(true);
    expect(labelCopies("pulse at rest", "Resting Heart Rate")).toBe(true);
  });

  it("does not count synonyms, world knowledge, or a word that only starts the same", () => {
    expect(labelCopies("pair my AirPods", "Bluetooth")).toBe(false);
    expect(labelCopies("email him", "Mail")).toBe(false);
    expect(labelCopies("SFMOMA", "San Francisco Museum of Modern Art")).toBe(false);
    expect(labelCopies("my apps", "Apple Account")).toBe(false);
    // Words that carry no meaning are not a copy of anything.
    expect(labelCopies("open the one on the left", "The Pond")).toBe(false);
  });
});

describe("splits", () => {
  const o = { heldoutApps: ["Maps"], validationApps: ["Watch"], heldoutShare: 0.15, validationShare: 0.12 };

  it("holds out and keeps apart whole apps, whatever the case", () => {
    for (let i = 0; i < 50; i++) {
      expect(splitOf("Maps", `k${i}`, o)).toBe("heldout");
      expect(splitOf("Watch", `k${i}`, o)).toBe("validation");
    }
  });

  it("draws every other app's cases stably, in about the shares asked for", () => {
    const keys = Array.from({ length: 4000 }, (_, i) => `target:settings:${i}:intent ${i}`);
    const splits = keys.map((k) => splitOf("Settings", k, o));
    expect(keys.map((k) => splitOf("Settings", k, o))).toEqual(splits);
    const share = (s: string) => splits.filter((x) => x === s).length / splits.length;
    expect(share("heldout")).toBeGreaterThan(0.12);
    expect(share("heldout")).toBeLessThan(0.18);
    expect(share("validation")).toBeGreaterThan(0.09);
    expect(share("validation")).toBeLessThan(0.15);
  });
});

describe("reading a benchmark", () => {
  function write(dir: string, o: { screen?: string; pair?: string } = {}) {
    for (const sub of ["screens", "pairs", "cases"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "benchmark.json"), JSON.stringify({ version: "v", apps: ["Settings"] }));
    writeFileSync(join(dir, "screens", "s.json"), JSON.stringify({ id: "s", app: "Settings", from: "t", elements: [{ id: "0", role: "Button", label: "General" }] }));
    writeFileSync(join(dir, "pairs", "p.json"), JSON.stringify({ id: "p", app: "Settings", tool: "simulator_tap", action: "tap", before: [], after: [] }));
    writeFileSync(join(dir, "cases", "target.jsonl"), JSON.stringify({ id: "t1", split: "heldout", app: "Settings", screen: o.screen ?? "s", element: "0", intent: "update iOS", copies: false }) + "\n");
    writeFileSync(join(dir, "cases", "sensitive.jsonl"), "");
    writeFileSync(join(dir, "cases", "verify.jsonl"), JSON.stringify({ id: "v1", split: "train", app: "Settings", pair: o.pair ?? "p", tool: "simulator_tap", intent: "open General", achieved: true, kind: "ok" }) + "\n");
  }

  it("reads its screens, pairs and cases", () => {
    const dir = tempDir("realm-laya-bench-");
    write(dir);
    const b = loadBenchmark(dir);
    expect(b.version).toBe("v");
    expect(b.screens.get("s")!.elements).toHaveLength(1);
    expect(b.target.map((c) => c.id)).toEqual(["t1"]);
    expect(b.verify.map((c) => c.pair)).toEqual(["p"]);
  });

  it("refuses a case that names a screen or a step it does not have", () => {
    const a = tempDir("realm-laya-bench-");
    write(a, { screen: "missing" });
    expect(() => loadBenchmark(a)).toThrow("benchmark case t1 names screen missing");
    const b = tempDir("realm-laya-bench-");
    write(b, { pair: "gone" });
    expect(() => loadBenchmark(b)).toThrow("benchmark case v1 names pair gone");
  });

  it("is the version the shipped benchmark says it is", () => {
    const shipped = loadBenchmark(join(bundledLayaDir()!, "benchmark"));
    expect(shipped.version).toBe(BENCHMARK_VERSION);
    expect(shipped.target.length).toBeGreaterThanOrEqual(350);
    expect(shipped.target.filter((c) => !c.copies).length * 2).toBeGreaterThanOrEqual(shipped.target.length);
  });

  it("finds Realm's Laya resources where it is told to, and says so when they are not there", () => {
    const dir = tempDir("realm-laya-res-");
    expect(bundledLayaDir({ REALM_LAYA_RESOURCES: dir })).toBe(dir);
    expect(bundledLayaDir({ REALM_LAYA_RESOURCES: join(dir, "nope") })).toBeNull();
  });
});
