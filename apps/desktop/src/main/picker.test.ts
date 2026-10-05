import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICKER_HOST, PICK_ATTR, PICK_BINDING, STOP_PICKER_JS, pickerScript } from "./browser-agent";

/**
 * The user's picker, run as the page runs it — injected into a document and driven with real events.
 * jsdom has no layout, so `elementFromPoint` and each element's box are answered by the test. What is
 * under test is everything the page decides on its own: where the outline goes and how round it is,
 * what the label says, what a click picks and swallows, and that nothing of it is left behind.
 */
let reports: string[];
let under: Element | null;
let pageClicks: number;
let page: HTMLElement;

const arm = () => new Function(pickerScript("rgb(76, 141, 255)"))();
const hosts = () => document.querySelectorAll(PICKER_HOST);
const shadow = () => (hosts()[0] as HTMLElement | undefined)?.shadowRoot ?? null;
const box = () => shadow()?.querySelector(".box") as HTMLElement;
const label = () => shadow()?.querySelector(".label") as HTMLElement;

/** An element of the page at a box of the test's choosing, with its own corners as the page set them. */
function element(id: string, rect: { x: number; y: number; w: number; h: number }, radius = "0px"): HTMLElement {
  const el = document.createElement("button");
  el.id = id;
  el.textContent = id;
  // Longhands: jsdom does not expand the shorthand the way a browser's computed style does.
  for (const corner of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"] as const) el.style[corner] = radius;
  el.getBoundingClientRect = () => ({ x: rect.x, y: rect.y, left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: rect.x + rect.w, bottom: rect.y + rect.h, toJSON: () => ({}) }) as DOMRect;
  page.appendChild(el);
  return el;
}
/** The pointer comes to rest over an element, as a hand's does before it clicks. */
function hover(el: Element | null) {
  under = el;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
}
function press(el: Element, type: string) {
  const e = new MouseEvent(type, { clientX: 5, clientY: 5, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  reports = [];
  pageClicks = 0;
  under = null;
  page = document.createElement("main");
  page.addEventListener("click", () => { pageClicks++; });
  document.body.appendChild(page);
  (window as unknown as Record<string, unknown>)[PICK_BINDING] = (payload: string) => reports.push(payload);
  document.elementFromPoint = () => under;
});
afterEach(() => {
  (window as unknown as { __realmPicker?: { stop(): void } | null }).__realmPicker?.stop();
  for (const n of hosts()) n.remove();
  page.remove();
  vi.useRealTimers();
});

describe("the picker's outline", () => {
  it("stands a few pixels off the element, rounded concentric with the element's own corners", () => {
    arm();
    hover(element("save", { x: 100, y: 100, w: 80, h: 30 }, "10px"));
    expect(box().style.transform).toBe("translate(97px,97px)");
    expect([box().style.width, box().style.height]).toEqual(["86px", "36px"]);
    // The element's 10px corner plus the 3px it stands off: one curve inside the other.
    expect(box().style.borderRadius).toBe("13px 13px 13px 13px");
    expect(box().hasAttribute("data-on")).toBe(true);
  });

  it("rounds a square element softly rather than drawing a square box round it", () => {
    /* The owner's report: "shouldn't be like this square thing". THE mutant: drop the floor, and a
       plain div — most of what anyone points at — is outlined with a 3px corner, which reads square. */
    arm();
    hover(element("card", { x: 20, y: 200, w: 300, h: 120 }));
    expect(box().style.borderRadius).toBe("8px 8px 8px 8px");
  });

  it("outlines a pill as a pill and a circle as a circle — never rounder than half its short side", () => {
    arm();
    hover(element("chip", { x: 10, y: 100, w: 90, h: 24 }, "999px"));
    expect(box().style.borderRadius).toBe("15px 15px 15px 15px");
    hover(element("avatar", { x: 10, y: 200, w: 40, h: 40 }, "50%"));
    expect(box().style.borderRadius).toBe("23px 23px 23px 23px");
  });

  it("keeps an element bigger than the viewport outlined inside it", () => {
    arm();
    hover(element("page", { x: 0, y: -400, w: 1024, h: 3000 }));
    expect(box().style.transform).toBe("translate(1px,1px)");
    expect([box().style.width, box().style.height]).toEqual(["1022px", "766px"]);
  });

  it("names the element and its size in a small label above it", () => {
    arm();
    hover(element("submit", { x: 100, y: 200, w: 120.4, h: 31.6 }));
    expect(label().textContent).toBe("button#submit120 × 32");
    expect(label().querySelector(".size")!.textContent).toBe("120 × 32");
    expect(label().style.transform).toBe("translate(97px,173px)");
  });

  it("names an element by its first class when it has no id, cut short past what a glance takes in", () => {
    arm();
    const el = element("", { x: 100, y: 200, w: 50, h: 20 });
    el.removeAttribute("id");
    el.className = "btn primary large";
    hover(el);
    // `split(/\s+/)`: a regex in this script has to survive a template literal, which cooks `\s` to "s".
    expect(label().firstElementChild!.textContent).toBe("button.btn");
    el.className = "a-very-long-class-name-from-a-css-in-js-hash";
    hover(null);
    hover(el);
    expect(label().firstElementChild!.textContent).toBe("button.a-very-long-class-name-f…");
  });

  it("puts the label below the outline when there is no room above it, and inside it when there is none below", () => {
    arm();
    hover(element("top", { x: 100, y: 4, w: 80, h: 30 }));
    expect(label().style.transform).toBe("translate(97px,41px)");
    hover(element("whole", { x: 0, y: 0, w: 1024, h: 768 }));
    expect(label().style.transform).toBe("translate(2px,5px)");
  });

  it("goes when the pointer leaves the page, and comes back where the next element is", () => {
    arm();
    hover(element("a", { x: 10, y: 100, w: 40, h: 20 }));
    window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null }));
    expect(box().hasAttribute("data-on")).toBe(false);
    hover(element("b", { x: 300, y: 300, w: 40, h: 20 }));
    expect(box().hasAttribute("data-on")).toBe(true);
    expect(box().style.transform).toBe("translate(297px,297px)");
  });

  it("follows its element when the page scrolls under it", () => {
    arm();
    const rect = { x: 100, y: 300, w: 80, h: 30 };
    const el = element("moving", rect);
    hover(el);
    rect.y = 150;
    window.dispatchEvent(new Event("scroll"));
    expect(box().style.transform).toBe("translate(97px,147px)");
  });

  it("is drawn out of the page's reach and out of the accessibility tree", () => {
    arm();
    const host = hosts()[0] as HTMLElement;
    // Its own element name, so `div { … !important }` on the page restyles nothing of it.
    expect(host.tagName.toLowerCase()).toBe(PICKER_HOST);
    expect(host.shadowRoot).not.toBeNull();
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.pointerEvents).toBe("none");
  });
});

describe("picking", () => {
  it("picks the element under the pointer, stamps it, and reports where in it the click landed", () => {
    arm();
    const el = element("go", { x: 0, y: 0, w: 10, h: 10 });
    hover(el);
    press(el, "click");
    expect(el.getAttribute(PICK_ATTR)).toBe("1");
    expect(JSON.parse(reports[0]!)).toEqual({ x: 0.5, y: 0.5, surface: null });
  });

  it("swallows the click and every press before it, so picking a link or a menu button does nothing to the page", () => {
    arm();
    const el = element("menu", { x: 0, y: 0, w: 10, h: 10 });
    let downs = 0;
    page.addEventListener("mousedown", () => { downs++; });
    hover(el);
    expect(press(el, "pointerdown").defaultPrevented).toBe(true);
    expect(press(el, "mousedown").defaultPrevented).toBe(true);
    expect(press(el, "click").defaultPrevented).toBe(true);
    expect([downs, pageClicks]).toEqual([0, 0]);
  });

  it("picks even when no move came first — the click never falls through to the page", () => {
    arm();
    const el = element("direct", { x: 0, y: 0, w: 10, h: 10 });
    under = el;
    press(el, "click");
    expect(pageClicks).toBe(0);
    expect(el.getAttribute(PICK_ATTR)).toBe("1");
  });

  it("answers the pick and then goes on its own — and a disarm arriving meanwhile lets it finish", () => {
    vi.useFakeTimers();
    arm();
    const el = element("go", { x: 0, y: 0, w: 10, h: 10 });
    hover(el);
    press(el, "click");
    expect(box().hasAttribute("data-picked")).toBe(true);
    // The page has its clicks back at once: the next one is the page's.
    press(el, "click");
    expect(pageClicks).toBe(1);
    // Main disarms the moment the pick resolves; the outline it is answering with is not cut short.
    new Function(STOP_PICKER_JS)();
    expect(hosts()).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(hosts()).toHaveLength(0);
  });
});

describe("nothing left behind", () => {
  it("Escape cancels: reports nothing picked and takes the outline down at once", () => {
    arm();
    hover(element("a", { x: 0, y: 0, w: 10, h: 10 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(reports).toEqual([""]);
    expect(hosts()).toHaveLength(0);
  });

  it("a cancel from the pane takes it down at once, and the page has its clicks back", () => {
    arm();
    const el = element("a", { x: 0, y: 0, w: 10, h: 10 });
    hover(el);
    new Function(STOP_PICKER_JS)();
    expect(hosts()).toHaveLength(0);
    press(el, "click");
    expect(pageClicks).toBe(1);
  });

  it("goes with the page: a page leaving takes the picker with it, so a page brought back is not still armed", () => {
    arm();
    window.dispatchEvent(new Event("pagehide"));
    expect(hosts()).toHaveLength(0);
    expect((window as unknown as { __realmPicker?: unknown }).__realmPicker).toBeNull();
  });

  it("sweeps up a host something left behind, on the next arm and on a disarm", () => {
    const stray = document.createElement(PICKER_HOST);
    document.documentElement.appendChild(stray);
    arm();
    expect(hosts()).toHaveLength(1);
    expect(hosts()[0]).not.toBe(stray);
    const another = document.createElement(PICKER_HOST);
    document.documentElement.appendChild(another);
    new Function(STOP_PICKER_JS)();
    expect(hosts()).toHaveLength(0);
  });
});
