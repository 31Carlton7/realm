import { describe, expect, it } from "vitest";
import { clampLeading, DEFAULT_FONTS, FONT_FACES, FONT_VARS, FONT_WEIGHT_SHIFT, fontVars, LEADING_RANGE, parseFontPref } from "./fonts";

describe("the faces on offer", () => {
  it("are ones the app can actually deliver: a bundled family, or a real system stack", () => {
    // THE bare-family mutant: offer "Inter" and "system-ui" with nothing behind them. A bundled face
    // that failed to load, or a system stack on a platform without that generic, leaves the app with
    // no family at all and the browser's default serif — which is not a font this layout was drawn
    // against and is not what the user picked either.
    for (const role of ["ui", "code"] as const) {
      expect(FONT_FACES[role].map((f) => f.id)).toEqual(["bundled", "system"]);
      for (const face of FONT_FACES[role]) {
        expect(face.stack.split(",").length, `${role}/${face.id}`).toBeGreaterThan(2);
        expect(face.stack, `${role}/${face.id}`).toMatch(role === "ui" ? /sans-serif$/ : /monospace$/);
      }
    }
    // The bundled options lead with the self-hosted family and keep the system stack behind them.
    expect(FONT_FACES.ui[0]!.stack).toMatch(/^"Inter", /);
    expect(FONT_FACES.code[0]!.stack).toMatch(/^"JetBrains Mono", /);
    expect(FONT_FACES.ui[0]!.stack.endsWith(FONT_FACES.ui[1]!.stack)).toBe(true);
    expect(FONT_FACES.code[0]!.stack.endsWith(FONT_FACES.code[1]!.stack)).toBe(true);
  });
});

describe("what a font preference writes", () => {
  it("fills exactly FONT_VARS, on every preference including the default", () => {
    // Unlike a palette these are never cleared: the stylesheet's own values ARE the bundled stacks,
    // so there is no static-CSS behaviour that writing nothing would preserve — and a preference
    // that wrote only some of the three would leave the app half on the previous one.
    for (const ui of ["bundled", "system"] as const) {
      for (const code of ["bundled", "system"] as const) {
        for (const uiWeight of ["regular", "medium"] as const) {
          expect(Object.keys(fontVars({ ui, code, uiWeight, leading: 0 })).sort()).toEqual([...FONT_VARS].sort());
        }
      }
    }
  });

  it("the weight is a SHIFT, so the four rungs of the ladder stay four rungs", () => {
    // THE absolute-weight mutant: write a font-weight instead of an offset. `--fw-medium` (450) and
    // `--fw-label` (500) would land on the same number, and a user who asked for heavier text would
    // lose the distinction between a label and the value beside it to get it.
    expect(fontVars(DEFAULT_FONTS)["--fw-shift"]).toBe("0");
    expect(fontVars({ ...DEFAULT_FONTS, uiWeight: "medium" })["--fw-shift"]).toBe(String(FONT_WEIGHT_SHIFT.medium));
    expect(FONT_WEIGHT_SHIFT.medium).toBeGreaterThan(0);
    // ...and small enough that the heaviest rung stays inside the weight axis Inter is bundled for.
    expect(600 + FONT_WEIGHT_SHIFT.medium).toBeLessThanOrEqual(900);
  });

  it("leading is a SHIFT too, so the surfaces keep the distances between them", () => {
    /* THE absolute-leading mutant: write a line-height instead of an offset. Prose (1.6), markdown
       (1.55) and a code block (1.65) would collapse onto one number, and the reason a code block
       breathes more than a paragraph would go with it. The stylesheet adds this to each surface's
       own ratio, so the only thing that can be asserted here is that it IS the offset, in ratio. */
    expect(fontVars({ ...DEFAULT_FONTS, leading: 0 })["--lh-shift"]).toBe("0");
    expect(fontVars({ ...DEFAULT_FONTS, leading: 10 })["--lh-shift"]).toBe("0.1");
    expect(fontVars({ ...DEFAULT_FONTS, leading: -10 })["--lh-shift"]).toBe("-0.1");
  });

  it("refuses a stored leading that would write a broken line-height", () => {
    // Same argument as the family regex above: the one thing this preference must never do is put a
    // value in `calc()` that drops the declaration and lays the app out on the UA's default.
    expect(clampLeading(Number.NaN)).toBe(LEADING_RANGE.default);
    expect(clampLeading(Number.POSITIVE_INFINITY)).toBe(LEADING_RANGE.default);
    expect(clampLeading(9999)).toBe(LEADING_RANGE.max);
    expect(clampLeading(-9999)).toBe(LEADING_RANGE.min);
    // Snapped to the step, so every stop is one somebody would choose on purpose.
    expect(clampLeading(7)).toBe(5);
    // A row stored before this setting existed carries no `leading` at all.
    expect(parseFontPref({ ui: "bundled", uiWeight: "regular", code: "bundled" }).leading).toBe(LEADING_RANGE.default);
    expect(parseFontPref({ ...DEFAULT_FONTS, leading: "big" }).leading).toBe(LEADING_RANGE.default);
  });

  it("the two roles are independent — a code face cannot move the chrome", () => {
    const a = fontVars({ ui: "bundled", code: "system", uiWeight: "regular", leading: 0 });
    const b = fontVars({ ui: "bundled", code: "bundled", uiWeight: "regular", leading: 0 });
    expect(a["--font-ui"]).toBe(b["--font-ui"]);
    expect(a["--font-mono"]).not.toBe(b["--font-mono"]);
  });
});

describe("read back off a user-editable settings row", () => {
  it("keeps what it recognises and defaults the rest, field by field", () => {
    // THE trusted-row mutant: cast it. A value this does not vet reaches `fontVars` and can write
    // the literal string "undefined" into --font-ui — a window with no text in it.
    expect(parseFontPref({ ui: "system", uiWeight: "medium", code: "system" }))
      .toEqual({ ui: "system", uiWeight: "medium", code: "system", leading: 0 });
    // A FAMILY NAME is a real answer now — the two reserved words are no longer the whole offer.
    expect(parseFontPref({ ui: "Comic Sans MS", uiWeight: 700, code: "system" }))
      .toEqual({ ui: "Comic Sans MS", uiWeight: "regular", code: "system", leading: 0 });
    for (const junk of [null, undefined, "bundled", 3, []]) expect(parseFontPref(junk)).toEqual(DEFAULT_FONTS);
    // Whatever comes back is a family the app has a stack for.
    expect(fontVars(parseFontPref({ ui: "nope" }))["--font-ui"]).toContain("sans-serif");
  });

  it("refuses a family name that could break out of the CSS stack", () => {
    /* The name goes into `font-family` inside quotes, so a quote or a semicolon in it would end the
       declaration and take the rest of the stack with it. Refused at the parse, not escaped at the
       write: there is one place this value is vetted and it is here. */
    for (const bad of ['a"; color: red; font-family: "b', "a;b", "a<b>", "", "x".repeat(80)]) {
      expect(parseFontPref({ ui: bad }).ui, bad).toBe("bundled");
    }
  });

  it("puts a chosen family in FRONT of the role's own fallbacks, so a missing one still reads", () => {
    const ui = fontVars(parseFontPref({ ui: "Iosevka" }))["--font-ui"]!;
    expect(ui.startsWith('"Iosevka", ')).toBe(true);
    expect(ui).toContain("system-ui");
    const code = fontVars(parseFontPref({ code: "Fira Code" }))["--font-mono"]!;
    expect(code.startsWith('"Fira Code", ')).toBe(true);
    // A mono choice falls back to a MONO stack, never to the UI one.
    expect(code).toContain("monospace");
  });
});
