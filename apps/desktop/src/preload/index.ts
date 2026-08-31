import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const port = arg("realm-port");
export type PickedFile = { path: string; mime: string; name: string; size: number };
export type ScrollPhaseMessage = { phase: string; momentum: string; dx: number; dy: number; ts: number };
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
});
