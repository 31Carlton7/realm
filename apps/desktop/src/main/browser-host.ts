/**
 * The browser pane's main-process core (Plan 11 W1) — every DECISION lives here, with no Electron
 * import, so the guards and lifecycle are unit-testable. The Electron calls (WebContentsView,
 * webContents events) live behind `ViewFactory`, implemented in browser-pane.ts.
 */
import { ERR_ABORTED, FAVICON_MAX_BYTES, type BrowserLoadError } from "@realm/contracts";

export type ViewRect = { x: number; y: number; width: number; height: number };

/** What the renderer's chrome renders from — pushed main→renderer on every navigation/title/loading
 *  change. */
export type BrowserViewState = {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  /** The device preset the view is showing the page at (Plan 26 W7e), or null when it fits the pane.
   *  On the state channel because the view outlives its pane: a pane that remounts learns it here. */
  device: DevicePresetId | null;
  /** The page's own icon as a `data:` URL (`createFaviconResolver`), or null until the page has offered
   *  one that loads — and for a page that offers none. */
  favicon: string | null;
  /** The page did not load (`PageLoad`): the pane draws its error page in the view's place. */
  error: BrowserLoadError | null;
  /** The view has a document of its own to show (`PageLoad`). Until it does, the pane shows its own
   *  ground rather than the view's blank white. */
  ready: boolean;
};

/**
 * Whether a view has a page worth showing, and whether the page it is on failed to load — the two
 * facts the pane needs to keep the view's blank white off the screen.
 *
 * A failed main-frame load commits Chromium's error page in the failed URL's place (measured on
 * Electron 37: the address and the history entry are the attempted URL's, Reload retries it, and the
 * document is an empty `chrome-error://` page). Electron draws nothing on it, so the pane does, and
 * hides the view. `did-fail-provisional-load` is that commit and nothing else: `did-fail-load` also
 * fires, with ERR_ABORTED and no name, when a page that already committed is stopped mid-load — a page
 * that is on screen and fine.
 *
 * Ready is DOMContentLoaded (or the load stopping) of a document that is not an error page and not
 * the `about:blank` the pane boots on. It goes false again only with an error page: from one good page
 * to the next, Chromium keeps the old one on screen until the new one paints, so there is no blank to
 * hide; from an error page to a good one there is, because the last frame the view drew was empty.
 */
export class PageLoad {
  error: BrowserLoadError | null = null;
  ready = false;

  /** A main-frame document committed (`did-navigate`). */
  committed(url: string): void {
    if (url !== "about:blank") this.error = null;
  }

  /** Chromium committed its error page for the main frame (`did-fail-provisional-load`). */
  failed(code: number, name: string, url: string): void {
    if (code === ERR_ABORTED) return;
    this.error = { code, name, url };
    this.ready = false;
  }

  /** The main frame's document is far enough along to show (`dom-ready`, `did-stop-loading`). */
  settled(url: string): void {
    if (this.error === null && url !== "about:blank" && url !== "") this.ready = true;
  }
}

/**
 * The widths the ⋯ menu's Device size offers (Plan 26 W7e) — one phone, one tablet, one desktop, the
 * three a layout is usually checked at. A width only: the height is the pane's, because a preview that
 * scrolled inside a box shorter than the pane would be a frame around a frame.
 *
 * What emulating them does NOT do, said here so nobody expects it: the user agent stays Realm's own
 * (browserUserAgent never claims to be a browser it is not), and touch input is not emulated — a site
 * that sniffs the UA for a phone, rather than reading its width, still sees a Mac.
 */
export type DevicePresetId = "phone" | "tablet" | "desktop";
export type DevicePreset = { id: DevicePresetId; label: string; width: number; mobile: boolean };
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: "phone", label: "iPhone", width: 390, mobile: true },
  { id: "tablet", label: "iPad", width: 820, mobile: true },
  { id: "desktop", label: "Desktop", width: 1440, mobile: false },
];
export const devicePreset = (id: unknown): DevicePreset | null => DEVICE_PRESETS.find((d) => d.id === id) ?? null;

/** `Emulation.setDeviceMetricsOverride`'s parameters. `deviceScaleFactor: 0` keeps the display's own. */
export type DeviceMetrics = { width: number; height: number; deviceScaleFactor: 0; mobile: boolean; scale: number };

/**
 * Where a preset's view sits in the pane, and what it is told to emulate.
 *
 * The VIEW is narrowed to the device's box rather than left at the pane's width, because measured on
 * Electron 37 an emulated viewport smaller than its view is drawn into the view's top-left corner with
 * nothing defined beside it, and one larger is cropped. Narrowed, centred and — for a device wider than
 * the pane — scaled down to fit, the view shows exactly the emulated page, and the pane's own ground
 * frames it. The emulated height is the pane's, divided by that scale, so the box is always full.
 */
export function deviceFit(host: ViewRect, preset: DevicePreset): { view: ViewRect; metrics: DeviceMetrics } | null {
  if (host.width <= 0 || host.height <= 0) return null;
  const scale = Math.min(1, host.width / preset.width);
  const width = Math.min(host.width, Math.round(preset.width * scale));
  return {
    view: { x: host.x + Math.floor((host.width - width) / 2), y: host.y, width, height: host.height },
    metrics: { width: preset.width, height: Math.round(host.height / scale), deviceScaleFactor: 0, mobile: preset.mobile, scale },
  };
}

/** A search query → the search URL it runs. Google, because that is what the address bar promises
 *  when the input is plainly not a host. */
export function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Is this the host part of something the user meant as an address, rather than words to search?
 * The bar is one field for two intents, so the split has to be decided from the text alone:
 * a bracketed IPv6 literal, a dotted quad, or a dotted name whose last label is letters — anything
 * else (spaces, a bare word, `3.14`, a `file:`/`javascript:` scheme) is a query.
 */
function looksLikeHost(host: string): boolean {
  if (host.startsWith("[")) return host.includes("]"); // IPv6 literal, port or not
  const parts = host.split(":");
  const name = parts[0] ?? "";
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^\d+$/.test(parts[1] ?? "")) return false;
  if (name === "" || /[\s@\\]/.test(name)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((l) => l === "")) return false;
  return /^\p{L}{2,}$/u.test(labels[labels.length - 1] ?? "");
}

/** Address-bar input → a loadable URL. https is the default scheme for anything host-shaped; input
 *  that is not host-shaped is a search, and goes to `searchUrl` rather than being prefixed into a
 *  URL that can only fail. The one pragmatic exception: loopback hosts get `http://` — dev servers
 *  do not speak TLS. Null = nothing to load. */
export function normalizeAddress(input: string): string | null {
  const s = input.trim();
  if (s === "") return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s === "about:blank") return s;
  const host = s.replace(/^\/*/, "").split(/[/?#]/)[0] ?? "";
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]" || host.startsWith("[::1]")) return `http://${s}`;
  if (!looksLikeHost(host)) return searchUrl(s);
  return `https://${s}`;
}

/**
 * The user agent a browser pane presents, derived from Electron's default.
 *
 * Two edits, and the restraint is the point of both.
 *
 * **`Electron/37.10.3` comes off.** It is the one token in the string that is not true of any
 * browser a site has ever tested against, and sites do read it: some serve a degraded page, some
 * refuse outright, and all of it is invisible from here because the page simply behaves differently.
 * What is left is what Realm's panes actually are — Chromium, on macOS, at the version we ship.
 *
 * **The Chrome version is REDUCED to `<major>.0.0.0`**, which is not a lie but a convention: Chrome
 * itself has frozen the minor/build/patch in its UA since the UA-reduction rollout, so a real Chrome
 * 138 sends `Chrome/138.0.0.0`. Sending `138.0.7204.251` is a mismatch that marks the client as
 * something other than a browser just as loudly as the Electron token does.
 *
 * What this deliberately does NOT do is claim a newer Chrome than we have. It would silence a
 * "your browser is out of date" interstitial today, and it would buy that by telling a site it may
 * use features this engine does not have — which is a failure that surfaces as a blank panel three
 * clicks into a flow, and cannot be diagnosed from the page. Being out of date is fixed by not
 * being out of date; see the Electron bump.
 *
 * The limit of this fix, measured rather than assumed: `navigator.userAgentData.brands` still
 * reports `Chromium`, not `Google Chrome`, and overriding the UA string does not change it (Electron
 * exposes no API for the client-hint metadata). A site that sniffs client hints rather than the UA
 * string therefore still sees Chromium. That is the honest state of it, and it is the right side to
 * err on — the string is what the overwhelming majority of sniffers read.
 *
 * Idempotent: a string that has already been through this comes out unchanged, so applying it at the
 * session AND at each view cannot compound.
 */
export function browserUserAgent(defaultUserAgent: string): string {
  const stripped = defaultUserAgent.replace(/\sElectron\/\S+/g, "");
  // Guard against a default we do not recognise: a UA with no Chrome token is not something to
  // rewrite blind, and handing back the input unchanged is the only safe answer.
  if (!/Chrome\/\d/.test(stripped)) return defaultUserAgent;
  return stripped.replace(/(Chrome\/\d+)(?:\.\d+)*/g, "$1.0.0.0");
}

/** How long a favicon fetch may take before the tab keeps its glyph. */
export const FAVICON_FETCH_MS = 8_000;
/** How many of a page's icons are tried before it is taken to have none that loads. */
export const FAVICON_TRIES = 3;
/** The longest icon address worth following — a page writes these, and a URL past this is not an icon's. */
const FAVICON_URL_MAX = 2_048;

/**
 * A page's icons, best first, for a tab that draws one at 14–16px on a 2x display.
 *
 * Electron hands them over as a sorted set — the document's own order is gone (measured: `/gh.svg`,
 * `/g.ico` and `/gh.png` arrive as g.ico, gh.png, gh.svg) — so the choice is made from the addresses:
 * an SVG is drawn at whatever size it is asked for; an icon naming a size of at least 32 is sharp at 2x
 * (the smallest such, since it is closest to what is drawn); one naming no size is usually an ICO
 * carrying several; and one naming a smaller size is a blur on a Retina tab, kept as a last resort.
 * Only addresses an icon can honestly come from survive: http(s) without credentials, or an image
 * inlined as `data:`.
 */
export function rankFavicons(candidates: readonly string[]): string[] {
  const named = (url: string) => Number(/(\d+)x\1(?!\d)/.exec(url)?.[1] ?? Number.NaN);
  const tier = (url: string) => {
    if (/^data:image\/svg\+xml[;,]/i.test(url) || /\.svg(?:[?#]|$)/i.test(url)) return 0;
    const px = named(url);
    return Number.isNaN(px) ? 2 : px >= 32 ? 1 : 3;
  };
  const usable = (url: string) => {
    if (/^data:image\//i.test(url)) return url.length <= FAVICON_MAX_BYTES * 3; // percent-encoding can triple it
    if (!/^https?:\/\//i.test(url) || url.length > FAVICON_URL_MAX) return false;
    try { const u = new URL(url); return u.username === "" && u.password === ""; } catch { return false; }
  };
  return candidates.filter(usable)
    .map((url, i) => ({ url, i, tier: tier(url), px: named(url) }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 1 ? a.px - b.px : 0) || a.i - b.i)
    .map((c) => c.url);
}

/** The bytes of a `data:` URL, base64 or percent-encoded; null when it does not parse. */
export function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:([^,]*),(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return /;base64$/i.test(m[1]!) ? Buffer.from(m[2]!, "base64") : Buffer.from(decodeURIComponent(m[2]!), "utf8");
  } catch { return null; }
}

/**
 * What picture these bytes are, read from their own signature — never from what the server called
 * them: a site that answers /favicon.ico with its HTML 404 page says `200` and `text/html`, and one that
 * serves its ICO as `application/octet-stream` has still served an icon. Null for anything else.
 */
export function sniffImage(b: Uint8Array): string | null {
  const at = (sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (at([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // An SVG is text: an <svg> root, after at most a BOM, an XML declaration, comments and a doctype.
  const head = new TextDecoder().decode(b.subarray(0, 1024));
  return /^﻿?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) ? "image/svg+xml" : null;
}

/** A favicon's bytes as Realm keeps them (`isFaviconDataUrl`), or null when they are no picture or too big. */
export function faviconDataUrl(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > FAVICON_MAX_BYTES) return null;
  const type = sniffImage(bytes);
  return type ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null;
}

/** A response body, read only as far as `max` bytes: null past it, so a 50MB "icon" costs one chunk. */
export async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
}

/**
 * Fetch an icon's bytes. Null is an ANSWER — the address gave back something other than a picture
 * that fits — and is remembered; a throw (a timeout, the network gone) is not, and the next page tries
 * again.
 */
export type FaviconFetch = (url: string) => Promise<Uint8Array | null>;

/**
 * A page's offered icons → the first that loads, as a `data:` URL the window can draw without making a
 * request of its own: the window's CSP admits no remote image, and stays that way.
 *
 * Remembered by address, a few dozen deep: every page of a site offers the same icon, and the next page
 * should not wait on a fetch for a picture already in hand — nor the tab show the glyph while it does.
 * An inlined `data:` icon is decoded each time; there is nothing to fetch.
 */
export function createFaviconResolver(fetchBytes: FaviconFetch, remember = 64): (candidates: readonly string[]) => Promise<string | null> {
  const known = new Map<string, string | null>();
  return async (candidates) => {
    for (const url of rankFavicons(candidates).slice(0, FAVICON_TRIES)) {
      let icon: string | null;
      if (url.startsWith("data:")) {
        const bytes = dataUrlBytes(url);
        icon = bytes ? faviconDataUrl(bytes) : null;
      } else if (known.has(url)) {
        icon = known.get(url)!;
        known.delete(url); // most recently used goes to the back
        known.set(url, icon);
      } else {
        const bytes = await fetchBytes(url).catch(() => undefined);
        if (bytes === undefined) continue; // no answer: try the next, and this one again next time
        icon = bytes ? faviconDataUrl(bytes) : null;
        known.set(url, icon);
        if (known.size > remember) known.delete(known.keys().next().value!);
      }
      if (icon) return icon;
    }
    return null;
  };
}

/**
 * The per-space origin allowlist check (consulted by `will-navigate`, `will-redirect`, and every
 * host-initiated navigate). `null` = no list configured = allow everything — W1's default posture;
 * the restrictive default is a settings-product decision deferred to that plan's W2.
 *
 * This is a GUARDRAIL against agent/user mistakes, explicitly NOT a security boundary: DNS rebinding,
 * server-side redirect chains (we check will-redirect, but only per-hop origin), and subresource
 * loads (W3's Fetch-level enforcement) all get past an origin string comparison. Treat it as a fence,
 * not a wall.
 */
export function originAllowed(url: string, allowlist: readonly string[] | null): boolean {
  if (allowlist === null) return true;
  if (url === "about:blank") return true; // the empty page is nobody's origin
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  if (origin === "null") return false; // opaque origins (data:, blob: without http base) never match a list
  return allowlist.some((entry) => {
    const e = entry.trim(); if (e === "") return false;
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `https://${e}`).origin === origin; } catch { return false; }
  });
}

/**
 * Placeholder rect (renderer CSS px) → view bounds (DIPs relative to the window's content view).
 * CSS px * zoom = DIP, and the renderer's devicePixelRatio = displayScaleFactor * zoomFactor, so
 * DIP = css * dpr / scaleFactor — which also stays correct when the user has zoomed the app.
 *
 * INSET to the pixel grid, never rounded to it. `setBounds` takes integers, and a WebContentsView
 * composites ABOVE the window's DOM unconditionally (browser-pane.ts) — so a view whose edge rounds
 * OUTWARD paints over whatever the renderer drew in the pixel next door, and cannot be drawn over in
 * return. The pixel next door is `.resize-handle`: the pane divider is the 1px immediately outside
 * this rect, and it is the whole boundary between two panes.
 *
 * Rounding each edge independently is what did it. A pane whose left edge sits at 1054.344 gave
 * `Math.round(1054.344) = 1054`, a third of a pixel to the LEFT of the pane — over the divider —
 * and rounding `width` separately let the right edge spill the same way. Even splits are where this
 * bites: two panes put every edge on .0 or .5 and .5 rounds outward-safe, but three panes put them
 * on thirds and six on sixths, so a fraction under .5 ate the line. Dragging the divider a hair
 * moved the edge to a fraction that rounded the other way and it came back, which is what made this
 * read as random.
 *
 * `ceil` the near edges and `floor` the far ones: the view is then always CONTAINED by its
 * placeholder. The cost is up to one device pixel of pane ground showing at an edge instead of page
 * content, which is invisible; the alternative is a structural divider that disappears.
 *
 * Clamped so a mid-layout negative or inverted rect can never throw.
 */
export function toViewBounds(rect: ViewRect, dpr: number, scaleFactor: number): ViewRect {
  const k = scaleFactor > 0 && dpr > 0 ? dpr / scaleFactor : 1;
  const left = Math.ceil(rect.x * k), top = Math.ceil(rect.y * k);
  const right = Math.floor((rect.x + rect.width) * k), bottom = Math.floor((rect.y + rect.height) * k);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * The zoom a pane steps through — Chrome's own ladder, so a page lands on the levels a person already
 * knows from every other browser rather than on whatever `zoomLevel ± 0.5` happens to produce.
 */
export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

/**
 * The next rung from wherever the page is now. Measured from the LIVE factor, not from an index this
 * file remembers: ⌘+ with the page focused is the View menu's own zoom role, which steps by half a zoom
 * level and lands between these rungs, and the next press here should still go to the nearest one.
 */
export function nextZoomFactor(current: number, step: "in" | "out" | "reset"): number {
  if (step === "reset" || !Number.isFinite(current) || current <= 0) return 1;
  const eps = 0.001;
  if (step === "in") return ZOOM_FACTORS.find((f) => f > current + eps) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  return [...ZOOM_FACTORS].reverse().find((f) => f < current - eps) ?? ZOOM_FACTORS[0]!;
}

/** What the ⋯ menu prints beside Zoom: the level as a person reads it. */
export const zoomPercent = (factor: number): number => Math.round(factor * 100);

/** The view's answer to a find, forwarded to the pane's find strip. */
export type FindResult = { activeMatchOrdinal: number; matches: number; finalUpdate: boolean };

/** The slice of Electron's `before-input-event` input a shortcut is read from. */
export type KeyInput = { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean };

/**
 * What a view says it is showing, for the address bar, the tab and the title the row is saved under.
 *
 * Realm loads `about:blank` into a new view before its first page (browser-pane.ts: the passkey
 * install needs a document to attach to), and that bootstrap is nobody's page. Until the page asked
 * for commits, the view is showing what it was ASKED for, under no title at all — Chromium would name
 * it "about:blank", the URL of an untitled document, and a tab restored after a relaunch was renamed
 * that while its page was still on the way, and for good when the page never came.
 */
export function shownPage(live: { url: string; title: string }, wanted: string | null): { url: string; title: string } {
  return live.url === "about:blank" || live.url === "" ? { url: wanted ?? "", title: "" } : live;
}

/**
 * ⌘F, pressed while the PAGE has the keyboard.
 *
 * The renderer never sees that keydown — it goes to the view's own webContents, which is a different
 * renderer process — so the pane's own ⌘F binding cannot hear it. Main can, through
 * `before-input-event`, and this is the whole test of whether to take it from the page. Only on its
 * own: ⌘⇧F is pane focus, and a find shortcut that also ate that chord would break the other one.
 * Control on a Mac is the text cursor's (⌃F moves forward a character in every field), so the Mac key
 * is Command and only Command.
 */
export function isFindShortcut(input: KeyInput, platform: string): boolean {
  if (input.type !== "keyDown" || input.key.toLowerCase() !== "f" || input.alt || input.shift) return false;
  return platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
}

/** The thin Electron adapter each live view is driven through. */
export type ViewHandle = {
  setBounds(r: ViewRect): void;
  setVisible(visible: boolean): void;
  loadURL(url: string): void;
  goBack(): void; goForward(): void; reload(): void; stop(): void;
  canGoBack(): boolean; canGoForward(): boolean;
  /** Every entry this view can reach, oldest first, and where in that list it is standing. The pair
   *  is read together — an index means nothing without the list it indexes. */
  history(): { entries: { url: string; title: string }[]; activeIndex: number };
  goToIndex(index: number): void;
  getURL(): string; getTitle(): string; isLoading(): boolean;
  /** The current page's icon, resolved (`createFaviconResolver`) — null until it has one. */
  getFavicon(): string | null;
  /** `PageLoad`'s two answers for this view. */
  getLoadError(): BrowserLoadError | null;
  isReady(): boolean;
  /** `webContents.findInPage` — `findNext` is Electron's "this is a NEW search", not "the next match". */
  findInPage(text: string, opts: { forward: boolean; findNext: boolean }): void;
  stopFindInPage(): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  /** The system print dialog, for this page. */
  print(): void;
  destroy(): void;
};

export type ViewHooks = {
  /** Wire to every navigation/title/loading webContents event. */
  emitState(): void;
  /** `will-navigate` / `will-redirect` consult — false means preventDefault. */
  allowNavigate(url: string): boolean;
  /** `setWindowOpenHandler` funnel: every window.open/target=_blank is DENIED as a window and offered
   *  back as an in-place navigation of the same view. */
  openInPlace(url: string): void;
  /** `found-in-page`: the view's answer to the last find. */
  found(result: FindResult): void;
  /** ⌘F with the page holding the keyboard (`isFindShortcut`) — the pane opens its find strip. */
  findShortcut(): void;
};

/** `partition` is the Electron session the view's cookies, site data and cache live in — its
 *  profile's own (Plan 27 Phase 2). */
export type ViewFactory = (id: string, hooks: ViewHooks, partition: string) => ViewHandle;

/**
 * How many RETAINED (off-screen) browser views stay alive at once, on top of whatever is on screen.
 *
 * This is a process budget, not a cache size: every `WebContentsView` is a full renderer process,
 * and retained ones run unthrottled (browser-pane.ts sets `backgroundThrottling: false`, without
 * which a hidden page's timers drop to ~1Hz). Ten spaces holding a browser each must not mean ten
 * unthrottled renderers, so past this limit the least-recently-used retained view is destroyed and
 * its page reloads on the user's next visit.
 */
export const RETAINED_VIEW_LIMIT = 3;

/**
 * One `WebContentsView` per open browser item, keyed by browser id. Owns lifecycle (create is
 * idempotent; destroy is final; destroyAll on window teardown — a view never outlives its window),
 * the navigation guards, and the state channel back to the renderer.
 *
 * A view's lifetime is NOT its pane's. Panes unmount for reasons that have nothing to do with the
 * user closing anything — switching space or pane group swaps the whole rendered tree — so an
 * unmounting pane `retain`s its view (hidden, still running, still drivable over CDP) and only an
 * explicit close or delete `destroy`s it. What bounds the cost is `RETAINED_VIEW_LIMIT`, below.
 */
export class BrowserPaneHost {
  private views = new Map<string, {
    handle: ViewHandle; allowlist: string[] | null;
    /** The cookie jar the view was made in, which is its profile's. A view never changes jar. */
    partition: string;
    /** Plan 26 W7e: the preset the page is shown at, and the rect the pane last gave the view. */
    device: DevicePreset | null; host: ViewRect | null;
    /** The metrics last sent, so a resize that changes nothing sends nothing. */
    emulated: string | null;
  }>();
  /** Retained ids in least-recently-used order — `Set` iterates by insertion, so re-adding after a
   *  delete moves an id to the back. Views with a mounted pane are absent, never evictable. */
  private retained = new Set<string>();

  constructor(private opts: {
    createView: ViewFactory;
    sendState: (s: BrowserViewState) => void;
    /** The window's display scale factor at the time of a bounds sync. */
    scaleFactor: () => number;
    /** A find's result, for the pane whose view it came from. */
    sendFound?: (m: FindResult & { id: string }) => void;
    /** ⌘F was pressed in this view's page. */
    requestFind?: (id: string) => void;
    /** Emulate a device on this view's page, or (null) stop. Over CDP, so best-effort: a view with
     *  DevTools already attached simply shows the page at the narrowed width instead. */
    emulate?: (id: string, metrics: DeviceMetrics | null) => void;
  }) {}

  has(id: string): boolean { return this.views.has(id); }

  /**
   * Idempotent: React StrictMode double-mounts, and a remount must not reload the page. It is also
   * how a retained view is re-adopted — a pane returning to a space calls this and gets the SAME view
   * back, mid-scroll and mid-form, rather than a reload.
   *
   * …unless it is asked for in a different `partition`. The browser's space has moved to another
   * profile since the view was made, and a view cannot change cookie jars: re-adopting it would show
   * the new profile a page signed in as the old one. That view goes, and a fresh one is made in the
   * jar asked for — the one place a retained view could carry one profile's sign-ins into another.
   */
  create(id: string, url: string, allowlist: string[] | null, partition: string): void {
    this.retained.delete(id); // a pane is showing it again: no longer evictable
    const existing = this.views.get(id);
    if (existing && existing.partition === partition) { this.emitState(id); return; }
    if (existing) this.destroy(id);
    const handle = this.opts.createView(id, {
      emitState: () => this.emitState(id),
      allowNavigate: (target) => originAllowed(target, this.views.get(id)?.allowlist ?? null),
      openInPlace: (target) => this.navigate(id, target),
      found: (result) => this.opts.sendFound?.({ id, ...result }),
      findShortcut: () => this.opts.requestFind?.(id),
    }, partition);
    this.views.set(id, { handle, allowlist, partition, device: null, host: null, emulated: null });
    const normalized = normalizeAddress(url);
    if (normalized && originAllowed(normalized, allowlist)) handle.loadURL(normalized);
    this.emitState(id);
  }

  /** Every host-initiated navigation (address bar, window.open funnel) passes the same allowlist the
   *  page's own navigations do — `loadURL` does not fire `will-navigate`, so checking here is what
   *  keeps the two paths equally fenced. Returns the normalized URL, or null when refused/no-op. */
  navigate(id: string, input: string): string | null {
    const v = this.views.get(id); if (!v) return null;
    const url = normalizeAddress(input);
    if (!url || !originAllowed(url, v.allowlist)) return null;
    v.handle.loadURL(url);
    return url;
  }

  /**
   * The back/forward trail, split at where the view is standing.
   *
   * `back` is oldest-first reversed — nearest first, the order a person reads a back menu in — and
   * `forward` is the entries past the active one in the order they would be walked. Titles fall back
   * to the URL: a page that never set one would otherwise be a blank row in the menu.
   */
  historyTrail(id: string, dir: "back" | "forward"): { index: number; label: string }[] {
    const v = this.views.get(id); if (!v) return [];
    const { entries, activeIndex } = v.handle.history();
    const range = dir === "back"
      ? entries.map((e, i) => ({ e, i })).slice(0, Math.max(0, activeIndex)).reverse()
      : entries.map((e, i) => ({ e, i })).slice(activeIndex + 1);
    return range.map(({ e, i }) => ({ index: i, label: e.title?.trim() || e.url }));
  }

  goToIndex(id: string, index: number): void {
    const v = this.views.get(id); if (!v) return;
    v.handle.goToIndex(index);
  }

  /**
   * Search the page from the pane's find strip. `start` is a new query — the text changed — and opens a
   * fresh find session; `next` and `previous` walk the one already open. An empty query ends the find
   * rather than searching for nothing, which Electron refuses with a throw.
   *
   * Electron's option is named backwards for this, and the mutant is the swap: `findNext: true` means
   * "begin a new session", so passing it on every press restarts the search at the first match and the
   * Next button never moves.
   */
  find(id: string, query: string, step: "start" | "next" | "previous"): void {
    const v = this.views.get(id); if (!v) return;
    if (query === "") { v.handle.stopFindInPage(); return; }
    v.handle.findInPage(query, { forward: step !== "previous", findNext: step === "start" });
  }

  /** The find strip closed: the highlight goes with it. */
  stopFind(id: string): void {
    this.views.get(id)?.handle.stopFindInPage();
  }

  /**
   * Step this view's zoom, or with `null` just read it, and answer the level it is at afterwards.
   *
   * Read back rather than assumed, because the answer is what the menu prints and Chromium can refuse
   * or round a level. One thing worth knowing before calling this per-pane: Chromium keeps zoom per
   * SITE within a session, so a second pane on the same host follows along — exactly as a second
   * Chrome tab on that host does. The level is in memory only; nothing here persists it.
   */
  zoom(id: string, step: "in" | "out" | "reset" | null): number {
    const v = this.views.get(id); if (!v) return 1;
    if (step !== null) v.handle.setZoomFactor(nextZoomFactor(v.handle.getZoomFactor(), step));
    return v.handle.getZoomFactor();
  }

  print(id: string): void {
    this.views.get(id)?.handle.print();
  }

  navAction(id: string, action: "back" | "forward" | "reload" | "stop"): void {
    const v = this.views.get(id); if (!v) return;
    if (action === "back") v.handle.goBack();
    else if (action === "forward") v.handle.goForward();
    else if (action === "reload") v.handle.reload();
    else v.handle.stop();
  }

  /** Per-frame renderer→main sync: placeholder rect + the renderer's devicePixelRatio, plus the
   *  renderer's visibility verdict (it hides the view during pane drags and layout settles — the
   *  research's bounds-lag mitigation lives on the renderer side, where the drag is known). */
  setBounds(id: string, rect: ViewRect, dpr: number, visible: boolean): void {
    const v = this.views.get(id); if (!v) return;
    v.host = toViewBounds(rect, dpr, this.opts.scaleFactor());
    this.place(id);
    v.handle.setVisible(visible);
  }

  /** Show the page at a device preset's width, or (null) fit the pane again. In memory, per view. */
  setDevice(id: string, preset: DevicePresetId | null): void {
    const v = this.views.get(id); if (!v) return;
    v.device = devicePreset(preset);
    this.place(id);
    this.emitState(id);
  }

  deviceOf(id: string): DevicePresetId | null {
    return this.views.get(id)?.device?.id ?? null;
  }

  /** The view's bounds from the pane's rect: the rect itself, or a preset's box inside it — and the
   *  emulation that goes with it, sent only when it changed. */
  private place(id: string): void {
    const v = this.views.get(id); if (!v || !v.host) return;
    const fit = v.device ? deviceFit(v.host, v.device) : null;
    v.handle.setBounds(fit?.view ?? v.host);
    const key = fit ? JSON.stringify(fit.metrics) : null;
    if (key === v.emulated) return;
    v.emulated = key;
    this.opts.emulate?.(id, fit?.metrics ?? null);
  }

  setAllowlist(id: string, allowlist: string[] | null): void {
    const v = this.views.get(id); if (v) v.allowlist = allowlist;
  }

  /**
   * The pane showing this view unmounted, but the browser item still exists — the user switched
   * space or pane group. Hide the view (main does it here because the renderer's per-frame bounds
   * sync, which is what normally carries the visibility verdict, stops with the pane) and keep the
   * process running so background work and agent driving continue.
   *
   * Hiding is safe for driving: on Electron 37 a hidden `WebContentsView` still accepts CDP
   * `Input.dispatchMouseEvent`/`dispatchKeyEvent` — measured, both with and without background
   * throttling. What hiding alone would cost is background WORK, which browser-pane.ts buys back.
   */
  retain(id: string): void {
    const v = this.views.get(id); if (!v) return;
    v.handle.setVisible(false);
    this.retained.delete(id);
    this.retained.add(id); // to the back: most recently retained
    while (this.retained.size > RETAINED_VIEW_LIMIT) {
      const oldest = this.retained.values().next().value;
      if (oldest === undefined) break;
      // Dropped here rather than left to `destroy`, so the loop terminates on its own terms and not
      // on the invariant that every retained id still has a view behind it.
      this.retained.delete(oldest);
      this.destroy(oldest);
    }
  }

  /** Mark a retained view as recently used, so eviction does not take one an agent is driving in the
   *  background out from under it. A no-op for views with a mounted pane — those cannot be evicted. */
  touch(id: string): void {
    if (!this.retained.delete(id)) return;
    this.retained.add(id);
  }

  /** Final: the user closed the pane or deleted the item. Only these destroy a view — a pane merely
   *  unmounting `retain`s instead, or a space switch would throw the page away. */
  destroy(id: string): void {
    const v = this.views.get(id); if (!v) return;
    this.views.delete(id);
    this.retained.delete(id);
    // Tolerate a view the window already tore down: on BrowserWindow "closed", Electron has destroyed
    // the children before this runs, and a second destroy throws "Object has been destroyed". The row
    // must be forgotten either way (user-hit crash, 2026-08-31).
    try { v.handle.destroy(); } catch { /* already gone with its window */ }
  }

  /** Window teardown: the views must never outlive the window they composite into. */
  destroyAll(): void { for (const id of [...this.views.keys()]) this.destroy(id); }

  /** Which cookie jar this view lives in — its profile's — or null when there is no view. */
  partitionOf(id: string): string | null { return this.views.get(id)?.partition ?? null; }

  /** Why the page this view is on did not load, or null when it did (or there is no view). */
  loadErrorOf(id: string): BrowserLoadError | null { return this.views.get(id)?.handle.getLoadError() ?? null; }

  /** Every view in one jar, retained or on screen: a deleted profile's panes, which must not go on
   *  running signed in to anything. */
  destroyPartition(partition: string): void {
    for (const [id, v] of [...this.views]) if (v.partition === partition) this.destroy(id);
  }

  private emitState(id: string): void {
    const v = this.views.get(id); if (!v) return;
    this.opts.sendState({
      id, url: v.handle.getURL(), title: v.handle.getTitle(), loading: v.handle.isLoading(),
      canGoBack: v.handle.canGoBack(), canGoForward: v.handle.canGoForward(), device: v.device?.id ?? null,
      favicon: v.handle.getFavicon(), error: v.handle.getLoadError(), ready: v.handle.isReady(),
    });
  }
}
