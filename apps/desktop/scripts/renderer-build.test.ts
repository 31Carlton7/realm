// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "../electron.vite.config";

const renderer = (config as { renderer: { build?: { minify?: unknown }; esbuild?: { keepNames?: boolean } } }).renderer;

describe("the production renderer build", () => {
  it("is minified, which roughly halves the boot chunk", () => {
    expect(renderer.build?.minify).toBe("esbuild");
  });

  it("keeps function names through the minifier, so the app picker can still name components", () => {
    expect(renderer.esbuild?.keepNames).toBe(true);
  });
});
