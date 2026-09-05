import { SEED_ROLES, SYNTAX_ROLES, isHexColour, type ThemeSeed } from "./themes";
import type { Mode } from "./theme";

/** Carrying a theme between two Realms, or out of one and into a gist.
 *
 *  The document IS a `ThemeSeed` and a face, because that is the only thing in this system that is
 *  stated rather than derived. Everything a theme looks like — the surface ladder, the ink ramp, the
 *  tints, the tooltip chip, the corrected hues — comes back out of `deriveVars` from these twelve
 *  values, so a document that carried the derived palette instead would be ninety numbers that go
 *  stale the moment a ramp constant changes, and would arrive as a set of raw colours the contrast
 *  floors never got to look at. Twelve values through the same machinery a vendored palette goes
 *  through is the whole point.
 *
 *  A FULL seed, not a partial one. An override is an edit to a palette that is already there; an
 *  import is a theme. Requiring all twelve means a document is either a theme or it is refused, and
 *  never half of one silently merged over whatever the user happened to have selected. */
export const THEME_DOC_VERSION = 1;

export type ThemeDocument = {
  realmTheme: number;
  /** What it was called where it came from. Kept for the message the import shows, never applied —
   *  an imported theme edits the palette it lands on rather than becoming a new entry in the picker. */
  name: string;
  mode: Mode;
  seed: ThemeSeed;
};

export type ThemeImport = { ok: true; doc: ThemeDocument } | { ok: false; reason: string };

/** What Copy puts on the clipboard: the face AS EDITED, so what is copied is what is on screen —
 *  copying the palette's own seeds under a set of overrides would hand someone a theme that is not
 *  the one they were looking at. Two-space JSON because this is read and edited by people. */
export function exportTheme(name: string, mode: Mode, seed: ThemeSeed): string {
  const doc: ThemeDocument = { realmTheme: THEME_DOC_VERSION, name, mode, seed };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every reason a blob is refused, as the sentence the user sees. A rejection has to say what is
 *  wrong with the thing they pasted: "invalid theme" sends someone back to a JSON blob with no idea
 *  which of ninety characters to look at. */
export function importTheme(text: string, face: Mode): ThemeImport {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, reason: "That is not JSON. Paste the whole block, braces included." }; }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "A theme is a JSON object; this is not one." };
  }
  const d = raw as Record<string, unknown>;
  if (typeof d["realmTheme"] !== "number") {
    return { ok: false, reason: "This is not a Realm theme — it has no realmTheme version." };
  }
  // Newer than this build understands. Refused rather than read for the fields it happens to share:
  // a version bump is how a later format says the old reading of it is wrong.
  if (d["realmTheme"] > THEME_DOC_VERSION) {
    return { ok: false, reason: `This theme was written for a newer version of Realm (format ${d["realmTheme"]}, this build reads ${THEME_DOC_VERSION}).` };
  }
  if (d["mode"] !== "dark" && d["mode"] !== "light") {
    return { ok: false, reason: "A theme has to say whether it is a light or a dark theme." };
  }
  if (d["mode"] !== face) {
    return { ok: false, reason: `This is a ${d["mode"]} theme. Import it in the ${d["mode"] === "dark" ? "Dark" : "Light"} theme row.` };
  }

  const seed = d["seed"];
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    return { ok: false, reason: "A theme has to carry a seed: the colours it is built from." };
  }
  const s = seed as Record<string, unknown>;
  const syntax = (s["syntax"] && typeof s["syntax"] === "object" && !Array.isArray(s["syntax"])
    ? s["syntax"] : {}) as Record<string, unknown>;
  const missing = [
    ...SEED_ROLES.filter((r) => !isHexColour(s[r])),
    ...SYNTAX_ROLES.filter((r) => !isHexColour(syntax[r])).map((r) => `syntax.${r}`),
  ];
  if (missing.length) {
    return { ok: false, reason: `These are missing or are not hex colours: ${missing.join(", ")}.` };
  }

  // Rebuilt field by field rather than cast, so nothing the document happens to carry beyond the
  // twelve reaches the derivation — and so the object stored is the shape this build states.
  const built = {
    ...Object.fromEntries(SEED_ROLES.map((r) => [r, s[r] as string])),
    syntax: Object.fromEntries(SYNTAX_ROLES.map((r) => [r, syntax[r] as string])),
  } as ThemeSeed;
  const name = typeof d["name"] === "string" && d["name"].trim() ? d["name"].trim().slice(0, 60) : "an imported theme";
  return { ok: true, doc: { realmTheme: THEME_DOC_VERSION, name, mode: face, seed: built } };
}
