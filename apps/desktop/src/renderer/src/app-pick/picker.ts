import { APP_PICKER_ATTR, pickTarget } from "./describe";

/**
 * The element picker over Realm's OWN window: the web picker's outline (browser-agent.ts), drawn by the
 * app it belongs to instead of injected into a page.
 *
 * It follows the pointer and outlines what a press there would mean (`pickTarget`): a soft accent fill
 * inside a fine accent line, standing a few pixels off the element and rounded concentric with its own
 * corners, with a small dark label above naming it the way its chip will — "Send button", and the
 * component that drew it. The outline glides from one element to the next and keeps to its element
 * while a scroller moves under it. ⌥ points at exactly what is under the pointer.
 *
 * While it is up the window is inert, the way a page is under the web picker. Every press is taken in
 * the CAPTURE phase on the window, ahead of React's root and every other listener, and cancelled — so
 * picking the send button sends nothing and picking a menu row chooses nothing — and so is every hover
 * event, which keeps the app's own tooltips and hover handlers from answering a pointer that is only
 * aiming. CSS still lights what is under it. The pick lands on the RELEASE, because Chromium sends no
 * click to a disabled control and a picker that could not point at a greyed-out button would be no
 * use for the most common thing a person working on the app points at; the click that follows the
 * release is swallowed before the window is given back.
 *
 * It never picks its own chrome: everything it draws carries `APP_PICKER_ATTR` and takes no pointer
 * events, so `elementFromPoint` passes straight through it and `pickTarget` refuses it besides. A
 * browser pane's page is a native view over the window, so the pointer over one never reaches this
 * document at all — the outline goes as it leaves, and that page keeps the web picker.
 */

/** On the root while the picker is up — the stylesheet turns the window's drag regions off under it,
 *  so a pane's bar can be pointed at like anything else, and keeps every frame's page out of reach. */
export const PICKING_ATTR = "data-app-picking";
/** On the root for the frames a capture of the window takes: the picker's own chrome is not in it. */
export const CAPTURING_ATTR = "data-app-pick-capturing";

/** How far the outline stands off the element and the least it rounds a corner by — the web picker's
 *  numbers (PICK_OUTLINE_GAP, PICK_OUTLINE_MIN_RADIUS), so pointing reads the same in a page and here. */
const GAP = 3;
const MIN_RADIUS = 8;
/** The label's height and its gap from the outline, which `styles.css` draws at those sizes. */
const LABEL_H = 20;
const LABEL_GAP = 4;
/** How long the confirming beat stays before the layer goes: its fill and fade (`.app-picker-box
 *  [data-picked]`), and a frame over. */
const CONFIRM_MS = 260;

export type AppPickerOptions = {
  /** What the label says — the chip's own words for the element, so what is pointed at is what lands. */
  describe(el: Element): { name: string; component: string | null };
  /** The pick, once the press that made it has let go. */
  onPick(el: Element): void;
  onCancel(): void;
  /** `elementFromPoint`, injectable because jsdom has none. */
  hitTest?: (x: number, y: number) => Element | null;
};

export type AppPicker = {
  /** Clear the screen for a capture of the window: the outline, the label and the hint stand aside. */
  hide(): void;
  /** Take it all down. With the picked element's box, the outline first answers the pick — a beat of
   *  deeper fill, then a fade — as the web picker's does. */
  leave(answer?: { x: number; y: number; w: number; h: number }): void;
};

type Box = { left: number; top: number; right: number; bottom: number };

/** Hover and its bookkeeping: swallowed so nothing in the app answers a pointer that is only aiming. */
const HOVERS = ["pointerover", "pointerout", "pointerenter", "pointerleave", "mouseover", "mouseout", "mouseenter", "mouseleave"];
/** Every part of a press but the release, which is the pick. */
const PRESSES = ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "dragstart"];

export function armAppPicker(doc: Document, opts: AppPickerOptions): AppPicker {
  const win = doc.defaultView!;
  const root = doc.documentElement;
  const hitTest = opts.hitTest ?? ((x: number, y: number) => doc.elementFromPoint(x, y));
  const node = (cls: string) => { const n = doc.createElement("div"); n.className = cls; return n; };
  const layer = node("app-picker");
  layer.setAttribute(APP_PICKER_ATTR, "");
  // The outline and its label are pictures of the pointer; the hint is what a screen reader hears.
  layer.setAttribute("aria-hidden", "true");
  const box = node("app-picker-box");
  const label = node("app-picker-label");
  const nameEl = doc.createElement("span");
  nameEl.className = "app-picker-name";
  const componentEl = doc.createElement("span");
  componentEl.className = "app-picker-component";
  label.append(nameEl, componentEl);
  layer.append(box, label);
  doc.body.appendChild(layer);
  root.setAttribute(PICKING_ATTR, "");

  let current: Element | null = null;
  let shown = false;
  let exact = false;
  let point: { x: number; y: number } | null = null;
  let live = true;

  const place = (el: Element, instant: boolean) => {
    const r = el.getBoundingClientRect();
    const vw = root.clientWidth || win.innerWidth;
    const vh = root.clientHeight || win.innerHeight;
    // Off the element by GAP, and inside the window: an outline round the whole app would otherwise
    // be drawn where nobody can see it.
    const b: Box = { left: Math.max(1, r.left - GAP), top: Math.max(1, r.top - GAP), right: Math.min(vw - 1, r.right + GAP), bottom: Math.min(vh - 1, r.bottom + GAP) };
    const w = Math.max(0, b.right - b.left), h = Math.max(0, b.bottom - b.top);
    // Concentric: the element's own corner plus the gap, never squarer than MIN_RADIUS — nor rounder
    // than half the outline's short side, past which a corner stops being one.
    const cs = win.getComputedStyle(el);
    const short = Math.min(r.width, r.height);
    const radii = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"]
      .map((p) => `${Math.min(Math.min(w, h) / 2, Math.max(MIN_RADIUS, length(cs.getPropertyValue(p).split(" ")[0] ?? "", short) + GAP))}px`);
    if (instant) { box.setAttribute("data-instant", ""); label.setAttribute("data-instant", ""); }
    box.style.transform = `translate(${b.left}px, ${b.top}px)`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.borderRadius = radii.join(" ");
    const said = opts.describe(el);
    nameEl.textContent = said.name;
    componentEl.textContent = said.component ?? "";
    componentEl.hidden = !said.component;
    // Above the outline; below it where there is no room above; inside its top edge where there is
    // room for neither. A label that runs off the window is a label nobody can read.
    const lw = label.offsetWidth;
    let ly = b.top - LABEL_H - LABEL_GAP;
    if (ly < 2) ly = b.bottom + LABEL_GAP + LABEL_H <= vh - 2 ? b.bottom + LABEL_GAP : b.top + LABEL_GAP;
    const lx = Math.max(2, Math.min(b.left, vw - lw - 2));
    label.style.transform = `translate(${lx}px, ${ly}px)`;
    box.setAttribute("data-on", "");
    label.setAttribute("data-on", "");
    if (instant) { void box.offsetWidth; box.removeAttribute("data-instant"); label.removeAttribute("data-instant"); }
  };
  // The first element after the outline was hidden is placed where it is, not slid to from wherever
  // the last one was.
  const show = (el: Element) => { current = el; place(el, !shown); shown = true; };
  const hide = () => { current = null; shown = false; box.removeAttribute("data-on"); label.removeAttribute("data-on"); };
  const aim = () => {
    if (!point) return;
    const el = pickTarget(hitTest(point.x, point.y), exact);
    if (!el) hide();
    else if (el !== current) show(el);
  };

  const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onMove = (e: MouseEvent) => {
    e.stopImmediatePropagation();
    point = { x: e.clientX, y: e.clientY };
    exact = e.altKey;
    aim();
  };
  const onHover = (e: Event) => {
    e.stopImmediatePropagation();
    // Leaving the document — for a browser pane's native view, or past the window's edge — takes the
    // outline with it. A view's page is the web picker's to point into.
    if ((e.type === "mouseout" || e.type === "pointerout") && !(e as MouseEvent).relatedTarget) { point = null; hide(); }
  };
  const onRelease = (e: MouseEvent) => {
    swallow(e);
    if (e.button !== 0) return;
    const el = pickTarget(hitTest(e.clientX, e.clientY), e.altKey);
    if (!el) return;
    if (el !== current) show(el);
    stop();
    opts.onPick(el);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { swallow(e); stop(); opts.onCancel(); return; }
    if (e.key === "Alt" && exact !== (e.type === "keydown")) { exact = e.type === "keydown"; aim(); }
  };
  const follow = () => { if (current) place(current, true); };

  function stop() {
    if (!live) return;
    live = false;
    win.removeEventListener("pointermove", onMove, true);
    win.removeEventListener("mousemove", onMove, true);
    for (const t of HOVERS) win.removeEventListener(t, onHover, true);
    win.removeEventListener("pointerup", onRelease, true);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("keyup", onKey, true);
    win.removeEventListener("scroll", follow, true);
    win.removeEventListener("resize", follow);
    // The press that made the pick is not over yet: its click arrives in the same task as the release,
    // and it must not reach the button under it. The presses stay swallowed until that task is done.
    win.setTimeout(() => { for (const t of PRESSES) win.removeEventListener(t, swallow, true); root.removeAttribute(PICKING_ATTR); }, 0);
  }

  win.addEventListener("pointermove", onMove, true);
  win.addEventListener("mousemove", onMove, true);
  for (const t of HOVERS) win.addEventListener(t, onHover, true);
  for (const t of PRESSES) win.addEventListener(t, swallow, true);
  win.addEventListener("pointerup", onRelease, true);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("keyup", onKey, true);
  win.addEventListener("scroll", follow, true);
  win.addEventListener("resize", follow);

  let gone = false;
  return {
    hide() { root.setAttribute(CAPTURING_ATTR, ""); },
    leave(answer) {
      stop();
      root.removeAttribute(CAPTURING_ATTR);
      if (gone) return;
      gone = true;
      if (!answer) { layer.remove(); return; }
      label.removeAttribute("data-on");
      const b = { left: answer.x - GAP, top: answer.y - GAP };
      box.setAttribute("data-instant", "");
      box.style.transform = `translate(${b.left}px, ${b.top}px)`;
      box.style.width = `${answer.w + GAP * 2}px`;
      box.style.height = `${answer.h + GAP * 2}px`;
      box.setAttribute("data-on", "");
      void box.offsetWidth;
      box.removeAttribute("data-instant");
      box.setAttribute("data-picked", "");
      win.setTimeout(() => layer.remove(), CONFIRM_MS);
    },
  };
}

/** A computed radius in px, resolving a percentage against the element's short side. */
function length(v: string, basis: number): number {
  const n = parseFloat(v);
  return !Number.isFinite(n) ? 0 : /%$/.test(v) ? (n * basis) / 100 : n;
}
