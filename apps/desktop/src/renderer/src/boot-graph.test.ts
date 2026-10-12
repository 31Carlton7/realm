// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the window has to parse before its first paint: every module `main.tsx` reaches through
 * static imports. The heavy parts below are each loaded on demand (`lazy-component.ts`,
 * `rich-libs.ts`, the terminal hub), and one static import from anywhere in that graph would put
 * them back in the boot chunk without a single test noticing — so this walks the graph the way the
 * bundler does and says where.
 */
const ROOT = dirname(new URL(import.meta.url).pathname);
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
// `import x from`, `import { … } from`, `export … from` and bare `import "…"`; not `import type`, not `import()`.
const STATIC = /^\s*(?:import(?!\s+type\b)(?:[^;"'()]*?from)?|export\s+(?!type\b)[^;"'()]*?from)\s*["']([^"']+)["']/gm;

function bootGraph(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [join(ROOT, "main.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(STATIC)) {
      if (spec!.startsWith(".")) {
        const base = resolve(dirname(file), spec!.replace(/\?.*$/, ""));
        const hit = EXTS.map((e) => base + e).find((p) => existsSync(p) && /\.tsx?$/.test(p));
        if (hit) queue.push(hit);
      } else if (!packages.has(spec!)) packages.set(spec!, relative(ROOT, file));
    }
  }
  return { files, packages };
}

describe("the boot chunk", () => {
  const { files, packages } = bootGraph();
  const reached = new Set([...files].map((f) => relative(ROOT, f)));

  it("is a real graph (the walk found the app)", () => {
    expect(reached).toContain("App.tsx");
    expect(reached).toContain("panes/session/SessionPane.tsx");
  });

  it.each(["katex", "highlight.js/lib/core", "@xterm/xterm", "@xterm/addon-fit"])("does not import %s", (pkg) => {
    expect(packages.get(pkg), `imported statically by ${packages.get(pkg)}`).toBeUndefined();
  });

  it.each([
    "panes/settings/SettingsPage.tsx",
    "panes/code-review/CodeReviewPage.tsx",
    "panes/browser/runner/RunnerGame.tsx",
    "components/RealmiteMaker.tsx",
    "panes/session/rich/highlight-grammars.ts",
    "panes/session/rich/katex-lib.ts",
  ])("does not reach %s", (file) => {
    expect(reached.has(file)).toBe(false);
  });
});
