import type { CaretPrefs } from "@realm/contracts";
import { atSoftWrap, caretBox, contains, drawnCaret, intersect, nativeCaret, spotBetween, type Box, type CaretSpot, type CaretSupport, type CharBox } from "./caret-geometry";

/**
 * The app's caret (Settings ▸ Appearance ▸ Cursor): ONE drawn caret, laid over whichever field has
 * the keyboard — the prompter, every input and text area, an editable region, the code editor.
 *
 * Chromium 138 lets a stylesheet colour its caret and nothing else, so every shape but a thin line,
 * every animation but its own blink and any glide is drawn here, over the field, with the field's own
 * caret made transparent underneath (`data-rl-caret`, and only while this one is standing in for it).
 * The selection, the keyboard, IME and a screen reader's idea of where the insertion point is all stay
 * the field's: this is a picture of the caret and nothing more, `aria-hidden`.
 *
 * Where it stands is read, never guessed:
 *  - the prompter has a mirror of its own — the highlight layer under its textarea, laid out glyph for
 *    glyph like it (`[data-caret-mirror]`) — so a Range over the character beside the caret IS the
 *    caret's place;
 *  - any other input or text area is copied into one hidden mirror of the layer's own, standing on
 *    the field's box, and measured the same way;
 *  - an editable region measures its selection;
 *  - the code editor lays out its own lines and says where its caret is (`registerCaretSource`).
 *
 * It is placed in a frame, and only when something could have moved it: a key, a selection, an input,
 * a scroll, a resize, a font arriving, or an animation on something that holds the field (a sheet
 * springing open), which it follows until the field stands still. Nothing runs while nothing moves.
 *
 * It steps aside rather than draw something false: for a selection (the platform hides its caret
 * then too), while the window or the field does not have focus, under anything drawn over the field,
 * and while an input method is composing — the platform's composition is drawn at ITS caret, so
 * during it the platform's caret comes back.
 */

/** A field that lays out its own text knows better than a mirror where its caret is: it says, and
 *  names the element whose own caret this one replaces. */
export type CaretSource = { measure(): CaretSpot | null; host?: Element };

const sources = new WeakMap<Element, CaretSource>();
/** The installed layer's way to be told that a source moved its caret without the DOM saying so. */
let nudge: (() => void) | null = null;

export function registerCaretSource(field: Element, source: CaretSource): () => void {
  sources.set(field, source);
  nudge?.();
  return () => {
    if (sources.get(field) === source) sources.delete(field);
    nudge?.();
  };
}

/** A source's caret moved, or its text did, in a way no DOM event announces. */
export function caretMoved(): void { nudge?.(); }

/** The input types that have a caret AND a selection API to read where it is. Email and number have
 *  the first and not the second, so their caret stays the platform's. */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "password"]);

/**
 * The field whose caret is drawn, given the focused element; null where there is no text caret, where
 * the platform's must stay, and in the two editors that draw their own — xterm's helper textarea, and
 * CodeMirror unless it has said where its caret is.
 */
export function caretField(el: Element | null): HTMLElement | null {
  if (!el || !(el instanceof HTMLElement)) return null;
  if (sources.has(el)) return el;
  if (el.closest(".xterm, .cm-editor")) return null;
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled ? el : null;
  return el.isContentEditable || el.getAttribute("contenteditable") === "true" ? el : null;
}

/** What the layer's own mirror copies off a field: every property that moves a glyph. */
const MIRRORED = [
  "direction", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "fontFeatureSettings",
  "fontVariationSettings", "fontKerning", "fontOpticalSizing", "fontSynthesis",
  "letterSpacing", "wordSpacing", "textTransform", "textIndent", "textAlign", "textRendering",
  "tabSize", "wordBreak", "overflowWrap", "hyphens", "lineHeight", "whiteSpace", "webkitTextSecurity",
] as const;

/** What a block's glyph copies, so the character it redraws lands on the one under it. */
const GLYPH_FONT = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant",
  "fontFeatureSettings", "fontVariationSettings", "fontKerning", "fontOpticalSizing", "letterSpacing", "textTransform"] as const;

const ZWSP = "​";
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The text node and offset holding the n-th character of `root`'s text. An icon's SVG carries no
 *  characters of a draft, whatever it holds. */
export function textPoint(root: Node, n: number): { node: Text; offset: number } | null {
  if (n < 0) return null;
  // A walker never returns its own root, and an editable region's caret is often IN one text node.
  if (root.nodeType === Node.TEXT_NODE) return n < (root as Text).length ? { node: root as Text, offset: n } : null;
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest("svg") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let left = n;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (left < t.length) return { node: t, offset: left };
    left -= t.length;
  }
  return null;
}

/** The box of the character at `n` (both halves of a surrogate pair). */
function charBox(root: Node, n: number, backwards = false): CharBox | null {
  const p = textPoint(root, n);
  if (!p) return null;
  let start = p.offset, end = p.offset + 1;
  const code = p.node.data.charCodeAt(p.offset);
  if (backwards && isLow(code) && start > 0) start -= 1;
  else if (!backwards && isHigh(code) && end < p.node.length) end += 1;
  const range = (root.ownerDocument ?? (root as Document)).createRange();
  range.setStart(p.node, start);
  range.setEnd(p.node, end);
  const r = range.getClientRects()[0];
  if (!r || r.height === 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height, char: p.node.data.slice(start, end) };
}

export type CaretLayer = { configure(prefs: CaretPrefs): void; uninstall(): void };

/** Why a frame is drawn. A MOVE is the caret going somewhere — it may glide there, and it restarts
 *  the blink so the caret is visible where it lands. A PLACE is anything else — focus, a scroll, a
 *  resize — and puts it there at once. FOLLOW is a frame spent following a field that is moving. */
const MOVE = 1, PLACE = 2, FOLLOW = 4;
/** How many frames a moving field is followed for at most, and how many it must hold still for. */
const FOLLOW_MAX = 90, FOLLOW_QUIET = 3;

export function installCaret(doc: Document, initial: CaretPrefs, opts: { support?: CaretSupport } = {}): CaretLayer {
  const win = doc.defaultView!;
  const root = doc.documentElement;
  const support: CaretSupport = opts.support ?? {
    shape: win.CSS?.supports?.("caret-shape", "block") ?? false,
    animation: win.CSS?.supports?.("caret-animation", "manual") ?? false,
  };

  const layer = doc.createElement("div");
  layer.className = "caret-layer";
  layer.setAttribute("aria-hidden", "true");
  const clip = doc.createElement("div");
  clip.className = "caret-clip";
  const caret = doc.createElement("div");
  caret.className = "caret";
  const glyph = doc.createElement("span");
  glyph.className = "caret-glyph";
  caret.append(glyph);
  clip.append(caret);
  layer.append(clip);
  /* The mirror plain fields are measured in: invisible, inert, standing exactly on the field it is
     copying so a Range in it reads in the window's own coordinates. */
  const mirror = doc.createElement("div");
  mirror.className = "caret-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const mirrorText = doc.createTextNode("");
  mirror.append(mirrorText);
  doc.body.append(layer, mirror);

  let prefs = initial;
  let still = false;
  let field: HTMLElement | null = null;
  /** The element wearing `data-rl-caret` — the one whose own caret is transparent right now. */
  let marked: Element | null = null;
  let composing = false;
  /** The last gesture asked for the end of a line (End, ⌘→), or put the pointer at this height. */
  let lineEnd = false;
  let pointerY: number | null = null;
  let clippers: Element[] = [];
  let shownIn: HTMLElement | null = null;
  let raf = 0, why = 0, following = 0, quiet = 0, lastKey = "";
  const ro = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => schedule(PLACE)) : null;
  const motion = win.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

  /** Whether the platform's own caret is the one asked for — never for a source, which hides its own. */
  const drawnFor = (el: HTMLElement): boolean => sources.has(el) || nativeCaret(drawnCaret(prefs, still), support) === null;
  const focused = (el: HTMLElement): boolean => doc.activeElement === el && doc.hasFocus();

  /** The field the caret belongs in: the focused one, or — while nothing is being typed in — the
   *  Settings preview, so a shape or an animation can be watched while it is being chosen. */
  const resolve = (): HTMLElement | null => caretField(doc.activeElement) ?? doc.querySelector<HTMLElement>("[data-caret-preview]");

  /** Hide the field's own caret exactly while this one is drawn in its place, and never otherwise. */
  const syncMark = () => {
    const active = caretField(doc.activeElement);
    const next = active && !composing && drawnFor(active) ? (sources.get(active)?.host ?? active) : null;
    if (next === marked) return;
    marked?.removeAttribute("data-rl-caret");
    marked = next;
    marked?.setAttribute("data-rl-caret", "");
  };

  const watch = (el: HTMLElement | null) => {
    ro?.disconnect();
    clippers = [];
    if (!el) return;
    ro?.observe(el);
    // The ancestors that clip what they hold: a field scrolled out of a pane is out of sight.
    for (let a = el.parentElement; a && a !== doc.body; a = a.parentElement) {
      const cs = win.getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clippers.push(a);
    }
  };

  const paddingBox = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    return { left: r.left + bl, top: r.top + bt, width: Math.max(0, r.width - bl - br), height: Math.max(0, r.height - bt - bb) };
  };

  /** Where the caret may be seen: the field's own box, inside everything that clips it, inside the window. */
  const visibleArea = (el: HTMLElement): Box | null => {
    let area: Box | null = { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
    const own = sources.get(el)?.host ? null : paddingBox(el);
    if (own) area = intersect(area, own);
    for (const c of clippers) { if (!area) break; area = intersect(area, paddingBox(c)); }
    return area;
  };

  /** Something is drawn over the field where the caret would stand — a popover, a sheet, a toast. */
  const covered = (el: HTMLElement, x: number, y: number): boolean => {
    const hit = doc.elementFromPoint(x, y);
    const owner = sources.get(el)?.host ?? el;
    return !hit || !(owner === hit || owner.contains(hit));
  };

  /** The soft-wrap question, answered from the last gesture: End or ⌘→ meant the end of the line, and a
   *  click meant whichever line it landed on. */
  const upstream = (before: CharBox | null): boolean =>
    lineEnd || (pointerY !== null && before !== null && pointerY <= before.top + before.height);

  /** A typical character's advance, for a block standing at the end of a line. */
  const typicalWidth = (el: Element) => (parseFloat(win.getComputedStyle(el).fontSize) || 14) * 0.6;

  const between = (text: Node, at: number, chars: string, width: number): CaretSpot | null => {
    const before = at > 0 && chars[at - 1] !== "\n" ? charBox(text, at - 1, true) : null;
    const after = charBox(text, at);
    return spotBetween(before, after, { upstream: atSoftWrap(before, after) && upstream(before), typicalWidth: width });
  };

  /** A plain field, copied into the layer's mirror standing on it. The password's characters never
   *  leave it: the mirror holds as many bullets, drawn by the same text-security the field uses. */
  const fromOwnMirror = (el: HTMLInputElement | HTMLTextAreaElement, at: number): CaretSpot | null => {
    const cs = win.getComputedStyle(el);
    const ms = mirror.style as unknown as Record<string, string>;
    for (const p of MIRRORED) ms[p] = (cs as unknown as Record<string, string>)[p] ?? "";
    const r = el.getBoundingClientRect();
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
    const single = el instanceof win.HTMLInputElement;
    ms.width = `${el.offsetWidth - scrollbar}px`;
    ms.height = `${el.offsetHeight}px`;
    // An input centres its one line in its box; a line box the height of the box does exactly that.
    if (single) {
      ms.whiteSpace = "pre";
      ms.lineHeight = `${Math.max(0, el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0))}px`;
    }
    const sx = el.offsetWidth ? r.width / el.offsetWidth : 1, sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    ms.transform = `translate(${r.left}px, ${r.top}px) scale(${sx}, ${sy})`;
    const value = el instanceof win.HTMLInputElement && el.type === "password" ? "•".repeat(el.value.length) : el.value;
    mirrorText.data = value + ZWSP;
    mirror.scrollTop = el.scrollTop;
    mirror.scrollLeft = el.scrollLeft;
    return between(mirror, at, value, typicalWidth(el));
  };

  /** An editable region: its own selection, measured where it is. */
  const fromSelection = (el: HTMLElement): CaretSpot | null => {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !sel.focusNode || !el.contains(sel.focusNode)) return null;
    const node = sel.focusNode, offset = sel.focusOffset;
    const width = typicalWidth(el);
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node as Text).data;
      const spot = between(node, offset, text, width);
      if (spot) return spot;
    }
    const range = doc.createRange();
    range.setStart(node, offset);
    const r = range.getClientRects()[0];
    if (r && r.height > 0) return { x: r.left, top: r.top, height: r.height, glyph: "", glyphWidth: width };
    // An empty line: a paragraph holding only its line break. The break's box is the line.
    const child = node.childNodes[offset] ?? node.childNodes[offset - 1];
    const box = (child instanceof win.Element ? child : node instanceof win.Element ? node : null)?.getBoundingClientRect();
    return box && box.height > 0 ? { x: box.left, top: box.top, height: box.height, glyph: "", glyphWidth: width } : null;
  };

  const measure = (el: HTMLElement): CaretSpot | null => {
    const source = sources.get(el);
    if (source) return source.measure();
    if (el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLInputElement) {
      if (el.selectionStart === null || el.selectionStart !== el.selectionEnd) return null;
      const at = el.selectionStart;
      const own = el.parentElement?.querySelector<HTMLElement>(":scope > [data-caret-mirror]");
      // The prompter's mirror is empty for an empty draft; the layer's own has a place even then.
      return (own && between(own, at, el.value, typicalWidth(el))) || fromOwnMirror(el, at);
    }
    return fromSelection(el);
  };

  const hide = () => {
    layer.removeAttribute("data-shown");
    shownIn = null;
  };

  /** The character a block redraws, set in the field's own face so it lands on the one under it. */
  const setGlyph = (el: HTMLElement, spot: CaretSpot, box: Box) => {
    if (prefs.shape !== "block" || !spot.glyph) { glyph.textContent = ""; return; }
    const face = win.getComputedStyle(sources.get(el)?.host?.querySelector(".cm-content") ?? el);
    const gs = glyph.style as unknown as Record<string, string>;
    for (const p of GLYPH_FONT) gs[p] = (face as unknown as Record<string, string>)[p] ?? "";
    gs.lineHeight = `${box.height}px`;
    glyph.textContent = spot.glyph;
  };

  /** Restart the blink, so a caret that has just moved is visible where it landed. */
  const restart = () => { for (const a of caret.getAnimations?.() ?? []) a.currentTime = 0; };

  const draw = (reason: number): string => {
    const target = resolve();
    if (target !== field) { field = target; watch(target); reason |= PLACE; }
    syncMark();
    const rect = target?.getBoundingClientRect();
    const key = rect ? `${rect.left} ${rect.top} ${rect.width} ${rect.height}` : "";
    /* A focused field shows the drawn caret only where the platform's cannot be the one asked for. The
       preview, unfocused, shows it whatever was asked for: it is a specimen, and the platform draws
       no caret at all in a field without the focus. */
    const showing = target && target.isConnected && doc.hasFocus() && !composing
      && (target === doc.activeElement ? drawnFor(target) : true);
    let spot: CaretSpot | null = null;
    try { spot = showing ? measure(target) : null; } catch { spot = null; }
    if (!target || !spot) { hide(); return key; }
    const box = caretBox(spot, prefs.shape, win.devicePixelRatio || 1);
    const area = visibleArea(target);
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    if (!area || !contains(area, cx, cy) || covered(target, cx, cy)) { hide(); return key; }
    // A glide is for the caret moving through the text; anything that moved the field puts it there.
    const glide = drawnCaret(prefs, still).glide && reason === MOVE && shownIn === target;
    caret.toggleAttribute("data-glide", glide);
    clip.style.transform = `translate(${area.left}px, ${area.top}px)`;
    clip.style.width = `${area.width}px`;
    clip.style.height = `${area.height}px`;
    caret.style.transform = `translate(${box.left - area.left}px, ${box.top - area.top}px)`;
    caret.style.width = `${box.width}px`;
    caret.style.height = `${box.height}px`;
    setGlyph(target, spot, box);
    if (!layer.hasAttribute("data-shown")) layer.setAttribute("data-shown", "");
    else if (reason & MOVE) restart();
    shownIn = target;
    return key;
  };

  const frame = () => {
    raf = 0;
    const reason = why;
    why = 0;
    if (reason & PLACE) following = FOLLOW_MAX;
    const key = draw(reason);
    // A field that moved may still be moving — a sheet on its spring — and nothing says when it stops.
    if (following > 0 && field) {
      following--;
      quiet = key === lastKey ? quiet + 1 : 0;
      lastKey = key;
      if (quiet < FOLLOW_QUIET && following > 0) schedule(FOLLOW);
      else following = 0;
    } else following = 0;
  };

  function schedule(reason: number) {
    why |= reason;
    if (!raf) raf = win.requestAnimationFrame(frame);
  }

  const apply = () => {
    still = (motion?.matches ?? false) || root.getAttribute("data-quiet") === "always";
    root.setAttribute("data-caret", prefs.shape);
    root.setAttribute("data-caret-animation", prefs.animation);
    root.setAttribute("data-caret-colour", prefs.colour);
    root.toggleAttribute("data-caret-still", still);
    const native = nativeCaret(drawnCaret(prefs, still), support);
    if (support.shape) root.style.setProperty("caret-shape", native?.shape ?? "auto");
    if (support.animation) root.style.setProperty("caret-animation", native?.animation ?? "auto");
    syncMark();
    schedule(PLACE);
  };

  const onMove = () => schedule(MOVE);
  const onKey = (e: KeyboardEvent) => {
    lineEnd = e.key === "End" || (e.metaKey && e.key === "ArrowRight") || (e.ctrlKey && e.key === "e");
    pointerY = null;
    schedule(MOVE);
  };
  const onPointer = (e: PointerEvent) => { lineEnd = false; pointerY = e.clientY; schedule(MOVE); };
  const onFocus = () => { syncMark(); schedule(PLACE); };
  const onCompose = (e: CompositionEvent) => { composing = e.type !== "compositionend"; syncMark(); schedule(PLACE); };
  const onPlace = () => schedule(PLACE);
  /** An animation or transition on something that holds the field, which may carry it with it. */
  const onMotion = (e: Event) => {
    const t = e.target;
    if (field && t instanceof win.Element && !layer.contains(t) && t.contains(field)) schedule(PLACE);
  };
  const onStill = () => apply();
  const quietWatch = new win.MutationObserver(onStill);
  quietWatch.observe(root, { attributes: true, attributeFilter: ["data-quiet"] });

  const capture = { capture: true, passive: true } as const;
  doc.addEventListener("selectionchange", onMove);
  doc.addEventListener("input", onMove, capture);
  doc.addEventListener("keydown", onKey, capture);
  doc.addEventListener("pointerdown", onPointer, capture);
  doc.addEventListener("pointerup", onPointer, capture);
  doc.addEventListener("focusin", onFocus, capture);
  doc.addEventListener("focusout", onFocus, capture);
  doc.addEventListener("compositionstart", onCompose, capture);
  doc.addEventListener("compositionupdate", onCompose, capture);
  doc.addEventListener("compositionend", onCompose, capture);
  doc.addEventListener("scroll", onPlace, capture);
  for (const type of ["transitionrun", "transitionend", "animationstart", "animationend"]) doc.addEventListener(type, onMotion, capture);
  win.addEventListener("resize", onPlace);
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onFocus);
  motion?.addEventListener?.("change", onStill);
  doc.fonts?.addEventListener?.("loadingdone", onPlace);
  nudge = () => schedule(MOVE);
  apply();

  return {
    configure(next) { prefs = next; apply(); },
    uninstall() {
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      nudge = null;
      ro?.disconnect();
      quietWatch.disconnect();
      doc.removeEventListener("selectionchange", onMove);
      doc.removeEventListener("input", onMove, capture);
      doc.removeEventListener("keydown", onKey, capture);
      doc.removeEventListener("pointerdown", onPointer, capture);
      doc.removeEventListener("pointerup", onPointer, capture);
      doc.removeEventListener("focusin", onFocus, capture);
      doc.removeEventListener("focusout", onFocus, capture);
      doc.removeEventListener("compositionstart", onCompose, capture);
      doc.removeEventListener("compositionupdate", onCompose, capture);
      doc.removeEventListener("compositionend", onCompose, capture);
      doc.removeEventListener("scroll", onPlace, capture);
      for (const type of ["transitionrun", "transitionend", "animationstart", "animationend"]) doc.removeEventListener(type, onMotion, capture);
      win.removeEventListener("resize", onPlace);
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("blur", onFocus);
      motion?.removeEventListener?.("change", onStill);
      doc.fonts?.removeEventListener?.("loadingdone", onPlace);
      marked?.removeAttribute("data-rl-caret");
      marked = null;
      for (const a of ["data-caret", "data-caret-animation", "data-caret-colour", "data-caret-still"]) root.removeAttribute(a);
      root.style.removeProperty("caret-shape");
      root.style.removeProperty("caret-animation");
      layer.remove();
      mirror.remove();
    },
  };
}
