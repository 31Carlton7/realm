import { WebContentsView, screen, session, type BrowserWindow, type WebContents } from "electron";
import { BrowserPaneHost, browserUserAgent, isFindShortcut, type ViewFactory } from "./browser-host";
import type { CdpBinding } from "./browser-agent-host";
import { asDownloadItem, type DownloadDecision, type DownloadItemLike } from "./downloads";
import type { PasskeyCdp } from "./passkeys";

/** The browser views' session partition. Persistent and Realm's own: never the user's daily Chrome
 *  profile — they log in once inside Realm, and the isolation is structural (capability research §5:
 *  no shared cookies/autofill/OAuth grants with any real browser). */
export const BROWSER_PARTITION = "persist:browser";

/** Installs the pane's virtual authenticator and the passkey shim (passkeys.ts). Injected rather
 *  than imported so the factory stays testable and a build without it simply has no passkeys. */
export type PasskeyInstaller = (id: string, cdp: PasskeyCdp) => Promise<void>;

/**
 * How long the first navigation waits for the passkey install before going ahead without it.
 *
 * The install must finish BEFORE the first document runs script — a conditional-mediation get that
 * escapes the shim poisons the modal request the page's own passkey button makes next (passkeys.ts,
 * fact 4). But a pane that never loads is a worse failure than a pane without passkeys, so the wait
 * is bounded and the page wins the tie.
 */
export const PASSKEY_INSTALL_TIMEOUT_MS = 5_000;

/**
 * Put the authenticator and the shim in place before the pane's first real page.
 *
 * The `about:blank` is not ceremony. `WebAuthn.enable` and `addVirtualAuthenticator` answer on a view
 * that has never loaded anything, but `Page.enable`, `Runtime.enable` and `Runtime.addBinding` do
 * not — on a document-less view they never return at all (measured, Electron 37). One in-process
 * navigation to the emptiest document there is gives them something to attach to.
 */
async function installPasskeys(id: string, wc: WebContents, install: PasskeyInstaller): Promise<void> {
  try {
    await wc.loadURL("about:blank");
    if (wc.isDestroyed()) return;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await install(id, {
      send: (method, params) => wc.debugger.sendCommand(method, params) as Promise<unknown>,
      onEvent: (cb) => { wc.debugger.on("message", (_e, method, params) => cb(method, params)); },
    });
  } catch {
    // A pane without passkey support is exactly the pane Realm shipped before this existed. A pane
    // whose first navigation never happens is not.
  }
}

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
export function electronViewFactory(
  win: BrowserWindow,
  onView?: (id: string, wc: WebContents | null) => void,
  installPasskeysFor?: PasskeyInstaller,
): ViewFactory {
  return (id, hooks) => {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        // Untrusted web content: full Chromium sandbox, no node, no preload, isolated world.
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        // A browser pane keeps working while its space is off screen, and Chromium's default
        // undoes that: measured on Electron 37, a `setVisible(false)` WebContentsView drops a 50ms
        // interval to ~1Hz and reports `document.visibilityState === "hidden"`, which pages take as
        // their own cue to stop polling, stall SSE and pause media. With this off, the hidden view
        // ticks at full rate and still reads as visible to the page. The cost is CPU for pages
        // nobody is looking at, which is what RETAINED_VIEW_LIMIT exists to bound.
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#ffffffff"); // opaque — the window behind is transparent on macOS
    view.setVisible(false); // hidden until the renderer's first bounds sync places it
    win.contentView.addChildView(view);
    const wc = view.webContents;
    /* The pane's user agent, set before anything can load. Also set on the SESSION below, and both
       are needed rather than either: measured on Electron 37, `session.setUserAgent` reaches views
       created AFTER the call and leaves existing ones on the old string, so the session covers what
       has no view (workers, the partition's own fetches) and this covers the view in hand. One
       derivation feeds both, so they cannot drift. */
    wc.setUserAgent(browserUserAgent(wc.getUserAgent()));
    onView?.(id, wc);

    // The URL the pane was ASKED for, which is what every reader of this view's state wants to hear
    // about — `about:blank` below is Realm's own bootstrap and belongs to nobody's address bar.
    let wanted: string | null = null;
    const ready = installPasskeysFor
      ? Promise.race([
          installPasskeys(id, wc, installPasskeysFor),
          new Promise<void>((r) => setTimeout(r, PASSKEY_INSTALL_TIMEOUT_MS).unref?.()),
        ])
      : Promise.resolve();

    // Guard 1: no popups, ever — a window.open becomes an in-place navigation (allowlist-checked
    // inside the host's navigate), so the pane can never spawn a window Realm does not manage.
    wc.setWindowOpenHandler(({ url }) => { hooks.openInPlace(url); return { action: "deny" }; });
    // Guard 2: page-initiated navigations (and per-hop redirects) consult the per-space allowlist.
    const guard = (e: { preventDefault(): void }, url: string) => { if (!hooks.allowNavigate(url)) e.preventDefault(); };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);

    /* Realm's `about:blank` bootstrap (above) commits a history entry like any page does, so the first
       real page had a Back — and a row in the back menu and in History — that went to a blank view the
       address bar still named as the page. Once the first real page commits, the bootstrap entry goes.
       Registered ahead of the state events below, so the state they send already has no Back. */
    const dropBootstrapEntry = (_e: unknown, url: string) => {
      if (url === "about:blank") return;
      wc.off("did-navigate", dropBootstrapEntry);
      const history = wc.navigationHistory;
      if (history.getActiveIndex() > 0 && history.getEntryAtIndex(0)?.url === "about:blank") history.removeEntryAtIndex(0);
    };
    if (installPasskeysFor) wc.on("did-navigate", dropBootstrapEntry);

    const stateEvents = [
      "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page",
      "page-title-updated", "did-fail-load",
    ] as const;
    for (const ev of stateEvents) wc.on(ev as Parameters<typeof wc.on>[0], () => hooks.emitState());
    wc.on("found-in-page", (_e, r) => hooks.found({ activeMatchOrdinal: r.activeMatchOrdinal, matches: r.matches, finalUpdate: r.finalUpdate }));
    // ⌘F with the page holding the keyboard. That keydown goes to this view's renderer, never to the
    // window's, so this is the only place it can be heard; taken from the page so a site's own ⌘F
    // handler (or Chromium's, which there is none of here) does not also run.
    wc.on("before-input-event", (e, input) => {
      if (isFindShortcut(input, process.platform)) { e.preventDefault(); hooks.findShortcut(); }
    });

    return {
      setBounds: (r) => view.setBounds(r),
      setVisible: (v) => view.setVisible(v),
      loadURL: (url) => {
        wanted = url;
        // Queued behind the passkey install rather than racing it: a page that runs its own scripts
        // first is a page whose passkey button is already broken.
        void ready.then(() => {
          if (wc.isDestroyed() || wanted !== url) return;
          wc.loadURL(url).catch(() => { /* did-fail-load reports honestly */ });
        });
      },
      goBack: () => wc.navigationHistory.goBack(),
      goForward: () => wc.navigationHistory.goForward(),
      reload: () => wc.reload(),
      stop: () => wc.stop(),
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      history: () => ({
        // `getAllEntries` carries a `pageState` blob as well; only the two fields a menu row needs
        // cross into the host, which keeps the handle's shape the thing the fake has to satisfy.
        entries: wc.navigationHistory.getAllEntries().map((e) => ({ url: e.url, title: e.title })),
        activeIndex: wc.navigationHistory.getActiveIndex(),
      }),
      goToIndex: (index) => wc.navigationHistory.goToIndex(index),
      getURL: () => {
        const live = wc.getURL();
        return live === "about:blank" || live === "" ? wanted ?? "" : live;
      },
      getTitle: () => wc.getTitle(),
      isLoading: () => wc.isLoading(),
      findInPage: (text, opts) => { wc.findInPage(text, opts); },
      stopFindInPage: () => wc.stopFindInPage("clearSelection"),
      getZoomFactor: () => wc.getZoomFactor(),
      setZoomFactor: (factor) => wc.setZoomFactor(factor),
      // The system dialog, attached to the window. A failure or a cancel is the dialog's to report.
      print: () => wc.print({}, () => {}),
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
  /** Trustworthy page identity, straight off the webContents — never page-authored text — and
   *  whether it is still loading, which is what the pane's own spinner shows. */
  pageState(id: string): { url: string; title: string; loading: boolean } | null;
  /** browser id for a WebContents id — how the partition-wide download handler finds its pane. */
  browserIdForWebContents(webContentsId: number): string | null;
  /** Re-request a URL as a download, on the view's own session so its cookies apply (Plan 23 W4's
   *  Save button). Fires `will-download` again — which is still default-deny, so this only produces
   *  a file when the governor has been armed for this pane first. */
  downloadURL(id: string, url: string): void;
  /** Fires on view destruction, so the agent host can drop buffers and snapshot state. */
  onViewDestroyed(cb: (id: string) => void): void;
  /** The view's visible viewport as a PNG, or null when there is no view or nothing was drawn.
   *  The VIEW's own capture: the window's `capturePage` composites no child view and comes back blank
   *  over the whole of the page. */
  capture(id: string): Promise<Uint8Array | null>;
};

export function createBrowserPane(win: BrowserWindow, installPasskeysFor?: PasskeyInstaller): BrowserPane {
  const views = new Map<string, WebContents>();
  const destroyedCbs: ((id: string) => void)[] = [];
  const send = (channel: string, payload: unknown) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); };
  const host = new BrowserPaneHost({
    createView: electronViewFactory(win, (id, wc) => {
      if (wc) views.set(id, wc);
      else { views.delete(id); for (const cb of destroyedCbs) cb(id); }
    }, installPasskeysFor),
    sendState: (s) => send("realm:browser-state", s),
    scaleFactor: () => screen.getDisplayMatching(win.getBounds()).scaleFactor,
    sendFound: ({ id, ...result }) => send("realm:browser-found", { browserId: id, ...result }),
    // The keyboard is in the VIEW when this fires, and focusing an input inside the window's own page
    // does not move it — typing would go on landing in the site. Handing focus to the window's
    // webContents first is what lets the find field the pane focuses actually receive the keys.
    requestFind: (id) => {
      if (win.isDestroyed()) return;
      win.webContents.focus();
      send("realm:browser-find-request", { browserId: id });
    },
    emulate: (id, metrics) => {
      const wc = views.get(id);
      if (!wc || wc.isDestroyed()) return;
      try { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); } catch { return; } // DevTools has it
      void (metrics
        ? wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", metrics)
        : wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride")).catch(() => {});
    },
  });
  applyBrowserUserAgent();
  // The views composite into this window; they must never outlive it.
  win.on("closed", () => host.destroyAll());
  return {
    host,
    hasView: (id) => { const wc = views.get(id); return !!wc && !wc.isDestroyed(); },
    pageState: (id) => {
      const wc = views.get(id);
      return wc && !wc.isDestroyed() ? { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() } : null;
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
    capture: async (id) => {
      const wc = views.get(id);
      if (!wc || wc.isDestroyed()) return null;
      // At a device preset the view's own capture is the emulated SURFACE — for a desktop width scaled
      // into a narrow pane, a page shrunk into one corner of a mostly blank picture (measured). CDP's
      // capture is the emulated viewport at full size, which is the screenshot a person asked for.
      if (host.deviceOf(id) && wc.debugger.isAttached()) {
        const shot = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" }).catch(() => null) as { data?: string } | null;
        if (shot?.data) return new Uint8Array(Buffer.from(shot.data, "base64"));
      }
      const image = await wc.capturePage();
      return image.isEmpty() ? null : new Uint8Array(image.toPNG());
    },
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
 * Put the pane user agent on the partition's session. Once per process, like
 * `governBrowserDownloads` and for the same reason: the session outlives any window, and a second
 * window must not re-derive a string from a UA its own views have already been given.
 *
 * Deliberately reads the session's CURRENT default rather than a constant, so the string tracks
 * whatever Chromium the app ships without anyone remembering to update it — which is the failure
 * mode a hardcoded UA has, and it fails by claiming an engine version that no longer exists.
 */
let userAgentApplied = false;
export function applyBrowserUserAgent(): void {
  if (userAgentApplied) return;
  userAgentApplied = true;
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
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
    const decision = d.decide(d.browserIdFor(wcId), asDownloadItem(item));
    if (decision.allow) return; // the governor already called setSavePath and wired the item
    event.preventDefault();
    // The filename travels too, so W4's bar can name what was blocked. Page/server-authored, and
    // sanitized by `BlockedDownloads.note` before it is stored or shown — never used as a path here.
    d.onBlocked(wcId, item.getURL(), decision.refused, item.getFilename());
  });
}

/**
 * Cookies, site storage and the HTTP cache of the browser partition (Plan 26 W7b's Clear browsing
 * data). Every pane's at once, and not as a side effect: the panes share this one partition, which is
 * what keeps a sign-in made in one pane good in the next — and so what one clear takes from all of them.
 * Realm's saved sign-ins and passkeys are not in the partition (they are in the Keychain-sealed secret
 * store), so they are untouched by this.
 */
export async function clearBrowserPartition(): Promise<void> {
  const ses = session.fromPartition(BROWSER_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
}
