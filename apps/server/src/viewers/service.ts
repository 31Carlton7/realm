import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { newId, ViewerOpenSchema, type Viewer, type ViewerOpen } from "@realm/contracts";
import { NotFoundError, RpcError } from "../store/rows";
import { originAllowed } from "../rpc/server";
import { CDP_TIMEOUT_MS, ElectronRelay } from "./electron-relay";
import type { HiddenApp } from "./hidden-apps";

/**
 * Hidden apps shown as pictures. Each viewer is one live connection to a running process, so they
 * are kept in memory only: nothing about one outlives the app or this server.
 *
 * One loopback HTTP server carries every viewer's picture (`/<secret>/<id>/frames`), layers socket
 * (`/<secret>/<id>/layers`) and input socket (`/<secret>/<id>/input`), as `AndroidStream` does for
 * emulators. The secret is in the path because an `<img src>` cannot set headers, and each viewer has
 * its own, so one viewer's URL opens no other.
 *
 * A viewer opens only on an app Realm's own launcher started (`HiddenApps`), never on a port a caller
 * names, and never on Realm's own DevTools port: CDP input skips the guards Realm's UI puts in front
 * of an agent, so a viewer on the owner's window would let an agent answer its own cards.
 */
export class ViewerService {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly viewers = new Map<string, { viewer: Viewer; secret: string; relay: ElectronRelay; inputs: Set<WebSocket> }>();

  constructor(private readonly opts: {
    apps: { get(id: string): HiddenApp | undefined };
    /** The port Realm's own window serves DevTools on, if it does (`REALM_DEVTOOLS_PORT`). */
    ownDevtoolsPort?: number | null;
    /** The origins Realm's renderer loads from: the RPC socket's list. */
    allowedOrigins?: readonly string[];
    stillMs?: number;
    timeoutMs?: number;
  }) {}

  private async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const entry = this.match(req.url ?? "", "frames");
      if (!entry) { res.writeHead(404).end(); return; }
      entry.relay.serve(res);
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (!originAllowed(req.headers.origin, this.opts.allowedOrigins)) { socket.destroy(); return; }
      const layers = this.match(req.url ?? "", "layers");
      if (layers) {
        wss.handleUpgrade(req, socket, head, (ws) => layers.relay.serveLayers(ws));
        return;
      }
      const entry = this.match(req.url ?? "", "input");
      if (!entry) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        entry.inputs.add(ws);
        ws.on("close", () => entry.inputs.delete(ws));
        ws.on("message", (raw) => {
          let msg: unknown;
          try { msg = JSON.parse(String(raw)); } catch { return; }
          void entry.relay.input(msg).catch(() => {});
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    this.wss = wss;
  }

  private match(url: string, kind: "frames" | "layers" | "input") {
    const m = new RegExp(`^/([A-Za-z0-9_-]+)/([0-9A-Z]{26})/${kind}$`).exec(url.split("?")[0] ?? "");
    if (!m) return null;
    const entry = this.viewers.get(m[2]!);
    if (!entry || entry.viewer.status !== "live") return null;
    const given = Buffer.from(m[1]!), want = Buffer.from(entry.secret);
    return given.length === want.length && timingSafeEqual(given, want) ? entry : null;
  }

  async open(input: ViewerOpen): Promise<Viewer> {
    const params = ViewerOpenSchema.parse(input);
    const app = this.opts.apps.get(params.appId);
    if (!app) throw new RpcError("NOT_FOUND", `No app Realm launched has the id ${params.appId}.`);
    const port = app.cdpPort;
    if (port === this.opts.ownDevtoolsPort) throw new RpcError("FORBIDDEN", "A viewer cannot open on Realm's own window.");
    const timeoutMs = this.opts.timeoutMs ?? CDP_TIMEOUT_MS;
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => r.json() as Promise<{ id: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string }[]>)
      .catch(() => { throw new RpcError("UNAVAILABLE", `Nothing is answering DevTools on port ${port}.`); });
    const target = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && (params.targetId ? t.id === params.targetId : !params.targetUrl || t.url.startsWith(params.targetUrl)));
    if (!target) throw new RpcError("NOT_FOUND", `The app on port ${port} has no page to show.`);
    // The socket must be that page on that port: a list that names any other address is not the app's.
    const wsUrl = `ws://127.0.0.1:${port}/devtools/page/${target.id}`;
    if (target.webSocketDebuggerUrl !== wsUrl) throw new RpcError("FORBIDDEN", `The app on port ${port} named a DevTools socket that is not its own page's.`);

    await this.listen();
    const id = newId();
    const secret = randomBytes(16).toString("base64url");
    const base = `127.0.0.1:${this.port}/${secret}/${id}`;
    const viewer: Viewer = {
      id, kind: "electron", title: params.title ?? target.title ?? "App",
      streamUrl: `http://${base}/frames`, inputUrl: `ws://${base}/input`, layersUrl: `ws://${base}/layers`,
      status: "connecting", pid: app.pid,
    };
    const inputs = new Set<WebSocket>();
    const relay = new ElectronRelay(wsUrl, {
      maxWidth: params.maxWidth, maxHeight: params.maxHeight, everyNthFrame: params.everyNthFrame, stillMs: this.opts.stillMs, timeoutMs,
      onExit: () => {
        viewer.status = "exited";
        this.viewers.delete(id);
        for (const ws of inputs) ws.close();
      },
    });
    this.viewers.set(id, { viewer, secret, relay, inputs });
    try {
      await relay.start();
    } catch (err) {
      this.viewers.delete(id);
      await relay.close();
      throw new RpcError("UNAVAILABLE", `Could not start the picture: ${(err as Error).message}`);
    }
    viewer.status = "live";
    return { ...viewer };
  }

  list(): Viewer[] {
    return [...this.viewers.values()].map((e) => ({ ...e.viewer }));
  }

  async close(id: string): Promise<void> {
    const entry = this.viewers.get(id);
    if (!entry) throw new NotFoundError("viewer", id);
    this.viewers.delete(id);
    for (const ws of entry.inputs) ws.close();
    await entry.relay.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.viewers.keys()].map((id) => this.close(id)));
    this.wss?.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    this.wss = null;
  }
}
