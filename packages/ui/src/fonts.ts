/** The type faces, as a preference.
 *
 *  What is NOT here: every font installed on the machine. Enumerating those needs a main-process hop
 *  (or `queryLocalFonts`, which is permission-gated and Chromium-only), and the list it returns is
 *  mostly faces this UI cannot use — Realm's chrome is laid out against a four-step weight scale and
 *  tabular figures, and a display face picked out of a list of four hundred silently loses both. The
 *  honest offer is the faces the app ships, which are guaranteed to be there and to have the axes the
 *  layout leans on, plus a genuine system stack for someone who would rather the app looked like the
 *  rest of their machine.
 *
 *  Weight is offered for the UI face and not for code, and that asymmetry is a fact about the
 *  stylesheet rather than a judgement: every mono surface in styles.css sets its font with the `font:`
 *  shorthand, which resets font-weight to normal by definition. Reaching them would mean editing
 *  fifty-odd rules in a shared stylesheet, or encoding a weight into a family name. The UI face has
 *  no such problem — its weights come from a four-token scale the whole app already reads — so the
 *  control shifts that scale and the hierarchy it draws survives intact. */

export type FontRole = "ui" | "code";
export type FontId = "bundled" | "system";
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

const isFontId = (x: unknown): x is FontId => x === "bundled" || x === "system";
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

const stack = (role: FontRole, id: FontId): string =>
  (FONT_FACES[role].find((f) => f.id === id) ?? FONT_FACES[role][0]!).stack;

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
