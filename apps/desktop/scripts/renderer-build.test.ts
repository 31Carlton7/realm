// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { transformWithEsbuild } from "vite";
import { describe, expect, it } from "vitest";
import config from "../electron.vite.config";

const renderer = (config as {
  renderer: {
    build?: { minify?: unknown };
    esbuild?: { keepNames?: boolean };
    optimizeDeps?: { esbuildOptions?: { target?: string } };
  };
}).renderer;

describe("the production renderer build", () => {
  it("is minified, which roughly halves the boot chunk", () => {
    expect(renderer.build?.minify).toBe("esbuild");
  });

  it("keeps function names through the minifier, so the app picker can still name components", () => {
    expect(renderer.esbuild?.keepNames).toBe(true);
  });
});

describe("the dev renderer's dependency pre-bundle", () => {
  const novncBrowser = join(createRequire(import.meta.url).resolve("@novnc/novnc"), "../util/browser.js");
  const compile = (target: string) =>
    transformWithEsbuild(readFileSync(novncBrowser, "utf8"), novncBrowser, { format: "esm", target });

  it("compiles noVNC's top-level await, which Vite's own chrome87 default rejects", async () => {
    await expect(compile("chrome87")).rejects.toThrow(/Top-level await is not available/);
    const target = renderer.optimizeDeps?.esbuildOptions?.target;
    expect(target).toBeDefined();
    await expect(compile(target!)).resolves.toBeTruthy();
  });
});
