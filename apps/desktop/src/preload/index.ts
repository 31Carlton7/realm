import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const port = arg("realm-port");
export type PickedFile = { path: string; mime: string; name: string; size: number };
export type ScrollPhaseMessage = { phase: string; momentum: string; dx: number; dy: number; ts: number };
export type BrowserViewState = { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
contextBridge.exposeInMainWorld("realm", {
  port: port === undefined ? NaN : Number(port), home: arg("realm-home") ?? "",
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
  /** Native multi-select file picker; [] when cancelled. */
  pickFiles: (): Promise<PickedFile[]> => ipcRenderer.invoke("pick-files"),
  /** Write a pasted (pathless) file under Realm's home and describe it like a picked one. */
  saveTempAttachment: (name: string, mime: string, bytes: Uint8Array): Promise<PickedFile> => ipcRenderer.invoke("save-temp-attachment", name, mime, bytes),
  /** The real filesystem path behind a dropped File. Electron 32 removed `File.path`; `webUtils` is
   *  its documented replacement and only exists in the preload. Returns "" for a pathless File —
   *  which is exactly how a pasted image announces that it has to be written out first. */
  pathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  /** Native trackpad scroll phases from the macOS helper (may never fire if the helper is absent). */
  onScrollPhase: (cb: (m: ScrollPhaseMessage) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, m: ScrollPhaseMessage) => cb(m);
    ipcRenderer.on("realm:scroll-phase", handler);
    return () => ipcRenderer.removeListener("realm:scroll-phase", handler);
  },
  /** Browser pane (Plan 11 W1): drives the native WebContentsView the main process owns for a
   *  browser item. `setBounds` is per-frame and fire-and-forget; the rest are invokes. */
  browser: {
    create: (id: string, url: string, allowlist: string[] | null): Promise<void> => ipcRenderer.invoke("browser:create", id, url, allowlist),
    destroy: (id: string): Promise<void> => ipcRenderer.invoke("browser:destroy", id),
    /** Resolves the normalized URL actually loaded, or null when refused (allowlist) / empty. */
    navigate: (id: string, input: string): Promise<string | null> => ipcRenderer.invoke("browser:navigate", id, input),
    nav: (id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void> => ipcRenderer.invoke("browser:nav", id, action),
    setAllowlist: (id: string, allowlist: string[] | null): Promise<void> => ipcRenderer.invoke("browser:set-allowlist", id, allowlist),
    setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void =>
      ipcRenderer.send("browser:set-bounds", id, rect, dpr, visible),
    onState: (cb: (s: BrowserViewState) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: BrowserViewState) => cb(s);
      ipcRenderer.on("realm:browser-state", handler);
      return () => ipcRenderer.removeListener("realm:browser-state", handler);
    },
  },
});
