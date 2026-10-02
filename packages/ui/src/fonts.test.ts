import { describe, expect, it } from "vitest";
import { clampLeading, CODE_SIZE_RANGE, DEFAULT_FONTS, FONT_FACES, FONT_VARS, FONT_WEIGHT_SHIFT, fontVars, LEADING_RANGE, parseFontPref, UI_SIZE_RANGE } from "./fonts";

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
          expect(Object.keys(fontVars({ ...DEFAULT_FONTS, ui, code, uiWeight })).sort()).toEqual([...FONT_VARS].sort());
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
    const a = fontVars({ ...DEFAULT_FONTS, code: "system" });
    const b = fontVars({ ...DEFAULT_FONTS, code: "bundled" });
    expect(a["--font-ui"]).toBe(b["--font-ui"]);
    expect(a["--font-mono"]).not.toBe(b["--font-mono"]);
  });
});

describe("read back off a user-editable settings row", () => {
  it("keeps what it recognises and defaults the rest, field by field", () => {
    // THE trusted-row mutant: cast it. A value this does not vet reaches `fontVars` and can write
    // the literal string "undefined" into --font-ui — a window with no text in it.
    expect(parseFontPref({ ui: "system", uiWeight: "medium", code: "system" }))
      .toEqual({ ...DEFAULT_FONTS, ui: "system", uiWeight: "medium", code: "system" });
    // A FAMILY NAME is a real answer now — the two reserved words are no longer the whole offer.
    expect(parseFontPref({ ui: "Comic Sans MS", uiWeight: 700, code: "system" }))
      .toEqual({ ...DEFAULT_FONTS, ui: "Comic Sans MS", uiWeight: "regular", code: "system" });
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

describe("the content face (prose)", () => {
  it("is the UI face until someone picks another, so nothing moves on upgrade", () => {
    // THE own-default mutant: give prose a face of its own out of the box, and every transcript in
    // every install changes typeface the day this ships.
    expect(DEFAULT_FONTS.content).toBe("bundled");
    expect(fontVars(DEFAULT_FONTS)["--font-content"]).toBe("var(--font-ui)");
    expect(FONT_FACES.content.map((f) => f.id)).toEqual(["bundled", "serif", "system"]);
    expect(fontVars({ ...DEFAULT_FONTS, content: "serif" })["--font-content"]).toMatch(/^ui-serif, .*serif$/);
  });

  it("is its own role — choosing it moves neither the chrome nor the code", () => {
    const a = fontVars({ ...DEFAULT_FONTS, content: "serif" });
    const b = fontVars(DEFAULT_FONTS);
    expect(a["--font-ui"]).toBe(b["--font-ui"]);
    expect(a["--font-mono"]).toBe(b["--font-mono"]);
    expect(a["--font-content"]).not.toBe(b["--font-content"]);
  });

  it("puts a chosen family in front of the UI face, which is what prose fell back to before", () => {
    expect(fontVars(parseFontPref({ content: "Lora" }))["--font-content"]).toBe('"Lora", var(--font-ui)');
  });
});

describe("the two text sizes", () => {
  it("write a multiplier off the default each stylesheet size is drawn at", () => {
    // THE px-written mutant: write the size itself, which no rule can multiply by.
    expect(fontVars(DEFAULT_FONTS)["--ui-text-scale"]).toBe("1");
    expect(fontVars(DEFAULT_FONTS)["--code-text-scale"]).toBe("1");
    expect(fontVars({ ...DEFAULT_FONTS, uiSize: 16 })["--ui-text-scale"]).toBe(String(+(16 / UI_SIZE_RANGE.default).toFixed(4)));
    expect(fontVars({ ...DEFAULT_FONTS, codeSize: 15 })["--code-text-scale"]).toBe("1.25");
    // Independent, like the faces: a bigger UI is not a request for bigger code.
    expect(fontVars({ ...DEFAULT_FONTS, uiSize: 16 })["--code-text-scale"]).toBe("1");
  });

  it("hold to whole px inside the range the layout was checked at", () => {
    expect(parseFontPref({ ...DEFAULT_FONTS, uiSize: 99, codeSize: 2 })).toMatchObject({ uiSize: UI_SIZE_RANGE.max, codeSize: CODE_SIZE_RANGE.min });
    expect(parseFontPref({ ...DEFAULT_FONTS, uiSize: 15.6, codeSize: "big" })).toMatchObject({ uiSize: 16, codeSize: CODE_SIZE_RANGE.default });
    expect(parseFontPref({ ...DEFAULT_FONTS, uiSize: Number.NaN }).uiSize).toBe(UI_SIZE_RANGE.default);
  });

  it("a row saved before the content face and the sizes existed reads as the defaults for them", () => {
    /* The shape `ui.fonts` had on the previous release, written out by hand rather than built from
       DEFAULT_FONTS — the point is what an OLD row parses to. Everything it did say survives. */
    const previous = { ui: "Iosevka", uiWeight: "medium", code: "system", leading: 10 };
    expect(parseFontPref(previous)).toEqual({
      ui: "Iosevka", uiWeight: "medium", code: "system", leading: 10,
      content: "bundled", uiSize: 14, codeSize: 12,
    });
  });
});
