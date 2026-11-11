import { behindOpenSurface } from "./components/use-anchored-popover";
import { placeTooltip, type Rect, type TooltipSide } from "./state/no-overlay";

/**
 * The app's tooltip (v2): ONE layer that shows the `title` every control already carries, in the app's
 * own type and quickly, instead of the system's grey box a second and a half later.
 *
 * It adopts the attribute rather than asking ~300 call sites to change. While the layer has an element
 * its `title` is held EMPTY — the only way to keep the system's tooltip away — and given back the
 * moment the pointer or the focus leaves, so the DOM a test or a screen reader reads is the one the
 * component wrote. What the title was to a screen reader stays what it was while it is held: a control
 * named only by its title is given that name as `aria-label`, any other gets it as its
 * `aria-description`, and both come off again with the hold. A title React rewrites while it is held
 * is the one shown and the one given back; a title React takes away is not put back.
 *
 * It appears TIP_DELAY_MS after the pointer arrives, and at once for the next control if the last
 * tooltip went away within TIP_WARM_MS — sweeping along a toolbar reads every button without waiting
 * on each. A press, a key, a scroll of what it is pinned to, or the window going away hides it. It
 * never takes the pointer. Keyboard focus shows it too, when the focus is the visible kind. While a
 * menu or popover is up, only what is inside it has a tooltip: the press that opens a context menu
 * quiets only the element it landed on, and a tile that comes under the pointer after it (the same
 * right-click put away the sheet over it) said its name on top of its own menu.
 *
 * Where it goes is `placeTooltip`'s: under the element — under the whole control, when it is part of
 * one — over it where the window's foot or a browser view is in the way below, beside it where both
 * are. A native view composites over anything in its rectangle, so where no side is clear the element
 * is handed BACK to the system's tooltip — which macOS draws above every view — rather than shown
 * somewhere nobody can see it.
 *
 * A title ending in a chord in brackets — "Search (⌘K)" — shows the chord as a key; `data-shortcut`
 * states one outright.
 *
 * A row that already shows its name carries no title. `data-tip="clipped"` gives it the words of its
 * `[data-tip-text]` child instead, and only while the column has cut them short, beside the row rather
 * than under it: under it, the tooltip covered the row below.
 */
export const TIP_DELAY_MS = 200;
export const TIP_WARM_MS = 500;
/** An element taller than this is a region, and its tooltip goes under the pointer. One only wider is
 *  a row: its tooltip goes where the pointer is along it, and under the whole row. A settings row with
 *  a line under its label stands about 70 tall, and read as a region its tooltip dropped onto the chip
 *  the pointer was on, so the cut sits above two-line rows. */
const LARGE = { width: 320, height: 96 };
/** What a person presses: a title inside one of these describes it. */
const CONTROL = "button, a[href], [role='button'], [role='menuitem'], [role='option'], [role='tab']";
/** The arrow's height under its hotspot: a tooltip at the pointer clears the cursor, as the system's does. */
const CURSOR_H = 18;
const GAP = 6;
const MARGIN = 6;
/** Where a clipped row's tooltip looks first: beside the column, clear of the rows above and below. */
const BESIDE: readonly TooltipSide[] = ["right", "left", "below", "above"];

/** A trailing chord in brackets: one or more modifiers, then a key — a glyph, a character, a short name —
 *  or the spelled-out form Linux and Windows print ("Ctrl+Shift+F"). */
const CHORD = /^(.*\S)\s+\(([⌘⌃⌥⇧]+(?:Space|Tab|esc|[^\s()]{1,3})|(?:(?:Ctrl|Win|Super|Alt|Shift)\+)+[^\s()]{1,9})\)$/u;

/** "Search (⌘K)" → "Search" and "⌘K". Words in brackets are words: "Stop (interrupt)" has no shortcut. */
export function splitShortcut(title: string): { label: string; shortcut: string | null } {
  const text = title.trim();
  const m = CHORD.exec(text);
  return m ? { label: m[1]!, shortcut: m[2]! } : { label: text, shortcut: null };
}

const clips = (el: Element): boolean => el.getAttribute("data-tip") === "clipped";
/** A clipped row's words: its name's, while the name is cut short, and none while it is whole. */
const clippedName = (el: Element): string => {
  const name = el.querySelector("[data-tip-text]");
  return name && name.scrollWidth > name.clientWidth ? name.textContent ?? "" : "";
};
const wordsOf = (el: Element): string => (clips(el) ? clippedName(el) : el.getAttribute("title") ?? "");

type Hold = {
  el: HTMLElement;
  title: string;
  via: "pointer" | "focus";
  /** Where the title's meaning is kept while the attribute is held empty — its name, its description,
   *  or nowhere (the element already has a description of its own). Taken off with the hold, and only
   *  while it still says what the hold wrote. */
  carries: "aria-label" | "aria-description" | null;
};
type Spot = { left: number; top: number; side: TooltipSide };

export function installTooltips(doc: Document, opts: { avoid?: () => readonly Rect[] } = {}): () => void {
  const win = doc.defaultView!;
  const tip = doc.createElement("div");
  tip.className = "tooltip";
  // The words are the element's already (its name or its description, kept above); read twice they
  // would be noise.
  tip.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span");
  label.className = "tooltip-label";
  const key = doc.createElement("kbd");
  key.className = "tooltip-key";
  tip.append(label, key);
  doc.body.appendChild(tip);

  let hold: Hold | null = null;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warmUntil = 0;
  /** Pressed, keyed or scrolled while held: no tooltip for it until the pointer has left it. */
  let quiet: HTMLElement | null = null;
  /** Handed back to the system's tooltip (no clear spot beside it) until the pointer leaves it. */
  let handedBack: HTMLElement | null = null;
  const pointer = { x: 0, y: 0 };

  /** The element whose title the pointer is under: the nearest with one, where an EMPTY title says
   *  "no tooltip here, nor from my ancestors", as HTML has it. The held element's title is the empty
   *  one this layer wrote, so it is recognised by identity. A frame's title names it for a screen
   *  reader; what is under the pointer there is another document's. */
  const titled = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof win.Element) || tip.contains(target)) return null;
    for (let el: Element | null = target; el; el = el.parentElement) {
      if (el === hold?.el) return hold.el;
      if (clips(el)) return clippedName(el).trim() && el instanceof win.HTMLElement ? el : null;
      const title = el.getAttribute("title");
      if (title === null) continue;
      return title.trim() && el instanceof win.HTMLElement && !(el instanceof win.HTMLIFrameElement) ? el : null;
    }
    return null;
  };

  /** What a title is to a screen reader: the NAME of an element nothing else names (an icon button, an
   *  unlabelled field), and otherwise its description. */
  const carrierFor = (el: HTMLElement): Hold["carries"] => {
    const named = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || ((el as HTMLInputElement).labels?.length ?? 0) > 0;
    const field = el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLSelectElement;
    if (!named && (field || (el.textContent ?? "").trim() === "")) return "aria-label";
    return el.hasAttribute("aria-description") || el.hasAttribute("aria-describedby") ? null : "aria-description";
  };
  const dropMeaning = (h: Hold) => {
    if (h.carries && h.el.getAttribute(h.carries) === h.title) h.el.removeAttribute(h.carries);
  };

  const watch = new win.MutationObserver(() => {
    if (!hold) return;
    const now = hold.el.getAttribute("title");
    if (now === "") return; // the hold's own write
    if (now === null || !now.trim()) {
      // React took the title away: so does the tooltip, and nothing is put back.
      const h = hold;
      hide(); watch.disconnect(); dropMeaning(h); hold = null;
      return;
    }
    if (hold.carries && hold.el.getAttribute(hold.carries) === hold.title) hold.el.setAttribute(hold.carries, now);
    hold.title = now;
    hold.el.setAttribute("title", "");
    if (shown) show(true);
  });

  const take = (el: HTMLElement, via: Hold["via"]) => {
    // A clipped row has no title to hold, and its name is on screen for a screen reader already.
    if (clips(el)) { hold = { el, title: clippedName(el), via, carries: null }; return; }
    const title = el.getAttribute("title") ?? "";
    hold = { el, title, via, carries: carrierFor(el) };
    el.setAttribute("title", "");
    if (hold.carries) el.setAttribute(hold.carries, title);
    watch.observe(el, { attributes: true, attributeFilter: ["title"] });
  };
  const release = () => {
    if (!hold) return;
    const h = hold;
    hold = null;
    watch.disconnect();
    if (h.el.getAttribute("title") === "") h.el.setAttribute("title", h.title);
    dropMeaning(h);
  };

  const hide = (warm = true) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!shown) return;
    shown = false;
    tip.removeAttribute("data-open");
    warmUntil = warm ? Date.now() + TIP_WARM_MS : 0;
  };

  /** Write `title`'s words into the layer and find them a spot beside `el` — null where neither side
   *  is clear of a browser view. */
  const place = (el: HTMLElement, title: string, via: Hold["via"]): Spot | null => {
    const { label: text, shortcut } = splitShortcut(title);
    const chord = el.dataset.shortcut ?? shortcut;
    label.textContent = text;
    key.textContent = chord ?? "";
    key.hidden = !chord;
    const size = tip.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Under its own line of text, a tool row's command sat over the row it described.
    const control = el.parentElement?.closest(CONTROL)?.getBoundingClientRect();
    const band = control && control.height <= LARGE.height ? control : r;
    const anchor = clips(el) ? r
      : via === "pointer" && r.height > LARGE.height
        ? { x: pointer.x - 1, y: pointer.y, width: 2, height: CURSOR_H }
        : via === "pointer" && r.width > LARGE.width
          ? { x: pointer.x - 1, y: band.y, width: 2, height: band.height }
          : { x: r.x, y: band.y, width: r.width, height: band.height };
    return placeTooltip({ anchor, size: { width: size.width, height: size.height }, win: { width: win.innerWidth, height: win.innerHeight },
      gap: GAP, margin: MARGIN, avoid: opts.avoid?.() ?? [], sides: clips(el) ? BESIDE : undefined });
  };
  /** Nowhere beside it can be seen: the system's tooltip can, so it keeps its title until the pointer
   *  leaves. */
  const handBack = (el: HTMLElement) => {
    hide(false);
    release();
    handedBack = el;
  };

  const show = (instant: boolean) => {
    const h = hold;
    if (!h || !h.el.isConnected || quiet === h.el || behindOpenSurface(h.el)) return;
    const spot = place(h.el, h.title, h.via);
    if (!spot) { handBack(h.el); return; }
    tip.style.left = `${spot.left}px`;
    tip.style.top = `${spot.top}px`;
    tip.dataset.side = spot.side;
    tip.toggleAttribute("data-instant", instant);
    // The side decides which way it arrives from, so it has to be the style it leaves FROM: one
    // style recalc between the side and the open.
    void tip.offsetWidth;
    tip.setAttribute("data-open", "");
    shown = true;
  };

  const enter = (el: HTMLElement, via: Hold["via"]) => {
    // Asked before the title is taken, so an element that will go to the system's tooltip never has
    // its title held at all and the system's own wait starts at once.
    if (!place(el, wordsOf(el), via)) { handedBack = el; return; }
    take(el, via);
    if (Date.now() < warmUntil) { show(true); return; }
    timer = setTimeout(() => { timer = null; show(false); }, TIP_DELAY_MS);
  };
  /** Leave whatever the layer has: the tooltip goes (warm, for the next control), the title comes back. */
  const leave = () => {
    hide();
    release();
    quiet = null;
    handedBack = null;
  };
  /** Hide for something the person did — a press, a key, a scroll — and keep it away from this element
   *  until the pointer has left it. Not warm: what they did was not looking for the next tooltip. */
  const silence = () => {
    if (!hold) return;
    hide(false);
    quiet = hold.el;
  };

  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    pointer.x = e.clientX; pointer.y = e.clientY;
    const el = titled(e.target);
    if (el !== null && (el === hold?.el || el === handedBack)) return;
    leave();
    if (el) enter(el, "pointer");
  };
  const move = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };
  // Out of the window — or into a browser view, which the page hears as the same thing.
  const out = (e: PointerEvent) => { if (e.relatedTarget === null && hold?.via !== "focus") leave(); };
  const visibleFocus = (el: Element): boolean => { try { return el.matches(":focus-visible"); } catch { return false; } };
  const focusIn = (e: FocusEvent) => {
    const el = e.target instanceof win.HTMLElement ? e.target : null;
    if (!el || el === hold?.el || !visibleFocus(el) || !wordsOf(el).trim()) return;
    leave();
    enter(el, "focus");
  };
  const focusOut = (e: FocusEvent) => { if (hold?.via === "focus" && e.target === hold.el) leave(); };
  const keyDown = (e: KeyboardEvent) => {
    // Tab moves the focus, and the focus says the rest; a modifier held on its own is a chord on its way.
    if (["Tab", "Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    silence();
  };
  const scrolled = (e: Event) => {
    // Only a scroll that moves the element: the transcript streaming under the pointer is not one.
    if (hold && (e.target === doc || (e.target instanceof win.Node && e.target.contains(hold.el)))) silence();
  };

  doc.addEventListener("pointerover", over, { capture: true, passive: true });
  doc.addEventListener("pointermove", move, { capture: true, passive: true });
  doc.addEventListener("pointerout", out, { capture: true, passive: true });
  doc.addEventListener("pointerdown", silence, { capture: true, passive: true });
  doc.addEventListener("wheel", silence, { capture: true, passive: true });
  doc.addEventListener("scroll", scrolled, { capture: true, passive: true });
  doc.addEventListener("keydown", keyDown, true);
  doc.addEventListener("focusin", focusIn, true);
  doc.addEventListener("focusout", focusOut, true);
  doc.addEventListener("dragstart", leave, true);
  win.addEventListener("blur", leave);
  win.addEventListener("resize", leave);
  return () => {
    leave();
    doc.removeEventListener("pointerover", over, { capture: true });
    doc.removeEventListener("pointermove", move, { capture: true });
    doc.removeEventListener("pointerout", out, { capture: true });
    doc.removeEventListener("pointerdown", silence, { capture: true });
    doc.removeEventListener("wheel", silence, { capture: true });
    doc.removeEventListener("scroll", scrolled, { capture: true });
    doc.removeEventListener("keydown", keyDown, true);
    doc.removeEventListener("focusin", focusIn, true);
    doc.removeEventListener("focusout", focusOut, true);
    doc.removeEventListener("dragstart", leave, true);
    win.removeEventListener("blur", leave);
    win.removeEventListener("resize", leave);
    tip.remove();
  };
}
