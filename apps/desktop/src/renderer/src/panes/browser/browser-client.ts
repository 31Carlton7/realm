import type { BlockedDownload, Browser, BrowserDownloadResult } from "@realm/contracts";
import { rpc } from "../../rpc/client";

/** The per-space origin allowlist's settings key — stored like MCP enablement (`mcp.enabled:<spaceId>`),
 *  one settings row per space. Absent/null = no list = allow everything (W1's default posture; the
 *  restrictive default is a settings-product decision for that plan's W2). */
export const allowlistKey = (spaceId: string): string => `browser.allowedOrigins:${spaceId}`;

/** Value → allowlist: only a real array of strings counts as a configured list. */
export function parseAllowlist(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

/** The editor's posture sentence, verbatim from the enforcement's own doctrine (`originAllowed` in
 *  Electron main / Plan 11 W1): the list is a guardrail, and pretending otherwise would be the lie. */
export const ALLOWLIST_GUARDRAIL_NOTE =
  "This is a guardrail against agent and user mistakes, explicitly not a security boundary — DNS rebinding, redirect chains and subresource loads can get past an origin check. Treat it as a fence, not a wall.";

/**
 * One typed allowlist entry → the ORIGIN it names, or null when it does not name one (Plan 14 W4).
 *
 * Origins, not URLs, deliberately: `originAllowed` compares `new URL(entry).origin`, so a stored
 * `https://example.com/admin` would silently mean all of `https://example.com` — the editor refusing
 * the path is what keeps the list honest about what it fences. Scheme defaults mirror main's
 * `normalizeAddress`: bare loopback hosts get `http://` (dev servers do not speak TLS), everything
 * else `https://`. What is stored is `URL.origin` itself — scheme-explicit, so the enforcement's
 * default-scheme guess never has to be right about it later.
 */
export function parseOriginInput(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const bare = (raw.replace(/^\/*/, "").split(/[/?#]/)[0] ?? "").split(":")[0]?.toLowerCase() ?? "";
    candidate = `${bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]" ? "http" : "https"}://${raw}`;
  }
  let u: URL;
  try { u = new URL(candidate); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // A path, query, hash or credentials means the user pasted a URL, not an origin. A single "/" is
  // the origin form as browsers print it, so it alone passes.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") return null;
  if (u.hostname === "") return null;
  return u.origin;
}

/** The native side (Electron main's BrowserPaneHost, over the preload). Structural mirror of
 *  `window.realm.browser` so tests can fake it without a preload. */
export type BrowserHostBridge = {
  create(id: string, url: string, allowlist: string[] | null): Promise<void>;
  destroy(id: string): Promise<void>;
  navigate(id: string, input: string): Promise<string | null>;
  nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
  setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
  onState(cb: (s: BrowserViewState) => void): () => void;
  blockedDownloads(id: string): Promise<BlockedDownload[]>;
  saveDownload(id: string, blockedId: string, dir: string): Promise<BrowserDownloadResult>;
  dismissDownload(id: string, blockedId: string): Promise<void>;
  onDownloadBlocked(cb: (m: { browserId: string; blocked: BlockedDownload }) => void): () => void;
};

/** The server side: the persisted row and the space's allowlist setting. */
export type BrowserServerBridge = {
  get(browserId: string): Promise<Browser>;
  update(browserId: string, patch: { url?: string; title?: string }): Promise<void>;
  allowlist(spaceId: string): Promise<string[] | null>;
  /** Where this space's downloads land — `<project root>/downloads`, or null with no project. The
   *  SERVER decides, by the same rule the agent's downloads follow; the renderer never joins paths. */
  downloadDir(spaceId: string): Promise<string | null>;
};

export type BrowserBridges = { host: BrowserHostBridge; server: BrowserServerBridge };

let bridges: BrowserBridges | null = null;

export function getBrowserBridges(): BrowserBridges {
  return (bridges ??= {
    host: window.realm.browser,
    server: {
      get: (browserId) => rpc().call("browsers.get", { browserId }),
      update: async (browserId, patch) => { await rpc().call("browsers.update", { browserId, ...patch }); },
      allowlist: async (spaceId) => parseAllowlist((await rpc().call("settings.get", { key: allowlistKey(spaceId) })).value),
      downloadDir: async (spaceId) => (await rpc().call("browsers.downloadDir", { spaceId })).dir,
    },
  });
}
export function setBrowserBridgesForTests(b: BrowserBridges | null): void { bridges = b; }

/**
 * StrictMode-safe destroy: React double-mounts in dev (mount → cleanup → mount, synchronously), and
 * an immediate destroy would reload the page on every dev mount. Cleanup schedules the destroy a
 * macrotask out; a remount for the same id cancels it and the (idempotent) create simply re-attaches.
 * A real unmount lets the timer fire — the view dies with the pane, never surviving hidden.
 */
const pendingDestroys = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleViewDestroy(id: string, destroy: () => void): void {
  cancelViewDestroy(id);
  pendingDestroys.set(id, setTimeout(() => { pendingDestroys.delete(id); destroy(); }, 0));
}
export function cancelViewDestroy(id: string): void {
  const t = pendingDestroys.get(id);
  if (t !== undefined) { clearTimeout(t); pendingDestroys.delete(id); }
}
