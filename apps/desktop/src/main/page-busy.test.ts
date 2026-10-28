// @vitest-environment jsdom
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
  it("marks a view typed into, keeps it through an in-page step, and forgets it on a new document", () => {
    const t = new TypedSince();
    t.input("b", { type: "keyDown", key: "Shift" });
    t.input("b", { type: "keyUp", key: "4" });
    expect(t.has("b")).toBe(false);
    t.input("b", { type: "keyDown", key: "4" });
    expect(t.has("b")).toBe(true);
    expect(t.has("other")).toBe(false);
    t.navigated("b");
    expect(t.has("b")).toBe(false);
    t.input("b", { type: "keyDown", key: "Enter" });
    t.forget("b");
    expect(t.has("b")).toBe(false);
  });
});
