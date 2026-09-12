import { describe, expect, it, vi } from "vitest";
import {
  BrowserPaneHost, RETAINED_VIEW_LIMIT, normalizeAddress, originAllowed, toViewBounds,
  type BrowserViewState, type ViewHandle, type ViewHooks,
} from "./browser-host";

describe("normalizeAddress", () => {
  it("keeps http(s) URLs and about:blank as-is", () => {
    expect(normalizeAddress("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(normalizeAddress("http://example.com")).toBe("http://example.com");
    expect(normalizeAddress("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(normalizeAddress("about:blank")).toBe("about:blank");
  });
  it("prefixes https:// onto host-shaped input", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeAddress("example.com:8443/x")).toBe("https://example.com:8443/x");
    expect(normalizeAddress("sub.example.co.uk")).toBe("https://sub.example.co.uk");
    expect(normalizeAddress("192.168.1.5:8080")).toBe("https://192.168.1.5:8080");
    expect(normalizeAddress("münchen.de")).toBe("https://münchen.de");
  });
  it("sends anything that is not host-shaped to the search engine", () => {
    expect(normalizeAddress("not a url")).toBe("https://www.google.com/search?q=not%20a%20url");
    expect(normalizeAddress("realm")).toBe("https://www.google.com/search?q=realm");
    expect(normalizeAddress("3.14")).toBe("https://www.google.com/search?q=3.14");
    expect(normalizeAddress("what is a WebContentsView?")).toBe(
      "https://www.google.com/search?q=what%20is%20a%20WebContentsView%3F",
    );
    // A scheme-shaped input is NOT honored: file:/javascript: never reach loadURL as themselves,
    // and no longer get https:// glued on to fail — they are searched like any other words.
    expect(normalizeAddress("javascript:alert(1)")).toBe("https://www.google.com/search?q=javascript%3Aalert(1)");
    expect(normalizeAddress("file:///etc/passwd")).toBe("https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd");
  });
  it("loopback hosts get http:// (dev servers do not speak TLS)", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("localhost")).toBe("http://localhost");
    expect(normalizeAddress("127.0.0.1:8787/health")).toBe("http://127.0.0.1:8787/health");
    expect(normalizeAddress("[::1]:3000")).toBe("http://[::1]:3000");
    // ...but a host merely containing "localhost" does not.
    expect(normalizeAddress("localhost.evil.com")).toBe("https://localhost.evil.com");
    // A bare non-loopback word is a search, not an intranet guess.
    expect(normalizeAddress("myserver")).toBe("https://www.google.com/search?q=myserver");
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
  it("scales by the zoom factor (dpr / scaleFactor) and insets to the grid", () => {
    // App zoomed to 150% on a 2x display: dpr = 3, scale = 2. The box is x 150 → 451.5, y 75 → 223.5.
    // This used to answer width 302 — a right edge at 452, half a pixel PAST the placeholder and
    // therefore over the divider beside it, which a WebContentsView paints on top of. 301 is the
    // last whole pixel still inside the box.
    expect(toViewBounds({ x: 100, y: 50, width: 201, height: 99 }, 3, 2)).toEqual({ x: 150, y: 75, width: 301, height: 148 });
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

const alive = (v: ReturnType<typeof fakeView>) => !v.calls.includes("destroy");
/** One more browser than the budget can retain, named v0 (oldest) upward. */
const overBudget = (host: BrowserPaneHost) => {
  const ids = Array.from({ length: RETAINED_VIEW_LIMIT + 1 }, (_, i) => `v${i}`);
  for (const id of ids) host.create(id, "example.com", null);
  return ids;
};

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

  it("never lets the native view paint outside its placeholder — the divider lives in that pixel", () => {
    /* A WebContentsView composites ABOVE the DOM unconditionally, so an edge that rounds OUTWARD
       covers whatever the renderer drew next door and cannot be drawn over in return. Next door is
       `.resize-handle`, the entire boundary between two panes.

       THE mutant: `Math.round` per edge, which is what this was. 1054.344 rounded to 1054 — a third
       of a pixel left of the pane, on top of the divider — and the reports were of dividers that
       vanish and come back when you nudge them, because nudging moves the edge to a fraction that
       rounds the other way. Three panes put edges on thirds and six on sixths, which is why even
       splits were where it bit. */
    const containment = (rect: { x: number; y: number; width: number; height: number }, dpr: number, scale: number) => {
      const b = toViewBounds(rect, dpr, scale);
      const k = dpr / scale;
      return { spillsNear: b.x < rect.x * k - 1e-9 || b.y < rect.y * k - 1e-9,
               spillsFar: b.x + b.width > (rect.x + rect.width) * k + 1e-9 || b.y + b.height > (rect.y + rect.height) * k + 1e-9 };
    };
    // The measured case, and a sweep of every fraction a split can produce (halves, thirds, sixths).
    for (const frac of [0, 1 / 6, 1 / 3, 0.344, 0.5, 2 / 3, 5 / 6, 0.999]) {
      for (const [dpr, scale] of [[1, 1], [2, 2], [3, 2], [2, 1]] as const) {
        const rect = { x: 1054 + frac, y: 40 + frac, width: 385 + frac, height: 300 + frac };
        const c = containment(rect, dpr, scale);
        expect(c.spillsNear, `near edge, frac ${frac} @${dpr}/${scale}`).toBe(false);
        expect(c.spillsFar, `far edge, frac ${frac} @${dpr}/${scale}`).toBe(false);
      }
    }
  });

  it("still fills the placeholder when it already sits on the pixel grid", () => {
    // Insetting must not cost a pixel in the ordinary case, or every browser pane grows a hairline
    // of pane ground down its edge. Whole numbers in, the same whole numbers out.
    expect(toViewBounds({ x: 100, y: 50, width: 200, height: 100 }, 2, 2)).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(toViewBounds({ x: 100, y: 50, width: 200, height: 100 }, 3, 2)).toEqual({ x: 150, y: 75, width: 300, height: 150 });
  });

  it("gives back an empty rect rather than a negative one when the layout is mid-flight", () => {
    // A collapsed or inverted placeholder must not reach setBounds as a negative size.
    expect(toViewBounds({ x: 10.7, y: 10.7, width: 0.2, height: 0.2 }, 1, 1)).toMatchObject({ width: 0, height: 0 });
    expect(toViewBounds({ x: 0, y: 0, width: -5, height: -5 }, 1, 1)).toMatchObject({ width: 0, height: 0 });
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

  it("destroyAll survives views the window already destroyed (the close-crash regression)", () => {
    // Electron destroys child views WITH the window before the "closed" listener fires; a handle that
    // throws "Object has been destroyed" on a second destroy is exactly what the real adapter guards.
    // The host-level contract: destroyAll never throws and still forgets every row.
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null);
    host.create("b2", "https://b.example", null);
    views.get("b1")!.handle.destroy = () => { throw new TypeError("Object has been destroyed"); };
    expect(() => host.destroyAll()).not.toThrow();
    expect(host.has("b1")).toBe(false);
    expect(host.has("b2")).toBe(false);
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

/**
 * Retention: what a pane unmounting means. Switching space or pane group swaps the whole rendered
 * tree, so unmount is not the user closing anything — the view has to outlive it.
 */
describe("BrowserPaneHost retention", () => {
  it("retain keeps the view alive and hides it — a space switch must not close the browser", () => {
    const { host, views } = makeHost();
    host.create("b1", "example.com", null);
    host.retain("b1");
    expect(views.get("b1")!.calls).not.toContain("destroy");
    expect(host.has("b1")).toBe(true);
    // Main hides it itself: the renderer's per-frame bounds sync, which normally carries the
    // visibility verdict, stopped with the pane.
    expect(views.get("b1")!.calls.at(-1)).toBe("visible:false");
  });

  it("returning to the space re-adopts the SAME view instead of reloading it", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "example.com", null);
    host.retain("b1");
    host.create("b1", "example.com", null); // the pane remounts in its space
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
  });

  it("a re-adopted view leaves the off-screen budget", () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    host.retain(ids[0]!);
    host.create(ids[0]!, "example.com", null); // the user came back to its space
    for (const id of ids.slice(1)) host.retain(id); // exactly the budget, so nothing is evicted
    for (const id of ids) expect(alive(views.get(id)!)).toBe(true);
  });

  it("past the off-screen budget the LEAST recently retained view is destroyed", () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    for (const id of ids) host.retain(id);
    expect(alive(views.get(ids[0]!)!)).toBe(false); // oldest off-screen page pays
    expect(host.has(ids[0]!)).toBe(false);
    for (const id of ids.slice(1)) expect(alive(views.get(id)!)).toBe(true);
  });

  it("touch spares a background view an agent is still driving", () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    for (const id of ids.slice(0, RETAINED_VIEW_LIMIT)) host.retain(id);
    host.touch(ids[0]!); // an agent op reached it while its space was off screen
    host.retain(ids[RETAINED_VIEW_LIMIT]!);
    expect(alive(views.get(ids[0]!)!)).toBe(true);
    expect(alive(views.get(ids[1]!)!)).toBe(false); // the next-oldest pays instead
  });

  it("touch never makes an on-screen view evictable", () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    host.touch(ids[0]!); // still mounted, never retained
    for (const id of ids.slice(1)) host.retain(id); // exactly the budget
    for (const id of ids) expect(alive(views.get(id)!)).toBe(true);
  });

  it("retain on an unknown id is refused, not thrown", () => {
    const { host } = makeHost();
    expect(() => host.retain("nope")).not.toThrow();
    expect(() => host.touch("nope")).not.toThrow();
  });

  it("destroyAll still takes retained views — they must never outlive the window", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null);
    host.retain("b1");
    host.destroyAll();
    expect(alive(views.get("b1")!)).toBe(false);
    expect(host.has("b1")).toBe(false);
  });
});
