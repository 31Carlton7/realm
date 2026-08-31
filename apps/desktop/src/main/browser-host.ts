/**
 * The browser pane's main-process core (Plan 11 W1) — every DECISION lives here, with no Electron
 * import, so the guards and lifecycle are unit-testable. The Electron calls (WebContentsView,
 * webContents events) live behind `ViewFactory`, implemented in browser-pane.ts.
 */

export type ViewRect = { x: number; y: number; width: number; height: number };

/** What the renderer's chrome renders from — pushed main→renderer on every navigation/title/loading
 *  change. Favicon deliberately skipped for W1. */
export type BrowserViewState = {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
};

/** Address-bar input → a loadable URL. https is the default scheme; a non-URL just gets `https://`
 *  prefixed and may fail honestly (search fallback is out of scope for W1). The one pragmatic
 *  exception: loopback hosts get `http://` — dev servers do not speak TLS. Null = nothing to load. */
export function normalizeAddress(input: string): string | null {
  const s = input.trim();
  if (s === "") return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s === "about:blank") return s;
  const host = s.replace(/^\/*/, "").split(/[/?#]/)[0] ?? "";
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]" || host.startsWith("[::1]")) return `http://${s}`;
  return `https://${s}`;
}

/**
 * The per-space origin allowlist check (consulted by `will-navigate`, `will-redirect`, and every
 * host-initiated navigate). `null` = no list configured = allow everything — W1's default posture;
 * the restrictive default is a settings-product decision deferred to that plan's W2.
 *
 * This is a GUARDRAIL against agent/user mistakes, explicitly NOT a security boundary: DNS rebinding,
 * server-side redirect chains (we check will-redirect, but only per-hop origin), and subresource
 * loads (W3's Fetch-level enforcement) all get past an origin string comparison. Treat it as a fence,
 * not a wall.
 */
export function originAllowed(url: string, allowlist: readonly string[] | null): boolean {
  if (allowlist === null) return true;
  if (url === "about:blank") return true; // the empty page is nobody's origin
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  if (origin === "null") return false; // opaque origins (data:, blob: without http base) never match a list
  return allowlist.some((entry) => {
    const e = entry.trim(); if (e === "") return false;
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `https://${e}`).origin === origin; } catch { return false; }
  });
}

/**
 * Placeholder rect (renderer CSS px) → view bounds (DIPs relative to the window's content view).
 * CSS px * zoom = DIP, and the renderer's devicePixelRatio = displayScaleFactor * zoomFactor, so
 * DIP = css * dpr / scaleFactor — which also stays correct when the user has zoomed the app.
 * Rounded (setBounds takes integers) and clamped so a mid-layout negative rect can never throw.
 */
export function toViewBounds(rect: ViewRect, dpr: number, scaleFactor: number): ViewRect {
  const k = scaleFactor > 0 && dpr > 0 ? dpr / scaleFactor : 1;
  return {
    x: Math.round(rect.x * k), y: Math.round(rect.y * k),
    width: Math.max(0, Math.round(rect.width * k)), height: Math.max(0, Math.round(rect.height * k)),
  };
}

/** The thin Electron adapter each live view is driven through. */
export type ViewHandle = {
  setBounds(r: ViewRect): void;
  setVisible(visible: boolean): void;
  loadURL(url: string): void;
  goBack(): void; goForward(): void; reload(): void; stop(): void;
  canGoBack(): boolean; canGoForward(): boolean;
  getURL(): string; getTitle(): string; isLoading(): boolean;
  destroy(): void;
};

export type ViewHooks = {
  /** Wire to every navigation/title/loading webContents event. */
  emitState(): void;
  /** `will-navigate` / `will-redirect` consult — false means preventDefault. */
  allowNavigate(url: string): boolean;
  /** `setWindowOpenHandler` funnel: every window.open/target=_blank is DENIED as a window and offered
   *  back as an in-place navigation of the same view. */
  openInPlace(url: string): void;
};

export type ViewFactory = (id: string, hooks: ViewHooks) => ViewHandle;

/**
 * One `WebContentsView` per open browser item, keyed by browser id. Owns lifecycle (create is
 * idempotent; destroy is final; destroyAll on window teardown — a view never outlives its window),
 * the navigation guards, and the state channel back to the renderer.
 */
export class BrowserPaneHost {
  private views = new Map<string, { handle: ViewHandle; allowlist: string[] | null }>();

  constructor(private opts: {
    createView: ViewFactory;
    sendState: (s: BrowserViewState) => void;
    /** The window's display scale factor at the time of a bounds sync. */
    scaleFactor: () => number;
  }) {}

  has(id: string): boolean { return this.views.has(id); }

  /** Idempotent: React StrictMode double-mounts, and a remount must not reload the page. */
  create(id: string, url: string, allowlist: string[] | null): void {
    if (this.views.has(id)) { this.emitState(id); return; }
    const handle = this.opts.createView(id, {
      emitState: () => this.emitState(id),
      allowNavigate: (target) => originAllowed(target, this.views.get(id)?.allowlist ?? null),
      openInPlace: (target) => this.navigate(id, target),
    });
    this.views.set(id, { handle, allowlist });
    const normalized = normalizeAddress(url);
    if (normalized && originAllowed(normalized, allowlist)) handle.loadURL(normalized);
    this.emitState(id);
  }

  /** Every host-initiated navigation (address bar, window.open funnel) passes the same allowlist the
   *  page's own navigations do — `loadURL` does not fire `will-navigate`, so checking here is what
   *  keeps the two paths equally fenced. Returns the normalized URL, or null when refused/no-op. */
  navigate(id: string, input: string): string | null {
    const v = this.views.get(id); if (!v) return null;
    const url = normalizeAddress(input);
    if (!url || !originAllowed(url, v.allowlist)) return null;
    v.handle.loadURL(url);
    return url;
  }

  navAction(id: string, action: "back" | "forward" | "reload" | "stop"): void {
    const v = this.views.get(id); if (!v) return;
    if (action === "back") v.handle.goBack();
    else if (action === "forward") v.handle.goForward();
    else if (action === "reload") v.handle.reload();
    else v.handle.stop();
  }

  /** Per-frame renderer→main sync: placeholder rect + the renderer's devicePixelRatio, plus the
   *  renderer's visibility verdict (it hides the view during pane drags and layout settles — the
   *  research's bounds-lag mitigation lives on the renderer side, where the drag is known). */
  setBounds(id: string, rect: ViewRect, dpr: number, visible: boolean): void {
    const v = this.views.get(id); if (!v) return;
    v.handle.setBounds(toViewBounds(rect, dpr, this.opts.scaleFactor()));
    v.handle.setVisible(visible);
  }

  setAllowlist(id: string, allowlist: string[] | null): void {
    const v = this.views.get(id); if (v) v.allowlist = allowlist;
  }

  /** Final: a browser is not a terminal — closing the pane kills the view, no hidden survival. */
  destroy(id: string): void {
    const v = this.views.get(id); if (!v) return;
    this.views.delete(id);
    v.handle.destroy();
  }

  /** Window teardown: the views must never outlive the window they composite into. */
  destroyAll(): void { for (const id of [...this.views.keys()]) this.destroy(id); }

  private emitState(id: string): void {
    const v = this.views.get(id); if (!v) return;
    this.opts.sendState({
      id, url: v.handle.getURL(), title: v.handle.getTitle(), loading: v.handle.isLoading(),
      canGoBack: v.handle.canGoBack(), canGoForward: v.handle.canGoForward(),
    });
  }
}
