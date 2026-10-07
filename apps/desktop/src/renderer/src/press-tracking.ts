/**
 * Press tracking, the way an NSButton does it: the highlight follows the pointer for as long as the
 * button is held. Drag off and it lets go at once; drag back on and it takes the highlight again;
 * release off it and nothing is clicked. The last part the browser already does. The first two it
 * cannot: Chromium drops `:active` the moment a held pointer leaves the element and never hands it
 * back, and the fill it drops fades out on the hover rung instead of snapping.
 *
 * So the press is marked up rather than inferred: `data-pressed` while the pointer is down AND over
 * the control, and `data-press-tracking` for the whole of the press, which is what lets the
 * stylesheet zero the transition in both directions while a press is being tracked (styles.css,
 * Press). Keyboard presses never come through here — Space on a focused button is still `:active`,
 * and the stylesheet asks for that separately.
 */
export const PRESSABLE = [
  "button", '[role="button"]', '[role^="menuitem"]', '[role="option"]', '[role="tab"]', '[role="switch"]',
  'input[type="checkbox"]',
].join(", ");

export function installPressTracking(doc: Document): () => void {
  const win = doc.defaultView!;
  let held: HTMLElement | null = null;

  const inside = (el: Element, x: number, y: number) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  };
  const end = () => {
    if (!held) return;
    held.removeAttribute("data-pressed");
    held.removeAttribute("data-press-tracking");
    held = null;
  };
  const down = (e: PointerEvent) => {
    end();
    if (e.button !== 0 || e.pointerType === "touch") return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>(PRESSABLE) : null;
    if (!target || target.matches(":disabled, [aria-disabled='true']")) return;
    held = target;
    held.setAttribute("data-press-tracking", "");
    held.setAttribute("data-pressed", "");
  };
  const move = (e: PointerEvent) => {
    if (!held) return;
    if (!held.isConnected) { held = null; return; }
    if (inside(held, e.clientX, e.clientY)) held.setAttribute("data-pressed", "");
    else held.removeAttribute("data-pressed");
  };

  doc.addEventListener("pointerdown", down, { capture: true, passive: true });
  doc.addEventListener("pointermove", move, { capture: true, passive: true });
  doc.addEventListener("pointerup", end, { capture: true, passive: true });
  doc.addEventListener("pointercancel", end, { capture: true, passive: true });
  // A press that ends somewhere the page never hears about — over another app, or in an OS menu.
  win.addEventListener("blur", end);
  return () => {
    end();
    doc.removeEventListener("pointerdown", down, { capture: true });
    doc.removeEventListener("pointermove", move, { capture: true });
    doc.removeEventListener("pointerup", end, { capture: true });
    doc.removeEventListener("pointercancel", end, { capture: true });
    win.removeEventListener("blur", end);
  };
}
