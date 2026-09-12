import { describe, expect, it } from "vitest";

/**
 * Every hook in a pane sits above its early returns.
 *
 * React counts hooks per render, so a `useApp` below an `if (…) return` renders a different number
 * of them depending on data that arrives later — and answers with error #310, which in a built app
 * is a blank window rather than a message. It happened: `SessionPane` grew four hooks under its
 * `if (!session)` guard and took the whole shell down at boot, on a build whose unit tests were all
 * green, because no test ever rendered the pane in the state that returns early.
 *
 * A source scan rather than a render, deliberately: the failure is about ORDER in the file, one
 * render can only ever show one path through it, and the panes that matter are the ones nobody
 * thought to mount in the loading state.
 */
const SOURCES = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** A component's body, from its opening line to the closing brace at column 0. */
function bodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^(?:export )?function ([A-Z]\w*)\s*\(/gm;
  for (const m of src.matchAll(re)) {
    const start = m.index!;
    const end = src.indexOf("\n}", start);
    out.push({ name: m[1]!, body: src.slice(start, end < 0 ? src.length : end) });
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("hook order", () => {
  it("scans the real panes", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(15);
  });

  it("no component calls a hook below one of its own early returns", () => {
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(SOURCES)) {
      if (file.includes(".test.")) continue;
      for (const { name, body } of bodies(strip(raw))) {
        const lines = body.split("\n");
        // A guard: `if (…) return …` at the component's own indentation. Two spaces is one level
        // inside the function, so this never matches a return inside a callback or a nested block.
        const guard = lines.findIndex((l) => /^ {2}if \s*\(.*\)\s*return\b/.test(l) || /^ {2}if \s*\(.*\)\s*\{$/.test(l) === false && /^ {2}return\b/.test(l));
        if (guard < 0) continue;
        const hook = lines.findIndex((l, i) => i > guard && /^ {2}(?:const |let )?[\w{}, ]*=?\s*use[A-Z]\w*\(/.test(l));
        if (hook >= 0) offenders.push(`${file.replace("./", "")} ${name}: "${lines[hook]!.trim().slice(0, 60)}" is below "${lines[guard]!.trim().slice(0, 40)}"`);
      }
    }
    expect(offenders, "hooks below an early return — React counts hooks per render (#310)").toEqual([]);
  });
});
