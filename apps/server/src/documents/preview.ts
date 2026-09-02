import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { DOCUMENT_MAX_BYTES } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { resolveInRoot } from "./paths";
import { GUIDE_CSS, GUIDE_JS } from "./guide-runtime";

/**
 * The document preview server (Plan 22 W1): a loopback HTTP listener the documents pane frames
 * `.html` guides and `.pdf` files from.
 *
 * Why a server at all, when the pane already has the file's text in a buffer? Because of how CSP
 * inherits. A `srcdoc`/`blob:`/`data:` frame inherits the RENDERER's policy — `script-src 'self'`,
 * which forbids the inline script every self-contained guide is made of. A document loaded from a
 * real origin gets its own policy from its own response headers, so this server hands each guide a
 * strict one of its own: scripts and styles inline or from this origin only, no network at all
 * (`connect-src 'none'`), no forms. The frame is additionally `sandbox`ed by the pane, so the
 * guide's origin is opaque — it cannot read the app, the app's cookies, or another guide.
 *
 * URL shape: `/p/<token>/<documentsId>/<relative path>`. The token is minted once per server boot
 * (every boot invalidates every old URL; there is nothing to persist) and is a PATH segment rather
 * than a query parameter so a guide's relative assets — `<img src="fig.png">` — resolve under the same
 * prefix without the guide knowing the token exists. `<documentsId>` maps to a workspace root through
 * the same `resolveInRoot` guard the RPC surface uses, so a URL can no more escape the checkout than
 * a tab can. Helper assets live under the reserved `_realm/` segment beside the workspaces.
 *
 * What is injected into an `.html` response: the guide stylesheet and runtime (always — both are
 * inert on a page that uses none of the markup), and KaTeX only when the document opts in with
 * `<meta name="realm-helpers" content="katex">`. Nothing is injected into any other type.
 */
export type PreviewDeps = {
  /** Workspace id → absolute root, or null when no such workspace. */
  rootOf(documentsId: string): string | null;
  /** Directory holding `katex.min.js`, `katex.min.css`, `contrib/`, `fonts/`; null disables KaTeX. */
  katexDir?: string | null;
};

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  pdf: "application/pdf",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
};

/** The policy every served guide runs under. `'self'` is this loopback origin — the helpers. */
export const GUIDE_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' data: blob:",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
].join("; ");

/** Locate the vendored KaTeX distribution, or null if the package is not resolvable (a trimmed install). */
export function defaultKatexDir(): string | null {
  try {
    // `process.getBuiltinModule` rather than `import { createRequire } from "node:module"`: the
    // server bundle's banner (tsup.config.ts) already declares that exact import for the CJS deps
    // it inlines, and a second top-level `createRequire` is a SyntaxError in the built ESM — one
    // the source-level test suite can never see. Caught by the live check.
    const { createRequire } = process.getBuiltinModule("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("katex/dist/katex.min.js"));
  } catch {
    return null;
  }
}

export class DocumentPreviewServer {
  private server: HttpServer | null = null;
  private port: number | null = null;
  readonly token: string;
  private readonly katexDir: string | null;

  constructor(private d: PreviewDeps) {
    this.token = randomBytes(18).toString("base64url");
    this.katexDir = d.katexDir === undefined ? defaultKatexDir() : d.katexDir;
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`preview: ${e instanceof Error ? e.message : String(e)}`);
    }));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr && addr.port > 0 ? addr.port : null;
    if (this.port === null) throw new Error("document preview: the listener bound without a usable TCP port");
    return this.port;
  }

  info(): { port: number; token: string } {
    if (this.port === null) throw new RpcError("UNAVAILABLE", "the document preview server is not listening");
    return { port: this.port, token: this.token };
  }

  /** The frame URL for one document — what `documents.previewInfo` lets the renderer compute itself. */
  urlFor(documentsId: string, relPath: string): string {
    const { port, token } = this.info();
    return `http://127.0.0.1:${port}/p/${token}/${documentsId}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  async close(): Promise<void> {
    const s = this.server; this.server = null; this.port = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  // ---------------------------------------------------------------- request handling

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") return this.fail(res, 405, "method not allowed");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return "\0"; } });
    // /p/<token>/<owner>/<path...>
    if (parts.length < 3 || parts[0] !== "p" || !this.tokenMatches(parts[1]!)) return this.fail(res, 404, "not found");
    const owner = parts[2]!;
    const rel = parts.slice(3).join("/");
    if (owner === "_realm") return this.serveHelper(res, rel);
    const root = this.d.rootOf(owner);
    if (!root) return this.fail(res, 404, "no such workspace");
    let abs: string;
    try { abs = resolveInRoot(root, rel); } catch { return this.fail(res, 400, "bad path"); }
    let st;
    try { st = await stat(abs); } catch { return this.fail(res, 404, "not found"); }
    if (!st.isFile()) return this.fail(res, 404, "not found");
    const ext = extname(abs).slice(1).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    if (ext === "html" || ext === "htm") {
      if (st.size > DOCUMENT_MAX_BYTES) return this.fail(res, 413, "document too large to preview");
      const html = await readFile(abs, "utf8");
      const body = injectHelpers(html, `/p/${this.token}/_realm`, { katex: this.katexDir !== null && wantsKatex(html) });
      res.writeHead(200, { "content-type": mime, "content-security-policy": GUIDE_CSP, "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(200, { "content-type": mime, "content-length": st.size, "accept-ranges": "none" });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(abs).on("error", () => res.destroy()).pipe(res);
  }

  private async serveHelper(res: ServerResponse, rel: string): Promise<void> {
    res.setHeader("cache-control", "public, max-age=600");
    if (rel === "guide.js") return this.text(res, "text/javascript; charset=utf-8", GUIDE_JS);
    if (rel === "guide.css") return this.text(res, "text/css; charset=utf-8", GUIDE_CSS);
    if (rel.startsWith("katex/") && this.katexDir) {
      const sub = rel.slice("katex/".length);
      // Only the three entry files and the fonts directory — never a listing of the package.
      const allowed = sub === "katex.min.js" || sub === "katex.min.css" || sub === "auto-render.min.js" || /^fonts\/[A-Za-z0-9_.-]+$/.test(sub);
      if (!allowed) return this.fail(res, 404, "not found");
      const file = sub === "auto-render.min.js" ? join(this.katexDir, "contrib", sub) : join(this.katexDir, sub);
      const rootAbs = resolve(this.katexDir);
      if (!resolve(file).startsWith(rootAbs + sep)) return this.fail(res, 404, "not found");
      let st;
      try { st = await stat(file); } catch { return this.fail(res, 404, "not found"); }
      const ext = extname(file).slice(1).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "content-length": st.size });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return;
    }
    return this.fail(res, 404, "not found");
  }

  private text(res: ServerResponse, type: string, body: string): void {
    res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  private fail(res: ServerResponse, code: number, msg: string): void {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(msg);
  }

  private tokenMatches(t: string): boolean {
    const a = Buffer.from(t), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** `<meta name="realm-helpers" content="… katex …">`, case-insensitive, attribute order free. */
export function wantsKatex(html: string): boolean {
  const m = /<meta\s+[^>]*name\s*=\s*["']realm-helpers["'][^>]*>/i.exec(html);
  if (!m) return false;
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? "";
  return /\bkatex\b/i.test(content);
}

/**
 * Add the runtime (and KaTeX, if asked for) to a document. Before `</head>` when there is one, after
 * the opening `<head>` otherwise, and at the very top when the document has no head at all — every
 * shape a hand-written or agent-written guide can take still gets the runtime. All tags are `defer`
 * and in order, so `renderMathInElement` exists by the time the runtime's DOMContentLoaded init runs.
 */
export function injectHelpers(html: string, base: string, o: { katex: boolean }): string {
  const tags = [
    `<link rel="stylesheet" href="${base}/guide.css">`,
    ...(o.katex ? [
      `<link rel="stylesheet" href="${base}/katex/katex.min.css">`,
      `<script defer src="${base}/katex/katex.min.js"></script>`,
      `<script defer src="${base}/katex/auto-render.min.js"></script>`,
    ] : []),
    `<script defer src="${base}/guide.js"></script>`,
  ].join("\n");
  const closeHead = /<\/head\s*>/i.exec(html);
  if (closeHead) return `${html.slice(0, closeHead.index)}${tags}\n${html.slice(closeHead.index)}`;
  const openHead = /<head(\s[^>]*)?>/i.exec(html);
  if (openHead) { const at = openHead.index + openHead[0].length; return `${html.slice(0, at)}\n${tags}${html.slice(at)}`; }
  return `${tags}\n${html}`;
}
