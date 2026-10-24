import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { pruneDevFiles } from "./lib/prune-dev-files.mjs";

describe("pruneDevFiles", () => {
  it("deletes source maps and declarations, keeps code, data and licenses, and never follows a link", () => {
    const modules = join(tempDir("prune-dev-"), "node_modules");
    const pkg = join(modules, ".pnpm", "sdk@1.0.0", "node_modules", "sdk");
    const files = ["index.js", "index.js.map", "index.d.ts", "index.d.mts", "esm/index.mjs", "esm/index.mjs.map", "style.css.map",
      "LICENSE", "package.json", "cmaps/Adobe-Japan1-0.bcmap", "src/index.ts"];
    for (const f of files) { mkdirSync(dirname(join(pkg, f)), { recursive: true }); writeFileSync(join(pkg, f), ""); }
    // pnpm's own shapes: a package linked at the top, and one whose dependency links back to itself.
    symlinkSync(join(".pnpm", "sdk@1.0.0", "node_modules", "sdk"), join(modules, "sdk"));
    mkdirSync(join(pkg, "node_modules"));
    symlinkSync(join("..", "..", "sdk"), join(pkg, "node_modules", "sdk"));

    expect(pruneDevFiles(modules)).toBe(5);
    const left = (d: string, rel = ""): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isSymbolicLink() ? [] : e.isDirectory() ? left(join(d, e.name), join(rel, e.name)) : [join(rel, e.name)]);
    expect(left(pkg).sort()).toEqual(["LICENSE", "cmaps/Adobe-Japan1-0.bcmap", "esm/index.mjs", "index.js", "package.json", "src/index.ts"]);
  });
});
