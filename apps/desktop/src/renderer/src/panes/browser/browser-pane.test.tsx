import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Browser } from "@realm/contracts";
import { BrowserPane } from "./BrowserPane";
import { setBrowserBridgesForTests, type BrowserBridges, type BrowserHostBridge, type BrowserServerBridge } from "./browser-client";
import { SETTLE_MS, shouldShowView, isRealmItemDrag } from "./view-sync";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

type StateMsg = BrowserViewState;

function fakeBridges(row: Partial<Browser> = {}) {
  const r: Browser = { id: "b1", spaceId: "s1", url: "", title: "Browser", createdAt: 0, updatedAt: 0, ...row };
  const calls: string[] = [];
  const bounds: { id: string; rect: DOMRectReadOnly | { x: number; y: number; width: number; height: number }; dpr: number; visible: boolean }[] = [];
  const updates: Record<string, unknown>[] = [];
  const cbs = new Set<(s: StateMsg) => void>();
  let allowlist: string[] | null = null;
  const host: BrowserHostBridge = {
    create: async (id, url, list) => { calls.push(`create:${id}:${url}:${JSON.stringify(list)}`); },
    destroy: async (id) => { calls.push(`destroy:${id}`); },
    navigate: async (id, input) => { calls.push(`navigate:${id}:${input}`); return input.trim() === "" ? null : `https://${input}`; },
    nav: async (id, a) => { calls.push(`nav:${id}:${a}`); },
    setAllowlist: async () => {},
    setBounds: (id, rect, dpr, visible) => { bounds.push({ id, rect, dpr, visible }); },
    onState: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
  };
  const server: BrowserServerBridge = {
    get: async () => r,
    update: async (id, patch) => { updates.push({ id, ...patch }); },
    allowlist: async () => allowlist,
  };
  const bridges: BrowserBridges = { host, server };
  return {
    bridges, calls, bounds, updates,
    setAllowlist: (l: string[] | null) => { allowlist = l; },
    emit: (s: Partial<StateMsg>) => {
      const full: StateMsg = { id: "b1", url: "", title: "", loading: false, canGoBack: false, canGoForward: false, ...s };
      for (const cb of cbs) cb(full);
    },
  };
}

const state = (s: Partial<StateMsg>) => s;
const browserItem = () => item("i1", "s1", { kind: "browser", refId: "b1", title: "Browser" });

/** Flush the mount's async row/allowlist fetch + create, then the settle timer. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS + 20); });
}

describe("BrowserPane", () => {
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
      expect(store.getState().browserRects).toEqual([]);
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
  it("matches only the realm item MIME type", () => {
    expect(isRealmItemDrag({ dataTransfer: { types: ["application/x-realm-item"] } as unknown as DataTransfer })).toBe(true);
    expect(isRealmItemDrag({ dataTransfer: { types: ["Files"] } as unknown as DataTransfer })).toBe(false);
    expect(isRealmItemDrag({ dataTransfer: null })).toBe(false);
  });
});
