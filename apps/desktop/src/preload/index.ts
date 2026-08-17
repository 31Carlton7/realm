import { contextBridge, ipcRenderer } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? "";
contextBridge.exposeInMainWorld("realm", {
  port: Number(arg("realm-port")), home: arg("realm-home"),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
});
