import type { BlockedDownload, PasskeyNotice, Browser, BrowserAnnotateResult, BrowserDownloadResult, BrowserFindResult, BrowserHistoryPage, BrowserMenuState, BrowserPickedElement, BrowserScreenshotSaved, BrowserSignInShare } from "@realm/contracts";
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
  /** Plan 26 W7c: the typed text as a web search, even when it looks like an address. */
  search(id: string, query: string): Promise<string | null>;
  /** The trail as an OS menu — see main's handler for why it cannot be a popover in this pane. */
  historyMenu(id: string, dir: "back" | "forward", at: { x: number; y: number }): Promise<void>;
  setAllowlist(id: string, allowlist: string[] | null): Promise<void>;
  setBounds(id: string, rect: { x: number; y: number; width: number; height: number }, dpr: number, visible: boolean): void;
  onState(cb: (s: BrowserViewState) => void): () => void;
  /** Arms the picker; resolves when the user clicks an element, or null if the pick did not happen.
   *  Stays pending for as long as the user takes to aim. */
  /** `accent` is the theme colour the page-side overlay is drawn in. */
  pickElement(id: string, accent?: string): Promise<BrowserPickedElement | null>;
  cancelPick(id: string): Promise<void>;
  /** Plan 26 W7d — the picker kept armed: pending until the user presses Send in the page's own
   *  toolbar (every pin, and a screenshot of them saved into `dir`) or ends the session. */
  annotate(id: string, accent?: string, dir?: string | null): Promise<BrowserAnnotateResult>;
  cancelAnnotate(id: string): Promise<void>;
  /** The theme accent main paints the agent's in-page marks in. Fire-and-forget; pushed on every
   *  theme apply, because the page it is drawn into carries none of Realm's CSS. */
  setAccent(accent: string): void;
  blockedDownloads(id: string): Promise<BlockedDownload[]>;
  saveDownload(id: string, blockedId: string, dir: string): Promise<BrowserDownloadResult>;
  dismissDownload(id: string, blockedId: string): Promise<void>;
  onDownloadBlocked(cb: (m: { browserId: string; blocked: BlockedDownload }) => void): () => void;
  /** A passkey request the pane refused, so a sign-in that goes nowhere says why (passkeys.ts). */
  onPasskey(cb: (m: PasskeyNotice) => void): () => void;
  /** Plan 26 W7a: a menu the OS draws at a window-relative point — the one surface that can open over
   *  the page. Resolves the chosen row's id, or null when it was dismissed. */
  popupMenu(items: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null>;
  /** Plan 26 W7b: what the ⋯ menu is built from, read as it opens. */
  menuState(id: string): Promise<BrowserMenuState>;
  goToIndex(id: string, index: number): Promise<void>;
  /** `start` is a new query; `next`/`previous` step through what it found. An empty query ends it. */
  find(id: string, query: string, step: "start" | "next" | "previous"): Promise<void>;
  stopFind(id: string): Promise<void>;
  onFound(cb: (m: BrowserFindResult) => void): () => void;
  /** ⌘F pressed inside the page, where this window cannot hear it. */
  onFindRequest(cb: (m: { browserId: string }) => void): () => void;
  /** Step the zoom (null reads it); resolves the level the page is at afterwards. */
  zoom(id: string, step: "in" | "out" | "reset" | null): Promise<number>;
  print(id: string): Promise<void>;
  /** Plan 26 W7e: the page at a device preset's width, or (null) fitting the pane again. */
  setDevice(id: string, preset: "phone" | "tablet" | "desktop" | null): Promise<void>;
  screenshot(id: string, dir: string): Promise<BrowserScreenshotSaved>;
  /** Confirms in main first; clears the pane's PROFILE's partition and resolves whether it did, and
   *  whose — the history to forget is that profile's. */
  clearData(id: string): Promise<{ cleared: boolean; profileId: string | null }>;
  /** Plan 27 Phase 2: copy the page's site's sign-in (its cookies) into another profile's browser. */
  shareSignIn(id: string, toProfileId: string): Promise<BrowserSignInShare>;
  /** Show a file this pane saved in the Finder — `files.reveal`, which only ever selects a file.
   *  False when nothing is at the path any more (moved or deleted since it was saved). */
  reveal(path: string): Promise<boolean>;
};

/** The server side: the persisted row and the space's allowlist setting. */
export type BrowserServerBridge = {
  get(browserId: string): Promise<Browser>;
  update(browserId: string, patch: { url?: string; title?: string; favicon?: string; failed?: boolean }): Promise<void>;
  allowlist(spaceId: string): Promise<string[] | null>;
  /** Where this space's downloads land — `<project root>/downloads`, or null with no project. The
   *  SERVER decides, by the same rule the agent's downloads follow; the renderer never joins paths. */
  downloadDir(spaceId: string): Promise<string | null>;
  /** Where this space's screenshots land — `<space folder>/screenshots`. Same rule as `downloadDir`:
   *  the server says where, and the renderer only passes it on. */
  screenshotDir(spaceId: string): Promise<string | null>;
  /** Plan 26 W7c: pages this space's profile has visited that match what is being typed, best first. */
  suggest(spaceId: string, query: string): Promise<BrowserHistoryPage[]>;
  /** Plan 26 W6: the handful of pages this space's profile went to last, newest first — what a blank
   *  tab lists under its tools. */
  recent(spaceId: string): Promise<BrowserHistoryPage[]>;
  /** Forget the pages ONE profile's panes visited — Clear browsing data's other half. */
  clearHistory(profileId: string): Promise<void>;
};

export type BrowserBridges = { host: BrowserHostBridge; server: BrowserServerBridge };

let bridges: BrowserBridges | null = null;

export function getBrowserBridges(): BrowserBridges {
  return (bridges ??= {
    host: {
      ...window.realm.browser,
      // The menu bridge is the window's, not the browser's — every pane kind may pop one — but the
      // browser pane is its first caller, and faking it with the rest keeps its tests in one place.
      popupMenu: (items, at) => window.realm.popupMenu?.(items, at) ?? Promise.resolve(null),
      reveal: (path) => window.realm.files?.reveal(path) ?? Promise.resolve(false),
    },
    server: {
      get: (browserId) => rpc().call("browsers.get", { browserId }),
      update: async (browserId, patch) => { await rpc().call("browsers.update", { browserId, ...patch }); },
      allowlist: async (spaceId) => parseAllowlist((await rpc().call("settings.get", { key: allowlistKey(spaceId) })).value),
      downloadDir: async (spaceId) => (await rpc().call("browsers.downloadDir", { spaceId })).dir,
      screenshotDir: async (spaceId) => (await rpc().call("browsers.screenshotDir", { spaceId })).dir,
      suggest: async (spaceId, query) => (await rpc().call("browsers.suggest", { spaceId, query })).pages,
      recent: async (spaceId) => (await rpc().call("browsers.recent", { spaceId })).pages,
      clearHistory: async (profileId) => { await rpc().call("browsers.clearHistory", { profileId }); },
    },
  });
}
export function setBrowserBridgesForTests(b: BrowserBridges | null): void { bridges = b; }

/**
 * Clear browsing data's word to every pane in this window: the history is gone. The pages are the
 * server's, but a blank tab's Recently visited is a list each pane read for itself, and one read
 * before the clear would go on naming pages Realm has just been told to forget.
 */
const historyCleared = new Set<() => void>();
export function onHistoryCleared(cb: () => void): () => void {
  historyCleared.add(cb);
  return () => { historyCleared.delete(cb); };
}
export function announceHistoryCleared(): void { for (const cb of historyCleared) cb(); }

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
