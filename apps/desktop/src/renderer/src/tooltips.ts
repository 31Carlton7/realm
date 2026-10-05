import { placeTooltip, type Rect } from "./state/no-overlay";

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
 * never takes the pointer. Keyboard focus shows it too, when the focus is the visible kind.
 *
 * Where it goes is `placeTooltip`'s: under the element, over it where the window's foot or a browser
 * view is in the way below. A native view composites over anything in its rectangle, so where neither
 * side is clear the element is handed BACK to the system's tooltip — which macOS draws above every view
 * — rather than shown somewhere nobody can see it.
 *
 * A title ending in a chord in brackets — "Search (⌘K)" — shows the chord as a key; `data-shortcut`
 * states one outright.
 */
export const TIP_DELAY_MS = 200;
export const TIP_WARM_MS = 500;
/** An element wider or taller than this is a row or a region, and its tooltip goes under the pointer
 *  rather than under the middle of something three hundred pixels wide. */
const LARGE = { width: 320, height: 64 };
/** The arrow's height under its hotspot: a tooltip at the pointer clears the cursor, as the system's does. */
const CURSOR_H = 18;
const GAP = 6;
const MARGIN = 6;

/** A trailing chord in brackets: one or more modifiers, then a key — a glyph, a character, a short name. */
const CHORD = /^(.*\S)\s+\(([⌘⌃⌥⇧]+(?:Space|Tab|esc|[^\s()]{1,3}))\)$/u;

/** "Search (⌘K)" → "Search" and "⌘K". Words in brackets are words: "Stop (interrupt)" has no shortcut. */
export function splitShortcut(title: string): { label: string; shortcut: string | null } {
  const text = title.trim();
  const m = CHORD.exec(text);
  return m ? { label: m[1]!, shortcut: m[2]! } : { label: text, shortcut: null };
}

type Hold = {
  el: HTMLElement;
  title: string;
  via: "pointer" | "focus";
  /** Where the title's meaning is kept while the attribute is held empty — its name, its description,
   *  or nowhere (the element already has a description of its own). Taken off with the hold, and only
   *  while it still says what the hold wrote. */
  carries: "aria-label" | "aria-description" | null;
};
type Spot = { left: number; top: number; above: boolean };

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
    const anchor = via === "pointer" && (r.width > LARGE.width || r.height > LARGE.height)
      ? { x: pointer.x - 1, y: pointer.y, width: 2, height: CURSOR_H }
      : { x: r.x, y: r.y, width: r.width, height: r.height };
    return placeTooltip({ anchor, size: { width: size.width, height: size.height }, win: { width: win.innerWidth, height: win.innerHeight },
      gap: GAP, margin: MARGIN, avoid: opts.avoid?.() ?? [] });
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
    if (!h || !h.el.isConnected || quiet === h.el) return;
    const spot = place(h.el, h.title, h.via);
    if (!spot) { handBack(h.el); return; }
    tip.style.left = `${spot.left}px`;
    tip.style.top = `${spot.top}px`;
    tip.dataset.side = spot.above ? "above" : "below";
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
    if (!place(el, el.getAttribute("title") ?? "", via)) { handedBack = el; return; }
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
    if (!el || el === hold?.el || !visibleFocus(el) || !el.getAttribute("title")?.trim()) return;
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
