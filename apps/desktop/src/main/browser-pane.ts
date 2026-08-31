import { WebContentsView, screen, type BrowserWindow } from "electron";
import { BrowserPaneHost, type ViewFactory } from "./browser-host";

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
export function electronViewFactory(win: BrowserWindow): ViewFactory {
  return (_id, hooks) => {
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
      destroy: () => { win.contentView.removeChildView(view); wc.close(); },
    };
  };
}

export function createBrowserPaneHost(win: BrowserWindow): BrowserPaneHost {
  const host = new BrowserPaneHost({
    createView: electronViewFactory(win),
    sendState: (s) => { if (!win.isDestroyed()) win.webContents.send("realm:browser-state", s); },
    scaleFactor: () => screen.getDisplayMatching(win.getBounds()).scaleFactor,
  });
  // The views composite into this window; they must never outlive it.
  win.on("closed", () => host.destroyAll());
  return host;
}
