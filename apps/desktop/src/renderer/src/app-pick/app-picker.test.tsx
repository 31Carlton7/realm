import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { gridPreset, type BrowserPickedElement } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";
import { Toasts } from "../components/Toasts";
import { AppPickerBridge } from "./AppPicker";
import { startAppPick } from "./start";

/**
 * One pick, end to end in the renderer: the + menu or ⌘⇧C puts the picker up, a release over a part
 * of Realm describes it, main is asked for its picture, and the chip and the picture land in the
 * session's draft. Main's half is a fake bridge here — `main/app-pick.test.ts` holds its rules.
 */

const SHOT = { path: "/realm/tmp/attachments/abc123-realm-send-button.png", mime: "image/png", name: "realm-send-button.png", size: 2048 };
type Shot = { file: typeof SHOT | null; webView: boolean };

let under: Element | null = null;
let calls: string[] = [];
let answer: Shot = { file: SHOT, webView: false };
const realm = window.realm;

beforeEach(() => {
  calls = []; under = null; answer = { file: SHOT, webView: false };
  (window as unknown as { realm: unknown }).realm = {
    ...realm,
    appPick: {
      arm: (on: boolean) => { calls.push(on ? "arm" : "disarm"); },
      capture: async (_rect: unknown, _ground: unknown, name: string) => { calls.push(`capture ${name}`); return answer; },
    },
  };
  // jsdom has no hit testing: whatever the test points at is what is under the pointer.
  document.elementFromPoint = (() => under) as typeof document.elementFromPoint;
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => {
  (window as unknown as { realm: unknown }).realm = realm;
  setBrowserBridgesForTests(null);
  // The picker's layer is the window's, not React's: a confirming beat still fading when a test ends
  // would otherwise be found by the next one.
  document.querySelectorAll(".fake-app, .app-picker, [data-realm-agent-highlight]").forEach((n) => n.remove());
  document.documentElement.removeAttribute("data-app-picking");
});

function mount(over: { browser?: boolean; withSession?: boolean } = {}) {
  const store = createAppStore(fakeApi());
  const session = item("i1", "s1", { kind: "session", refId: "se1", title: "Fix the parser" });
  const browser = item("i2", "s1", { kind: "browser", refId: "b1", title: "Docs" });
  const items = [...(over.withSession === false ? [] : [session]), ...(over.browser ? [browser] : [])];
  store.setState({ items, layout: gridPreset(items.length > 1 ? "two-col" : "one", items.map((i) => i.id)), focusedLeafId: null, activeSpaceId: "s1",
    browserRects: over.browser ? [{ itemId: "i2", x: 700, y: 40, width: 700, height: 860 }] : [] });
  render(<StoreContext.Provider value={store}><AppPickerBridge /><Toasts /></StoreContext.Provider>);
  // A part of Realm to point at, outside React's tree like the rest of the window as far as this goes.
  document.body.insertAdjacentHTML("beforeend", `<div class="fake-app"><div class="composer-card">
    <button class="composer-send" aria-label="Send" data-state="send"><svg><path d="M1 1"/></svg></button></div></div>`);
  return store;
}

const release = (el: Element) => {
  under = el;
  el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
};
const toastText = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" | ");
const hint = () => document.querySelector<HTMLElement>(".app-picker-hint");

describe("Select in Realm", () => {
  it("puts the picker up for the session a pick would go to, and says how to get out", async () => {
    const store = mount();
    act(() => startAppPick(store));
    expect(store.getState().appPick).toEqual({ sessionId: "se1" });
    expect(hint()).toHaveTextContent("Click a part of Realm·Esc to cancel");
    // Heard as well as seen: the way out is what a screen reader is told.
    expect(hint()).toHaveAttribute("role", "status");
    expect(calls).toEqual(["arm"]);
  });

  it("lands the pick in the prompter as a chip, with its picture beside it", async () => {
    const store = mount();
    act(() => startAppPick(store));
    act(() => release(document.querySelector(".composer-send path")!));
    await waitFor(() => expect(store.getState().drafts.se1).toBe("@[Realm · Send button] "));
    const [chip] = store.getState().draftElements.se1!;
    expect(chip!.element).toMatchObject({ role: "button", name: "Send", selector: "button.composer-send", app: { shot: SHOT.path, webView: false, hooks: ['data-state="send" on button.composer-send'] } });
    expect(store.getState().pendingAttachments.se1).toEqual([SHOT]);
    expect(toastText()).toContain("Added Realm · Send button to Fix the parser.");
    // Main hears the pick is over only once its picture is taken — and the picker is put away.
    expect(calls).toEqual(["arm", "capture realm-send-button.png", "disarm"]);
    expect(store.getState().appPick).toBeNull();
    await waitFor(() => expect(hint()).toBeNull());
  });

  it("says in the chip when there is no picture, and attaches none", async () => {
    answer = { file: null, webView: true };
    const store = mount();
    act(() => startAppPick(store));
    act(() => release(document.querySelector(".composer-send")!));
    await waitFor(() => expect(store.getState().drafts.se1).toBe("@[Realm · Send button (no picture)] "));
    expect(store.getState().draftElements.se1![0]!.element).toMatchObject({ app: { shot: null, webView: true } });
    expect(store.getState().pendingAttachments.se1 ?? []).toEqual([]);
  });

  it("is put away by Escape with nothing added, and by the chord a second time", async () => {
    const store = mount();
    act(() => startAppPick(store));
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(store.getState().appPick).toBeNull();
    expect(store.getState().drafts.se1 ?? "").toBe("");
    expect(calls).toEqual(["arm", "disarm"]);
    act(() => startAppPick(store));
    act(() => startAppPick(store));
    expect(store.getState().appPick).toBeNull();
    expect(document.querySelector(".app-picker")).toBeNull();
    expect(calls).toEqual(["arm", "disarm", "arm", "disarm"]);
  });

  it("will not start while an agent is driving the window — a pick begun then would be the agent's", () => {
    // THE MUTANT: drop the check. An agent that focused the + menu's row could press Return on it.
    const store = mount();
    document.body.insertAdjacentHTML("beforeend", '<div data-realm-agent-highlight="frame"></div>');
    act(() => startAppPick(store, "se1"));
    expect(store.getState().appPick).toBeNull();
    expect(calls).toEqual([]);
    expect(toastText()).toContain("An agent is driving Realm's window");
  });

  it("with no session open, says there is nothing to send it to rather than aiming at nothing", () => {
    const store = mount({ withSession: false });
    act(() => startAppPick(store));
    expect(store.getState().appPick).toBeNull();
    expect(toastText()).toContain("Nothing to send a part of Realm to");
  });

  it("keeps the web picker in every page on screen, and a pick there lands in the same prompter", async () => {
    let settle: (el: BrowserPickedElement | null) => void = () => {};
    const picked: string[] = [];
    setBrowserBridgesForTests(fakeBrowserBridges({ host: {
      pickElement: (id) => { picked.push(`pick ${id}`); return new Promise((r) => { settle = r; }); },
      cancelPick: async (id) => { picked.push(`cancel ${id}`); },
    } }));
    const store = mount({ browser: true });
    act(() => startAppPick(store));
    expect(picked).toEqual(["pick b1"]);
    const page: BrowserPickedElement = { ref: 9, url: "https://example.com/login", title: "Sign in", rect: { x: 0, y: 0, w: 10, h: 10 },
      selector: "#submit", tag: "button", role: "button", name: "Sign in", text: "Sign in", html: "<button>Sign in</button>" };
    await act(async () => { settle(page); });
    expect(store.getState().drafts.se1).toBe('@[button "Sign in"] ');
    expect(store.getState().appPick).toBeNull();
    expect(document.querySelector(".app-picker")).toBeNull();
  });

  it("takes the pages' pickers down when the pick lands in Realm's own window", async () => {
    const picked: string[] = [];
    setBrowserBridgesForTests(fakeBrowserBridges({ host: {
      pickElement: (id) => { picked.push(`pick ${id}`); return new Promise(() => {}); },
      cancelPick: async (id) => { picked.push(`cancel ${id}`); },
    } }));
    const store = mount({ browser: true });
    act(() => startAppPick(store));
    act(() => release(document.querySelector(".composer-send")!));
    await waitFor(() => expect(store.getState().drafts.se1).toBe("@[Realm · Send button] "));
    expect(picked).toEqual(["pick b1", "cancel b1"]);
  });
});

describe("the hint", () => {
  it("stands over the part of the window no browser view covers", () => {
    const store = mount({ browser: true });
    act(() => startAppPick(store));
    // The view takes the right half from x 700; the hint centres on what is left of the 1024px window.
    expect(hint()!.style.left).toBe("350px");
  });

  it("is the picker's own chrome, which nothing picks", () => {
    const store = mount();
    act(() => startAppPick(store));
    act(() => release(hint()!));
    expect(store.getState().appPick).toEqual({ sessionId: "se1" });
  });
});
