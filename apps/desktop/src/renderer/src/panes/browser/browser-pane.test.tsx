import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import type { BlockedDownload, Browser, BrowserAnnotateResult, BrowserDownloadResult, BrowserFindResult, BrowserHistoryPage, BrowserMenuState, BrowserPickedElement, BrowserScreenshotSaved, BrowserSignInShare, PasskeyNotice } from "@realm/contracts";
import { BrowserPane, SUGGEST_DEBOUNCE_MS } from "./BrowserPane";
import { Toasts } from "../../components/Toasts";
import { setBrowserBridgesForTests, type BrowserBridges, type BrowserHostBridge, type BrowserServerBridge } from "./browser-client";
import { persistBrowserPages } from "./persist-pages";

/** Savers started by the tests that check what a page saves; stopped after each test. */
const pageSavers: (() => void)[] = [];
import { SETTLE_MS, shouldShowView, isRealmItemDrag } from "./view-sync";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, space } from "../../state/store.test-fakes";
import { gridPreset } from "@realm/contracts";

type StateMsg = BrowserViewState;

/**
 * `ready`: whether main's first word about a view with a page is that the page is up — what an adopted
 * view on a loaded page says, and what every test not about loading wants. False leaves the view
 * where a new one starts, on its way, until the test says otherwise.
 */
function fakeBridges(row: Partial<Browser> = {}, { ready = true }: { ready?: boolean } = {}) {
  const r: Browser = { id: "b1", spaceId: "s1", url: "", title: "Browser", favicon: "", createdAt: 0, updatedAt: 0, ...row };
  const calls: string[] = [];
  const bounds: { id: string; rect: DOMRectReadOnly | { x: number; y: number; width: number; height: number }; dpr: number; visible: boolean }[] = [];
  const updates: Record<string, unknown>[] = [];
  const cbs = new Set<(s: StateMsg) => void>();
  const blockedCbs = new Set<(m: { browserId: string; blocked: BlockedDownload }) => void>();
  const passkeyCbs = new Set<(m: PasskeyNotice) => void>();
  const foundCbs = new Set<(m: BrowserFindResult) => void>();
  const findRequestCbs = new Set<(m: { browserId: string }) => void>();
  /** What the next ⋯ menu is built from, and which row the "user" picks when it pops. */
  let menuState: BrowserMenuState = { zoom: 1, canZoomIn: true, canZoomOut: true, back: [], forward: [], blocked: [], saved: [], shareTargets: [] };
  let menuChoice: string | null = null;
  const menus: { items: NativeMenuItem[]; at: { x: number; y: number } }[] = [];
  let screenshotDir: string | null = "/tmp/space/screenshots";
  let screenshotResult: BrowserScreenshotSaved = { ok: true, path: "/tmp/space/screenshots/example.com-2026-10-01T19-30-05.png", name: "example.com-2026-10-01T19-30-05.png", size: 2048 };
  let cleared = true;
  /** What main answers "Share this site's sign-in with" with. */
  let shareResult: BrowserSignInShare = { ok: true, profileName: "School", host: "example.com", copied: 3 };
  /** History the server answers `suggest` with; `holdSuggest` makes each answer wait to be released. */
  let history: BrowserHistoryPage[] = [];
  /** What `recent` answers: the profile's last pages, newest first, as the server ranks them. */
  let recentPages: BrowserHistoryPage[] = [];
  let holdSuggest = false;
  const heldSuggest: { query: string; release: () => void }[] = [];
  let allowlist: string[] | null = null;
  let downloadDir: string | null = "/tmp/proj/downloads";
  let saveResult: BrowserDownloadResult = { ok: true, name: "week-3.pdf", bytes: 2048, relPath: "downloads/week-3.pdf" };
  /** The armed pick's resolver — the real bridge stays pending until the user clicks in the view. */
  let pickResolve: ((el: BrowserPickedElement | null) => void) | null = null;
  /** The armed annotation's resolver — pending until the user presses Send in the page's toolbar. */
  let annotateResolve: ((r: BrowserAnnotateResult) => void) | null = null;
  const host: BrowserHostBridge = {
    create: async (id, url, list) => {
      calls.push(`create:${id}:${url}:${JSON.stringify(list)}`);
      // Main answers a create with the view's state, as `BrowserPaneHost.create` does.
      if (url !== "") emitState({ id, url, ready, loading: !ready });
    },
    destroy: async (id) => { calls.push(`destroy:${id}`); },
    retain: async (id) => { calls.push(`retain:${id}`); },
    navigate: async (id, input) => { calls.push(`navigate:${id}:${input}`); return input.trim() === "" ? null : `https://${input}`; },
    nav: async (id, a) => { calls.push(`nav:${id}:${a}`); },
    search: async (id, q) => { calls.push(`search:${id}:${q}`); return `https://www.google.com/search?q=${encodeURIComponent(q)}`; },
    historyMenu: async (id, dir, at) => { calls.push(`historyMenu:${id}:${dir}:${Math.round(at.x)},${Math.round(at.y)}`); },
    setAllowlist: async () => {},
    setBounds: (id, rect, dpr, visible) => { bounds.push({ id, rect, dpr, visible }); },
    onState: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
    pickElement: (id) => { calls.push(`pick:${id}`); return new Promise((resolve) => { pickResolve = resolve; }); },
    cancelPick: async (id) => { calls.push(`cancel-pick:${id}`); pickResolve?.(null); pickResolve = null; },
    annotate: (id, accent, dir) => { calls.push(`annotate:${id}:${dir}`); return new Promise((resolve) => { annotateResolve = resolve; }); },
    cancelAnnotate: async (id) => { calls.push(`cancel-annotate:${id}`); annotateResolve?.({ outcome: "closed" }); annotateResolve = null; },
    setAccent: (accent) => { calls.push(`set-accent:${accent}`); },
    blockedDownloads: async () => [],
    saveDownload: async (id, blockedId, dir) => { calls.push(`save:${id}:${blockedId}:${dir}`); return saveResult; },
    dismissDownload: async (id, blockedId) => { calls.push(`dismiss:${id}:${blockedId}`); },
    onDownloadBlocked: (cb) => { blockedCbs.add(cb); return () => blockedCbs.delete(cb); },
    onPasskey: (cb) => { passkeyCbs.add(cb); return () => passkeyCbs.delete(cb); },
    popupMenu: async (items, at) => { menus.push({ items, at }); calls.push(`menu:${Math.round(at.x)},${Math.round(at.y)}`); return menuChoice; },
    menuState: async (id) => { calls.push(`menu-state:${id}`); return menuState; },
    goToIndex: async (id, index) => { calls.push(`go-to-index:${id}:${index}`); },
    find: async (id, query, step) => { calls.push(`find:${id}:${query}:${step}`); },
    stopFind: async (id) => { calls.push(`stop-find:${id}`); },
    onFound: (cb) => { foundCbs.add(cb); return () => foundCbs.delete(cb); },
    onFindRequest: (cb) => { findRequestCbs.add(cb); return () => findRequestCbs.delete(cb); },
    zoom: async (id, step) => { calls.push(`zoom:${id}:${step}`); return 1; },
    print: async (id) => { calls.push(`print:${id}`); },
    setDevice: async (id, preset) => { calls.push(`set-device:${id}:${preset}`); },
    screenshot: async (id, dir) => { calls.push(`screenshot:${id}:${dir}`); return screenshotResult; },
    clearData: async (id) => { calls.push(`clear-data:${id}`); return { cleared, profileId: cleared ? "p1" : null }; },
    shareSignIn: async (id, to) => { calls.push(`share-signin:${id}:${to}`); return shareResult; },
    reveal: async (path) => { calls.push(`reveal:${path}`); return !path.includes("/gone/"); },
  };
  const server: BrowserServerBridge = {
    get: async () => r,
    update: async (id, patch) => { updates.push({ id, ...patch }); },
    allowlist: async () => allowlist,
    downloadDir: async () => downloadDir,
    screenshotDir: async (spaceId) => { calls.push(`screenshot-dir:${spaceId}`); return screenshotDir; },
    suggest: (spaceId, query) => {
      calls.push(`suggest:${spaceId}:${query}`);
      const answer = history.filter((h) => `${h.url} ${h.title}`.toLowerCase().includes(query.toLowerCase()));
      if (!holdSuggest) return Promise.resolve(answer);
      return new Promise((resolve) => { heldSuggest.push({ query, release: () => resolve(answer) }); });
    },
    recent: async (spaceId) => { calls.push(`recent:${spaceId}`); return recentPages; },
    clearHistory: async (profileId) => { calls.push(`clear-history:${profileId}`); },
  };
  /** A page that is up unless the test says otherwise: no error, and something to show. */
  function emitState(s: Partial<StateMsg>) {
    const full: StateMsg = { id: "b1", url: "", title: "", loading: false, canGoBack: false, canGoForward: false, device: null, favicon: null, error: null, ready: true, ...s };
    for (const cb of cbs) cb(full);
  }
  const bridges: BrowserBridges = { host, server };
  return {
    bridges, calls, bounds, updates,
    setAllowlist: (l: string[] | null) => { allowlist = l; },
    setDownloadDir: (d: string | null) => { downloadDir = d; },
    setSaveResult: (r: BrowserDownloadResult) => { saveResult = r; },
    settlePick: (el: BrowserPickedElement | null) => { pickResolve?.(el); pickResolve = null; },
    settleAnnotate: (r: BrowserAnnotateResult) => { annotateResolve?.(r); annotateResolve = null; },
    menus,
    setMenuState: (m: Partial<BrowserMenuState>) => { menuState = { ...menuState, ...m }; },
    /** The row the next ⋯ menu answers with — what the user clicks in the OS's menu. */
    choose: (id: string | null) => { menuChoice = id; },
    setScreenshotDir: (d: string | null) => { screenshotDir = d; },
    setScreenshotResult: (r: BrowserScreenshotSaved) => { screenshotResult = r; },
    setCleared: (c: boolean) => { cleared = c; },
    setShareResult: (r: BrowserSignInShare) => { shareResult = r; },
    found: (m: Partial<BrowserFindResult>) => {
      const full: BrowserFindResult = { browserId: "b1", activeMatchOrdinal: 1, matches: 1, finalUpdate: true, ...m };
      for (const cb of foundCbs) cb(full);
    },
    requestFind: (browserId = "b1") => { for (const cb of findRequestCbs) cb({ browserId }); },
    setHistory: (h: BrowserHistoryPage[]) => { history = h; },
    setRecent: (p: BrowserHistoryPage[]) => { recentPages = p; },
    holdSuggestions: () => { holdSuggest = true; },
    heldSuggest,
    blockDownload: (blocked: BlockedDownload, browserId = "b1") => {
      for (const cb of blockedCbs) cb({ browserId, blocked });
    },
    refusePasskey: (notice: Partial<PasskeyNotice> = {}) => {
      const full: PasskeyNotice = { browserId: "b1", rpId: "github.com", kind: "get", refused: "none", ...notice };
      for (const cb of passkeyCbs) cb(full);
    },
    emit: (s: Partial<StateMsg>) => {
      emitState(s);
    },
  };
}

const state = (s: Partial<StateMsg>) => s;
/** A favicon as main hands one over: the picture itself, a 16px ICO's first bytes, in a data: URL. */
const ICON = "data:image/x-icon;base64,AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQ";
const browserItem = () => item("i1", "s1", { kind: "browser", refId: "b1", title: "Browser" });

/**
 * What a pane test needs before it can render, in one place: fake timers for the mount settle and the
 * persist debounce, a stub ResizeObserver (jsdom has none), and a fixed rect — jsdom has no layout, so
 * without one the bounds sync reports zeros and `shouldShowView` is exercised against nothing.
 */
function paneTestEnv(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 10, y: 40, width: 600, height: 400, top: 40, left: 10, right: 610, bottom: 440, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => {
    for (const stop of pageSavers.splice(0)) stop();
    setBrowserBridgesForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

/** Flush the mount's async row/allowlist fetch + create, then the settle timer. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS + 20); });
}

describe("BrowserPane", () => {
  paneTestEnv();

  it("chrome is inline-only: back/forward/reload buttons and an address input, nothing with a popup", async () => {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    const { container } = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(screen.getByLabelText("Back")).toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
    expect(screen.getByLabelText("Reload")).toBeDisabled(); // nothing loaded yet
    expect(screen.getByLabelText("Address")).toBeInTheDocument();
    // W2's invariant starts here: the browser chrome must never grow a dropdown.
    expect(container.querySelector(".browser-chrome [aria-haspopup]")).toBeNull();
  });

  it("creates the native view from the persisted row (url + the space's allowlist)", async () => {
    const f = fakeBridges({ url: "https://example.com/docs" });
    f.setAllowlist(["https://example.com"]);
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(f.calls).toContain('create:b1:https://example.com/docs:["https://example.com"]');
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com/docs");
  });

  it("state events drive the chrome — and only OUR item's events do", async () => {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    act(() => f.emit(state({ url: "https://a.example", canGoBack: true, loading: true })));
    expect(screen.getByLabelText("Address")).toHaveValue("https://a.example");
    expect(screen.getByLabelText("Back")).toBeEnabled();
    expect(screen.getByLabelText("Stop")).toBeInTheDocument(); // loading: reload swaps to stop
    // Another pane's state must not bleed in (state channel keyed to the right item).
    act(() => f.emit(state({ id: "OTHER", url: "https://evil.example", canGoBack: false })));
    expect(screen.getByLabelText("Address")).toHaveValue("https://a.example");
    expect(screen.getByLabelText("Back")).toBeEnabled();
  });

  it("Enter navigates via the host with exactly what was typed; toolbar buttons drive nav actions", async () => {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    const input = screen.getByLabelText("Address");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.submit(input.closest("form")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f.calls).toContain("navigate:b1:example.com");

    act(() => f.emit(state({ url: "https://example.com", canGoBack: true, canGoForward: true })));
    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.click(screen.getByLabelText("Forward"));
    fireEvent.click(screen.getByLabelText("Reload"));
    expect(f.calls).toEqual(expect.arrayContaining(["nav:b1:back", "nav:b1:forward", "nav:b1:reload"]));
  });

  it("right-clicking an arrow asks main for the OS trail menu, anchored under that button", async () => {
    /* The pane bans dropdowns because the native view composites over every piece of renderer DOM in
       its rect, so this menu is the OS's and main pops it. THE MUTANT: leave the default context
       menu through — the page's own menu appears over a toolbar button that is not part of the page. */
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    act(() => f.emit(state({ url: "https://example.com", canGoBack: true, canGoForward: true })));

    const back = screen.getByLabelText("Back");
    const ev = createEvent.contextMenu(back);
    fireEvent(back, ev);
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.contextMenu(screen.getByLabelText("Forward"));
    expect(f.calls.some((c) => c.startsWith("historyMenu:b1:back:"))).toBe(true);
    expect(f.calls.some((c) => c.startsWith("historyMenu:b1:forward:"))).toBe(true);
    // A right-click must not also navigate — the arrow's own click is the one-step gesture.
    expect(f.calls).not.toContain("nav:b1:back");
  });

  it("bounds sync: hidden until settle + first page; visible with the placeholder rect after", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    // Before the settle window closes, any sync must say hidden.
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(f.bounds.every((b) => !b.visible)).toBe(true);
    await settle();
    const last = f.bounds.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.rect).toMatchObject({ x: 10, y: 40, width: 600, height: 400 });
    expect(last.id).toBe("b1");
  });

  it("the view stays hidden while the pane has no page (empty state is DOM, not about:blank)", async () => {
    const f = fakeBridges({ url: "" });
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(f.bounds.length).toBeGreaterThan(0);
    expect(f.bounds.every((b) => !b.visible)).toBe(true);
    expect(screen.getByRole("region", { name: "New tab" })).toBeInTheDocument();
  });

  it("a realm item drag hides the view immediately and dragend restores it; OS file drags don't", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(f.bounds.at(-1)!.visible).toBe(true);

    const drag = (type: string, mime: string) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, "dataTransfer", { value: { types: [mime] } });
      window.dispatchEvent(e);
    };
    const n = f.bounds.length;
    act(() => drag("dragstart", "Files")); // an OS file drag must NOT blank the view
    expect(f.bounds.length).toBe(n); // filtered out before any sync
    act(() => drag("dragstart", "application/x-realm-item"));
    expect(f.bounds.at(-1)!.visible).toBe(false); // hidden synchronously, not next frame
    await act(async () => { window.dispatchEvent(new Event("dragend")); await vi.advanceTimersByTimeAsync(50); });
    expect(f.bounds.at(-1)!.visible).toBe(true);
  });

  describe("before a page has drawn, and a page that did not load", () => {
    const REFUSED = { code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" };
    const host = (container: HTMLElement) => container.querySelector(".browser-view-host") as HTMLElement;

    it("keeps the view hidden until main says the page has something to show", async () => {
      /* A WebContentsView paints opaque white before anything has loaded into it, which is the lighter
         slab under the toolbar this exists to keep off the screen. THE mutant: drop `ready` from the
         verdict, and the view is up the moment there is an address. */
      const f = fakeBridges({ url: "http://localhost:3000/" }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      expect(f.bounds.every((b) => !b.visible)).toBe(true);
      // Nothing of its own is painted either: the host is the pane's ground until the page is up.
      expect(host(container)).not.toHaveAttribute("data-page");
      await act(async () => { f.emit(state({ url: "http://localhost:3000/", ready: true })); await vi.advanceTimersByTimeAsync(20); });
      expect(f.bounds.at(-1)!.visible).toBe(true);
      expect(host(container)).toHaveAttribute("data-page");
    });

    it("shows the spiral while the first page is on its way, and nothing once it is up", async () => {
      const f = fakeBridges({ url: "http://localhost:3000/" }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      expect(container.querySelector(".browser-connecting .reach-mark[data-busy]")).not.toBeNull();
      act(() => f.emit(state({ url: "http://localhost:3000/", ready: true })));
      expect(container.querySelector(".browser-connecting")).toBeNull();
    });

    it("a first load that was stopped shows neither the spiral nor an error page", async () => {
      // Stopping is not failing: Chromium reports no error, and the pane must not invent one.
      const f = fakeBridges({ url: "http://localhost:3000/" }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      act(() => f.emit(state({ url: "http://localhost:3000/", ready: false, loading: false })));
      expect(container.querySelector(".browser-connecting")).toBeNull();
      expect(screen.queryByRole("region", { name: "This site can't be reached" })).toBeNull();
    });

    it("draws the error page where the view would be, keeps the view hidden, and keeps the address", async () => {
      const f = fakeBridges({ url: "http://localhost:3000/" }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      await act(async () => { f.emit(state({ url: REFUSED.url, title: "localhost:3000", ready: false, error: REFUSED })); await vi.advanceTimersByTimeAsync(20); });
      const page = screen.getByRole("region", { name: "This site can't be reached" });
      expect(within(page).getByText("localhost refused to connect.")).toBeInTheDocument();
      expect(within(page).getByText("Checking that a server is running on port 3000")).toBeInTheDocument();
      expect(within(page).getByText("ERR_CONNECTION_REFUSED")).toBeInTheDocument();
      expect(screen.getByLabelText("Address")).toHaveValue(REFUSED.url);
      // A DOM page under a live view is a page nobody sees: the view must be down while it is up.
      expect(f.bounds.at(-1)!.visible).toBe(false);
      expect(host(container)).not.toHaveAttribute("data-page");
      // …and there is nothing on the error document to pick from.
      expect(screen.getByLabelText("Pick an element")).toBeDisabled();
    });

    it("Reload retries the failed address, and the page stays up with its mark busy while it does", async () => {
      const f = fakeBridges({ url: REFUSED.url }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      act(() => f.emit(state({ url: REFUSED.url, error: REFUSED, ready: false })));
      fireEvent.click(within(screen.getByRole("region", { name: "This site can't be reached" })).getByRole("button", { name: "Reload" }));
      expect(f.calls).toContain("nav:b1:reload");
      // The retry is in flight: the error document is still what the view holds, so the page stays.
      act(() => f.emit(state({ url: REFUSED.url, error: REFUSED, ready: false, loading: true })));
      expect(container.querySelector(".browser-error .reach-mark[data-busy]")).not.toBeNull();
      expect(within(screen.getByRole("region", { name: "This site can't be reached" })).getByRole("button", { name: "Reload" })).toHaveAttribute("aria-busy", "true");
      // The server came up: the page goes and the view comes back.
      await act(async () => { f.emit(state({ url: REFUSED.url, title: "My app", ready: true })); await vi.advanceTimersByTimeAsync(20); });
      expect(screen.queryByRole("region", { name: "This site can't be reached" })).toBeNull();
      expect(f.bounds.at(-1)!.visible).toBe(true);
    });

    it("a certificate failure wears the padlock and offers nothing past it but Reload", async () => {
      const f = fakeBridges({ url: "https://127.0.0.1:8893/" }, { ready: false });
      setBrowserBridgesForTests(f.bridges);
      const { container } = render(<BrowserPane item={browserItem()} visible />);
      await settle();
      act(() => f.emit(state({ url: "https://127.0.0.1:8893/", ready: false, error: { code: -202, name: "ERR_CERT_AUTHORITY_INVALID", url: "https://127.0.0.1:8893/" } })));
      const page = screen.getByRole("region", { name: "Your connection isn't private" });
      expect(container.querySelector(".browser-error .lock-mark")).not.toBeNull();
      expect(within(page).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reload"]);
    });
  });

  describe("no-overlay registration (W2)", () => {
    const mountWithStore = (f: ReturnType<typeof fakeBridges>) => {
      setBrowserBridgesForTests(f.bridges);
      const store = createAppStore(fakeApi());
      const view = render(
        <StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
      return { store, ...view };
    };

    it("a space moved to another profile asks main for its view again — the view has to change cookie jars", async () => {
      /* THE mutant: leave the profile out of what the pane's view depends on, and a space moved from
         Personal to Work keeps showing Personal's signed-in page until something happens to remount it. */
      const f = fakeBridges({ url: "https://example.com" });
      const { store } = mountWithStore(f);
      act(() => store.setState({ spaces: [space("s1", "p1", "Versed")] }));
      await settle();
      const creates = () => f.calls.filter((c) => c.startsWith("create:b1:")).length;
      const before = creates();
      expect(before).toBeGreaterThan(0);
      // Something unrelated changes in the store: no new view.
      act(() => store.setState({ sidebarCollapsed: true }));
      await settle();
      expect(creates()).toBe(before);
      act(() => store.setState({ spaces: store.getState().spaces.map((sp) => (sp.id === "s1" ? { ...sp, profileId: "p2" } : sp)) }));
      await settle();
      expect(creates()).toBe(before + 1);
    });

    it("a pane with a page registers the rect its view paints, keyed by the ITEM id", async () => {
      const { store } = mountWithStore(fakeBridges({ url: "https://example.com" }));
      await settle();
      expect(store.getState().browserRects).toEqual([{ itemId: "i1", x: 10, y: 40, width: 600, height: 400 }]);
    });

    /**
     * The reported bug: clicking Settings with a browser open left the browser painting over the
     * page, which is unreadable and unrecoverable without closing the page blind.
     *
     * A page overlay is DOM, and a native `WebContentsView` paints over all of it — so unlike a
     * sheet (a card with room beside it that the browser can be snapped away from) a full-host page
     * has no complement, and the only honest answer is to hide the view. Both halves are asserted
     * because they go out in one `sync()`: the SHOW flag main acts on, and the rect that tells
     * floating surfaces where a view is.
     */
    it("hides the view and drops its rect while a page is open over the workspace", async () => {
      const shows: boolean[] = [];
      const f = fakeBridges({ url: "https://example.com" });
      f.bridges.host.setBounds = (_id, _rect, _dpr, show) => { shows.push(show); };
      const { store } = mountWithStore(f);
      await settle();
      expect(shows.at(-1)).toBe(true);
      expect(store.getState().browserRects).toHaveLength(1);

      await act(async () => { store.setState({ pageOverlay: { kind: "settings-page", refId: "settings", spaceId: "s1" } }); await settle(); });

      /* The mutant this catches: the sync effect deliberately does not depend on the overlay (it
         owns the view's create/adopt/release lifecycle and re-running it would rebuild the view), so
         without the one-line re-sync effect nothing ever told main — which is exactly how this
         shipped. */
      expect(shows.at(-1)).toBe(false);
      expect(store.getState().browserRects).toEqual([]);
    });

    it("shows it again when the page closes", async () => {
      const shows: boolean[] = [];
      const f = fakeBridges({ url: "https://example.com" });
      f.bridges.host.setBounds = (_id, _rect, _dpr, show) => { shows.push(show); };
      const { store } = mountWithStore(f);
      await settle();
      await act(async () => { store.setState({ pageOverlay: { kind: "settings-page", refId: "settings", spaceId: "s1" } }); await settle(); });
      expect(shows.at(-1)).toBe(false);
      // Hidden, never destroyed: the view kept running and comes back at the same rect.
      await act(async () => { store.setState({ pageOverlay: null }); await settle(); });
      expect(shows.at(-1)).toBe(true);
      expect(store.getState().browserRects).toHaveLength(1);
    });

    /* The media viewer covers the whole window, as a page covers the panes — and a view left
       showing would paint straight through the picture being looked at. THE MUTANT: leave the
       viewer out of the overlay selector. */
    it("hides the view while the media viewer is up, and shows it again when it closes", async () => {
      const shows: boolean[] = [];
      const f = fakeBridges({ url: "https://example.com" });
      f.bridges.host.setBounds = (_id, _rect, _dpr, show) => { shows.push(show); };
      const { store } = mountWithStore(f);
      await settle();
      expect(shows.at(-1)).toBe(true);
      await act(async () => { store.getState().openViewer({ files: [{ path: "/tmp/shot.png" }] }); await settle(); });
      expect(shows.at(-1)).toBe(false);
      expect(store.getState().browserRects).toEqual([]);
      await act(async () => { store.getState().closeViewer(); await settle(); });
      expect(shows.at(-1)).toBe(true);
    });

    /* The window's toasts, with no clear spot along its foot, hold a corner — and the view under it
       gives that corner up for as long as they are up. THE mutant: send the placeholder's rect as it
       is, and the view paints over the toast that is the only thing the window is trying to say. */
    it("gives up the corner the toasts are holding, and takes it back when they go — its own rect unchanged", async () => {
      const f = fakeBridges({ url: "https://example.com" });
      const { store } = mountWithStore(f);
      await settle();
      expect(f.bounds.at(-1)!.rect).toMatchObject({ y: 40, height: 400 });
      await act(async () => { store.getState().setToastReserve({ x: 300, y: 380, width: 372, height: 388 }); await settle(); });
      expect(f.bounds.at(-1)!.rect).toMatchObject({ x: 10, y: 40, width: 600, height: 340 });
      // The strip it gave up shows the pane's ground, not the placeholder's page white.
      expect(document.querySelector(".browser-view-host")).toHaveAttribute("data-yielded");
      // Where the view stands is still all of it: the no-overlay rect is the placeholder's.
      expect(store.getState().browserRects).toEqual([{ itemId: "i1", x: 10, y: 40, width: 600, height: 400 }]);
      await act(async () => { store.getState().setToastReserve(null); await settle(); });
      expect(f.bounds.at(-1)!.rect).toMatchObject({ height: 400 });
      expect(document.querySelector(".browser-view-host")).not.toHaveAttribute("data-yielded");
    });

    it("no page, no rect — the empty state is plain DOM and floats may cover it", async () => {
      const { store } = mountWithStore(fakeBridges({ url: "" }));
      await settle();
      expect(store.getState().browserRects).toEqual([]);
    });

    it("a drag-hidden view KEEPS its rect (the view snaps back to it) and unmount clears it", async () => {
      const f = fakeBridges({ url: "https://example.com" });
      const { store, unmount } = mountWithStore(f);
      await settle();
      const e = new Event("dragstart", { bubbles: true });
      Object.defineProperty(e, "dataTransfer", { value: { types: ["application/x-realm-item"] } });
      act(() => { window.dispatchEvent(e); });
      expect(f.bounds.at(-1)!.visible).toBe(false); // native view hidden for the drag...
      expect(store.getState().browserRects).toHaveLength(1); // ...but the no-overlay rect stays
      unmount();
      // The rect clears WITH the deferred view release (one macrotask), not eagerly — a layout
      // remount cancels that timer and the rect never blinks while the adopted view keeps painting.
      expect(store.getState().browserRects).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(store.getState().browserRects).toEqual([]);
      expect(f.calls).toContain("retain:b1");
    });
  });

  it("remounting after a release re-adopts the view instead of reloading the page", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    const first = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    first.unmount();
    // Past the deferred release: main is holding the view hidden, exactly as after a space switch.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(f.calls).toContain("retain:b1");
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    // Re-adoption is `create` — idempotent on the main side, so the page is not reloaded.
    expect(f.calls.filter((c) => c.startsWith("create:b1"))).toHaveLength(2);
    expect(f.calls).not.toContain("destroy:b1");
  });

  it("a StrictMode-style remount within the same tick cancels the release outright", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    const first = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    first.unmount();
    // Remount BEFORE the deferred release's macrotask fires: the view never even blinks hidden.
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(f.calls.filter((c) => c === "retain:b1")).toHaveLength(0);
    expect(f.calls.filter((c) => c.startsWith("create:b1"))).toHaveLength(2); // idempotent on the main side
  });

  it("persists the page's icon with its address and title, so the tab and its row can draw it", async () => {
    // THE mutant: persist url and title alone. The icon main resolved would never reach the item.
    const f = fakeBridges({ url: "" });
    setBrowserBridgesForTests(f.bridges);
    // The page is saved by the app-wide saver, which App starts beside every pane (persist-pages.ts).
    pageSavers.push(persistBrowserPages(f.bridges));
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    act(() => f.emit(state({ url: "https://www.google.com/search?q=hi", title: "hi - Google Search" })));
    act(() => f.emit(state({ url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: ICON })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.updates).toEqual([{ id: "b1", url: "https://www.google.com/search?q=hi", title: "hi - Google Search", favicon: ICON }]);
  });

});

describe("shouldShowView", () => {
  it("requires every condition", () => {
    const base = { paneVisible: true, pageOverlay: false, dragging: false, settled: true, hasUrl: true, ready: true, failed: false };
    expect(shouldShowView(base)).toBe(true);
    expect(shouldShowView({ ...base, paneVisible: false })).toBe(false);
    expect(shouldShowView({ ...base, dragging: true })).toBe(false);
    expect(shouldShowView({ ...base, settled: false })).toBe(false);
    expect(shouldShowView({ ...base, hasUrl: false })).toBe(false);
    /* A native WebContentsView paints over ALL dom, so a page opened over the workspace cannot cover
       one — and a full-host overlay leaves no complement to snap a browser into, the way a sheet
       does. The measured symptom: opening Settings with a browser behind it left the page readable
       only where the browser did not happen to be. */
    expect(shouldShowView({ ...base, pageOverlay: true })).toBe(false);
    // Nothing of the page's own to show yet, or an error document: the pane's ground or its error
    // page are what is meant to be seen there, and the view would cover either.
    expect(shouldShowView({ ...base, ready: false })).toBe(false);
    expect(shouldShowView({ ...base, failed: true })).toBe(false);
  });
});

describe("isRealmItemDrag", () => {
  it("matches both pane-producing Realm drag types", () => {
    expect(isRealmItemDrag({ dataTransfer: { types: ["application/x-realm-item"] } as unknown as DataTransfer })).toBe(true);
    expect(isRealmItemDrag({ dataTransfer: { types: ["application/x-realm-new-session"] } as unknown as DataTransfer })).toBe(true);
    expect(isRealmItemDrag({ dataTransfer: { types: ["Files"] } as unknown as DataTransfer })).toBe(false);
    expect(isRealmItemDrag({ dataTransfer: null })).toBe(false);
  });
});

describe("action ticker + driving dot (W4)", () => {
  paneTestEnv();

  const mountWithStore = (f: ReturnType<typeof fakeBridges>) => {
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    const view = render(
      <StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
    return { store, ...view };
  };

  it("no agent activity, no ticker — the chrome starts as W1 left it", async () => {
    const { container } = mountWithStore(fakeBridges({ url: "https://example.com" }));
    await settle();
    expect(container.querySelector(".browser-ticker")).toBeNull();
  });

  it("shows the LAST settled action with its attributed wording, a quiet time, and the recent few on hover", async () => {
    const { store, container } = mountWithStore(fakeBridges({ url: "https://example.com" }));
    await settle();
    act(() => {
      store.getState().applyBrowserAction({ browserId: "b1", text: 'Click the button the page labels "Submit" on example.com', ok: true, ts: 1725100000000 });
      store.getState().applyBrowserAction({ browserId: "b1", text: 'Type "carlton" into the textbox the page labels "Name" on example.com', ok: true, ts: 1725100060000 });
    });
    const ticker = container.querySelector(".browser-ticker")!;
    expect(ticker.querySelector(".browser-ticker-text")!.textContent).toBe('Type "carlton" into the textbox the page labels "Name" on example.com');
    expect(ticker.querySelector(".browser-ticker-time")!.textContent).toMatch(/\d/);
    expect(ticker.getAttribute("title")).toContain('the page labels "Submit"'); // older ones ride the hover reveal
    // Attribution framing intact — the ticker never launders page text into Realm's own voice.
    expect(ticker.querySelector(".browser-ticker-text")!.textContent).toContain("the page labels");
  });

  it("a failed action is marked; another browser's actions never bleed in", async () => {
    const { store, container } = mountWithStore(fakeBridges({ url: "https://example.com" }));
    await settle();
    act(() => {
      store.getState().applyBrowserAction({ browserId: "b1", text: "Click the button on example.com", ok: false, ts: 1 });
      store.getState().applyBrowserAction({ browserId: "OTHER", text: "Elsewhere", ok: true, ts: 2 });
    });
    const text = container.querySelector(".browser-ticker-text")!;
    expect(text).toHaveAttribute("data-failed");
    expect(text.textContent).toBe("Click the button on example.com");
  });

  it("the driving dot appears while an act is in flight and leaves when it settles (mutant: dot stuck on)", async () => {
    const { store, container } = mountWithStore(fakeBridges({ url: "https://example.com" }));
    await settle();
    expect(container.querySelector('.status-dot[data-status="driving"]')).toBeNull();
    act(() => store.getState().applyBrowserDriving({ browserId: "b1", driving: true }));
    expect(container.querySelector('.status-dot[data-status="driving"]')).toBeInTheDocument();
    act(() => store.getState().applyBrowserDriving({ browserId: "b1", driving: false }));
    expect(container.querySelector('.status-dot[data-status="driving"]')).toBeNull();
  });

  it("the ticker is inline chrome, never a popup surface", async () => {
    const { store, container } = mountWithStore(fakeBridges({ url: "https://example.com" }));
    await settle();
    act(() => store.getState().applyBrowserAction({ browserId: "b1", text: "Scroll the page on example.com", ok: true, ts: 1 }));
    expect(container.querySelector(".browser-chrome .browser-ticker")).toBeInTheDocument();
    expect(container.querySelector(".browser-chrome [aria-haspopup]")).toBeNull();
  });
});

/**
 * Plan 23 W4 — the blocked-download bar.
 *
 * What it exists to remove is a SILENT failure: `will-download` cannot tell the user's click from
 * the agent's, so the user's own downloads are blocked like everything else, and before W4 they
 * simply vanished. The mutants: a bar that never appears; a Save button offered for a file type the
 * allowlist would refuse; a save that invents a destination when the space has no project.
 */
describe("the blocked-download bar (Plan 23 W4)", () => {
  const blocked = (over: Partial<BlockedDownload> = {}): BlockedDownload =>
    ({ id: "bd_1", name: "week-3.pdf", ts: 1, ...over });

  async function mountPane() {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible focused={false} />);
    await act(async () => {});
    return f;
  }

  it("says what was blocked instead of failing silently, and offers to save it", async () => {
    const f = await mountPane();
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => { f.blockDownload(blocked()); });
    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("Blocked a download");
    expect(bar).toHaveTextContent("week-3.pdf");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("Save goes through main with the SERVER's directory — the renderer never composes a path", async () => {
    const f = await mountPane();
    await act(async () => { f.blockDownload(blocked()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(f.calls).toContain("save:b1:bd_1:/tmp/proj/downloads");
    expect(screen.getByRole("status")).toHaveTextContent("Saved week-3.pdf to downloads/");
  });

  it("a space whose folder is gone says so rather than inventing a destination", async () => {
    const f = await mountPane();
    f.setDownloadDir(null);
    await act(async () => { f.blockDownload(blocked()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(screen.getByRole("status")).toHaveTextContent("can't be found");
    expect(f.calls.some((c) => c.startsWith("save:"))).toBe(false);
    // The Save stays, so the user can retry rather than being stranded.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("a failed save reports main's reason", async () => {
    const f = await mountPane();
    f.setSaveResult({ ok: false, error: "that file was too large and was cancelled part-way" });
    await act(async () => { f.blockDownload(blocked()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(screen.getByRole("status")).toHaveTextContent("too large");
  });

  it("Dismiss clears the bar and tells main to forget it", async () => {
    const f = await mountPane();
    await act(async () => { f.blockDownload(blocked()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });

    expect(f.calls).toContain("dismiss:b1:bd_1");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores blocked downloads belonging to ANOTHER pane", async () => {
    const f = await mountPane();
    await act(async () => { f.blockDownload(blocked(), "b2"); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the most recent block, and dismissing it reveals the one before", async () => {
    const f = await mountPane();
    await act(async () => { f.blockDownload(blocked({ id: "bd_1", name: "first.pdf" })); });
    await act(async () => { f.blockDownload(blocked({ id: "bd_2", name: "second.pdf" })); });
    expect(screen.getByRole("status")).toHaveTextContent("second.pdf");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
    expect(screen.getByRole("status")).toHaveTextContent("first.pdf");
  });

  /**
   * A refused passkey request is invisible by design — the page gets `NotAllowedError` and renders
   * its own "that didn't work" — so the bar is the only thing that tells the user which of four
   * quite different problems they have. The one that matters on a Mac is the first: their existing
   * passkey is in iCloud Keychain, where Electron cannot reach it.
   */
  it("says why a passkey request went nowhere, naming the site and the way out", async () => {
    const f = await mountPane();
    await act(async () => { f.refusePasskey({ refused: "none", rpId: "github.com" }); });
    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("No passkey for github.com");
    expect(bar).toHaveTextContent(/iCloud Keychain/);
  });

  it("tells the four refusals apart, because each needs something different from the user", async () => {
    const f = await mountPane();
    await act(async () => { f.refusePasskey({ refused: "no_presence", rpId: "github.com" }); });
    expect(screen.getByRole("status")).toHaveTextContent("Touch ID didn't confirm");

    await act(async () => { f.refusePasskey({ refused: "rp_mismatch", rpId: "github.com" }); });
    expect(screen.getByRole("status")).toHaveTextContent("asked for a passkey belonging to github.com");

    await act(async () => { f.refusePasskey({ refused: "unavailable", rpId: "github.com" }); });
    expect(screen.getByRole("status")).toHaveTextContent("no Touch ID sensor");
  });

  it("ignores a passkey refusal belonging to ANOTHER pane", async () => {
    const f = await mountPane();
    await act(async () => { f.refusePasskey({ browserId: "b2" }); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the passkey bar without touching the pane", async () => {
    const f = await mountPane();
    await act(async () => { f.refusePasskey(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/**
 * The element picker. What these pin is the round trip a user actually makes: press the button, click
 * something in a rectangle React cannot see into, and find a chip waiting in a composer that may be
 * in another pane entirely. Nothing here asserts on the highlight — that is Chrome's overlay, drawn
 * inside the native view, and the pane deliberately draws nothing of its own.
 */
describe("BrowserPane — element picker", () => {
  paneTestEnv();

  const PICKED: BrowserPickedElement = {
    ref: 42, url: "https://example.com/login", title: "Sign in",
    rect: { x: 4, y: 8, w: 90, h: 32 },
    selector: "#submit", tag: "button", role: "button", name: "Sign in",
    text: "Sign in", html: '<button id="submit">Sign in</button>',
  };
  const sessionItem = item("i2", "s1", { kind: "session", refId: "se1", title: "Session" });

  const mount = async (over: { withSession?: boolean } = {}) => {
    const f = fakeBridges({ url: "https://example.com/login" });
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    const items = over.withSession === false ? [browserItem()] : [browserItem(), sessionItem];
    store.setState({ items, layout: gridPreset("two-col", items.map((i) => i.id)), focusedLeafId: null });
    // The receipts are the window's toasts, drawn by the host beside the pane.
    const { unmount } = render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /><Toasts /></StoreContext.Provider>);
    await settle();
    return { f, store, unmount };
  };

  const press = async () => { await act(async () => { fireEvent.click(screen.getByLabelText("Pick an element")); }); };

  it("has no page, has nothing to pick from", async () => {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(screen.getByLabelText("Pick an element")).toBeDisabled();
  });

  it("arms on press and disarms on a second press, without waiting for a pick", async () => {
    const { f } = await mount();
    await press();
    expect(screen.getByLabelText("Pick an element")).toHaveAttribute("aria-pressed", "true");
    expect(f.calls).toContain("pick:b1");
    await press();
    expect(screen.getByLabelText("Pick an element")).toHaveAttribute("aria-pressed", "false");
    expect(f.calls).toContain("cancel-pick:b1");
  });

  it("lands the picked element in the session's composer as a chip, with the element kept beside it", async () => {
    const { f, store } = await mount();
    await press();
    await act(async () => { f.settlePick(PICKED); });
    expect(store.getState().drafts.se1).toBe('@[button "Sign in"] ');
    expect(store.getState().draftElements.se1).toEqual([{ label: 'button "Sign in"', element: PICKED }]);
    expect(screen.getByLabelText("Pick an element")).toHaveAttribute("aria-pressed", "false");
  });

  it("names the session the pick went to — with two open, \"the prompter\" says nothing", async () => {
    const { f } = await mount();
    await press();
    await act(async () => { f.settlePick(PICKED); });
    expect(screen.getByRole("status")).toHaveTextContent('Added button "Sign in" to Session.');
  });

  it("a pick with nowhere to go says so rather than being dropped", async () => {
    const { f, store } = await mount({ withSession: false });
    await press();
    await act(async () => { f.settlePick(PICKED); });
    expect(screen.getByRole("status")).toHaveTextContent("open a session pane in this group first");
    expect(store.getState().drafts).toEqual({});
  });

  it("a cancelled pick says nothing at all", async () => {
    const { f } = await mount();
    await press();
    await act(async () => { f.settlePick(null); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("Pick an element")).toHaveAttribute("aria-pressed", "false");
  });

  it("two picks of the same control become two distinguishable chips", async () => {
    const { f, store } = await mount();
    await press();
    await act(async () => { f.settlePick(PICKED); });
    await press();
    await act(async () => { f.settlePick({ ...PICKED, ref: 43 }); });
    expect(store.getState().drafts.se1).toBe('@[button "Sign in"] @[button "Sign in" 2] ');
    expect(store.getState().draftElements.se1!.map((c) => (c.element as BrowserPickedElement).ref)).toEqual([42, 43]);
  });

  it("a pick main refuses outright un-arms the button — a lit picker over a view that is not picking", async () => {
    const f = fakeBridges({ url: "https://example.com/login" });
    f.bridges.host.pickElement = async () => { throw new Error("could not attach the debugger to browser b1"); };
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /><Toasts /></StoreContext.Provider>);
    await settle();
    await press();
    expect(screen.getByLabelText("Pick an element")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent(/could not take control of this page/i);
  });

  it("closing the pane takes the picker down with it, rather than leaving the page eating clicks", async () => {
    const { f, unmount } = await mount();
    await press();
    await act(async () => { unmount(); });
    expect(f.calls).toContain("cancel-pick:b1");
  });
});

/**
 * Plan 26 W7 — the ⋯ menu and what it opens.
 *
 * The menu itself is the OS's: these tests stand in for main by answering `popupMenu` with the row a
 * user would click, and pin what the pane does with that answer. What they also pin is the rule the
 * whole feature is built around — nothing the menu opens is drawn over the page.
 */
describe("BrowserPane — the ⋯ menu (Plan 26 W7)", () => {
  paneTestEnv();
  // Unmount while the bridges are still in place: a pane closed with its find strip up takes the
  // page's highlight down on the way out, and that call needs a bridge to go to.
  afterEach(() => { cleanup(); });

  const sessionItem = item("i2", "s1", { kind: "session", refId: "se1", title: "Session" });
  const mount = async (over: { withSession?: boolean; focused?: boolean } = {}) => {
    const f = fakeBridges({ url: "https://example.com/login" });
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    const items = over.withSession === false ? [browserItem()] : [browserItem(), sessionItem];
    store.setState({ items, layout: gridPreset("two-col", items.map((i) => i.id)), focusedLeafId: null, activeSpaceId: "s1" });
    const view = render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible focused={over.focused} /><Toasts /></StoreContext.Provider>);
    await settle();
    act(() => f.emit(state({ url: "https://example.com/login", title: "Sign in" })));
    return { f, store, ...view };
  };
  /** Press ⋯ and answer the OS's menu with `id` — the row a user would click, or null for Escape. */
  const choose = async (f: ReturnType<typeof fakeBridges>, id: string | null) => {
    f.choose(id);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "More" })); await vi.advanceTimersByTimeAsync(0); });
  };
  const rowsOf = (items: NativeMenuItem[]) => items as { label?: string; checked?: boolean; submenu?: { label?: string; checked?: boolean }[] }[];

  it("⋯ is the chrome's last control, and its menu is the OS's: nothing opens in this window's DOM", async () => {
    const { f, container } = await mount();
    expect(container.querySelector(".browser-chrome")!.lastElementChild).toHaveAccessibleName("More");
    await choose(f, null);
    expect(f.calls).toContain("menu-state:b1");
    // Anchored at the button's bottom-left (the mocked rect: x 10, bottom 440), like the trail menu.
    expect(f.calls).toContain("menu:10,440");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(rowsOf(f.menus[0]!.items).map((r) => r.label ?? "—")[0]).toBe("Find in page…");
    // Dismissed: nothing ran.
    expect(f.calls.filter((c) => /^(find|print|zoom|screenshot|clear-data)/.test(c))).toEqual([]);
  });

  it("Find in page opens a strip ABOVE the view — never inside it, where the page would cover it", async () => {
    const { f, container } = await mount();
    await choose(f, "find");
    const strip = container.querySelector(".browser-find")!;
    const host = container.querySelector(".browser-view-host")!;
    expect(strip).toBeInTheDocument();
    // THE mutant: render the strip in the view host, floating. The view paints over it there.
    expect(host.contains(strip)).toBe(false);
    expect(host.querySelector(".browser-find, [role=search], input")).toBeNull();
    expect(strip.parentElement).toBe(host.parentElement);
    expect(strip.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Find in page" })).toHaveFocus();
  });

  it("typing searches the page, Return steps forward, ⇧Return back, and the count is the page's", async () => {
    const { f } = await mount();
    await choose(f, "find");
    const field = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(field, { target: { value: "sign" } });
    expect(f.calls.at(-1)).toBe("find:b1:sign:start");
    act(() => f.found({ activeMatchOrdinal: 1, matches: 3 }));
    expect(screen.getByRole("search")).toHaveTextContent("1 of 3");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(f.calls.at(-1)).toBe("find:b1:sign:next");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(f.calls.at(-1)).toBe("find:b1:sign:previous");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(f.calls.at(-1)).toBe("find:b1:sign:next");
    // Another pane's answer is not this one's count.
    act(() => f.found({ browserId: "b2", activeMatchOrdinal: 9, matches: 9 }));
    expect(screen.getByRole("search")).toHaveTextContent("1 of 3");
    act(() => f.found({ activeMatchOrdinal: 0, matches: 0 }));
    expect(screen.getByRole("search")).toHaveTextContent("No matches");
  });

  it("a navigation ends the search: the next step starts a new one rather than continuing a dead session", async () => {
    const { f } = await mount();
    await choose(f, "find");
    const field = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(field, { target: { value: "item" } });
    act(() => f.found({ activeMatchOrdinal: 2, matches: 4 }));
    act(() => f.emit(state({ url: "https://example.com/next", title: "Next" })));
    expect(screen.getByRole("search")).not.toHaveTextContent("of 4");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(f.calls.at(-1)).toBe("find:b1:item:start");
  });

  it("Escape closes the strip and takes the page's highlight with it", async () => {
    const { f } = await mount();
    await choose(f, "find");
    const field = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(field, { target: { value: "sign" } });
    const ev = createEvent.keyDown(field, { key: "Escape" });
    fireEvent(field, ev);
    // Consumed, so the window's Escape (interrupt the focused session) does not also fire.
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.queryByRole("search")).toBeNull();
    expect(f.calls).toContain("stop-find:b1");
  });

  it("⌘F pressed in the PAGE reaches this pane through main — and another pane's does not open this one", async () => {
    const { f } = await mount();
    act(() => f.requestFind("b2"));
    expect(screen.queryByRole("search")).toBeNull();
    act(() => f.requestFind("b1"));
    expect(screen.getByRole("textbox", { name: "Find in page" })).toHaveFocus();
  });

  it("⌘F in the chrome opens it while this pane is the focused one, and only then", async () => {
    const unfocused = await mount({ focused: false });
    fireEvent.keyDown(screen.getByLabelText("Address"), { key: "f", metaKey: true });
    expect(screen.queryByRole("search")).toBeNull();
    unfocused.unmount();

    await mount({ focused: true });
    // ⌘⇧F is pane focus; it must not open find on the way past.
    fireEvent.keyDown(screen.getByLabelText("Address"), { key: "f", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("search")).toBeNull();
    const ev = createEvent.keyDown(screen.getByLabelText("Address"), { key: "f", metaKey: true });
    fireEvent(screen.getByLabelText("Address"), ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getByRole("textbox", { name: "Find in page" })).toBeInTheDocument();
  });

  it("Print, Zoom and History reach the view they were chosen for", async () => {
    const { f } = await mount();
    await choose(f, "print");
    await choose(f, "zoom:in");
    await choose(f, "zoom:reset");
    f.setMenuState({ back: [{ index: 0, label: "Home" }], forward: [{ index: 2, label: "Docs" }] });
    await choose(f, "history:0");
    expect(f.calls).toEqual(expect.arrayContaining(["print:b1", "zoom:b1:in", "zoom:b1:reset", "go-to-index:b1:0"]));
    const history = rowsOf(f.menus.at(-1)!.items).find((r) => r.label === "History")!.submenu!;
    expect(history.map((r) => [r.label, r.checked ?? false])).toEqual([["Docs", false], ["Sign in", true], ["Home", false]]);
  });

  it("Take a screenshot saves into the space's folder and lands in the session's prompter", async () => {
    const { f, store } = await mount();
    await choose(f, "screenshot");
    expect(f.calls).toContain("screenshot-dir:s1");
    expect(f.calls).toContain("screenshot:b1:/tmp/space/screenshots");
    expect(store.getState().pendingAttachments.se1).toEqual([{
      path: "/tmp/space/screenshots/example.com-2026-10-01T19-30-05.png", mime: "image/png",
      name: "example.com-2026-10-01T19-30-05.png", size: 2048,
    }]);
    expect(screen.getByRole("status")).toHaveTextContent("Added example.com-2026-10-01T19-30-05.png to Session.");
  });

  it("…with no session to take it, it is still saved, and the receipt says where", async () => {
    const { f, store } = await mount({ withSession: false });
    await choose(f, "screenshot");
    expect(store.getState().pendingAttachments).toEqual({});
    expect(screen.getByRole("status")).toHaveTextContent("Saved example.com-2026-10-01T19-30-05.png to screenshots/");
  });

  it("…and a capture that failed says why instead of attaching nothing", async () => {
    const { f, store } = await mount();
    f.setScreenshotResult({ ok: false, error: "The page had nothing on screen to capture." });
    await choose(f, "screenshot");
    expect(store.getState().pendingAttachments.se1 ?? []).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("nothing on screen");
  });

  it("Downloads saves a blocked file with the server's folder, and shows a saved one in the Finder", async () => {
    const { f } = await mount();
    f.setMenuState({
      blocked: [{ id: "bd_1", name: "week-3.pdf", ts: 1 }],
      saved: [{ id: "sd_1", name: "report.pdf", path: "/tmp/proj/downloads/report.pdf", ts: 2 }],
    });
    await choose(f, "download:save:bd_1");
    expect(f.calls).toContain("save:b1:bd_1:/tmp/proj/downloads");
    await choose(f, "download:show:sd_1");
    expect(f.calls).toContain("reveal:/tmp/proj/downloads/report.pdf");
    const downloads = rowsOf(f.menus[0]!.items).find((r) => r.label === "Downloads")!.submenu!;
    expect(downloads.map((r) => r.label ?? "—")).toEqual(["Save week-3.pdf", "—", "Show report.pdf in Finder"]);
    expect(screen.queryByText(/Nothing is at/)).toBeNull();
  });

  it("says so when a saved download has gone, rather than doing nothing", async () => {
    // THE MUTANT: drop the answer from `reveal`. The Finder shows nothing for a path with no file, so
    // the click would do nothing at all — the report that started the reveal fix.
    const { f } = await mount();
    f.setMenuState({ blocked: [], saved: [{ id: "sd_2", name: "old.pdf", path: "/tmp/gone/old.pdf", ts: 3 }] });
    await choose(f, "download:show:sd_2");
    expect(f.calls).toContain("reveal:/tmp/gone/old.pdf");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Nothing is at /tmp/gone/old.pdf. It may have been moved or deleted.")).toBeTruthy();
  });

  it("Clear browsing data says so only when it happened — main asks first, and Cancel is a no", async () => {
    const { f } = await mount();
    f.setCleared(false);
    await choose(f, "clear-data");
    // Main is told WHICH pane, because the partition it clears is that pane's profile's.
    expect(f.calls).toContain("clear-data:b1");
    expect(screen.queryByRole("status")).toBeNull();
    expect(f.calls).not.toContain("clear-history:p1");
    f.setCleared(true);
    await choose(f, "clear-data");
    expect(screen.getByRole("status")).toHaveTextContent("This profile's browser panes are signed out");
    // …and the pages it showed go too, or the address field would go on suggesting them — the pane's
    // own profile's pages, which the server names.
    expect(f.calls).toContain("clear-history:p1");
  });

  it("Share this site's sign-in copies into the profile chosen, and the receipt names the site and the profile", async () => {
    /* THE mutants: share into the pane's own profile, or say "Shared" when main copied nothing — the
       person would open the other profile and find themselves signed out. */
    const { f } = await mount();
    f.setMenuState({ shareTargets: [{ id: "p2", name: "School" }] });
    await choose(f, "share-signin:p2");
    expect(f.calls).toContain("share-signin:b1:p2");
    expect(screen.getByRole("status")).toHaveTextContent("Shared example.com's sign-in with School.");
    f.setShareResult({ ok: true, profileName: "School", host: "example.com", copied: 0 });
    await choose(f, "share-signin:p2");
    expect(screen.getByRole("status")).toHaveTextContent("This pane has no sign-in for example.com, so nothing was shared with School.");
    f.setShareResult({ ok: false, error: "That profile no longer exists." });
    await choose(f, "share-signin:p2");
    expect(screen.getByRole("status")).toHaveTextContent("That profile no longer exists.");
  });

  it("Device size reaches the view, and the pane's ground frames the device's box", async () => {
    const { f, container } = await mount();
    await choose(f, "device:phone");
    expect(f.calls).toContain("set-device:b1:phone");
    // Main answers on the state channel — which is also how a pane that remounts learns it.
    act(() => f.emit(state({ url: "https://example.com/login", title: "Sign in", device: "phone" })));
    expect(container.querySelector(".browser-view-host")).toHaveAttribute("data-device", "phone");
    await choose(f, null);
    const sizes = rowsOf(f.menus.at(-1)!.items).find((r) => r.label === "Device size")!.submenu!;
    expect(sizes.find((r) => r.checked)?.label).toBe("iPhone · 390px");
    await choose(f, "device:none");
    expect(f.calls).toContain("set-device:b1:null");
    act(() => f.emit(state({ url: "https://example.com/login", title: "Sign in", device: null })));
    expect(container.querySelector(".browser-view-host")).not.toHaveAttribute("data-device");
  });

  it("Browser settings opens Settings on Sign-ins", async () => {
    const { f, store } = await mount();
    await choose(f, "settings");
    expect(store.getState().pageOverlay?.kind).toBe("settings-page");
    expect(store.getState().settingsPageTab).toBe("signins");
  });
});

/**
 * Plan 26 W7c — what the address field suggests while it is being typed in. The pane's own history
 * comes from the server (`browsers.suggest`); these pin what the pane does with it: when it asks, where
 * the list is drawn, and what each key does.
 */
describe("BrowserPane — address suggestions (Plan 26 W7c)", () => {
  paneTestEnv();
  afterEach(() => { cleanup(); });

  const PAGES: BrowserHistoryPage[] = [
    { url: "https://docs.example/start", title: "Getting started", visits: 5, lastVisitAt: 10, favicon: "" },
    { url: "https://docs.example/config", title: "Configuration", visits: 2, lastVisitAt: 20, favicon: "" },
    { url: "https://dogs.example/", title: "", visits: 1, lastVisitAt: 30, favicon: "" },
  ];
  const mount = async () => {
    const f = fakeBridges({ url: "https://example.com/" });
    f.setHistory(PAGES);
    setBrowserBridgesForTests(f.bridges);
    const view = render(<StoreContext.Provider value={createAppStore(fakeApi())}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
    await settle();
    act(() => f.emit(state({ url: "https://example.com/", title: "Example" })));
    return { f, ...view };
  };
  const field = () => screen.getByLabelText("Address");
  const type = async (...texts: string[]) => {
    fireEvent.focus(field());
    for (const t of texts) fireEvent.change(field(), { target: { value: t } });
    await act(async () => { await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 1); });
  };
  const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
  const press = (key: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(field(), { key, ...init });
  const enter = async () => { await act(async () => { fireEvent.submit(field().closest("form")!); await vi.advanceTimersByTimeAsync(0); }); };

  it("focusing the field shows the page's address, not a list — a list is for text someone types", async () => {
    const { f } = await mount();
    fireEvent.focus(field());
    await act(async () => { await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS * 2); });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(f.calls.some((c) => c.startsWith("suggest:"))).toBe(false);
  });

  it("typing lists the space's visited pages that match, best first, then a search for the text", async () => {
    const { f } = await mount();
    // A word typed at speed is one question, not one per letter.
    await type("d", "do", "doc", "docs");
    expect(f.calls.filter((c) => c.startsWith("suggest:"))).toEqual(["suggest:s1:docs"]);
    expect(options()).toEqual([
      "Getting starteddocs.example/start",
      "Configurationdocs.example/config",
      "Search the web for “docs”",
    ]);
    // A combobox the way a screen reader expects one: expanded, pointing at its list.
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(field()).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
  });

  it("a page row wears the icon the page last showed, and one that showed none keeps the history's clock", async () => {
    // THE mutant: the clock on every row. The row for a site the person knows by its mark says nothing of it.
    const f = fakeBridges({ url: "https://example.com/" });
    f.setHistory([{ ...PAGES[0]!, favicon: ICON }, PAGES[1]!]);
    setBrowserBridgesForTests(f.bridges);
    render(<StoreContext.Provider value={createAppStore(fakeApi())}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
    await settle();
    await type("docs");
    const rows = screen.getAllByRole("option");
    expect(rows[0]!.querySelector("img.page-icon")?.getAttribute("src")).toBe(ICON);
    expect(rows[1]!.querySelector("img")).toBeNull();
    expect(rows[1]!.querySelector("svg")).not.toBeNull();
  });

  it("the list is a strip ABOVE the view — never a dropdown inside it, where the page would cover it", async () => {
    const { container } = await mount();
    await type("docs");
    const list = screen.getByRole("listbox");
    const host = container.querySelector(".browser-view-host")!;
    // THE mutant: draw it floating in the view host. The native view paints over everything there.
    expect(host.contains(list)).toBe(false);
    expect(list.parentElement).toBe(host.parentElement);
    expect(list.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".browser-chrome [aria-haspopup]")).toBeNull();
  });

  it("↓ moves onto a row and Return opens that page", async () => {
    const { f } = await mount();
    await type("docs");
    press("ArrowDown");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(field()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]!.id);
    press("ArrowDown");
    await enter();
    expect(f.calls).toContain("navigate:b1:https://docs.example/config");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑ back past the first row returns to the field, and Return goes where the text says", async () => {
    const { f } = await mount();
    await type("docs");
    press("ArrowDown"); press("ArrowUp"); press("ArrowUp");
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    await enter();
    expect(f.calls).toContain("navigate:b1:docs");
  });

  it("the search row searches the typed text, even when it looks like an address", async () => {
    const { f } = await mount();
    await type("docs.example");
    for (let i = 0; i < 5; i++) press("ArrowDown"); // held at the last row, which is the search
    expect(screen.getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
    await enter();
    expect(f.calls).toContain("search:b1:docs.example");
    expect(f.calls.some((c) => c.startsWith("navigate:"))).toBe(false);
  });

  it("Escape closes the list and puts the page's own address back in the field", async () => {
    await mount();
    await type("docs");
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("https://example.com/");
  });

  it("a click picks the row — the press keeps the field's focus, so the list is still there to click", async () => {
    const { f } = await mount();
    await type("dog");
    const row = screen.getAllByRole("option")[0]!;
    // A page with no title is named by its address rather than drawn as a blank row.
    expect(row).toHaveTextContent("dogs.example");
    const down = createEvent.mouseDown(row);
    fireEvent(row, down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => { fireEvent.click(row); await vi.advanceTimersByTimeAsync(0); });
    expect(f.calls).toContain("navigate:b1:https://dogs.example/");
  });

  it("an answer that arrives after the text has moved on is dropped, not shown against the wrong words", async () => {
    const { f } = await mount();
    f.holdSuggestions();
    await type("do");
    await type("docs");
    expect(f.heldSuggest.map((h) => h.query)).toEqual(["do", "docs"]);
    await act(async () => { f.heldSuggest[1]!.release(); await vi.advanceTimersByTimeAsync(0); });
    expect(options()).not.toContain("dogs.exampledogs.example");
    // THE mutant: no staleness check. The earlier question's answer lands last and wins.
    await act(async () => { f.heldSuggest[0]!.release(); await vi.advanceTimersByTimeAsync(0); });
    expect(options().some((o) => o?.includes("dogs.example"))).toBe(false);
    expect(options()).toHaveLength(3);
  });
});

/**
 * Plan 26 W6 — a blank tab's Recently visited. The pages come from the server (`browsers.recent`);
 * these pin what the pane does with them: when it asks, where a chosen one goes, and that a clear
 * takes the list down with the history it was read from.
 */
describe("BrowserPane — Recently visited on a blank tab (Plan 26 W6)", () => {
  paneTestEnv();
  afterEach(() => { cleanup(); });

  const RECENT: BrowserHistoryPage[] = [
    { url: "https://jobs.example/delta", title: "Delta careers", visits: 1, lastVisitAt: 30, favicon: "" },
    { url: "https://docs.example/start", title: "Getting started", visits: 4, lastVisitAt: 20, favicon: "" },
  ];
  const mount = async (row: Partial<Browser> = {}) => {
    const f = fakeBridges(row);
    f.setRecent(RECENT);
    setBrowserBridgesForTests(f.bridges);
    const view = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    return { f, ...view };
  };
  const reads = (f: ReturnType<typeof fakeBridges>) => f.calls.filter((c) => c.startsWith("recent:"));
  const listed = () => {
    const section = screen.queryByRole("region", { name: "Recently visited" });
    return section ? within(section).getAllByRole("button").map((b) => b.textContent) : null;
  };
  const clearData = async () => {
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "More" }).at(-1)!); await vi.advanceTimersByTimeAsync(0); });
  };

  it("each page wears the icon it last showed, and one that showed none the browser's glyph", async () => {
    const f = fakeBridges();
    f.setRecent([{ ...RECENT[0]!, favicon: ICON }, RECENT[1]!]);
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(screen.getByRole("button", { name: "Delta careers" }).querySelector("img.page-icon")?.getAttribute("src")).toBe(ICON);
    expect(screen.getByRole("button", { name: "Getting started" }).querySelector("img")).toBeNull();
  });

  it("a tab with a page asks for none and draws no new-tab page", async () => {
    // THE mutant: read them whenever the pane is visible, page or not.
    const { f } = await mount({ url: "https://example.com/" });
    expect(reads(f)).toEqual([]);
    expect(screen.queryByRole("region", { name: "New tab" })).toBeNull();
  });

  it("asks again each time the blank page comes back on screen, and never per render", async () => {
    /* THE mutants: ask on every render, and each letter typed into the address field is a read; ask
       once and keep it, and a side pane's blank tab — kept mounted while its neighbours browse —
       comes back listing the pages from before they went anywhere. */
    const { f, rerender } = await mount();
    const field = screen.getByLabelText("Address");
    fireEvent.focus(field);
    for (const t of ["d", "do", "doc"]) fireEvent.change(field, { target: { value: t } });
    await act(async () => { await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 1); });
    fireEvent.blur(field);
    expect(reads(f)).toEqual(["recent:s1"]);
    rerender(<BrowserPane item={browserItem()} visible={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(reads(f)).toHaveLength(1);
    f.setRecent([RECENT[1]!]);
    rerender(<BrowserPane item={browserItem()} visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(reads(f)).toHaveLength(2);
    expect(listed()).toEqual(["Getting started"]);
  });

  it("Clear browsing data takes the list down once main has cleared — and a Cancel leaves it", async () => {
    // THE mutant: keep the list as it was read. The page would go on naming what was just forgotten.
    const { f } = await mount();
    f.choose("clear-data");
    f.setCleared(false);
    await clearData();
    expect(listed()).toEqual(["Delta careers", "Getting started"]);
    f.setCleared(true);
    await clearData();
    expect(f.calls).toContain("clear-history:p1");
    expect(listed()).toBeNull();
  });

  it("…and so does a clear chosen in another pane, since the history is one for every pane", async () => {
    const f = fakeBridges();
    f.setRecent(RECENT);
    setBrowserBridgesForTests(f.bridges);
    const { container } = render(<>
      <BrowserPane item={browserItem()} visible />
      <BrowserPane item={item("i2", "s1", { kind: "browser", refId: "b2", title: "Browser" })} visible />
    </>);
    await settle();
    expect(container.querySelectorAll(".new-tab-section[aria-label='Recently visited']")).toHaveLength(2);
    f.choose("clear-data");
    await clearData(); // the second pane's ⋯
    expect(container.querySelectorAll(".new-tab-section[aria-label='Recently visited']")).toHaveLength(0);
  });
});

/**
 * Plan 26 W7d — annotate, the pane's half. The pins and the toolbar are drawn in the page (main's
 * injected annotator, tested against a real DOM in annotator.test.ts); what the pane owns is the
 * button's lit state and where a Send lands: ONE chip, every pinned element under it, and the
 * screenshot of the pins attached beside it.
 */
describe("BrowserPane — annotate (Plan 26 W7d)", () => {
  paneTestEnv();
  afterEach(() => { cleanup(); });

  const el = (n: number): BrowserPickedElement => ({
    ref: 40 + n, url: "https://example.com/list", title: "List", rect: { x: 0, y: 0, w: 10, h: 10 },
    selector: `li:nth-of-type(${n})`, tag: "li", role: "listitem", name: `Item ${n}`, text: `Item ${n}`, html: "<li></li>",
  });
  const SHOT = { path: "/tmp/space/screenshots/example.com-2026-10-01T19-30-05-annotations.png", name: "example.com-2026-10-01T19-30-05-annotations.png", size: 4096 };
  const sessionItem = item("i2", "s1", { kind: "session", refId: "se1", title: "Session" });
  const mount = async (over: { withSession?: boolean } = {}) => {
    const f = fakeBridges({ url: "https://example.com/list" });
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    const items = over.withSession === false ? [browserItem()] : [browserItem(), sessionItem];
    store.setState({ items, layout: gridPreset("two-col", items.map((i) => i.id)), focusedLeafId: null });
    const view = render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /><Toasts /></StoreContext.Provider>);
    await settle();
    return { f, store, ...view };
  };
  const press = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Annotate" })); await vi.advanceTimersByTimeAsync(0); }); };

  it("is a mode the button wears while it is on, armed with where its screenshot goes", async () => {
    const { f } = await mount();
    await press();
    expect(screen.getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "true");
    expect(f.calls).toContain("annotate:b1:/tmp/space/screenshots");
    await press();
    expect(f.calls).toContain("cancel-annotate:b1");
    expect(screen.getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "false");
  });

  it("Send lands as ONE chip carrying every pin, in order, with the screenshot of the pins attached", async () => {
    /* THE mutant: one chip per pin. Three pins would be three chips in the prompter, and the thing the
       user did — mark three places on one page as one remark — would be lost in the draft. */
    const { f, store } = await mount();
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "sent", elements: [el(1), el(2), el(3)], shot: SHOT }); await vi.advanceTimersByTimeAsync(0); });
    const st = store.getState();
    expect(st.drafts.se1).toBe("@[3 annotations] ");
    expect(st.draftElements.se1!.map((c) => [c.label, c.pin, (c.element as BrowserPickedElement).ref, c.shot])).toEqual([
      ["3 annotations", 1, 41, SHOT.name], ["3 annotations", 2, 42, SHOT.name], ["3 annotations", 3, 43, SHOT.name],
    ]);
    expect(st.pendingAttachments.se1).toEqual([{ path: SHOT.path, mime: "image/png", name: SHOT.name, size: 4096 }]);
    expect(screen.getByRole("status")).toHaveTextContent("Added 3 annotations to Session.");
    expect(screen.getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "false");
  });

  it("a Send whose page would not draw still lands its pins, naming no screenshot", async () => {
    const { f, store } = await mount();
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "sent", elements: [el(1)], shot: null }); await vi.advanceTimersByTimeAsync(0); });
    expect(store.getState().drafts.se1).toBe("@[1 annotation] ");
    expect(store.getState().draftElements.se1![0]).not.toHaveProperty("shot");
    expect(store.getState().pendingAttachments.se1 ?? []).toEqual([]);
  });

  it("a page that navigates says its pins went with it; a close the user chose says nothing", async () => {
    const { f } = await mount();
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "left" }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveTextContent("The page changed, so its pins were cleared.");
    // Arming again takes the pane's last receipt down; only a new one would put one back.
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "closed" }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a Send with nowhere to go says so rather than dropping the pins", async () => {
    const { f, store } = await mount({ withSession: false });
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "sent", elements: [el(1)], shot: SHOT }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveTextContent("open a session pane in this group first");
    expect(store.getState().drafts).toEqual({});
  });

  it("a draft that cannot carry that many more elements refuses the whole annotation, and says so", async () => {
    const { f, store } = await mount();
    for (let i = 0; i < 7; i++) store.getState().addElementChip("se1", { ...el(10 + i), name: `Pick ${i}` });
    await press();
    await act(async () => { f.settleAnnotate({ outcome: "sent", elements: [el(1), el(2)], shot: SHOT }); await vi.advanceTimersByTimeAsync(0); });
    expect(store.getState().draftElements.se1).toHaveLength(7);
    expect(store.getState().pendingAttachments.se1 ?? []).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("already carrying as many picked elements as one message can");
  });

  it("closing the pane takes the page's pins and toolbar down with it", async () => {
    const { f, unmount } = await mount();
    await press();
    await act(async () => { unmount(); });
    expect(f.calls).toContain("cancel-annotate:b1");
  });

  it("has no page, has nothing to annotate", async () => {
    const f = fakeBridges();
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(screen.getByRole("button", { name: "Annotate" })).toBeDisabled();
  });
});
