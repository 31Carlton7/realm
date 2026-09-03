import { WebContentsView, screen, session, type BrowserWindow, type WebContents } from "electron";
import { BrowserPaneHost, type ViewFactory } from "./browser-host";
import type { CdpBinding } from "./browser-agent-host";
import type { DownloadDecision, DownloadItemLike } from "./downloads";

/** The browser views' session partition. Persistent and Realm's own: never the user's daily Chrome
 *  profile — they log in once inside Realm, and the isolation is structural (capability research §5:
 *  no shared cookies/autofill/OAuth grants with any real browser). */
export const BROWSER_PARTITION = "persist:browser";

/**
 * The thin Electron half of the browser pane (Plan 11 W1): every decision is in browser-host.ts;
 * this file only touches WebContentsView.
 *
 * Layering: a WebContentsView composites ABOVE the window's DOM, always (wontfix, electron#16854) —
 * that is why W2's no-overlay layout exists and why the pane's own chrome is inline-only. On macOS
 * the window is transparent-backed for sidebar vibrancy; the view must paint opaque (white, the
 * neutral ground most pages assume) so no vibrancy material ever shines through page transparency.
 * Within its bounds it covers the renderer; outside them it does not exist — nothing else to verify.
 */
export function electronViewFactory(win: BrowserWindow, onView?: (id: string, wc: WebContents | null) => void): ViewFactory {
  return (id, hooks) => {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        // Untrusted web content: full Chromium sandbox, no node, no preload, isolated world.
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    view.setBackgroundColor("#ffffffff"); // opaque — the window behind is transparent on macOS
    view.setVisible(false); // hidden until the renderer's first bounds sync places it
    win.contentView.addChildView(view);
    const wc = view.webContents;
    onView?.(id, wc);

    // Guard 1: no popups, ever — a window.open becomes an in-place navigation (allowlist-checked
    // inside the host's navigate), so the pane can never spawn a window Realm does not manage.
    wc.setWindowOpenHandler(({ url }) => { hooks.openInPlace(url); return { action: "deny" }; });
    // Guard 2: page-initiated navigations (and per-hop redirects) consult the per-space allowlist.
    const guard = (e: { preventDefault(): void }, url: string) => { if (!hooks.allowNavigate(url)) e.preventDefault(); };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);

    const stateEvents = [
      "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page",
      "page-title-updated", "did-fail-load",
    ] as const;
    for (const ev of stateEvents) wc.on(ev as Parameters<typeof wc.on>[0], () => hooks.emitState());

    return {
      setBounds: (r) => view.setBounds(r),
      setVisible: (v) => view.setVisible(v),
      loadURL: (url) => { wc.loadURL(url).catch(() => { /* did-fail-load reports honestly */ }); },
      goBack: () => wc.navigationHistory.goBack(),
      goForward: () => wc.navigationHistory.goForward(),
      reload: () => wc.reload(),
      stop: () => wc.stop(),
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      getURL: () => wc.getURL(),
      getTitle: () => wc.getTitle(),
      isLoading: () => wc.isLoading(),
      destroy: () => {
        onView?.(id, null);
        // On window close, Electron tears the child views down WITH the window before our "closed"
        // listener runs — destroying again throws "Object has been destroyed" (user-hit crash,
        // 2026-08-31). The guard makes teardown idempotent from either direction.
        if (wc.isDestroyed()) return;
        if (!win.isDestroyed()) win.contentView.removeChildView(view);
        wc.close();
      },
    };
  };
}

export function createBrowserPaneHost(win: BrowserWindow): BrowserPaneHost {
  return createBrowserPane(win).host;
}

/** What the browser agent's executor needs from the pane layer (Plan 11 W3): the pane host itself
 *  plus per-id access to the live views' CDP and identity, and view-lifecycle notifications. */
export type BrowserPane = {
  host: BrowserPaneHost;
  /** Attach `webContents.debugger` (flatten-mode CDP, no debugging port) for a live view. Idempotent
   *  per view; null when the view is gone or the attach was refused (DevTools already attached). */
  attachCdp(id: string): CdpBinding | null;
  hasView(id: string): boolean;
  /** Trustworthy page identity, straight off the webContents — never page-authored text. */
  pageState(id: string): { url: string; title: string } | null;
  /** browser id for a WebContents id — how the partition-wide download handler finds its pane. */
  browserIdForWebContents(webContentsId: number): string | null;
  /** Re-request a URL as a download, on the view's own session so its cookies apply (Plan 23 W4's
   *  Save button). Fires `will-download` again — which is still default-deny, so this only produces
   *  a file when the governor has been armed for this pane first. */
  downloadURL(id: string, url: string): void;
  /** Fires on view destruction, so the agent host can drop buffers and snapshot state. */
  onViewDestroyed(cb: (id: string) => void): void;
};

export function createBrowserPane(win: BrowserWindow): BrowserPane {
  const views = new Map<string, WebContents>();
  const destroyedCbs: ((id: string) => void)[] = [];
  const host = new BrowserPaneHost({
    createView: electronViewFactory(win, (id, wc) => {
      if (wc) views.set(id, wc);
      else { views.delete(id); for (const cb of destroyedCbs) cb(id); }
    }),
    sendState: (s) => { if (!win.isDestroyed()) win.webContents.send("realm:browser-state", s); },
    scaleFactor: () => screen.getDisplayMatching(win.getBounds()).scaleFactor,
  });
  // The views composite into this window; they must never outlive it.
  win.on("closed", () => host.destroyAll());
  return {
    host,
    hasView: (id) => { const wc = views.get(id); return !!wc && !wc.isDestroyed(); },
    pageState: (id) => {
      const wc = views.get(id);
      return wc && !wc.isDestroyed() ? { url: wc.getURL(), title: wc.getTitle() } : null;
    },
    browserIdForWebContents: (webContentsId) => {
      for (const [id, wc] of views) if (!wc.isDestroyed() && wc.id === webContentsId) return id;
      return null;
    },
    downloadURL: (id, url) => {
      const wc = views.get(id);
      if (wc && !wc.isDestroyed()) wc.downloadURL(url);
    },
    onViewDestroyed: (cb) => destroyedCbs.push(cb),
    attachCdp: (id) => {
      const wc = views.get(id);
      if (!wc || wc.isDestroyed()) return null;
      try { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); } catch { return null; }
      return {
        send: (method, params) => wc.debugger.sendCommand(method, params) as Promise<unknown>,
        onEvent: (cb) => { wc.debugger.on("message", (_e, method, params) => cb(method, params)); },
      };
    },
  };
}

/**
 * Downloads on the browser partition (Plan 11 W3, narrowed by Plan 23).
 *
 * The posture is unchanged in its resting state: **`will-download` is default-deny**, and the
 * `preventDefault()` below runs for every download that is not covered by a live, one-shot,
 * server-gated grant. What Plan 23 added is that one branch, not a setting — see `downloads.ts` for
 * why "permit the user, keep blocking the agent" is not implementable at this layer (CDP input is
 * indistinguishable from a real click, so any rule loose enough for a human is loose for the agent).
 *
 * Registered once per partition. `decide` is the governor's; this function only translates its answer
 * into Electron's event API and routes the notice to the pane's console buffer via the wc→browser map.
 */
let downloadsGoverned = false;
export function governBrowserDownloads(d: {
  browserIdFor(webContentsId: number): string | null;
  decide(browserId: string | null, item: DownloadItemLike): DownloadDecision;
  onBlocked(webContentsId: number, url: string, reason: string, filename: string): void;
}): void {
  if (downloadsGoverned) return;
  downloadsGoverned = true;
  session.fromPartition(BROWSER_PARTITION).on("will-download", (event, item, wc) => {
    const wcId = wc?.id ?? -1;
    const decision = d.decide(d.browserIdFor(wcId), item as unknown as DownloadItemLike);
    if (decision.allow) return; // the governor already called setSavePath and wired the item
    event.preventDefault();
    // The filename travels too, so W4's bar can name what was blocked. Page/server-authored, and
    // sanitized by `BlockedDownloads.note` before it is stored or shown — never used as a path here.
    d.onBlocked(wcId, item.getURL(), decision.refused, item.getFilename());
  });
}
