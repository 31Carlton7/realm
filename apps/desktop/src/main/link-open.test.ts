import { describe, expect, it } from "vitest";
import { SYSTEM_BROWSER_FRAME } from "@realm/contracts";
import { heldCommand, linkTarget, windowOpenTarget } from "./link-open";

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
    expect(heldCommand("background-tab")).toBe(true);
    expect(heldCommand("foreground-tab")).toBe(false);
    expect(heldCommand("new-window")).toBe(false);
    expect(heldCommand("default")).toBe(false);
  });
});

describe("a window request from a Realm window", () => {
  it("is a link click, routed by the setting and ⌘", () => {
    expect(windowOpenTarget({ url: "https://a.co", disposition: "foreground-tab", frameName: "" }, "realm")).toBe("realm");
    expect(windowOpenTarget({ url: "https://a.co", disposition: "background-tab", frameName: "" }, "realm")).toBe("default");
    expect(windowOpenTarget({ url: "mailto:a@b.co", disposition: "foreground-tab", frameName: "" }, "realm")).toBeNull();
  });

  it("opens a sign-in named for the system browser there, whatever the setting", () => {
    expect(windowOpenTarget({ url: "https://auth.example/authorize", disposition: "foreground-tab", frameName: SYSTEM_BROWSER_FRAME }, "realm")).toBe("default");
    expect(windowOpenTarget({ url: "https://auth.example/authorize", disposition: "background-tab", frameName: SYSTEM_BROWSER_FRAME }, "default")).toBe("default");
  });
});
