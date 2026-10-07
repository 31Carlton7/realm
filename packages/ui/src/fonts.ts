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

/** `content` is the face prose is read in — a transcript's messages, rendered markdown and the
 *  documents editor — and it is the UI face until someone picks another. */
export type FontRole = "ui" | "code" | "content";
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
  /* `bundled` here is "the UI face", whatever that has been set to: prose read in the chrome's own
     face is what the app has always done, so it stays the default and the role only changes
     anything once someone chooses. The serif is the one face the other two roles have no use for and
     prose does — New York on a Mac. */
  content: [
    { id: "bundled", label: "Same as UI font", stack: "var(--font-ui)" },
    { id: "serif", label: "System serif", stack: 'ui-serif, "New York", Georgia, serif' },
    { id: "system", label: "System default", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
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

export type FontPref = { ui: FontId; uiWeight: FontWeight; code: FontId; content: FontId; leading: number; uiSize: number; codeSize: number };

/**
 * The two text sizes, in px — what the body text and inline code are set at, which every other size
 * in the stylesheet is drawn in proportion to (`theme/text-scale.ts` in the desktop app scales each
 * of them by size ÷ default). ⌘+ and ⌘− are page zoom and stay page zoom: zoom scales the layout with
 * the text, these scale only the text.
 *
 * The ranges stop where the layout stops holding. Twelve is as small as the UI goes before its
 * smallest labels meet the 11px floor they are held to; eighteen and sixteen are where a row's text
 * and a chip's mono label still fit the boxes they are drawn in.
 */
export const UI_SIZE_RANGE = { min: 12, max: 18, default: 14 } as const;
export const CODE_SIZE_RANGE = { min: 11, max: 16, default: 12 } as const;

export const DEFAULT_FONTS: FontPref = {
  ui: "bundled", uiWeight: "regular", code: "bundled", content: "bundled", leading: 0,
  uiSize: UI_SIZE_RANGE.default, codeSize: CODE_SIZE_RANGE.default,
};

/**
 * Line height, as an OFFSET in hundredths — the same argument `--fw-shift` makes one block up.
 *
 * Prose is 1.6, markdown 1.55, a code block 1.65, and those three ratios are a judgement about each
 * surface rather than an accident. A control that set an absolute line-height would flatten them into
 * one number and lose the reason a code block breathes more than a paragraph; an offset moves all of
 * them together and keeps the distances between them.
 *
 * Stepped rather than continuous because leading is not a thing anyone dials in by eye at 1/100th —
 * five steps is the whole useful range, and every stop is a ratio somebody would choose on purpose.
 */
export const LEADING_RANGE = { min: -10, max: 30, step: 5, default: 0 } as const;

export const clampLeading = (x: number): number => {
  if (!Number.isFinite(x)) return LEADING_RANGE.default;
  const held = Math.min(LEADING_RANGE.max, Math.max(LEADING_RANGE.min, x));
  return Math.round(held / LEADING_RANGE.step) * LEADING_RANGE.step;
};

/** A whole px inside the range, or the default for anything that is not a number — a size outside
 *  it is a value an older build or a hand edit wrote, and the range is what the layout holds at. */
const clampSize = (range: { min: number; max: number; default: number }, x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? Math.round(Math.min(range.max, Math.max(range.min, x))) : range.default;

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
  const { ui, uiWeight, code, content, leading, uiSize, codeSize } = raw as Record<string, unknown>;
  return {
    ui: isFontId(ui) ? ui : DEFAULT_FONTS.ui,
    uiWeight: isFontWeight(uiWeight) ? uiWeight : DEFAULT_FONTS.uiWeight,
    code: isFontId(code) ? code : DEFAULT_FONTS.code,
    // Field by field like the rest: a row stored before this setting existed has no `leading`, and
    // the answer to that is the default rather than `NaN` written into a line-height. The same goes
    // for the content face and the two sizes, which are younger still.
    content: isFontId(content) ? content : DEFAULT_FONTS.content,
    leading: typeof leading === "number" ? clampLeading(leading) : DEFAULT_FONTS.leading,
    uiSize: clampSize(UI_SIZE_RANGE, uiSize),
    codeSize: clampSize(CODE_SIZE_RANGE, codeSize),
  };
}

export const FONT_VARS = ["--font-ui", "--font-mono", "--font-content", "--fw-shift", "--lh-shift", "--ui-text-scale", "--code-text-scale"] as const;

/** The fallbacks each role lands on — the "System default" stack, which is what a family that fails
 *  to load should degrade to rather than to nothing. */
const FALLBACK: Record<FontRole, string> = {
  ui: FONT_FACES.ui[1]!.stack,
  code: FONT_FACES.code[1]!.stack,
  // A prose family that fails to load reads in the UI face, which is what prose was in before.
  content: "var(--font-ui)",
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
    "--font-content": stack("content", pref.content),
    "--fw-shift": String(FONT_WEIGHT_SHIFT[pref.uiWeight]),
    // Hundredths on the way in, a ratio on the way out — the stylesheet adds it to each surface's own.
    "--lh-shift": String(clampLeading(pref.leading) / 100),
    // Px on the way in, a multiplier on the way out: every size in the stylesheet is drawn at the
    // default, so the multiplier is the one number they all need.
    "--ui-text-scale": String(+(clampSize(UI_SIZE_RANGE, pref.uiSize) / UI_SIZE_RANGE.default).toFixed(4)),
    "--code-text-scale": String(+(clampSize(CODE_SIZE_RANGE, pref.codeSize) / CODE_SIZE_RANGE.default).toFixed(4)),
  };
}
