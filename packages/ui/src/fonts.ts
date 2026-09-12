/** The type faces, as a preference.
 *
 *  Three kinds of answer now: the faces the app ships, a genuine system stack, and ANY family — one
 *  installed on this Mac (`queryLocalFonts`, which Electron answers with some seven hundred) or one
 *  fetched from Google Fonts and kept in `~/Realm/fonts`.
 *
 *  This used to offer only the first two, and the argument for that is worth keeping because it is
 *  still true rather than wrong: Realm's chrome is laid out against a four-step weight scale and
 *  tabular figures, and a display face picked out of a list of seven hundred has neither. What
 *  changed is who decides. The caveat belongs on screen, next to the control, where someone choosing
 *  a face can read it — not in a list that refuses to show them their own fonts.
 *
 *  Weight is offered for the UI face and not for code, and that asymmetry is a fact about the
 *  stylesheet rather than a judgement: every mono surface in styles.css sets its font with the `font:`
 *  shorthand, which resets font-weight to normal by definition. Reaching them would mean editing
 *  fifty-odd rules in a shared stylesheet, or encoding a weight into a family name. The UI face has
 *  no such problem — its weights come from a four-token scale the whole app already reads — so the
 *  control shifts that scale and the hierarchy it draws survives intact. */

export type FontRole = "ui" | "code";
/**
 * `bundled`, `system`, or a family NAME.
 *
 * A bare string rather than a tagged union, and deliberately: this is persisted in a settings row
 * that predates families, so widening the type has to leave every stored `"bundled"` and `"system"`
 * meaning exactly what it meant. Anything that is not one of the two reserved words is a family, and
 * `fontVars` quotes it into the stack in front of the role's own fallbacks — so a family that fails
 * to load lands on the same thing "System default" would have picked.
 */
export type FontId = "bundled" | "system" | (string & {});
export type FontWeight = "regular" | "medium";

export type FontFace = {
  id: FontId;
  label: string;
  /** The CSS font stack. Bundled families lead with the self-hosted name and keep the system stack
   *  behind them, so a face that somehow fails to load degrades to the same thing "System" picks. */
  stack: string;
};

/** Inter and JetBrains Mono are @font-face'd at the top of styles.css; the fallbacks after them are
 *  the stacks that block was written against. */
export const FONT_FACES: Record<FontRole, readonly FontFace[]> = {
  ui: [
    { id: "bundled", label: "Inter", stack: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
    { id: "system", label: "System default", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  ],
  code: [
    { id: "bundled", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace' },
    { id: "system", label: "System default", stack: 'ui-monospace, "SF Mono", Menlo, monospace' },
  ],
};

/** How much the whole UI weight scale moves. Applied as an offset rather than as absolute weights so
 *  the four steps stay four steps: `--fw-medium` through `--fw-strong` are 450/500/560/600, and a
 *  control that flattened them to one number would erase the difference between a label and a title
 *  in the course of making both a little heavier. 45 is one step of that scale. */
export const FONT_WEIGHT_SHIFT: Record<FontWeight, number> = { regular: 0, medium: 45 };

export const FONT_WEIGHTS: { id: FontWeight; label: string }[] = [
  { id: "regular", label: "Regular" }, { id: "medium", label: "Medium" },
];

export type FontPref = { ui: FontId; uiWeight: FontWeight; code: FontId };

export const DEFAULT_FONTS: FontPref = { ui: "bundled", uiWeight: "regular", code: "bundled" };

/** A family name that can go in a CSS stack without escaping games: letters, digits, spaces and the
 *  punctuation real family names use. A name outside this is dropped rather than quoted, because the
 *  one thing a font preference must never do is write a broken `font-family` and leave a window with
 *  no text in it. */
const FAMILY = /^[\w][\w .'+-]{0,62}$/;
const isFontId = (x: unknown): x is FontId =>
  x === "bundled" || x === "system" || (typeof x === "string" && FAMILY.test(x));
const isFontWeight = (x: unknown): x is FontWeight => x === "regular" || x === "medium";

/** Read back off a user-editable settings row, field by field. An unknown family would resolve to
 *  `undefined` in `fontVars` and write the literal string "undefined" into `--font-ui`, which is a
 *  window with no text in it. */
export function parseFontPref(raw: unknown): FontPref {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_FONTS;
  const { ui, uiWeight, code } = raw as Record<string, unknown>;
  return {
    ui: isFontId(ui) ? ui : DEFAULT_FONTS.ui,
    uiWeight: isFontWeight(uiWeight) ? uiWeight : DEFAULT_FONTS.uiWeight,
    code: isFontId(code) ? code : DEFAULT_FONTS.code,
  };
}

export const FONT_VARS = ["--font-ui", "--font-mono", "--fw-shift"] as const;

/** The fallbacks each role lands on — the "System default" stack, which is what a family that fails
 *  to load should degrade to rather than to nothing. */
const FALLBACK: Record<FontRole, string> = {
  ui: FONT_FACES.ui[1]!.stack,
  code: FONT_FACES.code[1]!.stack,
};

const stack = (role: FontRole, id: FontId): string => {
  const known = FONT_FACES[role].find((f) => f.id === id);
  if (known) return known.stack;
  // A family: quoted, in front of the role's own fallbacks. `FAMILY` has already refused anything
  // that could break out of the quotes.
  return FAMILY.test(id) ? `"${id}", ${FALLBACK[role]}` : FALLBACK[role];
};

/** The three properties a font preference writes. The default writes them too rather than clearing
 *  them: unlike a palette, these are not a second skin over a hand-tuned one — the stylesheet's own
 *  values ARE the bundled stacks, so writing them back is a no-op and there is no static-CSS
 *  behaviour to preserve by staying silent. */
export function fontVars(pref: FontPref): Record<string, string> {
  return {
    "--font-ui": stack("ui", pref.ui),
    "--font-mono": stack("code", pref.code),
    "--fw-shift": String(FONT_WEIGHT_SHIFT[pref.uiWeight]),
  };
}
