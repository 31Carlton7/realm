import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { newId, ViewerOpenSchema, type Viewer, type ViewerOpen } from "@realm/contracts";
import { NotFoundError, RpcError } from "../store/rows";
import { ElectronRelay } from "./electron-relay";

/**
 * Hidden apps shown as pictures. Each viewer is one live connection to a running process, so they
 * are kept in memory only: nothing about one outlives the app or this server.
 *
 * One loopback HTTP server carries every viewer's picture (`/<token>/<id>/frames`) and input socket
 * (`/<token>/<id>/input`), as `AndroidStream` does for emulators. The token is in the path because an
 * `<img src>` cannot set headers.
 */
export class ViewerService {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly token = randomBytes(16).toString("base64url");
  private readonly viewers = new Map<string, { viewer: Viewer; relay: ElectronRelay; inputs: Set<WebSocket> }>();

  constructor(private readonly opts: { stillMs?: number } = {}) {}

  private async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const entry = this.match(req.url ?? "", "frames");
      if (!entry) { res.writeHead(404).end(); return; }
      entry.relay.serve(res);
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
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

  private match(url: string, kind: "frames" | "input") {
    const m = new RegExp(`^/([A-Za-z0-9_-]+)/([0-9A-Z]{26})/${kind}$`).exec(url.split("?")[0] ?? "");
    if (!m) return null;
    const given = Buffer.from(m[1]!), want = Buffer.from(this.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const entry = this.viewers.get(m[2]!);
    return entry && entry.viewer.status === "live" ? entry : null;
  }

  async open(input: ViewerOpen): Promise<Viewer> {
    const params = ViewerOpenSchema.parse(input);
    const targets = await fetch(`http://127.0.0.1:${params.cdpPort}/json/list`)
      .then((r) => r.json() as Promise<{ id: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string }[]>)
      .catch(() => { throw new RpcError("UNAVAILABLE", `Nothing is answering DevTools on port ${params.cdpPort}.`); });
    const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && (params.targetId ? t.id === params.targetId : !params.targetUrl || t.url.startsWith(params.targetUrl)));
    if (!target) throw new RpcError("NOT_FOUND", `The app on port ${params.cdpPort} has no page to show.`);

    await this.listen();
    const id = newId();
    const base = `127.0.0.1:${this.port}/${this.token}/${id}`;
    const viewer: Viewer = {
      id, kind: "electron", title: params.title ?? target.title ?? "App",
      streamUrl: `http://${base}/frames`, inputUrl: `ws://${base}/input`,
      status: "connecting", pid: params.pid,
    };
    const inputs = new Set<WebSocket>();
    const relay = new ElectronRelay(target.webSocketDebuggerUrl!, {
      maxWidth: params.maxWidth, maxHeight: params.maxHeight, everyNthFrame: params.everyNthFrame, stillMs: this.opts.stillMs,
      onExit: () => { viewer.status = "exited"; for (const ws of inputs) ws.close(); },
    });
    this.viewers.set(id, { viewer, relay, inputs });
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
