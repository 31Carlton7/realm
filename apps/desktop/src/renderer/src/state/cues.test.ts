import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_SOUND_VOLUME } from "@realm/contracts";
import { CUE_BY_CATEGORY, cueVolume } from "./cues";

/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd instead
   (vitest may be invoked from the repo root or from apps/desktop). */
function repoDir(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/* Prose ABOUT `bind()` and the attributes it wires — this file's own, and cues.ts's — must not read
   as a use of them. Line comments are cut only where the slashes do not follow a colon, so a URL in
   a comment cannot swallow the rest of its line. */
const code = (path: string): string =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("cues", () => {
  it("an unreadable or out-of-range volume falls back to the default, never to silence", () => {
    for (const bad of [null, undefined, "loud", NaN, Infinity, -0.5, 4]) {
      expect(cueVolume(bad)).toBe(DEFAULT_NOTIFICATION_SOUND_VOLUME);
    }
    expect(cueVolume(0)).toBe(0); // an explicit zero IS a preference, and is kept
    expect(cueVolume(0.2)).toBe(0.2);
    expect(cueVolume(1)).toBe(1);
  });

  it("two sounds, no more: the table maps categories onto a vocabulary of exactly `ready` and `chime`", () => {
    expect(new Set(Object.values(CUE_BY_CATEGORY))).toEqual(new Set(["ready", "chime"]));
  });

  /**
   * cuelume's `bind()` wires every `data-cuelume-*` attribute for hovers, presses, releases and
   * toggles — a sound on ordinary UI interaction, which is the one thing these cues must never
   * become. Nothing else in the suite can see it: `bind()` attaches document listeners at call time,
   * so a stray call in a module no test mounts would ship silently. This reads the renderer sources
   * instead, which is the only place the absence is visible.
   */
  it("THE bind() mutant: the renderer reaches for `play` and nothing else in cuelume", () => {
    const root = repoDir("apps/desktop/src/renderer/src");
    const importers = sourceFiles(root)
      .map((p) => [p, code(p)] as const)
      .filter(([, src]) => /from\s+["']cuelume["']/.test(src));
    // One importer, so there is one place to look when asking what Realm makes noise for.
    expect(importers.map(([p]) => p.slice(root.length + 1))).toEqual(["state/live-api.ts"]);
    for (const [, src] of importers) {
      const imported = /import\s*\{([^}]*)\}\s*from\s*["']cuelume["']/.exec(src)?.[1] ?? "";
      expect(imported.split(",").map((s) => s.trim()).filter(Boolean)).toEqual(["play"]);
    }
    expect(sourceFiles(root).some((p) => /data-cuelume-/.test(code(p)))).toBe(false);
  });
});
