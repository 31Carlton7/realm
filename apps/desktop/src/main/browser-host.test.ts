import { describe, expect, it, vi } from "vitest";
import { FAVICON_MAX_BYTES, isFaviconDataUrl } from "@realm/contracts";
import {
  BrowserPaneHost, DEVICE_PRESETS, FAVICON_TRIES, RETAINED_VIEW_LIMIT, ZOOM_FACTORS, browserUserAgent, createFaviconResolver, dataUrlBytes, deviceFit, faviconDataUrl,
  isFindShortcut, nextZoomFactor, normalizeAddress, originAllowed, rankFavicons, readCapped, shownPage, sniffImage, toViewBounds, zoomPercent,
  type DeviceMetrics,
  type BrowserViewState, type FindResult, type ViewHandle, type ViewHooks,
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

/** The cookie jar every test below makes its views in, unless it says otherwise. */
const P = "persist:browser";

/** A fake ViewHandle that records calls and simulates the webContents state getters. */
function fakeView() {
  const nav = { url: "", title: "", loading: false, back: false, forward: false,
    entries: [] as { url: string; title: string }[], activeIndex: 0, zoom: 1, favicon: null as string | null };
  const calls: string[] = [];
  let hooks: ViewHooks | null = null;
  const handle: ViewHandle = {
    setBounds: (r) => calls.push(`bounds:${r.x},${r.y},${r.width},${r.height}`),
    setVisible: (v) => calls.push(`visible:${v}`),
    loadURL: (url) => { calls.push(`load:${url}`); nav.url = url; nav.loading = true; hooks?.emitState(); },
    goBack: () => calls.push("back"), goForward: () => calls.push("forward"),
    reload: () => calls.push("reload"), stop: () => calls.push("stop"),
    canGoBack: () => nav.back, canGoForward: () => nav.forward,
    getURL: () => nav.url, getTitle: () => nav.title, isLoading: () => nav.loading, getFavicon: () => nav.favicon,
    history: () => ({ entries: nav.entries, activeIndex: nav.activeIndex }),
    goToIndex: (i) => calls.push(`goToIndex:${i}`),
    findInPage: (text, o) => calls.push(`find:${text}:${o.forward ? "forward" : "backward"}:${o.findNext ? "new" : "step"}`),
    stopFindInPage: () => calls.push("stop-find"),
    getZoomFactor: () => nav.zoom,
    setZoomFactor: (f) => { calls.push(`zoom:${f}`); nav.zoom = f; },
    print: () => calls.push("print"),
    destroy: () => calls.push("destroy"),
  };
  return { handle, calls, nav, setHooks: (h: ViewHooks) => { hooks = h; }, getHooks: () => hooks! };
}

function makeHost(scaleFactor = 2) {
  const views = new Map<string, ReturnType<typeof fakeView>>();
  const states: BrowserViewState[] = [];
  const found: (FindResult & { id: string })[] = [];
  const findRequests: string[] = [];
  const emulations: { id: string; metrics: DeviceMetrics | null }[] = [];
  const factory = vi.fn((id: string, hooks: ViewHooks, _partition: string) => {
    const v = fakeView(); v.setHooks(hooks); views.set(id, v); return v.handle;
  });
  const host = new BrowserPaneHost({
    createView: factory, sendState: (s) => states.push(s), scaleFactor: () => scaleFactor,
    sendFound: (m) => found.push(m), requestFind: (id) => findRequests.push(id),
    emulate: (id, metrics) => emulations.push({ id, metrics }),
  });
  return { host, views, states, factory, found, findRequests, emulations };
}

const alive = (v: ReturnType<typeof fakeView>) => !v.calls.includes("destroy");
/** One more browser than the budget can retain, named v0 (oldest) upward. */
const overBudget = (host: BrowserPaneHost) => {
  const ids = Array.from({ length: RETAINED_VIEW_LIMIT + 1 }, (_, i) => `v${i}`);
  for (const id of ids) host.create(id, "example.com", null, P);
  return ids;
};

describe("BrowserPaneHost", () => {
  it("create loads the (normalized) url and emits initial state; create is idempotent", () => {
    const { host, views, states, factory } = makeHost();
    host.create("b1", "example.com", null, P);
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com", loading: true });
    host.create("b1", "https://other.example", null, P); // StrictMode remount: no reload, state re-emitted
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
    expect(states.at(-1)!.id).toBe("b1");
  });

  it("splits the trail at where the view is standing, nearest first going back", () => {
    /* THE off-by-one mutant: include the active entry in either arm. Back would offer the page you
       are already on as its first row, and Forward would too — one of them a no-op wearing a title. */
    const { host, views } = makeHost();
    host.create("b1", "https://c.example", null, P);
    const v = views.get("b1")!;
    v.nav.entries = [
      { url: "https://a.example", title: "A" },
      { url: "https://b.example", title: "B" },
      { url: "https://c.example", title: "C" },
      { url: "https://d.example", title: "D" },
    ];
    v.nav.activeIndex = 2;
    // Nearest first: the page one press of Back away is the row nearest the button.
    expect(host.historyTrail("b1", "back")).toEqual([{ index: 1, label: "B" }, { index: 0, label: "A" }]);
    // Forward is walked in the order it would be walked.
    expect(host.historyTrail("b1", "forward")).toEqual([{ index: 3, label: "D" }]);
  });

  it("falls back to the url for a page that never set a title, and refuses both ends", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    const v = views.get("b1")!;
    v.nav.entries = [{ url: "https://a.example", title: "" }, { url: "https://b.example", title: "   " }];
    v.nav.activeIndex = 1;
    // A blank row in a menu is a row nobody can aim at.
    expect(host.historyTrail("b1", "back")).toEqual([{ index: 0, label: "https://a.example" }]);
    // Standing at the oldest entry there is nothing behind; at the newest, nothing ahead.
    v.nav.activeIndex = 0;
    expect(host.historyTrail("b1", "back")).toEqual([]);
    v.nav.activeIndex = 1;
    expect(host.historyTrail("b1", "forward")).toEqual([]);
    // A browser that is not open has no trail rather than throwing at the menu's call site.
    expect(host.historyTrail("nope", "back")).toEqual([]);
  });

  it("goToIndex reaches the view, and a missing one is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.goToIndex("b1", 3);
    expect(views.get("b1")!.calls).toContain("goToIndex:3");
    expect(() => host.goToIndex("nope", 1)).not.toThrow();
  });

  it("create with an empty url loads nothing (the pane's empty state, not about:blank)", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("navigate normalizes, consults the allowlist, and reports what it did", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    expect(host.navigate("b1", "example.com")).toBe("https://example.com");
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(host.navigate("b1", "evil.com")).toBeNull();
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com");
    expect(host.navigate("b1", "   ")).toBeNull();
    expect(host.navigate("nope", "example.com")).toBeNull(); // unknown id: refused, not thrown
  });

  it("create refuses to load a persisted url the allowlist no longer permits", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://evil.com", ["https://example.com"], P);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("the will-navigate consult reads the CURRENT allowlist, and setAllowlist swaps it live", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    const hooks = views.get("b1")!.getHooks();
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(true); // null = allow-all
    host.setAllowlist("b1", ["https://example.com"]);
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(false);
    expect(hooks.allowNavigate("https://example.com/x")).toBe(true);
  });

  it("a window.open funnels into an in-place navigation of the SAME view, allowlist included", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    const hooks = views.get("b1")!.getHooks();
    hooks.openInPlace("https://example.com/popup");
    expect(views.get("b1")!.calls).toContain("load:https://example.com/popup");
    hooks.openInPlace("https://evil.com/popup");
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com/popup");
  });

  it("setBounds converts css px → DIP with the renderer's dpr and applies visibility", () => {
    const { host, views } = makeHost(2);
    host.create("b1", "", null, P);
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
    host.create("b1", "", null, P);
    for (const a of ["back", "forward", "reload", "stop"] as const) host.navAction("b1", a);
    expect(views.get("b1")!.calls).toEqual(expect.arrayContaining(["back", "forward", "reload", "stop"]));
    expect(() => host.navAction("nope", "back")).not.toThrow();
  });

  it("destroy is final: the view is torn down and every later call is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
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
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    views.get("b1")!.handle.destroy = () => { throw new TypeError("Object has been destroyed"); };
    expect(() => host.destroyAll()).not.toThrow();
    expect(host.has("b1")).toBe(false);
    expect(host.has("b2")).toBe(false);
  });

  it("destroyAll tears down every view (window teardown)", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    host.create("b2", "", null, P);
    host.destroyAll();
    expect(views.get("b1")!.calls).toContain("destroy");
    expect(views.get("b2")!.calls).toContain("destroy");
    expect(host.has("b1")).toBe(false);
    expect(host.has("b2")).toBe(false);
  });

  it("state events carry the id of THEIR view, not the last-created one", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "", null, P);
    host.create("b2", "", null, P);
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
    host.create("b1", "example.com", null, P);
    host.retain("b1");
    expect(views.get("b1")!.calls).not.toContain("destroy");
    expect(host.has("b1")).toBe(true);
    // Main hides it itself: the renderer's per-frame bounds sync, which normally carries the
    // visibility verdict, stopped with the pane.
    expect(views.get("b1")!.calls.at(-1)).toBe("visible:false");
  });

  it("returning to the space re-adopts the SAME view instead of reloading it", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "example.com", null, P);
    host.retain("b1");
    host.create("b1", "example.com", null, P); // the pane remounts in its space
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
  });

  it("a re-adopted view leaves the off-screen budget", () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    host.retain(ids[0]!);
    host.create(ids[0]!, "example.com", null, P); // the user came back to its space
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
    host.create("b1", "", null, P);
    host.retain("b1");
    host.destroyAll();
    expect(alive(views.get("b1")!)).toBe(false);
    expect(host.has("b1")).toBe(false);
  });
});

/**
 * Plan 27 Phase 2: a view lives in its profile's cookie jar. What must die here: a view made in the
 * wrong jar, and a RETAINED view re-adopted into a pane that now wants another jar — its page would
 * show the second profile the first one's sign-ins.
 */
describe("BrowserPaneHost — a partition per profile", () => {
  const WORK = "persist:browser-pWork";

  it("makes the view in the partition it is asked for, and says which", () => {
    const { host, factory } = makeHost();
    host.create("b1", "example.com", null, WORK);
    expect(factory.mock.calls[0]![2]).toBe(WORK);
    expect(host.partitionOf("b1")).toBe(WORK);
    expect(host.partitionOf("nope")).toBeNull();
  });

  it("a retained view asked back for ANOTHER profile's jar is destroyed and made again there", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "https://mail.example", null, P);
    const first = views.get("b1")!;
    host.retain("b1");
    // The space moved to Work while the pane was off screen; the pane comes back wanting Work's jar.
    host.create("b1", "https://mail.example", null, WORK);
    expect(alive(first)).toBe(false);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![2]).toBe(WORK);
    expect(host.partitionOf("b1")).toBe(WORK);
    expect(views.get("b1")!.calls).toContain("load:https://mail.example");
  });

  it("the SAME jar still adopts the live view — no reload, which is what retaining is for", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "https://mail.example", null, WORK);
    host.retain("b1");
    host.create("b1", "https://mail.example", null, WORK);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(alive(views.get("b1")!)).toBe(true);
  });

  it("destroyPartition takes every view in one jar, retained or showing, and leaves the others", () => {
    const { host, views } = makeHost();
    host.create("w1", "", null, WORK);
    host.create("w2", "", null, WORK);
    host.retain("w2");
    host.create("p1", "", null, P);
    host.destroyPartition(WORK);
    expect(alive(views.get("w1")!)).toBe(false);
    expect(alive(views.get("w2")!)).toBe(false);
    expect(alive(views.get("p1")!)).toBe(true);
    expect(host.has("w2")).toBe(false);
  });
});

/**
 * The pane's user agent. What must die here: the Electron token surviving into a request (sites read
 * it and quietly serve a different page); the full Chrome build number surviving (real Chrome froze
 * those at zero, so keeping them is its own tell); and — the mutant that would be tempting — the
 * MAJOR being rewritten to something newer than the engine, which trades a nag today for a feature
 * the page may then use and the renderer cannot do.
 */
describe("browserUserAgent", () => {
  const E37 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36";

  it("takes the Electron token out and freezes the Chrome build, leaving a plain Chrome UA", () => {
    expect(browserUserAgent(E37)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    );
  });

  it("says nothing about Electron anywhere in the result", () => {
    expect(browserUserAgent(E37).toLowerCase()).not.toContain("electron");
  });

  it("keeps the ENGINE's own major — it never claims a Chrome the renderer is not", () => {
    // The whole reason this is not a spoof. A site told "152" may use what 152 has; this renderer
    // is 138, and the failure lands as a blank panel three clicks into a flow.
    expect(browserUserAgent(E37)).toContain("Chrome/138.");
    expect(browserUserAgent(E37)).not.toContain("Chrome/139");
  });

  it("leaves the platform and the Safari/AppleWebKit tokens exactly as Chromium wrote them", () => {
    const out = browserUserAgent(E37);
    expect(out).toContain("(Macintosh; Intel Mac OS X 10_15_7)");
    expect(out).toContain("AppleWebKit/537.36 (KHTML, like Gecko)");
    expect(out.endsWith("Safari/537.36")).toBe(true);
  });

  it("is idempotent — it is applied at the session AND at each view, and must not compound", () => {
    const once = browserUserAgent(E37);
    expect(browserUserAgent(once)).toBe(once);
    expect(browserUserAgent(browserUserAgent(once))).toBe(once);
  });

  it("tracks whatever Chromium ships, rather than a version anyone has to remember to update", () => {
    const E44 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.3 Safari/537.36";
    expect(browserUserAgent(E44)).toContain("Chrome/152.0.0.0");
    expect(browserUserAgent(E44)).not.toContain("Electron");
  });

  it("hands back anything it does not recognise, rather than rewriting a string blind", () => {
    // Fail closed on shape: a UA with no Chrome token is not one this function has an opinion about,
    // and half-rewriting it would produce something no browser has ever sent.
    expect(browserUserAgent("curl/8.7.1")).toBe("curl/8.7.1");
    expect(browserUserAgent("")).toBe("");
  });

  it("does not disturb a UA that never carried an Electron token", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    expect(browserUserAgent(chrome)).toBe(chrome);
  });
});

/* ------------------------------ the ⋯ menu's view calls (Plan 26 W7b) ------------------------------ */

describe("find in page", () => {
  it("a new query starts a session; Next and Previous step through it without restarting", () => {
    /* THE mutant is Electron's own naming: `findNext: true` means "begin a NEW search". Passed on every
       press, the search restarts at the first match and the Next button never moves. */
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    host.find("b1", "agent", "start");
    host.find("b1", "agent", "next");
    host.find("b1", "agent", "previous");
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("find:"))).toEqual([
      "find:agent:forward:new", "find:agent:forward:step", "find:agent:backward:step",
    ]);
  });

  it("an emptied field ends the find instead of searching for nothing", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    host.find("b1", "", "start");
    host.stopFind("b1");
    const calls = views.get("b1")!.calls;
    expect(calls.filter((c) => c.startsWith("find:"))).toEqual([]);
    expect(calls.filter((c) => c === "stop-find")).toHaveLength(2);
    expect(() => host.find("nope", "x", "start")).not.toThrow();
  });

  it("a view's result and its ⌘F reach the pane they came from, by id", () => {
    const { host, views, found, findRequests } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    views.get("b2")!.getHooks().found({ activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    views.get("b1")!.getHooks().findShortcut();
    expect(found).toEqual([{ id: "b2", activeMatchOrdinal: 2, matches: 5, finalUpdate: true }]);
    expect(findRequests).toEqual(["b1"]);
  });
});

describe("isFindShortcut", () => {
  const key = (over: Partial<Parameters<typeof isFindShortcut>[0]> = {}) =>
    ({ type: "keyDown", key: "f", meta: true, control: false, alt: false, shift: false, ...over });

  it("is ⌘F on a Mac, on key-down, and nothing else", () => {
    expect(isFindShortcut(key(), "darwin")).toBe(true);
    expect(isFindShortcut(key({ key: "F" }), "darwin")).toBe(true);
    expect(isFindShortcut(key({ type: "keyUp" }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ key: "g" }), "darwin")).toBe(false);
    // ⌘⇧F is pane focus. Taking it from the page here would break the other shortcut.
    expect(isFindShortcut(key({ shift: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ alt: true }), "darwin")).toBe(false);
  });

  it("leaves ⌃F to the text cursor on a Mac, where it moves forward a character", () => {
    expect(isFindShortcut(key({ meta: false, control: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ meta: false, control: true }), "linux")).toBe(true);
  });
});

describe("zoom", () => {
  it("steps along Chrome's ladder and answers the level the view is at afterwards", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    expect(host.zoom("b1", null)).toBe(1); // a read changes nothing
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("zoom:"))).toEqual([]);
    expect(host.zoom("b1", "in")).toBe(1.1);
    expect(host.zoom("b1", "in")).toBe(1.25);
    expect(host.zoom("b1", "out")).toBe(1.1);
    expect(host.zoom("b1", "reset")).toBe(1);
    expect(host.zoom("nope", "in")).toBe(1);
  });

  it("reads back what Chromium actually did rather than what was asked", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    // A view that refuses the level (a crashed page, say) keeps its old one, and the menu must say so.
    views.get("b1")!.handle.setZoomFactor = () => {};
    expect(host.zoom("b1", "in")).toBe(1);
  });

  it("goes to the nearest rung from a level the View menu's own zoom left between them", () => {
    // ⌘+ with the page focused is Electron's zoom role, which steps half a zoom level: 1.0954…
    expect(nextZoomFactor(1.0954, "in")).toBe(1.1);
    expect(nextZoomFactor(1.0954, "out")).toBe(1);
    expect(nextZoomFactor(1.1, "in")).toBe(1.25);
    // The ends hold rather than run off the ladder.
    expect(nextZoomFactor(ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!, "in")).toBe(5);
    expect(nextZoomFactor(ZOOM_FACTORS[0]!, "out")).toBe(0.25);
    expect(nextZoomFactor(Number.NaN, "in")).toBe(1);
    expect(zoomPercent(1.1)).toBe(110);
    expect(zoomPercent(0.33)).toBe(33);
  });
});

describe("print", () => {
  it("reaches the view it was asked for, and an unknown one is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    host.print("b2");
    expect(views.get("b2")!.calls).toContain("print");
    expect(views.get("b1")!.calls).not.toContain("print");
    expect(() => host.print("nope")).not.toThrow();
  });
});

/* ------------------------------ Device size (Plan 26 W7e) ------------------------------ */

const preset = (id: string) => DEVICE_PRESETS.find((d) => d.id === id)!;

describe("deviceFit", () => {
  it("a phone in a wider pane is its own width, centred, at full scale, as tall as the pane", () => {
    expect(deviceFit({ x: 900, y: 80, width: 600, height: 840 }, preset("phone"))).toEqual({
      view: { x: 1005, y: 80, width: 390, height: 840 },
      metrics: { width: 390, height: 840, deviceScaleFactor: 0, mobile: true, scale: 1 },
    });
  });

  it("a desktop in a narrow pane is scaled down to the pane's width, and told the height that fills it", () => {
    /* THE mutant: no scale. A 1440-wide page in a 600-wide view is cropped to its left two-fifths, and
       the box is not a preview of anything. */
    const fit = deviceFit({ x: 900, y: 80, width: 600, height: 840 }, preset("desktop"))!;
    expect(fit.view).toEqual({ x: 900, y: 80, width: 600, height: 840 });
    expect(fit.metrics).toMatchObject({ width: 1440, mobile: false });
    expect(fit.metrics.scale).toBeCloseTo(600 / 1440, 6);
    expect(fit.metrics.height).toBe(Math.round(840 / (600 / 1440)));
  });

  it("never draws outside the pane it was given, and has nothing to fit in an empty one", () => {
    for (const p of DEVICE_PRESETS) for (const width of [200, 389, 390, 391, 820, 1439, 1441, 2000]) {
      const fit = deviceFit({ x: 10, y: 20, width, height: 500 }, p)!;
      expect(fit.view.x).toBeGreaterThanOrEqual(10);
      expect(fit.view.x + fit.view.width).toBeLessThanOrEqual(10 + width);
    }
    expect(deviceFit({ x: 0, y: 0, width: 0, height: 500 }, preset("phone"))).toBeNull();
  });
});

describe("BrowserPaneHost — device size", () => {
  const setup = () => {
    const h = makeHost(1);
    h.host.create("b1", "https://example.com", null, P);
    h.host.setBounds("b1", { x: 900, y: 80, width: 600, height: 840 }, 1, true);
    return h;
  };
  const lastBounds = (calls: string[]) => calls.filter((c) => c.startsWith("bounds:")).at(-1);

  it("a preset narrows the view to the device's box and emulates it; Fit the pane undoes both", () => {
    const { host, views, emulations, states } = setup();
    host.setDevice("b1", "phone");
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:1005,80,390,840");
    expect(emulations.at(-1)).toEqual({ id: "b1", metrics: { width: 390, height: 840, deviceScaleFactor: 0, mobile: true, scale: 1 } });
    expect(states.at(-1)!.device).toBe("phone");
    host.setDevice("b1", null);
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:900,80,600,840");
    expect(emulations.at(-1)).toEqual({ id: "b1", metrics: null });
    expect(states.at(-1)!.device).toBeNull();
  });

  it("the box follows the pane as it resizes, and a resize that changes nothing sends nothing", () => {
    const { host, views, emulations } = setup();
    host.setDevice("b1", "phone");
    const sent = emulations.length;
    host.setBounds("b1", { x: 900, y: 80, width: 600, height: 840 }, 1, true);
    expect(emulations).toHaveLength(sent);
    host.setBounds("b1", { x: 700, y: 80, width: 800, height: 700 }, 1, true);
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:905,80,390,700");
    expect(emulations.at(-1)!.metrics).toMatchObject({ width: 390, height: 700 });
  });

  it("a view never given a device never emulates, and an unknown preset is the pane", () => {
    const { host, emulations } = setup();
    host.setBounds("b1", { x: 900, y: 80, width: 500, height: 840 }, 1, true);
    expect(emulations).toEqual([]);
    host.setDevice("b1", "watch" as never);
    expect(host.deviceOf("b1")).toBeNull();
    expect(emulations).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * A page's icon: which of its offers, what the bytes are, and the one request main makes for it.
 * ------------------------------------------------------------------------------------------------ */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
const SVG = Buffer.from(`<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle r="8"/></svg>`);
const HTML_404 = Buffer.from("<!doctype html><html><head><title>Not found</title></head><body><svg></svg></body></html>");

describe("the state a pane's chrome is drawn from", () => {
  it("carries the page's icon, so the tab can draw it", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "https://www.google.com/search?q=hi", null, P);
    const v = views.get("b1")!;
    v.nav.favicon = `data:image/x-icon;base64,${ICO.toString("base64")}`;
    v.getHooks().emitState();
    expect(states.at(-1)!.favicon).toBe(v.nav.favicon);
  });
});

describe("shownPage", () => {
  it("names Realm's about:blank bootstrap after nothing: the address asked for, and no title", () => {
    // THE MUTANT: let the bootstrap's own title through. A restored tab was renamed "about:blank"
    // while its page was on the way — and kept that name when the page never came.
    expect(shownPage({ url: "about:blank", title: "about:blank" }, "https://example.com/")).toEqual({ url: "https://example.com/", title: "" });
    expect(shownPage({ url: "", title: "" }, null)).toEqual({ url: "", title: "" });
  });

  it("is the page's own address and title once it has committed", () => {
    expect(shownPage({ url: "https://example.com/", title: "Example Domain" }, "https://example.com/")).toEqual({ url: "https://example.com/", title: "Example Domain" });
  });
});

describe("rankFavicons", () => {
  it("puts an SVG first, then the smallest icon still sharp at 2x, then an unsized one, then a small one", () => {
    // Electron's own order (it hands over a sorted set): what a RealFaviconGenerator page offers.
    const offered = ["https://a.example/favicon-16x16.png", "https://a.example/favicon-192x192.png", "https://a.example/favicon-32x32.png", "https://a.example/favicon.ico"];
    // THE mutant: take the first. That is the 16px one, a blur in a Retina tab.
    expect(rankFavicons(offered)).toEqual(["https://a.example/favicon-32x32.png", "https://a.example/favicon-192x192.png", "https://a.example/favicon.ico", "https://a.example/favicon-16x16.png"]);
    expect(rankFavicons(["https://a.example/favicon.ico", "https://a.example/icon.svg?v=2"])[0]).toBe("https://a.example/icon.svg?v=2");
  });

  it("keeps only addresses an icon can come from — never a script, a file, or a credential", () => {
    expect(rankFavicons([
      "javascript:alert(1)", "file:///etc/passwd", "chrome://favicon/x", "https://me:pw@a.example/f.ico",
      `https://a.example/${"x".repeat(3_000)}.ico`, "data:text/html,<b>hi</b>",
      "https://a.example/favicon.ico", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    ])).toEqual(["data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "https://a.example/favicon.ico"]);
  });
});

describe("sniffImage", () => {
  it("knows a picture by its own bytes, whatever the server called it", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(ICO)).toBe("image/x-icon");
    expect(sniffImage(Buffer.from("GIF89a\x01\x00"))).toBe("image/gif");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffImage(SVG)).toBe("image/svg+xml");
  });

  it("refuses a page that answered /favicon.ico with its HTML — even one with an <svg> in it", () => {
    // THE mutant: trust the extension, or look for "<svg" anywhere. A soft 404 says 200 and text/html.
    expect(sniffImage(HTML_404)).toBeNull();
    expect(sniffImage(Buffer.from("not found"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("faviconDataUrl and dataUrlBytes", () => {
  it("turns an icon's bytes into the data: URL the row keeps, typed by what they are", () => {
    const url = faviconDataUrl(ICO)!;
    expect(url).toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
    expect(isFaviconDataUrl(url)).toBe(true);
    expect(faviconDataUrl(HTML_404)).toBeNull();
  });

  it("drops an icon past the bound — the item lists carry it", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]);
    expect(faviconDataUrl(big)).toBeNull();
    expect(faviconDataUrl(big.subarray(0, FAVICON_MAX_BYTES))).not.toBeNull();
  });

  it("reads an inlined icon, base64 or percent-encoded, and nothing that does not parse", () => {
    expect(Buffer.from(dataUrlBytes(`data:image/png;base64,${PNG.toString("base64")}`)!)).toEqual(PNG);
    expect(Buffer.from(dataUrlBytes("data:image/svg+xml,%3Csvg%20viewBox%3D'0%200%201%201'%3E%3C%2Fsvg%3E")!).toString()).toBe("<svg viewBox='0 0 1 1'></svg>");
    expect(dataUrlBytes("data:image/svg+xml,%E0%A4%A")).toBeNull();
    expect(dataUrlBytes("https://a.example/favicon.ico")).toBeNull();
  });
});

describe("readCapped", () => {
  const stream = (chunks: Uint8Array[]) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); },
      cancel() { cancelled = true; },
    });
    return { body, cancelled: () => cancelled };
  };

  it("reads a body that fits, and gives up — cancelling the rest — on one that does not", async () => {
    expect(Buffer.from((await readCapped(stream([PNG.subarray(0, 8), PNG.subarray(8)]).body, 64))!)).toEqual(PNG);
    const huge = stream([Buffer.alloc(40), Buffer.alloc(40), Buffer.alloc(40)]);
    expect(await readCapped(huge.body, 64)).toBeNull();
    expect(huge.cancelled()).toBe(true);
  });
});

describe("createFaviconResolver", () => {
  const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
  const site = (answers: Record<string, Uint8Array | null | Error>) => {
    const asked: string[] = [];
    const fetchBytes = async (url: string) => {
      asked.push(url);
      const a = answers[url];
      if (a instanceof Error) throw a;
      return a ?? null;
    };
    return { asked, resolve: createFaviconResolver(fetchBytes) };
  };

  it("takes the first icon that loads, past one that answered with a page instead", async () => {
    // THE mutant: stop at the first. A site whose favicon-32x32.png 404s but whose favicon.ico is real
    // would draw the glyph.
    const { resolve } = site({ "https://a.example/favicon-32x32.png": HTML_404, "https://a.example/favicon.ico": ICO });
    expect(await resolve(["https://a.example/favicon.ico", "https://a.example/favicon-32x32.png"]))
      .toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
  });

  it("asks a site once for an icon every one of its pages offers", async () => {
    // THE mutant: no memory. Each search would fetch Google's icon again and the tab would wait on it.
    const { asked, resolve } = site({ "https://www.google.com/favicon.ico": ICO, "https://none.example/favicon.ico": null });
    for (let i = 0; i < 3; i++) await resolve(["https://www.google.com/favicon.ico"]);
    for (let i = 0; i < 2; i++) expect(await resolve(["https://none.example/favicon.ico"])).toBeNull();
    expect(asked).toEqual(["https://www.google.com/favicon.ico", "https://none.example/favicon.ico"]);
  });

  it("does not remember a fetch that never answered — the next page asks again", async () => {
    const answers: Record<string, Uint8Array | null | Error> = { "https://a.example/favicon.ico": new Error("timeout") };
    const { asked, resolve } = site(answers);
    expect(await resolve(["https://a.example/favicon.ico"])).toBeNull();
    answers["https://a.example/favicon.ico"] = ICO;
    expect(await resolve(["https://a.example/favicon.ico"])).not.toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("decodes an inlined icon without a request, and tries no more than a few", async () => {
    const { asked, resolve } = site({});
    expect(await resolve([PNG_URL])).toBe(PNG_URL);
    const many = Array.from({ length: FAVICON_TRIES + 3 }, (_, i) => `https://a.example/icon-${i}.ico`);
    expect(await resolve(many)).toBeNull();
    expect(asked).toHaveLength(FAVICON_TRIES);
  });
});
