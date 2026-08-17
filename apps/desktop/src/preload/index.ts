import { contextBridge } from "electron";
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? "";
contextBridge.exposeInMainWorld("realm", { port: Number(arg("realm-port")), home: arg("realm-home") });
