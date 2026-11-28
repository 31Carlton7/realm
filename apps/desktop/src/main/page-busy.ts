import type { KeepReason } from "./browser-host";

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

/** What the discard guard asks of a page's webContents. */
export type GuardedPage = {
  isDevToolsOpened(): boolean;
  isCurrentlyAudible(): boolean;
  isLoading(): boolean;
  mainFrame: { framesInSubtree: { executeJavaScript(code: string): Promise<unknown> }[] };
};

/** Why a hidden page must not be discarded right now, or null when it may be: what the process says,
 *  then what every frame says. "loading" is the weakest answer, since the age limit lapses it, so it
 *  is given only when no frame holds anything stronger. */
export async function pageKeepReason(page: GuardedPage, o: { typed: boolean; popups: number }): Promise<KeepReason | null> {
  if (page.isDevToolsOpened()) return "devtools";
  if (o.typed) return "form";
  if (page.isCurrentlyAudible()) return "media";
  if (o.popups > 0) return "popup";
  let loading = page.isLoading();
  for (const frame of page.mainFrame.framesInSubtree) {
    // A frame that will not answer in a second is not one to throw away on a guess.
    const said = await Promise.race([
      frame.executeJavaScript(PAGE_BUSY).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve("loading"), 1_000).unref?.()),
    ]);
    if (said === "media" || said === "form" || said === "session") return said;
    if (said === "loading") loading = true;
  }
  return loading ? "loading" : null;
}

/** Keys that are not input on their own. */
const BARE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** What `TypedSince` hears from a page: its webContents' keyboard and navigation. */
type TypingPage = {
  on(event: "before-input-event", listener: (event: unknown, input: { type: string; key: string }) => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
};

/** Pages typed into since they last navigated: what was typed may be nowhere the page shows it as
 *  changed (a React form keeps `defaultValue` in step with `value`), and it is the person's either way.
 *  Kept per page rather than per browser: a page shown in place of its opener (`adoptInPlace`) leaves
 *  the opener running behind it, where it can navigate, and the opener comes back with its own mark. */
export class TypedSince<Page extends TypingPage> {
  private readonly shown = new Map<string, Page>();
  private readonly typed = new WeakSet<Page>();
  private readonly heard = new WeakSet<Page>();

  /** The page browser `id` shows now. */
  show(id: string, page: Page): void {
    this.shown.set(id, page);
    if (this.heard.has(page)) return;
    this.heard.add(page);
    // Any key but a bare modifier is input.
    page.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && !BARE_MODIFIERS.has(input.key)) this.typed.add(page);
    });
    // A new document. An in-page step — a single-page checkout moving on — is not one, and keeps what
    // was typed into it.
    page.on("did-navigate", () => this.typed.delete(page));
  }

  /** An agent typed into it, by whatever route — `Input.insertText` sends no key event at all. */
  mark(id: string): void {
    const page = this.shown.get(id);
    if (page) this.typed.add(page);
  }

  has(id: string): boolean {
    const page = this.shown.get(id);
    return !!page && this.typed.has(page);
  }

  /** Whether this page was typed into, shown or waiting behind the one that is. */
  typedInto(page: Page): boolean { return this.typed.has(page); }

  /** Browser `id` shows no page. */
  forget(id: string): void { this.shown.delete(id); }
}
