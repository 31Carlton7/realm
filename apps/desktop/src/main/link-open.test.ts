import { describe, expect, it } from "vitest";
import { SYSTEM_BROWSER_FRAME } from "@realm/contracts";
import { heldCommand, lastPress, linkTarget, windowOpenTarget } from "./link-open";

describe("where a clicked link opens", () => {
  it("follows the setting on a plain click", () => {
    expect(linkTarget("https://realm.computer", "default", false)).toBe("default");
    expect(linkTarget("http://localhost:5173/x", "realm", false)).toBe("realm");
  });

  it("opens in the other one on a ⌘-click", () => {
    expect(linkTarget("https://realm.computer", "default", true)).toBe("realm");
    expect(linkTarget("https://realm.computer", "realm", true)).toBe("default");
  });

  it("routes only web links", () => {
    for (const url of ["mailto:a@b.co", "file:///tmp/x", "vscode://file/x", "javascript:alert(1)", ""]) {
      expect(linkTarget(url, "realm", false)).toBeNull();
      expect(linkTarget(url, "default", true)).toBeNull();
    }
  });

  it("reads ⌘ from the disposition Chromium gives the click", () => {
    expect(heldCommand("background-tab", "other")).toBe(true);
    expect(heldCommand("foreground-tab", "other")).toBe(false);
    expect(heldCommand("new-window", "other")).toBe(false);
    expect(heldCommand("default", "other")).toBe(false);
  });

  it("never reads a middle-click as ⌘, though Chromium gives it the same background tab", () => {
    // THE MUTANT: heldCommand by the disposition alone (its old body), and a middle-click flips the setting.
    expect(heldCommand("background-tab", "middle")).toBe(false);
  });
});

describe("the last press in a Realm window", () => {
  it("is the middle button only when the middle button went down", () => {
    expect(lastPress({ type: "mouseDown", button: "middle" }, "other")).toBe("middle");
    expect(lastPress({ type: "mouseDown", button: "left" }, "middle")).toBe("other");
    expect(lastPress({ type: "mouseDown", button: "right" }, "middle")).toBe("other");
  });

  it("is a key once one is pressed — ⌘-Return on a focused link after a middle-click is still ⌘", () => {
    // THE MUTANT: hear only the mouse, and that ⌘-Return opens like the middle-click before it.
    expect(lastPress({ type: "rawKeyDown" }, "middle")).toBe("other");
    expect(lastPress({ type: "keyDown" }, "middle")).toBe("other");
  });

  it("is left alone by what presses nothing", () => {
    for (const type of ["mouseMove", "mouseUp", "mouseWheel", "keyUp", "char"]) expect(lastPress({ type, button: "left" }, "middle")).toBe("middle");
  });
});

describe("a window request from a Realm window", () => {
  const link = (disposition: string, frameName = "") => ({ url: "https://a.co", disposition, frameName });

  it("is a link click, routed by the setting and ⌘, in front", () => {
    expect(windowOpenTarget(link("foreground-tab"), "realm", "other")).toEqual({ to: "realm", background: false });
    expect(windowOpenTarget(link("background-tab"), "realm", "other")).toEqual({ to: "default", background: false });
    expect(windowOpenTarget(link("background-tab"), "default", "other")).toEqual({ to: "realm", background: false });
    expect(windowOpenTarget({ url: "mailto:a@b.co", disposition: "foreground-tab", frameName: "" }, "realm", "other")).toBeNull();
  });

  it("middle-clicked, follows the setting like a plain click, and in Realm opens behind", () => {
    // The product call on #537: a middle-click is never ⌘. THE MUTANT: leave `background` false, and the
    // tab comes to the front with the keyboard, as a click's does.
    expect(windowOpenTarget(link("background-tab"), "realm", "middle")).toEqual({ to: "realm", background: true });
    expect(windowOpenTarget(link("background-tab"), "default", "middle")).toEqual({ to: "default", background: true });
  });

  it("opens a sign-in named for the system browser there, whatever the setting", () => {
    expect(windowOpenTarget({ url: "https://auth.example/authorize", disposition: "foreground-tab", frameName: SYSTEM_BROWSER_FRAME }, "realm", "other")).toEqual({ to: "default", background: false });
    expect(windowOpenTarget({ url: "https://auth.example/authorize", disposition: "background-tab", frameName: SYSTEM_BROWSER_FRAME }, "default", "middle")).toEqual({ to: "default", background: false });
  });
});
