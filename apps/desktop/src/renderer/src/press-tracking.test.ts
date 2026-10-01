import { afterEach, expect, it } from "vitest";
import { installPressTracking } from "./press-tracking";

let uninstall: () => void = () => {};
afterEach(() => { uninstall(); document.body.innerHTML = ""; });

const setup = (html = '<button id="b">Go</button>') => {
  document.body.innerHTML = html;
  const b = document.body.firstElementChild as HTMLElement;
  b.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30, x: 0, y: 0, toJSON: () => ({}) });
  uninstall = installPressTracking(document);
  return b;
};
/** jsdom has no PointerEvent; a MouseEvent under a pointer event's name carries everything read. */
const fire = (el: EventTarget, type: string, init: MouseEventInit) => {
  const e = new MouseEvent(type, { bubbles: true, button: 0, ...init });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  el.dispatchEvent(e);
};

/* THE mutants: the highlight not leaving when the pointer does, not coming back when it returns,
   and a press that outlives its release. */
it("follows the pointer for as long as the button is held", () => {
  const b = setup();
  fire(b, "pointerdown", { clientX: 10, clientY: 10 });
  expect(b.hasAttribute("data-pressed")).toBe(true);
  expect(b.hasAttribute("data-press-tracking")).toBe(true);
  fire(document, "pointermove", { clientX: 10, clientY: 200 });
  expect(b.hasAttribute("data-pressed")).toBe(false);
  expect(b.hasAttribute("data-press-tracking")).toBe(true);
  fire(document, "pointermove", { clientX: 50, clientY: 20 });
  expect(b.hasAttribute("data-pressed")).toBe(true);
  fire(document, "pointerup", { clientX: 50, clientY: 20 });
  expect(b.hasAttribute("data-pressed")).toBe(false);
  expect(b.hasAttribute("data-press-tracking")).toBe(false);
});

it("leaves disabled controls, other buttons than the primary, and plain content alone", () => {
  const b = setup('<button id="b" disabled>Go</button>');
  fire(b, "pointerdown", { clientX: 10, clientY: 10 });
  expect(b.hasAttribute("data-pressed")).toBe(false);
  const c = setup();
  fire(c, "pointerdown", { clientX: 10, clientY: 10, button: 2 });
  expect(c.hasAttribute("data-pressed")).toBe(false);
  const p = setup("<p>text</p>");
  fire(p, "pointerdown", { clientX: 10, clientY: 10 });
  expect(p.hasAttribute("data-pressed")).toBe(false);
});

it("lets go when the window does — a release that lands in another app never reaches the page", () => {
  const b = setup();
  fire(b, "pointerdown", { clientX: 10, clientY: 10 });
  window.dispatchEvent(new Event("blur"));
  expect(b.hasAttribute("data-pressed")).toBe(false);
  expect(b.hasAttribute("data-press-tracking")).toBe(false);
});
