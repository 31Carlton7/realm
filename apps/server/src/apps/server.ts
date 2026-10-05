import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { APP_VIEW_HOST_SUFFIX } from "@realm/contracts";
import { RpcError } from "../store/rows";

/** Features a view is never given, whatever its frame is told: the header half of the frame's empty
 *  `allow` attribute, so the document itself carries the refusal too. */
const PERMISSIONS_POLICY = [
  "camera", "microphone", "geolocation", "display-capture", "clipboard-read", "clipboard-write", "fullscreen",
  "payment", "usb", "serial", "hid", "bluetooth", "midi", "screen-wake-lock", "publickey-credentials-get", "xr-spatial-tracking",
].map((f) => `${f}=()`).join(", ");

/** The most addresses held at once. A mount releases its own; this bounds the ones that never did. */
const MAX_LIVE = 256;

type Served = { key: string; html: string; csp: string };

/**
 * The views listener (MCP Apps): a loopback HTTP server that hands each mounted view its HTML, under
 * the CSP Realm built for it, on an origin no other frame shares.
 *
 * A sibling of the document preview server and the same idea — a frame onto a real origin gets its
 * policy from its own response headers, where a `srcdoc` would inherit the renderer's — with one
 * difference that is the point of it. Every address is on a host of its own,
 * `<key>.mcp-view.localhost:<port>`, with a fresh key each time a view is served. Chromium resolves
 * any `*.localhost` to loopback without asking DNS, so one listener serves them all, while the browser
 * treats each as a separate origin: two views, or one view in two places, cannot read each other's
 * DOM or storage, and none of them is Realm's page or any other server Realm runs.
 *
 * The path carries an unguessable token, and the request must arrive on the host minted with it.
 * Nothing else is served — no listing, no assets beside the HTML (a view loads those from the domains
 * it declared, as the spec says it must), no cookie ever set.
 */
export class AppViewServer {
  private server: HttpServer | null = null;
  private port: number | null = null;
  private readonly served = new Map<string, Served>();

  async listen(): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr && addr.port > 0 ? addr.port : null;
    if (this.port === null) throw new Error("app views: the listener bound without a usable TCP port");
    return this.port;
  }

  /** Serve one view: its HTML under `csp`, at a fresh address on a fresh origin. */
  serve(view: { html: string; csp: string }): { url: string; origin: string } {
    if (this.port === null) throw new RpcError("UNAVAILABLE", "the views listener is not running");
    const key = randomBytes(8).toString("hex");
    const token = randomBytes(24).toString("base64url");
    this.served.set(token, { key, html: view.html, csp: view.csp });
    if (this.served.size > MAX_LIVE) this.served.delete(this.served.keys().next().value!);
    const origin = `http://${key}${APP_VIEW_HOST_SUFFIX}:${this.port}`;
    return { url: `${origin}/v/${token}`, origin };
  }

  /** Stop serving an address. Anything that does not name one of ours is ignored. */
  release(url: string): void {
    let token: string | undefined;
    try { token = new URL(url).pathname.split("/")[2]; } catch { return; }
    if (token) this.served.delete(token);
  }

  async close(): Promise<void> {
    this.served.clear();
    const s = this.server; this.server = null; this.port = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") return this.fail(res, 405);
    const path = (req.url ?? "/").split("?")[0]!.split("/");
    const view = path.length === 3 && path[0] === "" && path[1] === "v" ? this.served.get(path[2]!) ?? null : null;
    // The address and the host it was minted on, together: a token is no good on any other origin.
    if (!view || req.headers.host !== `${view.key}${APP_VIEW_HOST_SUFFIX}:${this.port}`) return this.fail(res, 404);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": view.csp,
      "permissions-policy": PERMISSIONS_POLICY,
      "referrer-policy": "no-referrer",
      "content-length": Buffer.byteLength(view.html),
    });
    res.end(req.method === "HEAD" ? undefined : view.html);
  }

  private fail(res: ServerResponse, code: number): void {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(code === 404 ? "not found" : "method not allowed");
  }
}
