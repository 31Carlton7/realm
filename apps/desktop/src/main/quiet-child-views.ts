import { app, BrowserWindow, View, type WebContents } from "electron";
import { CHILD_VIEWS_BINDING, CHILD_VIEWS_GLOBAL, type ViewerChildView } from "@realm/contracts";

/**
 * Each quiet window's child views, left in the window's own page for a viewer relay to find.
 *
 * A screencast of a window's page has none of the `WebContentsView`s main lays over it. After any
 * view is added, removed, moved, shown or hidden, main writes the window's visible ones (DevTools
 * target id, rect in page CSS pixels) to `CHILD_VIEWS_GLOBAL` in that page and calls
 * `CHILD_VIEWS_BINDING` if a relay added it: the relay is on that page's socket already. Quiet mode
 * only (`installQuietWindows`): an app someone uses has no relay to tell.
 */

type ViewLike = { getVisible(): boolean; getBounds(): { x: number; y: number; width: number; height: number }; webContents?: WebContents };

/** The visible child views of one window, bottom first, with a target id each. Rects are in the
 *  window page's CSS pixels: the view's own bounds are DIPs, which the page's zoom divides. */
export function childViewsOf(children: ViewLike[], zoom: number, targetIdOf: (wc: WebContents) => string | null): ViewerChildView[] {
  const views: ViewerChildView[] = [];
  for (const view of children) {
    if (!view.webContents || !view.getVisible()) continue;
    const targetId = targetIdOf(view.webContents);
    if (!targetId) continue;
    const b = view.getBounds();
    views.push({ targetId, x: b.x / zoom, y: b.y / zoom, width: b.width / zoom, height: b.height / zoom });
  }
  return views;
}

export function publishChildViews(): void {
  const targetIds = new WeakMap<WebContents, string>();
  const asking = new WeakSet<WebContents>();
  const sent = new WeakMap<BrowserWindow, string>();
  let scheduled = false;

  const targetIdOf = (wc: WebContents): string | null => {
    const known = targetIds.get(wc);
    if (known || asking.has(wc) || wc.isDestroyed()) return known ?? null;
    asking.add(wc);
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      void (wc.debugger.sendCommand("Target.getTargetInfo") as Promise<{ targetInfo: { targetId: string } }>)
        .then(({ targetInfo }) => { targetIds.set(wc, targetInfo.targetId); schedule(); })
        .catch(() => {})
        .finally(() => asking.delete(wc));
    } catch { asking.delete(wc); } // DevTools has it
    return null;
  };

  const publish = () => {
    scheduled = false;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      const json = JSON.stringify(childViewsOf(win.contentView.children as ViewLike[], win.webContents.getZoomFactor(), targetIdOf));
      if (sent.get(win) === json) continue;
      sent.set(win, json);
      const text = JSON.stringify(json);
      void win.webContents.executeJavaScript(`globalThis.${CHILD_VIEWS_GLOBAL} = JSON.parse(${text}); globalThis.${CHILD_VIEWS_BINDING}?.(${text});`).catch(() => {});
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(publish);
  };

  const proto = View.prototype;
  for (const name of ["addChildView", "removeChildView", "setBounds", "setVisible"] as const) {
    const original = proto[name] as (...a: unknown[]) => unknown;
    (proto as unknown as Record<string, unknown>)[name] = function (this: View, ...a: unknown[]) {
      const result = original.apply(this, a);
      schedule();
      return result;
    };
  }
  // A page that reloads has lost what it was told.
  app.on("browser-window-created", (_e, win) => {
    win.webContents.on("did-finish-load", () => { sent.delete(win); schedule(); });
  });
}
