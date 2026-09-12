import { describe, expect, it } from "vitest";
import { DEFAULT_FONTS, FONT_FACES, FONT_VARS, FONT_WEIGHT_SHIFT, fontVars, parseFontPref } from "./fonts";

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
          expect(Object.keys(fontVars({ ui, code, uiWeight })).sort()).toEqual([...FONT_VARS].sort());
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

  it("the two roles are independent — a code face cannot move the chrome", () => {
    const a = fontVars({ ui: "bundled", code: "system", uiWeight: "regular" });
    const b = fontVars({ ui: "bundled", code: "bundled", uiWeight: "regular" });
    expect(a["--font-ui"]).toBe(b["--font-ui"]);
    expect(a["--font-mono"]).not.toBe(b["--font-mono"]);
  });
});

describe("read back off a user-editable settings row", () => {
  it("keeps what it recognises and defaults the rest, field by field", () => {
    // THE trusted-row mutant: cast it. A value this does not vet reaches `fontVars` and can write
    // the literal string "undefined" into --font-ui — a window with no text in it.
    expect(parseFontPref({ ui: "system", uiWeight: "medium", code: "system" }))
      .toEqual({ ui: "system", uiWeight: "medium", code: "system" });
    // A FAMILY NAME is a real answer now — the two reserved words are no longer the whole offer.
    expect(parseFontPref({ ui: "Comic Sans MS", uiWeight: 700, code: "system" }))
      .toEqual({ ui: "Comic Sans MS", uiWeight: "regular", code: "system" });
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
