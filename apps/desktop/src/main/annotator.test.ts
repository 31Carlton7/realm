import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANNOTATE_ATTR, ANNOTATE_BINDING, annotatorScript } from "./browser-agent";

/**
 * The annotator's page-side half, run as the page runs it — injected into a document and driven with
 * real events. jsdom has no layout, so `elementFromPoint` is answered by the test: "the pointer is over
 * this element". What is under test is everything the page decides on its own: what a click pins, what
 * it reports, what it swallows, and what each toolbar button does.
 */
type Report = { type: string; n?: number };

let reports: Report[];
let under: Element | null;
let pageClicks: number;

function arm(max = 8) {
  // The script is injected over CDP as one expression; this is the same string, run in this page.
  new Function(annotatorScript("rgb(76, 141, 255)", max))();
}
const toolbar = () => document.querySelector('[role="toolbar"][aria-label="Annotate"]') as HTMLElement | null;
const button = (name: string) => [...(toolbar()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;
const count = () => toolbar()?.querySelector("span")?.textContent ?? null;
/** Point at an element and click it, the way a hand does: the move first, then the click. */
function clickOn(el: Element) {
  under = el;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
  const click = new MouseEvent("click", { clientX: 5, clientY: 5, bubbles: true, cancelable: true });
  el.dispatchEvent(click);
  return click;
}

let page: HTMLElement;

beforeEach(() => {
  reports = [];
  pageClicks = 0;
  under = null;
  // A fresh page per test, with its own click listener — one left on `body` would count every test's.
  page = document.createElement("main");
  page.innerHTML = '<ul><li id="a">One</li><li id="b">Two</li><li id="c">Three</li></ul><a id="link" href="#next">Next</a>';
  page.addEventListener("click", () => { pageClicks++; });
  document.body.appendChild(page);
  (window as unknown as Record<string, unknown>)[ANNOTATE_BINDING] = (payload: string) => reports.push(JSON.parse(payload) as Report);
  document.elementFromPoint = () => under;
});
afterEach(() => {
  (window as unknown as { __realmAnnotator?: { stop(): void } | null }).__realmAnnotator?.stop();
  page.remove();
});

const item = (id: string) => document.getElementById(id)!;

describe("the annotator, in the page", () => {
  it("arms with its toolbar in the page and nothing yet to send", () => {
    arm();
    expect(toolbar()).not.toBeNull();
    expect(count()).toBe("Annotating · click to pin");
    expect(button("Send").disabled).toBe(true);
    expect(button("Clear").disabled).toBe(true);
  });

  it("a click pins the element under the pointer, numbers it, and keeps it from the page", () => {
    arm();
    const click = clickOn(item("a"));
    expect(reports).toEqual([expect.objectContaining({ type: "pin", n: 1 })]);
    expect(item("a").getAttribute(ANNOTATE_ATTR)).toBe("1");
    expect(count()).toBe("Annotating · 1");
    expect(button("Send").disabled).toBe(false);
    // Pinning a link or a button changes nothing about the page under it.
    expect(click.defaultPrevented).toBe(true);
    expect(pageClicks).toBe(0);
    clickOn(item("link"));
    expect(location.hash).toBe("");
  });

  it("the presses before a click are kept from the page too, so pinning focuses and drags nothing", () => {
    arm();
    under = item("b");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    item("b").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("each new click is the next number, and a second click on a pinned element adds nothing", () => {
    arm();
    clickOn(item("a")); clickOn(item("b")); clickOn(item("a"));
    expect(reports.map((r) => r.n)).toEqual([1, 2]);
    expect(item("b").getAttribute(ANNOTATE_ATTR)).toBe("2");
    expect(count()).toBe("Annotating · 2");
  });

  it("stops at the most one message carries, and says so instead of pinning", () => {
    /* THE mutant: no limit in the page. The ninth pin would be drawn, numbered and then silently
       missing from what Send carries, because main stops at the message's limit. */
    arm(2);
    clickOn(item("a")); clickOn(item("b")); clickOn(item("c"));
    expect(reports.map((r) => r.n)).toEqual([1, 2]);
    expect(item("c").hasAttribute(ANNOTATE_ATTR)).toBe(false);
    expect(count()).toBe("That is as many as one message carries");
  });

  it("the toolbar's own buttons work — the page's clicks are taken, never the toolbar's", () => {
    /* THE mutant: swallow every click, toolbar included. Send would then do nothing at all. */
    arm();
    clickOn(item("a"));
    button("Send").click();
    expect(reports.at(-1)).toEqual({ type: "send" });
    button("Stop annotating").click();
    expect(reports.at(-1)).toEqual({ type: "close" });
  });

  it("Clear takes every pin off the page, and the next one is number 1 again", () => {
    arm();
    clickOn(item("a")); clickOn(item("b"));
    button("Clear").click();
    expect(reports.at(-1)).toEqual({ type: "clear" });
    expect(document.querySelectorAll(`[${ANNOTATE_ATTR}]`)).toHaveLength(0);
    expect(count()).toBe("Annotating · click to pin");
    clickOn(item("c"));
    expect(reports.at(-1)).toEqual(expect.objectContaining({ type: "pin", n: 1 }));
  });

  it("Hide pins hides them and says how to bring them back", () => {
    arm();
    clickOn(item("a"));
    button("Hide pins").click();
    expect(button("Show pins")).toBeDefined();
    button("Show pins").click();
    expect(button("Hide pins")).toBeDefined();
  });

  it("Escape is a close, not a key for the page", () => {
    arm();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(reports).toEqual([{ type: "close" }]);
  });

  it("stopping takes the overlay and every stamp off, and the page gets its clicks back", () => {
    arm();
    clickOn(item("a"));
    (window as unknown as { __realmAnnotator: { stop(): void } }).__realmAnnotator.stop();
    expect(toolbar()).toBeNull();
    expect(item("a").hasAttribute(ANNOTATE_ATTR)).toBe(false);
    clickOn(item("b"));
    expect(pageClicks).toBe(1);
  });

  it("arming again replaces the last annotator rather than stacking a second one", () => {
    arm();
    arm();
    expect(document.querySelectorAll('[role="toolbar"][aria-label="Annotate"]')).toHaveLength(1);
  });
});
