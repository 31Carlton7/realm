import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BlockedDownload, Browser, BrowserDownloadResult, BrowserPickedElement } from "@realm/contracts";
import { BrowserPane } from "./BrowserPane";
import { setBrowserBridgesForTests, type BrowserBridges, type BrowserHostBridge, type BrowserServerBridge } from "./browser-client";
import { SETTLE_MS, shouldShowView, isRealmItemDrag } from "./view-sync";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { gridPreset } from "@realm/contracts";

type StateMsg = BrowserViewState;

function fakeBridges(row: Partial<Browser> = {}) {
  const r: Browser = { id: "b1", spaceId: "s1", url: "", title: "Browser", createdAt: 0, updatedAt: 0, ...row };
  const calls: string[] = [];
  const bounds: { id: string; rect: DOMRectReadOnly | { x: number; y: number; width: number; height: number }; dpr: number; visible: boolean }[] = [];
  const updates: Record<string, unknown>[] = [];
  const cbs = new Set<(s: StateMsg) => void>();
  const blockedCbs = new Set<(m: { browserId: string; blocked: BlockedDownload }) => void>();
  let allowlist: string[] | null = null;
  let downloadDir: string | null = "/tmp/proj/downloads";
  let saveResult: BrowserDownloadResult = { ok: true, name: "week-3.pdf", bytes: 2048, relPath: "downloads/week-3.pdf" };
  /** The armed pick's resolver — the real bridge stays pending until the user clicks in the view. */
  let pickResolve: ((el: BrowserPickedElement | null) => void) | null = null;
  const host: BrowserHostBridge = {
    create: async (id, url, list) => { calls.push(`create:${id}:${url}:${JSON.stringify(list)}`); },
    destroy: async (id) => { calls.push(`destroy:${id}`); },
    navigate: async (id, input) => { calls.push(`navigate:${id}:${input}`); return input.trim() === "" ? null : `https://${input}`; },
    nav: async (id, a) => { calls.push(`nav:${id}:${a}`); },
    setAllowlist: async () => {},
    setBounds: (id, rect, dpr, visible) => { bounds.push({ id, rect, dpr, visible }); },
    onState: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
    pickElement: (id) => { calls.push(`pick:${id}`); return new Promise((resolve) => { pickResolve = resolve; }); },
    cancelPick: async (id) => { calls.push(`cancel-pick:${id}`); pickResolve?.(null); pickResolve = null; },
    blockedDownloads: async () => [],
    saveDownload: async (id, blockedId, dir) => { calls.push(`save:${id}:${blockedId}:${dir}`); return saveResult; },
    dismissDownload: async (id, blockedId) => { calls.push(`dismiss:${id}:${blockedId}`); },
    onDownloadBlocked: (cb) => { blockedCbs.add(cb); return () => blockedCbs.delete(cb); },
  };
  const server: BrowserServerBridge = {
    get: async () => r,
    update: async (id, patch) => { updates.push({ id, ...patch }); },
    allowlist: async () => allowlist,
    downloadDir: async () => downloadDir,
  };
  const bridges: BrowserBridges = { host, server };
  return {
    bridges, calls, bounds, updates,
    setAllowlist: (l: string[] | null) => { allowlist = l; },
    setDownloadDir: (d: string | null) => { downloadDir = d; },
    setSaveResult: (r: BrowserDownloadResult) => { saveResult = r; },
    settlePick: (el: BrowserPickedElement | null) => { pickResolve?.(el); pickResolve = null; },
    blockDownload: (blocked: BlockedDownload, browserId = "b1") => {
      for (const cb of blockedCbs) cb({ browserId, blocked });
    },
    emit: (s: Partial<StateMsg>) => {
      const full: StateMsg = { id: "b1", url: "", title: "", loading: false, canGoBack: false, canGoForward: false, ...s };
      for (const cb of cbs) cb(full);
    },
  };
}

const state = (s: Partial<StateMsg>) => s;
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
    expect(screen.getByText("Where to?")).toBeInTheDocument();
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

  describe("no-overlay registration (W2)", () => {
    const mountWithStore = (f: ReturnType<typeof fakeBridges>) => {
      setBrowserBridgesForTests(f.bridges);
      const store = createAppStore(fakeApi());
      const view = render(
        <StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
      return { store, ...view };
    };

    it("a pane with a page registers the rect its view paints, keyed by the ITEM id", async () => {
      const { store } = mountWithStore(fakeBridges({ url: "https://example.com" }));
      await settle();
      expect(store.getState().browserRects).toEqual([{ itemId: "i1", x: 10, y: 40, width: 600, height: 400 }]);
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
      // The rect clears WITH the deferred view destroy (one macrotask), not eagerly — a layout
      // remount cancels that timer and the rect never blinks while the adopted view keeps painting.
      expect(store.getState().browserRects).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(store.getState().browserRects).toEqual([]);
      expect(f.calls).toContain("destroy:b1");
    });
  });

  it("unmount destroys the native view — no hidden survival", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    const { unmount } = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(f.calls).toContain("destroy:b1");
  });

  it("a StrictMode-style remount within the same tick re-adopts the view instead of destroying it", async () => {
    const f = fakeBridges({ url: "https://example.com" });
    setBrowserBridgesForTests(f.bridges);
    const first = render(<BrowserPane item={browserItem()} visible />);
    await settle();
    first.unmount();
    // Remount BEFORE the deferred destroy's macrotask fires:
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    expect(f.calls.filter((c) => c === "destroy:b1")).toHaveLength(0);
    expect(f.calls.filter((c) => c.startsWith("create:b1"))).toHaveLength(2); // idempotent on the main side
  });

  it("persists committed url/title to the server, debounced, and not while loading", async () => {
    const f = fakeBridges({ url: "" });
    setBrowserBridgesForTests(f.bridges);
    render(<BrowserPane item={browserItem()} visible />);
    await settle();
    act(() => f.emit(state({ url: "https://example.com", title: "Example", loading: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.updates).toHaveLength(0); // mid-load states never persist
    act(() => f.emit(state({ url: "https://example.com", title: "Example Domain", loading: false })));
    act(() => f.emit(state({ url: "https://example.com/2", title: "Example 2", loading: false })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.updates).toEqual([{ id: "b1", url: "https://example.com/2", title: "Example 2" }]); // one debounced write
  });
});

describe("shouldShowView", () => {
  it("requires all four conditions", () => {
    const base = { paneVisible: true, dragging: false, settled: true, hasUrl: true };
    expect(shouldShowView(base)).toBe(true);
    expect(shouldShowView({ ...base, paneVisible: false })).toBe(false);
    expect(shouldShowView({ ...base, dragging: true })).toBe(false);
    expect(shouldShowView({ ...base, settled: false })).toBe(false);
    expect(shouldShowView({ ...base, hasUrl: false })).toBe(false);
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
    ({ id: "bd_1", name: "week-3.pdf", retryable: true, ts: 1, ...over });

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

  it("a NON-retryable type is shown but offers no Save button (mutant: a button that cannot work)", async () => {
    const f = await mountPane();
    await act(async () => { f.blockDownload(blocked({ name: "installer.dmg", retryable: false })); });

    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("installer.dmg");
    expect(bar).toHaveTextContent("doesn't save this file type");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a space with no project says so rather than inventing a destination", async () => {
    const f = await mountPane();
    f.setDownloadDir(null);
    await act(async () => { f.blockDownload(blocked()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(screen.getByRole("status")).toHaveTextContent("no project folder");
    expect(f.calls.some((c) => c.startsWith("save:"))).toBe(false);
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
    const { unmount } = render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
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
    expect(store.getState().draftElements.se1!.map((c) => c.element.ref)).toEqual([42, 43]);
  });

  it("a pick main refuses outright un-arms the button — a lit picker over a view that is not picking", async () => {
    const f = fakeBridges({ url: "https://example.com/login" });
    f.bridges.host.pickElement = async () => { throw new Error("could not attach the debugger to browser b1"); };
    setBrowserBridgesForTests(f.bridges);
    const store = createAppStore(fakeApi());
    render(<StoreContext.Provider value={store}><BrowserPane item={browserItem()} visible /></StoreContext.Provider>);
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
