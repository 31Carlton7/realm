import type { BlockedDownload, Browser, BrowserDownloadResult, BrowserPickedElement } from "@realm/contracts";
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
  /** The pane unmounted but the browser is still open somewhere: keep the view alive and hidden. */
  retain(id: string): Promise<void>;
  navigate(id: string, input: string): Promise<string | null>;
  nav(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
  setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
  onState(cb: (s: BrowserViewState) => void): () => void;
  /** Arms the picker; resolves when the user clicks an element, or null if the pick did not happen.
   *  Stays pending for as long as the user takes to aim. */
  pickElement(id: string): Promise<BrowserPickedElement | null>;
  cancelPick(id: string): Promise<void>;
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
 * Deferred release of the native view on unmount.
 *
 * Releasing is not destroying: an unmounting pane means only that nothing is showing this browser
 * right now — a space or pane-group switch swaps the whole tree — so main hides the view and keeps
 * it running. Destroying is the user closing the pane or deleting the item, and reaches main from
 * the store instead.
 *
 * Still deferred a macrotask, for the reason it always was: React double-mounts in dev (mount →
 * cleanup → mount, synchronously) and a layout reshape remounts a leaf, and neither should make the
 * view blink through a hide. A remount cancels the timer and the (idempotent) create re-attaches.
 */
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleViewRelease(id: string, release: () => void): void {
  cancelViewRelease(id);
  pendingReleases.set(id, setTimeout(() => { pendingReleases.delete(id); release(); }, 0));
}
export function cancelViewRelease(id: string): void {
  const t = pendingReleases.get(id);
  if (t !== undefined) { clearTimeout(t); pendingReleases.delete(id); }
}
