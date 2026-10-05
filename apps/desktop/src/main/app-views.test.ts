import { describe, expect, it } from "vitest";
import { fromAppView, viewNavigationAllowed } from "./app-views";

const VIEW = "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234/v/tok";

describe("a view's frame", () => {
  it("may reload itself, and go nowhere else", () => {
    expect(viewNavigationAllowed(VIEW, VIEW)).toBe(true);
    expect(viewNavigationAllowed(VIEW, "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234/v/tok?again=1")).toBe(true);
    // THE MUTANT: let a view's frame follow its own navigation, and it can show any site inside the
    // window, a fake Realm sign-in among them, or step onto another of Realm's loopback listeners.
    for (const target of ["https://phish.example/login", "http://127.0.0.1:8809/", "http://aaaaaaaaaaaaaaaa.mcp-view.localhost:51234/v/other",
      "http://3f9a1c2b4d5e6f70.mcp-view.localhost:9/v/tok", "file:///etc/passwd", "not a url"]) {
      expect(viewNavigationAllowed(VIEW, target), target).toBe(false);
    }
  });

  it("is the only frame the rule touches — a guide, a PDF, the frame's first load are left alone", () => {
    expect(viewNavigationAllowed("http://127.0.0.1:50000/p/tok/doc/guide.html", "https://example.com/")).toBe(true);
    expect(viewNavigationAllowed("", VIEW)).toBe(true);
    expect(viewNavigationAllowed("about:blank", VIEW)).toBe(true);
  });

  it("asks for nothing it is given", () => {
    expect(fromAppView(VIEW)).toBe(true);
    expect(fromAppView("http://127.0.0.1:50000/p/tok/doc/guide.html")).toBe(false);
    expect(fromAppView("file:///Applications/Realm.app/Contents/Resources/app/out/renderer/index.html")).toBe(false);
    expect(fromAppView(undefined)).toBe(false);
  });
});
