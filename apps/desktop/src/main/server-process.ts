import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type ServerInfo = { port: number; home: string };
export type ServerLine = { type: "ready"; port: number; home: string } | { type: "error"; message: string };

const READY_TIMEOUT_MS = 15_000;

/** Parse one stdout line from realm-server. Returns null for anything that isn't a ready/error announcement. */
export function parseServerLine(line: string): ServerLine | null {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return null; }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "ready" && typeof m.port === "number" && typeof m.home === "string") return { type: "ready", port: m.port, home: m.home };
  if (m.type === "error") return { type: "error", message: typeof m.message === "string" ? m.message : "unknown error" };
  return null;
}

/** Accumulates stdout chunks and yields the first ready/error line seen; unrelated lines are skipped. */
export class ReadyLineParser {
  private buf = "";
  feed(chunk: string): ServerLine | null {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const parsed = parseServerLine(line);
      if (parsed) return parsed;
    }
    return null;
  }
}

function serverEntry(): string {
  if (process.env.REALM_SERVER_ENTRY) return process.env.REALM_SERVER_ENTRY;
  const dev = join(app.getAppPath(), "..", "server", "dist", "main.js");
  if (existsSync(dev)) return dev;
  return join(process.resourcesPath, "server", "main.js");
}

export function startServer(): { child: ChildProcess; ready: Promise<ServerInfo> } {
  const nodeBin = process.env.REALM_NODE ?? "node";
  const child = spawn(nodeBin, [serverEntry()], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise<ServerInfo>((resolve, reject) => {
    const parser = new ReadyLineParser();
    const stdout = child.stdout!;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const onData = (d: Buffer | string) => {
      const line = parser.feed(d.toString());
      if (!line) return;
      if (line.type === "ready") finish(() => resolve({ port: line.port, home: line.home }));
      else finish(() => reject(new Error(`realm-server failed to start: ${line.message}`)));
    };
    const onError = (e: Error) => finish(() => reject(e));
    const onExit = (code: number | null) => finish(() => reject(new Error(`realm-server exited early with code ${code}. Is Node >=22.13 on PATH? (set REALM_NODE)`)));
    const timer = setTimeout(() => finish(() => reject(new Error(`realm-server did not report ready within ${READY_TIMEOUT_MS / 1000}s`))), READY_TIMEOUT_MS);
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return { child, ready };
}
