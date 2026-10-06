import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";
import { TOAST_EXIT_MS, Toasts } from "./Toasts";

function mount() {
  const store = createAppStore(fakeApi());
  render(<StoreContext.Provider value={store}><Toasts /></StoreContext.Provider>);
  return { store, stack: () => document.querySelector<HTMLElement>(".toasts")! };
}
/** One step of the clock. The exit's own timer is armed by the render the first one causes, so a toast's
 *  time and its fade are always advanced as two steps. */
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** A rejected action's `.catch` runs a few microtasks after the throw. */
const settle = () => act(async () => { for (let k = 0; k < 5; k++) await Promise.resolve(); });
const cards = () => [...document.querySelectorAll<HTMLElement>(".toast")];

/** jsdom lays nothing out, so every toast would measure 0px and nothing would stack or lift. A
 *  one-line toast's height is what they measure here instead. */
const LINE = 42;
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true, get() { return (this as HTMLElement).classList.contains("toast-body") ? LINE : 0; },
  });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  document.documentElement.removeAttribute("data-window-inactive");
  document.body.querySelectorAll(".composer-dock").forEach((el) => el.remove());
});

describe("a toast", () => {
  it("is what a failed action says — an alert at the window's foot, its words selectable content", async () => {
    const { store } = mount();
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.getState().run(async () => { throw new Error("/Users/me/Realm/yooo is not a git repository, so it has no worktrees"); });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("is not a git repository");
    expect(alert.querySelector("p.toast-text")).not.toBeNull();
    // The old bar is gone with it.
    expect(document.querySelector(".error-bar")).toBeNull();
  });

  it("is a status for anything that is not an error", () => {
    const { store } = mount();
    act(() => { store.getState().toast({ tone: "success", text: "Shared example.com's sign-in with School." }); });
    expect(screen.getByRole("status")).toHaveTextContent("Shared example.com's sign-in");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves on its own once its time is up", () => {
    // THE mutant: no clock, and a toast is the banner again — up until someone closes it.
    const { store } = mount();
    act(() => { store.getState().toast({ text: "Saved", life: 1000 }); });
    advance(990);
    expect(store.getState().toasts).toHaveLength(1);
    advance(10);
    expect(cards()[0]).toHaveAttribute("data-leaving"); // fading…
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
    expect(cards()).toHaveLength(0);
  });

  it("waits while the pointer is on the stack, and goes on from where it was when it leaves", () => {
    // THE mutant: a clock that ignores the pointer, which takes the toast away from someone reading it.
    const { store, stack } = mount();
    act(() => { store.getState().toast({ text: "Saved", life: 1000 }); });
    advance(500);
    fireEvent.pointerEnter(stack());
    expect(stack()).toHaveAttribute("data-expanded");
    expect(cards()[0]).toHaveAttribute("data-paused"); // …and the line across its foot stops with it
    advance(60_000);
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toHaveLength(1);
    expect(cards()[0]).not.toHaveAttribute("data-leaving");
    fireEvent.pointerLeave(stack());
    expect(cards()[0]).not.toHaveAttribute("data-paused");
    advance(1000); advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
  });

  it("waits while the keyboard is in it", () => {
    const { store } = mount();
    act(() => { store.getState().toast({ text: "Saved", life: 1000 }); });
    const close = screen.getByRole("button", { name: "Dismiss" });
    act(() => { close.focus(); });
    advance(10_000);
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toHaveLength(1);
    expect(cards()[0]).not.toHaveAttribute("data-leaving");
    act(() => { close.blur(); });
    advance(1000); advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
  });

  it("waits while the window is not the key window — a notice that came while you were away is still there", async () => {
    const { store } = mount();
    // The attribute is watched by a MutationObserver, which reports on a microtask.
    document.documentElement.setAttribute("data-window-inactive", "");
    await settle();
    act(() => { store.getState().toast({ text: "Finished", life: 1000 }); });
    advance(10_000);
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toHaveLength(1);
    expect(cards()[0]).not.toHaveAttribute("data-leaving");
    document.documentElement.removeAttribute("data-window-inactive");
    await settle();
    advance(1000); advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
  });

  it("is dismissed by its button and by Escape", () => {
    const { store } = mount();
    act(() => { store.getState().toast({ text: "one" }); store.getState().toast({ text: "two" }); });
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Dismiss" }));
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts.map((t) => t.text)).toEqual(["one"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss" }), { key: "Escape" });
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
  });

  it("offers its action as a button beside the words, and goes once it is taken — and only then runs it", () => {
    /* THE mutants: an action drawn and not run, or a toast that stays up offering an Undo already
       done — a second press would undo nothing, or something else. */
    const { store } = mount();
    const run = vi.fn();
    act(() => { store.getState().toast({ text: "Removed hero.png from the Library.", action: { label: "Undo", run } }); });
    const undo = within(cards()[0]!).getByRole("button", { name: "Undo" });
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(undo);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cards()[0]).toHaveAttribute("data-leaving");
    advance(TOAST_EXIT_MS);
    expect(store.getState().toasts).toEqual([]);
    // A toast with nothing to offer draws no such button.
    act(() => { store.getState().toast({ text: "Saved" }); });
    expect(within(cards()[0]!).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Dismiss"]);
  });

  it("hands the keyboard to the next toast when one is dismissed by it", () => {
    const { store } = mount();
    act(() => { store.getState().toast({ text: "one" }); store.getState().toast({ text: "two" }); });
    const [front, behind] = cards();
    const close = within(front!).getByRole("button", { name: "Dismiss" });
    act(() => { close.focus(); });
    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.activeElement).toBe(within(behind!).getByRole("button", { name: "Dismiss" }));
  });
});

describe("the stack", () => {
  it("puts the newest in front and tucks the others behind it, fanning them out under the pointer", () => {
    const { store, stack } = mount();
    act(() => { for (const text of ["one", "two", "three"]) store.getState().toast({ text }); });
    const [front, second, third] = cards();
    expect(front).toHaveTextContent("three");
    expect(front).toHaveAttribute("data-front");
    expect(second).not.toHaveAttribute("data-front");
    // Collapsed: a peek apart, a step smaller each.
    expect([front, second, third].map((c) => c!.style.getPropertyValue("--toast-y"))).toEqual(["0px", "-10px", "-20px"]);
    expect(Number(third!.style.getPropertyValue("--toast-scale"))).toBeLessThan(Number(second!.style.getPropertyValue("--toast-scale")));
    expect(Number(front!.style.zIndex)).toBeGreaterThan(Number(third!.style.zIndex));
    fireEvent.pointerEnter(stack());
    // Fanned out: whole, and each standing on the one in front of it, a gap apart.
    expect([front, second, third].map((c) => c!.style.getPropertyValue("--toast-y"))).toEqual(["0px", `-${LINE + 8}px`, `-${2 * (LINE + 8)}px`]);
    expect(parseFloat(stack().style.height)).toBe(3 * LINE + 2 * 8); // the whole fan is one target
    expect(third!.style.getPropertyValue("--toast-scale")).toBe("1");
  });

  it("never stands over a browser view — it moves along the foot to the corner the view leaves", () => {
    // THE mutant: place the stack without the views, and it is drawn at the window's corner, inside
    // the view's rectangle, where the page paints over it.
    const { store, stack } = mount();
    act(() => { store.setState({ browserRects: [{ itemId: "b", x: 600, y: 40, width: window.innerWidth - 600, height: window.innerHeight - 40 }] }); });
    act(() => { store.getState().toast({ text: "Added button to Session." }); });
    const box = stack();
    expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(600 - 16);
    expect(store.getState().toastReserve).toBeNull();
  });

  it("stands over a prompter, never on it", () => {
    const { store, stack } = mount();
    const dock = document.createElement("div");
    dock.className = "composer-dock";
    const top = window.innerHeight - 140;
    dock.getBoundingClientRect = () => new DOMRect(200, top, window.innerWidth - 220, 124);
    document.body.appendChild(dock);
    act(() => { store.getState().toast({ text: "boom", tone: "error" }); });
    expect(parseFloat(stack().style.bottom)).toBe(window.innerHeight - top + 16);
  });

  it("where views cover the whole foot, asks the view under the corner to give it up — for as long as it is up", () => {
    const { store } = mount();
    act(() => { store.setState({ browserRects: [{ itemId: "b", x: 76, y: 40, width: window.innerWidth - 76, height: window.innerHeight - 40 }] }); });
    act(() => { store.getState().toast({ text: "Saved", life: 1000 }); });
    const reserve = store.getState().toastReserve!;
    expect(reserve).not.toBeNull();
    expect(reserve.x + reserve.width).toBe(window.innerWidth);
    expect(reserve.y + reserve.height).toBe(window.innerHeight);
    advance(1000); advance(TOAST_EXIT_MS);
    expect(store.getState().toastReserve).toBeNull();
  });
});
