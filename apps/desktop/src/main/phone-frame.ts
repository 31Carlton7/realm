/**
 * A browser pane's page as a phone is shown it (mobile.v1 `session.browserFrame`), with every field
 * that could hold a secret covered before the picture leaves main. Apart from browser-pane.ts so the
 * rule is testable without Electron.
 *
 * The rule: a phone never sees what is in a password field, a one-time code, or a card's number or
 * security code — not its dots, not its length, and not its text when a page's "Show password" has
 * turned the field to plain text. Each such field in the page's top frame is painted over in the
 * picture, a little past its edges, where it was both just before and just after the picture was
 * taken. A field like it inside a frame of the page (a payment form, a sign-in box from another site)
 * cannot be placed in the picture from here, so a page with one — or whose top frame cannot be read —
 * is not pictured at all, and the phone is told why.
 *
 * The fields are found by `SECRET_FIELDS`, run in each frame in the page's own world, as `PAGE_BUSY`
 * is: a page that lies about its fields can only hide its own, which it could as well draw anywhere.
 */

/** A field's place in its frame's viewport, in CSS pixels: x, y, width, height. */
export type FieldRect = [number, number, number, number];
/** What `SECRET_FIELDS` answers: the frame's viewport and its secret fields within it. */
export type SecretFields = { vw: number; vh: number; rects: FieldRect[] };

/** Words in a field's type, name, id or autocomplete that say it holds a secret. Broad on purpose:
 *  covering a passport number by mistake costs a phone nothing. */
export const SECRET_WORDS = /pass|pwd|secret|token|otp|one-time-code|cc-number|cc-csc|cvc|cvv|csc/i;

/** How far past a field's edges the cover reaches, in CSS pixels: a focus ring, a caret's shadow. */
export const COVER_MARGIN = 4;

/** Every field of the frame (open shadow roots too) that holds or may hold a secret, by its place. */
export const SECRET_FIELDS = `(() => {
  const words = ${SECRET_WORDS.toString()};
  const plain = ["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"];
  const rects = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName !== "INPUT") continue;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (plain.includes(type)) continue;
      const said = [type, el.getAttribute("name"), el.id, el.getAttribute("autocomplete")].filter(Boolean).join(" ");
      if (type !== "password" && !words.test(said)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      rects.push([r.left, r.top, r.width, r.height]);
    }
  };
  visit(document);
  return { vw: innerWidth, vh: innerHeight, rects };
})()`;

/** Whether `SECRET_FIELDS`' answer is one, rather than whatever a page that replaced its globals said. */
export function isSecretFields(v: unknown): v is SecretFields {
  const s = v as SecretFields | null;
  return !!s && typeof s.vw === "number" && typeof s.vh === "number" && Array.isArray(s.rects)
    && s.rects.every((r) => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)));
}

/**
 * The fields to cover across a page, from what `SECRET_FIELDS` answered in its top frame and in each
 * frame below it, or null when the page must not be pictured: its top frame did not answer as itself,
 * or a frame below holds a secret field (which cannot be placed in the picture) or answered something
 * other than itself. A frame that refused to run it at all (`null`: no document yet) holds no field.
 */
export function pageFields(top: unknown, frames: unknown[]): SecretFields | null {
  if (!isSecretFields(top)) return null;
  for (const said of frames) if (said !== null && (!isSecretFields(said) || said.rects.length > 0)) return null;
  return top;
}

/** Both reads' fields, one taken before the picture and one after: a page that scrolled between the
 *  two has its field covered wherever it was. Null when either read refused the page. */
export function bothReads(before: SecretFields | null, after: SecretFields | null): SecretFields | null {
  return before && after ? { vw: after.vw, vh: after.vh, rects: [...before.rects, ...after.rects] } : null;
}

/** The grey a cover is painted in: the same in light and dark, and plainly not part of the page. */
const COVER = [0x8a, 0x8a, 0x8a, 0xff] as const;

/**
 * Paints each field's place over in a BGRA bitmap `width` × `height`, whose picture is of a viewport
 * `vw` CSS pixels wide: the fields are in that viewport's pixels, the bitmap in its own.
 */
export function coverFields(bgra: Uint8Array, width: number, height: number, fields: SecretFields): void {
  const scale = width / fields.vw;
  for (const [x, y, w, h] of fields.rects) {
    const left = Math.max(0, Math.floor((x - COVER_MARGIN) * scale));
    const top = Math.max(0, Math.floor((y - COVER_MARGIN) * scale));
    const right = Math.min(width, Math.ceil((x + w + COVER_MARGIN) * scale));
    const bottom = Math.min(height, Math.ceil((y + h + COVER_MARGIN) * scale));
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) bgra.set(COVER, (row * width + col) * 4);
    }
  }
}

/** The side a picture `width` × `height` is made at to be no longer than `maxSide`, never enlarged. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** What the phone is told when a page holds a secret field this cannot cover. */
export const WITHHELD = "Hidden on your phone while this page shows a password or card field Realm can't cover. It's still open on your Mac.";
