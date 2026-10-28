/**
 * What keeps a hidden browser page from being discarded for memory, as far as the page itself can say:
 * `PAGE_BUSY`, run in each of its frames, and `TypedSince`, kept from the keyboard by main. Apart from
 * browser-pane.ts so neither needs Electron to be tested.
 */

/**
 * Why a page must not be discarded right now, read off the page itself, every frame: a video or a
 * sound playing (muted autoplay included, which `isCurrentlyAudible` cannot hear), a field holding text
 * that differs from what the page loaded with, a box ticked or a file chosen, the keyboard in an
 * editable region, or anything in its `sessionStorage` — which a revived page, a new webContents,
 * starts without, so a sign-in kept there (MSAL's) would come back signed out. Read-only, and in the
 * page's own world — a page that lies can only keep itself.
 *
 * A field is not the whole story: React keeps `defaultValue` equal to `value` as it renders, so a
 * half-filled React form reads clean here. What catches those is the keyboard (`typedSince`).
 */
export const PAGE_BUSY = `(() => {
  if ([...document.querySelectorAll("video,audio")].some((m) => !m.paused && !m.ended && m.readyState > 2)) return "media";
  const dirty = [...document.querySelectorAll("input,textarea,select")].some((el) => {
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === "SELECT") return [...el.options].some((o) => o.selected !== o.defaultSelected);
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.type === "file") return el.files && el.files.length > 0;
    if (["hidden", "submit", "button", "reset", "image"].includes(el.type)) return false;
    return el.value !== el.defaultValue;
  });
  if (dirty) return "form";
  const active = document.activeElement;
  if (active && active.isContentEditable) return "form";
  try { if (sessionStorage.length > 0) return "session"; } catch { /* storage refused to this frame */ }
  return null;
})()`;

/** Keys that are not input on their own. */
const BARE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** Views typed into since their page last navigated: what was typed may be nowhere the page shows it as
 *  changed (a React form keeps `defaultValue` in step with `value`), and it is the person's either way. */
export class TypedSince {
  private readonly typed = new Set<string>();

  /** `before-input-event`: any key but a bare modifier is input. */
  input(id: string, e: { type: string; key: string }): void {
    if (e.type === "keyDown" && !BARE_MODIFIERS.has(e.key)) this.typed.add(id);
  }

  /** `did-navigate`: a new document. An in-page step — a single-page checkout moving on — is not one,
   *  and keeps what was typed into it. */
  navigated(id: string): void { this.typed.delete(id); }

  has(id: string): boolean { return this.typed.has(id); }

  forget(id: string): void { this.typed.delete(id); }
}
