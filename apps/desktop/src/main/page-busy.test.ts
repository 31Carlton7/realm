// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_BUSY, TypedSince } from "./page-busy";

/**
 * What keeps a hidden page from being discarded. What must die: a page whose sign-in lives in its
 * sessionStorage given up and brought back signed out, and a half-filled React form — whose fields read
 * clean, `defaultValue` kept in step with `value` — thrown away because nobody looked at the keyboard.
 */

const busy = (): unknown => (0, eval)(PAGE_BUSY);

afterEach(() => { document.body.innerHTML = ""; sessionStorage.clear(); });

describe("what the page says", () => {
  it("is nothing for a page at rest", () => {
    document.body.innerHTML = `<input value="as loaded">`;
    expect(busy()).toBeNull();
  });

  it("is input for a field changed since the page loaded it", () => {
    document.body.innerHTML = `<input value="as loaded">`;
    document.querySelector("input")!.value = "typed";
    expect(busy()).toBe("form");
  });

  it("is a session for anything in sessionStorage, which a page brought back starts without", () => {
    sessionStorage.setItem("msal.token.keys", "[\"a\"]");
    expect(busy()).toBe("session");
  });

  it("cannot see a React field typed into — which is what TypedSince is for", () => {
    document.body.innerHTML = `<input value="">`;
    const input = document.querySelector("input")!;
    // react-dom keeps the default in step with the value as it renders.
    input.value = "4111 1111"; input.defaultValue = "4111 1111";
    expect(busy()).toBeNull();
  });
});

describe("what the keyboard says", () => {
  /** A page as main sees it: its webContents' keyboard and navigation. */
  const page = () => {
    const page = new EventEmitter();
    return {
      on: page.on.bind(page),
      key: (key: string, type = "keyDown") => page.emit("before-input-event", {}, { type, key }),
      navigate: () => page.emit("did-navigate"),
    };
  };

  it("marks a page typed into, keeps it through an in-page step, and forgets it on a new document", () => {
    const t = new TypedSince<ReturnType<typeof page>>();
    const b = page();
    t.show("b", b);
    b.key("Shift");
    b.key("4", "keyUp");
    expect(t.has("b")).toBe(false);
    b.key("4");
    expect(t.has("b")).toBe(true);
    expect(t.has("other")).toBe(false);
    b.navigate();
    expect(t.has("b")).toBe(false);
    // An agent's typing is told rather than heard, and goes the same way.
    t.mark("b");
    expect(t.has("b")).toBe(true);
    b.navigate();
    expect(t.has("b")).toBe(false);
  });

  it("is nothing for a browser it no longer shows", () => {
    const t = new TypedSince<ReturnType<typeof page>>();
    const b = page();
    t.show("b", b);
    b.key("4");
    t.forget("b");
    expect(t.has("b")).toBe(false);
    t.mark("b");
    expect(t.has("b")).toBe(false);
  });

  // A page shown in place of its opener (`adoptInPlace`) leaves the opener parked and running behind it.
  it("keeps the page in front typed into when the opener behind it navigates", () => {
    const t = new TypedSince<ReturnType<typeof page>>();
    const opener = page(), front = page();
    t.show("b", opener);
    t.show("b", front);
    front.key("4");
    expect(t.has("b")).toBe(true);
    opener.navigate();
    expect(t.has("b")).toBe(true);
  });

  it("gives an opener back its mark when it is uncovered, and only until its own next document", () => {
    const t = new TypedSince<ReturnType<typeof page>>();
    const opener = page(), front = page();
    t.show("b", opener);
    opener.key("4");
    t.show("b", front);
    expect(t.has("b")).toBe(false);
    t.show("b", opener);
    expect(t.has("b")).toBe(true);
    t.show("b", front);
    opener.navigate();
    t.show("b", opener);
    expect(t.has("b")).toBe(false);
  });
});
