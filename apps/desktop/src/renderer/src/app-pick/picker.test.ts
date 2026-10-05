import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PICKER_ATTR } from "./describe";
import { CAPTURING_ATTR, PICKING_ATTR, armAppPicker, type AppPicker } from "./picker";

/** jsdom has no `elementFromPoint` and no layout: the point a test aims at IS the element under it. */
let under: Element | null = null;
let picker: AppPicker | null = null;
const picks: Element[] = [];
let cancels = 0;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="root">
    <div class="composer-card"><button class="composer-send" aria-label="Send"><svg><path d="M1 1"/></svg></button></div>
    <button class="item-row" disabled>Pricing page</button>
  </div>`;
  picks.length = 0; cancels = 0; under = null;
  picker = armAppPicker(document, {
    describe: (el) => ({ name: el.getAttribute("aria-label") ?? el.textContent ?? "", component: el.localName === "button" ? "Composer" : null }),
    onPick: (el) => picks.push(el),
    onCancel: () => { cancels++; },
    hitTest: () => under,
  });
});
afterEach(() => { picker?.leave(); vi.runAllTimers(); vi.useRealTimers(); document.body.innerHTML = ""; });

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const at = (el: Element | null) => { under = el; };
const fire = (type: string, init: MouseEventInit = {}, target: EventTarget = under ?? document.body) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(e);
  return e;
};
const move = (el: Element, init: MouseEventInit = {}) => { at(el); fire("pointermove", init); };
const box = () => $(".app-picker-box");
const label = () => $(".app-picker-label");

describe("the in-app picker", () => {
  it("outlines what a press there would mean, named the way its chip will be", () => {
    move($(".composer-send path"));
    expect(box().hasAttribute("data-on")).toBe(true);
    expect(label().textContent).toBe("SendComposer");
    // The outline is the picker's own chrome: off the accessibility tree, and marked as its own.
    expect($(".app-picker").getAttribute("aria-hidden")).toBe("true");
    expect($(".app-picker").hasAttribute(APP_PICKER_ATTR)).toBe(true);
    expect(document.documentElement.hasAttribute(PICKING_ATTR)).toBe(true);
  });

  it("follows the pointer from one element to the next, and goes as the pointer leaves the document", () => {
    move($(".composer-send"));
    move($(".item-row"));
    expect($(".app-picker-name").textContent).toBe("Pricing page");
    // Onto a browser pane's native view, or out of the window: the document hears the pointer leave.
    fire("mouseout", { relatedTarget: null });
    expect(box().hasAttribute("data-on")).toBe(false);
  });

  it("picks on the release, and neither the press nor the click that follows reaches the control", () => {
    // THE MUTANT: let the presses through. Picking the send button would send the message.
    const clicked = vi.fn();
    $(".composer-send").addEventListener("click", clicked);
    const pressed = vi.fn();
    document.addEventListener("pointerdown", pressed);
    at($(".composer-send path"));
    const down = fire("pointerdown");
    fire("mousedown");
    fire("pointerup");
    fire("mouseup");
    fire("click");
    expect(down.defaultPrevented).toBe(true);
    expect(pressed).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
    expect(picks).toEqual([$(".composer-send")]);
    // The window is given back once the press is over, and not before.
    vi.runAllTimers();
    fire("click");
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute(PICKING_ATTR)).toBe(false);
  });

  it("can pick a disabled control, which Chromium sends no click to", () => {
    at($(".item-row"));
    fire("pointerup");
    expect(picks).toEqual([$(".item-row")]);
  });

  it("with ⌥ points at exactly what is under the pointer", () => {
    move($(".composer-send path"), { altKey: true });
    at($(".composer-send path"));
    fire("pointerup", { altKey: true });
    expect(picks).toEqual([$(".composer-send path")]);
  });

  it("never picks its own chrome — a release over the hint picks nothing and leaves the picker up", () => {
    document.body.insertAdjacentHTML("beforeend", `<div class="app-picker-hint" ${APP_PICKER_ATTR}>Click a part of Realm</div>`);
    at($(".app-picker-hint"));
    fire("pointerup");
    expect(picks).toEqual([]);
    move($(".composer-send"));
    expect(box().hasAttribute("data-on")).toBe(true);
  });

  it("keeps the app from answering a pointer that is only aiming — no tooltip, no hover handler", () => {
    // THE MUTANT: let hover through. The app's tooltip layer listens for pointerover on the document,
    // and its tip would come up over the outline's label on every element the pointer crossed.
    const hovered = vi.fn();
    document.addEventListener("pointerover", hovered, true);
    document.addEventListener("pointermove", hovered, true);
    at($(".composer-send"));
    fire("pointerover");
    fire("pointermove");
    expect(hovered).not.toHaveBeenCalled();
  });

  it("is cancelled by Escape, which nothing else hears — a running agent is not interrupted", () => {
    const keys = vi.fn();
    window.addEventListener("keydown", keys);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(cancels).toBe(1);
    expect(e.defaultPrevented).toBe(true);
    expect(keys).not.toHaveBeenCalled();
    window.removeEventListener("keydown", keys);
  });

  it("stands aside for a capture, and answers a pick with a beat before it goes", () => {
    move($(".composer-send"));
    at($(".composer-send"));
    fire("pointerup");
    picker!.hide();
    expect(document.documentElement.hasAttribute(CAPTURING_ATTR)).toBe(true);
    picker!.leave({ x: 10, y: 20, w: 32, h: 32 });
    expect(document.documentElement.hasAttribute(CAPTURING_ATTR)).toBe(false);
    expect(box().hasAttribute("data-picked")).toBe(true);
    expect(box().style.width).toBe("38px");
    vi.runAllTimers();
    expect(document.querySelector(".app-picker")).toBeNull();
  });

  it("goes at once when put away without a pick, leaving nothing behind", () => {
    picker!.leave();
    expect(document.querySelector(".app-picker")).toBeNull();
    vi.runAllTimers();
    expect(document.documentElement.hasAttribute(PICKING_ATTR)).toBe(false);
    // Nothing is listening any more: a release now picks nothing.
    at($(".composer-send"));
    fire("pointerup");
    expect(picks).toEqual([]);
  });
});
