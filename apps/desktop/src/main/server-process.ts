import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type ServerInfo = { port: number; home: string };

function serverEntry(): string {
  if (process.env.REALM_SERVER_ENTRY) return process.env.REALM_SERVER_ENTRY;
  const dev = join(app.getAppPath(), "..", "server", "dist", "main.js");
  if (existsSync(dev)) return dev;
  return join(process.resourcesPath, "server", "main.js");
}

export function startServer(): Promise<{ child: ChildProcess; info: ServerInfo }> {
  return new Promise((resolve, reject) => {
    const nodeBin = process.env.REALM_NODE ?? "node";
    const child = spawn(nodeBin, [serverEntry()], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try { const msg = JSON.parse(line); if (msg.type === "ready") resolve({ child, info: { port: msg.port, home: msg.home } }); }
      catch { /* ignore non-JSON */ }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`realm-server exited early with code ${code}. Is Node >=22.13 on PATH? (set REALM_NODE)`)));
  });
}
