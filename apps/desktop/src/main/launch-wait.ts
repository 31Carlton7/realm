import type { MaintenanceMarker } from "@realm/contracts";
import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import mark from "../../../../resources/icon-src/mark.svg?raw";

/**
 * What a launch shows while it waits on a server busy with maintenance (`MaintenanceMarker`).
 *
 * The launch opens no Realm window until it has a server to point it at, and a server compacting
 * realm.db can keep it waiting for minutes. With nothing on screen in that time, Realm looks like it
 * never opened. So a small window says what the wait is for, and goes when the first Realm window
 * opens.
 */

const WAIT_TEXT: Record<MaintenanceMarker["what"], string> = {
  "vacuum": "Realm is tidying its database…",
  "heap-snapshot": "Realm is saving a memory report…",
};

export const launchWaitText = (what: MaintenanceMarker["what"]): string => WAIT_TEXT[what];

/** The notice's page: the mark and the line, inline, so it needs nothing from disk. */
export function launchWaitPage(text: string): string {
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Realm</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: transparent; -webkit-user-select: none; cursor: default; }
  body { display: grid; place-content: center; justify-items: center; gap: 14px; -webkit-app-region: drag;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; color: CanvasText; }
  svg { width: 40px; height: auto; }
  p { margin: 0; }
</style></head>
<body>${mark}<p>${text}</p></body></html>`;
}

/** Show the notice for `what`. The returned function closes it, and is safe to call twice. */
export function showLaunchWait(what: MaintenanceMarker["what"], extra: BrowserWindowConstructorOptions = {}): () => void {
  const win = new BrowserWindow({
    width: 340, height: 150, center: true, show: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    titleBarStyle: "hiddenInset", vibrancy: "sidebar", backgroundColor: "#00000000",
    title: "Realm",
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    ...extra,
  });
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show(); });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(launchWaitPage(launchWaitText(what)))}`);
  return () => { if (!win.isDestroyed()) win.destroy(); };
}
