import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

/**
 * The pieces Plan 28's Phase 1 scripts stand up: the BUILT server on a scratch home with the fake
 * agent, the relay's real Worker under `wrangler dev`, and a recording tap in front of the relay. Every
 * piece is killed by `stop()`; nothing here ever touches the owner's `~/Realm`.
 */

export const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

export const freePort = (): Promise<number> => new Promise((ok, bad) => {
  const s = createServer();
  s.once("error", bad);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => ok(port)); });
});

export function refuseRealHome(home: string): void {
  if (resolve(home) === resolve(homedir(), "Realm")) throw new Error("refusing to run against ~/Realm — Phase 1 is scratch homes only");
}

export type Server = { home: string; port: number; token: string; stop(): void };

/** Boots `apps/server/dist/main.js` the way the live checks do, on a fresh scratch home. */
export async function bootServer(o: { home?: string } = {}): Promise<Server> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "realm-mobile-home-"));
  refuseRealHome(home);
  const child = spawn(process.execPath, [join(repoRoot, "apps/server/dist/main.js")], {
    env: { ...process.env, REALM_HOME: home, REALM_PORT: "0", REALM_ENABLE_FAKE_AGENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", () => {});
  const port = await new Promise<number>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error("server did not report ready")), 30_000);
    let buffer = "";
    child.once("exit", (code) => bad(new Error(`server exited (${code})`)));
    child.stdout!.on("data", (bytes: Buffer) => {
      buffer += bytes.toString();
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { const row = JSON.parse(line) as { type?: string; port?: number }; if (row.type === "ready" && row.port) { clearTimeout(timer); ok(row.port); } } catch { /* other output */ }
      }
    });
  });
  const state = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { token: string };
  return {
    home, port, token: state.token,
    stop: () => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3_000).unref(); },
  };
}

export type Relay = { url: string; stop(): void };

/** The relay's real Worker code in workerd, on loopback. */
export async function wranglerDev(): Promise<Relay> {
  const port = await freePort();
  const child: ChildProcess = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"], {
    cwd: join(repoRoot, "services/relay"), env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  child.stdout!.on("data", (b: Buffer) => { log += b.toString(); });
  child.stderr!.on("data", (b: Buffer) => { log += b.toString(); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log.slice(-2_000)}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`wrangler dev never answered /health:\n${log.slice(-2_000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url: `ws://127.0.0.1:${port}`,
    // wrangler starts workerd as a grandchild; the group kill is what reaps it.
    stop: () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } },
  };
}

export type Tap = { url: string; frames: number; bytes: number; sawMarker: () => boolean; stop(): void };

/**
 * A WebSocket man-in-the-middle that relays every message both ways and looks for `marker` in each,
 * text and binary alike. It sees exactly what the relay sees — so "the marker never crossed in the
 * clear" is a statement about the relay, not about our own code's good intentions.
 */
export async function startTap(upstream: string, marker: string): Promise<Tap> {
  const needle = Buffer.from(marker, "utf8");
  let hits = 0;
  const stats = { frames: 0, bytes: 0 };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (client, req) => {
    const up = new WebSocket(`${upstream}${req.url ?? ""}`);
    const queue: { data: Buffer; binary: boolean }[] = [];
    const inspect = (data: Buffer) => { stats.frames += 1; stats.bytes += data.length; if (data.includes(needle)) hits += 1; };
    client.on("message", (data: Buffer, binary: boolean) => {
      inspect(data);
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary }); else queue.push({ data, binary });
    });
    up.on("open", () => { for (const m of queue.splice(0)) up.send(m.data, { binary: m.binary }); });
    up.on("message", (data: Buffer, binary: boolean) => { inspect(data); if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
    const closeCode = (c: number) => (c >= 1000 && c <= 4999 && c !== 1005 && c !== 1006 ? c : 1000);
    up.on("close", (code, reason) => client.close(closeCode(code), reason));
    client.on("close", (code, reason) => up.close(closeCode(code), reason));
    up.on("error", () => client.terminate());
    client.on("error", () => up.terminate());
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    get frames() { return stats.frames; },
    get bytes() { return stats.bytes; },
    sawMarker: () => hits > 0,
    stop: () => { for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}

export const removeHome = (home: string): void => { refuseRealHome(home); rmSync(home, { recursive: true, force: true }); };

export const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

export const ms = (x: number): string => `${x.toFixed(x < 10 ? 2 : 1)} ms`;
