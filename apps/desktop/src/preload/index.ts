import { contextBridge, ipcRenderer } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const port = arg("realm-port");
contextBridge.exposeInMainWorld("realm", {
  port: port === undefined ? NaN : Number(port), home: arg("realm-home") ?? "",
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
});
