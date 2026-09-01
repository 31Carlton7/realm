import type { Browser } from "@realm/contracts";
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
};

/** The server side: the persisted row and the space's allowlist setting. */
export type BrowserServerBridge = {
  get(browserId: string): Promise<Browser>;
  update(browserId: string, patch: { url?: string; title?: string }): Promise<void>;
  allowlist(spaceId: string): Promise<string[] | null>;
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
