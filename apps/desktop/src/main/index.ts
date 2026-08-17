import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { startServer } from "./server-process";

let serverChild: import("node:child_process").ChildProcess | null = null;

async function createWindow(info: { port: number; home: string }) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
    webPreferences: { preload: join(__dirname, "../preload/index.mjs"), contextIsolation: true, sandbox: false,
      additionalArguments: [`--realm-port=${info.port}`, `--realm-home=${info.home}`] },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  try {
    const { child, info } = await startServer();
    serverChild = child;
    child.on("exit", () => { serverChild = null; });
    await createWindow(info);
  } catch (e) {
    console.error(e);
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { serverChild?.kill("SIGTERM"); });
