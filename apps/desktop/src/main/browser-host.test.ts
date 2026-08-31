import { describe, expect, it, vi } from "vitest";
import {
  BrowserPaneHost, normalizeAddress, originAllowed, toViewBounds,
  type BrowserViewState, type ViewHandle, type ViewHooks,
} from "./browser-host";

describe("normalizeAddress", () => {
  it("keeps http(s) URLs and about:blank as-is", () => {
    expect(normalizeAddress("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(normalizeAddress("http://example.com")).toBe("http://example.com");
    expect(normalizeAddress("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(normalizeAddress("about:blank")).toBe("about:blank");
  });
  it("prefixes https:// onto anything else — a non-URL fails honestly downstream", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeAddress("not a url")).toBe("https://not a url");
    // A scheme-shaped input is NOT honored: file:/javascript: never reach loadURL as themselves.
    expect(normalizeAddress("javascript:alert(1)")).toBe("https://javascript:alert(1)");
    expect(normalizeAddress("file:///etc/passwd")).toBe("https://file:///etc/passwd");
  });
  it("loopback hosts get http:// (dev servers do not speak TLS)", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("localhost")).toBe("http://localhost");
    expect(normalizeAddress("127.0.0.1:8787/health")).toBe("http://127.0.0.1:8787/health");
    expect(normalizeAddress("[::1]:3000")).toBe("http://[::1]:3000");
    // ...but a host merely containing "localhost" does not.
    expect(normalizeAddress("localhost.evil.com")).toBe("https://localhost.evil.com");
  });
  it("empty and whitespace-only input is nothing to load", () => {
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress(" example.com ")).toBe("https://example.com");
  });
});

describe("originAllowed", () => {
  it("null list = allow everything (W1 default posture)", () => {
    expect(originAllowed("https://anything.example", null)).toBe(true);
    expect(originAllowed("data:text/html,hi", null)).toBe(true);
  });
  it("a present list allows exactly its origins", () => {
    const list = ["https://example.com", "docs.example.org"];
    expect(originAllowed("https://example.com/deep/path", list)).toBe(true);
    expect(originAllowed("https://docs.example.org", list)).toBe(true); // bare entry = https origin
    expect(originAllowed("https://evil.com", list)).toBe(false);
    expect(originAllowed("https://sub.example.com", list)).toBe(false); // exact origin, no subdomain grant
    expect(originAllowed("http://example.com", list)).toBe(false); // scheme is part of the origin
    expect(originAllowed("https://example.com:8443", list)).toBe(false); // port too
  });
  it("about:blank is always allowed; opaque and unparseable URLs never match a list", () => {
    expect(originAllowed("about:blank", [])).toBe(true);
    expect(originAllowed("data:text/html,hi", ["https://example.com"])).toBe(false);
    expect(originAllowed("not a url", ["https://example.com"])).toBe(false);
  });
  it("junk entries are skipped, not crashed on", () => {
    expect(originAllowed("https://example.com", ["", "   ", "%%%", "https://example.com"])).toBe(true);
    expect(originAllowed("https://example.com", ["%%%"])).toBe(false);
  });
});

describe("toViewBounds", () => {
  it("passes through unchanged when dpr equals the display scale (no app zoom)", () => {
    expect(toViewBounds({ x: 10, y: 20, width: 300, height: 200 }, 2, 2)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(toViewBounds({ x: 10, y: 20, width: 300, height: 200 }, 1, 1)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });
  it("scales by the zoom factor (dpr / scaleFactor) and rounds", () => {
    // App zoomed to 150% on a 2x display: dpr = 3, scale = 2.
    expect(toViewBounds({ x: 100, y: 50, width: 201, height: 99 }, 3, 2)).toEqual({ x: 150, y: 75, width: 302, height: 149 });
  });
  it("clamps negative sizes and survives zero/garbage factors", () => {
    expect(toViewBounds({ x: 0, y: 0, width: -5, height: -1 }, 2, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(toViewBounds({ x: 1, y: 2, width: 3, height: 4 }, 0, 0)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

/** A fake ViewHandle that records calls and simulates the webContents state getters. */
function fakeView() {
  const nav = { url: "", title: "", loading: false, back: false, forward: false };
  const calls: string[] = [];
  let hooks: ViewHooks | null = null;
  const handle: ViewHandle = {
    setBounds: (r) => calls.push(`bounds:${r.x},${r.y},${r.width},${r.height}`),
    setVisible: (v) => calls.push(`visible:${v}`),
    loadURL: (url) => { calls.push(`load:${url}`); nav.url = url; nav.loading = true; hooks?.emitState(); },
    goBack: () => calls.push("back"), goForward: () => calls.push("forward"),
    reload: () => calls.push("reload"), stop: () => calls.push("stop"),
    canGoBack: () => nav.back, canGoForward: () => nav.forward,
    getURL: () => nav.url, getTitle: () => nav.title, isLoading: () => nav.loading,
    destroy: () => calls.push("destroy"),
  };
  return { handle, calls, nav, setHooks: (h: ViewHooks) => { hooks = h; }, getHooks: () => hooks! };
}

function makeHost(scaleFactor = 2) {
  const views = new Map<string, ReturnType<typeof fakeView>>();
  const states: BrowserViewState[] = [];
  const factory = vi.fn((id: string, hooks: ViewHooks) => {
    const v = fakeView(); v.setHooks(hooks); views.set(id, v); return v.handle;
  });
  const host = new BrowserPaneHost({ createView: factory, sendState: (s) => states.push(s), scaleFactor: () => scaleFactor });
  return { host, views, states, factory };
}

describe("BrowserPaneHost", () => {
  it("create loads the (normalized) url and emits initial state; create is idempotent", () => {
    const { host, views, states, factory } = makeHost();
    host.create("b1", "example.com", null);
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com", loading: true });
    host.create("b1", "https://other.example", null); // StrictMode remount: no reload, state re-emitted
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
    expect(states.at(-1)!.id).toBe("b1");
  });

  it("create with an empty url loads nothing (the pane's empty state, not about:blank)", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("navigate normalizes, consults the allowlist, and reports what it did", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"]);
    expect(host.navigate("b1", "example.com")).toBe("https://example.com");
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(host.navigate("b1", "evil.com")).toBeNull();
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com");
    expect(host.navigate("b1", "   ")).toBeNull();
    expect(host.navigate("nope", "example.com")).toBeNull(); // unknown id: refused, not thrown
  });

  it("create refuses to load a persisted url the allowlist no longer permits", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://evil.com", ["https://example.com"]);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("the will-navigate consult reads the CURRENT allowlist, and setAllowlist swaps it live", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    const hooks = views.get("b1")!.getHooks();
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(true); // null = allow-all
    host.setAllowlist("b1", ["https://example.com"]);
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(false);
    expect(hooks.allowNavigate("https://example.com/x")).toBe(true);
  });

  it("a window.open funnels into an in-place navigation of the SAME view, allowlist included", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"]);
    const hooks = views.get("b1")!.getHooks();
    hooks.openInPlace("https://example.com/popup");
    expect(views.get("b1")!.calls).toContain("load:https://example.com/popup");
    hooks.openInPlace("https://evil.com/popup");
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com/popup");
  });

  it("setBounds converts css px → DIP with the renderer's dpr and applies visibility", () => {
    const { host, views } = makeHost(2);
    host.create("b1", "", null);
    host.setBounds("b1", { x: 100, y: 50, width: 200, height: 100 }, 2, true); // dpr==scale → passthrough
    expect(views.get("b1")!.calls).toContain("bounds:100,50,200,100");
    expect(views.get("b1")!.calls).toContain("visible:true");
    host.setBounds("b1", { x: 100, y: 50, width: 200, height: 100 }, 3, false); // zoomed 1.5x
    expect(views.get("b1")!.calls).toContain("bounds:150,75,300,150");
    expect(views.get("b1")!.calls.at(-1)).toBe("visible:false");
  });

  it("navAction routes back/forward/reload/stop; unknown ids are ignored", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    for (const a of ["back", "forward", "reload", "stop"] as const) host.navAction("b1", a);
    expect(views.get("b1")!.calls).toEqual(expect.arrayContaining(["back", "forward", "reload", "stop"]));
    expect(() => host.navAction("nope", "back")).not.toThrow();
  });

  it("destroy is final: the view is torn down and every later call is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    host.destroy("b1");
    expect(views.get("b1")!.calls).toContain("destroy");
    expect(host.has("b1")).toBe(false);
    host.navigate("b1", "example.com");
    host.setBounds("b1", { x: 0, y: 0, width: 1, height: 1 }, 1, true);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
    host.destroy("b1"); // idempotent
    expect(views.get("b1")!.calls.filter((c) => c === "destroy")).toHaveLength(1);
  });

  it("destroyAll tears down every view (window teardown)", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    host.create("b2", "", null);
    host.destroyAll();
    expect(views.get("b1")!.calls).toContain("destroy");
    expect(views.get("b2")!.calls).toContain("destroy");
    expect(host.has("b1")).toBe(false);
    expect(host.has("b2")).toBe(false);
  });

  it("state events carry the id of THEIR view, not the last-created one", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "", null);
    host.create("b2", "", null);
    views.get("b1")!.nav.title = "Page one";
    views.get("b1")!.getHooks().emitState();
    const last = states.at(-1)!;
    expect(last.id).toBe("b1");
    expect(last.title).toBe("Page one");
  });
});
