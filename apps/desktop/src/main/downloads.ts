/**
 * The download governor (Plan 23) — what replaced the blanket `will-download` block.
 *
 * Electron-free, like `browser-agent.ts` and `secret-store.ts`, because the rules here are the whole
 * feature and they have to die in unit tests rather than only on a machine with a real download in
 * flight.
 *
 * ## The constraint everything else follows from
 *
 * `will-download` fires on the session partition, after the fact, with a `WebContents` and an item.
 * It **cannot tell a human's click from `Input.dispatchMouseEvent`** — CDP input is indistinguishable
 * from real input by construction, which is the point of CDP. So "permit the user, keep blocking the
 * agent" is not implementable at this layer: any rule loose enough for a human is exactly as loose
 * for `browser_act`.
 *
 * Therefore:
 *
 *   - **Default-deny is permanent.** `decide` returns a refusal when there is no grant, and there is
 *     no mode, setting or allowlist anywhere that changes that. It is the resting state.
 *   - A download proceeds only against a **one-shot grant** created by an already-approved,
 *     server-gated act, consumed on first use, and disarmed when that act's op returns. A page that
 *     fires three downloads on one click gets one through and two cancelled — that falls out of
 *     "one-shot" rather than needing its own rule.
 *   - **What** the grant covers is no longer narrowed by file type. Any type the web serves is
 *     saved; the file-type allowlist that used to sit at the end of the gate is gone, and
 *     `browser-agent.ts` carries the argument for why it was the wrong boundary. What a
 *     page-authored name still may never do is choose a path.
 *   - A blocked download is REMEMBERED rather than silently dropped (W4), so the pane can offer the
 *     user a Save button for it. That button is the human's own consent arriving through the
 *     renderer — a channel a page cannot reach (separate `WebContentsView`, contextIsolation) — which
 *     is the only way this layer can ever learn that a human, specifically, wanted a file.
 */
import { basename, join } from "node:path";
import {
  BLOCKED_DOWNLOAD_TTL_MS, DOWNLOAD_DIRNAME, DOWNLOAD_GRANT_TTL_MS, DOWNLOAD_MAX_BYTES,
  normalizeOrigin,
  type BlockedDownload, type BrowserDownloadResult, type BrowserRefusal, type SavedDownload,
} from "@realm/contracts";
import { safeAttachmentName } from "./attachments";

/** A live permission to write ONE file, minted by the gated `download` op and consumed on first use. */
export type DownloadGrant = {
  /** The origin the pane was on when the user approved. The item's own URL must still match it. */
  origin: string;
  /** Absolute directory the file must land in. Never page-influenced, never per-call from an agent. */
  dir: string;
  expiresAt: number;
};

/** The slice of Electron's `DownloadItem` this needs. Narrow on purpose: a wider surface is a wider
 *  set of things a page-controlled item could be asked about. */
export type DownloadItemLike = {
  getFilename(): string;
  getURL(): string;
  getReceivedBytes(): number;
  setSavePath(path: string): void;
  cancel(): void;
  on(event: "updated", cb: () => void): void;
  once(event: "done", cb: (state: string) => void): void;
};

export type DownloadGovernorDeps = {
  mkdirp(dir: string): void;
  exists(path: string): boolean;
  now(): number;
  /** A download finished on disk — the pane's ⋯ menu lists it (`SavedDownloads`). */
  onSaved?(browserId: string, saved: { name: string; path: string }): void;
};

/** `decide`'s answer. Deliberately not a boolean: the refusal code travels to the agent. */
export type DownloadDecision =
  | { allow: true; name: string }
  | { allow: false; refused: BrowserRefusal };

/**
 * The whole gate, as one pure function — every mutant that matters is a wrong answer from here.
 *
 * Order is: grant exists → not expired → origin still matches. There is no test of the file's type;
 * see `browser-agent.ts` for why the allowlist that used to sit at the end of this list was the
 * wrong boundary, and what carries the weight in its place.
 */
export function decideDownload(opts: {
  grant: DownloadGrant | null;
  url: string;
  filename: string;
  now: number;
}): DownloadDecision {
  const { grant } = opts;
  // Default-deny. The single assertion this entire plan rests on.
  if (!grant) return { allow: false, refused: "download_blocked" };
  if (opts.now >= grant.expiresAt) return { allow: false, refused: "download_blocked" };

  // The approved thing and the executed thing must be the same thing — the same rule the credential
  // fill's origin gate enforces, for the same reason. A redirect that lands the download on another
  // origin is drift, not a detail.
  const origin = normalizeOrigin(opts.url);
  if (origin === null || origin !== grant.origin) return { allow: false, refused: "origin_mismatch" };

  // `getFilename()` is page/server-authored (Content-Disposition). Reduced to a basename and a
  // conservative character set by the SAME sanitizer pasted attachments already go through — one
  // sanitizer, so the two cannot disagree. With no extension test after it, this is the ONLY thing
  // standing between a page-authored name and a path: `../../.ssh/authorized_keys`, a name carrying
  // a NUL, and a name that is nothing but dots all have to come out as a bare filename in `dir`.
  const name = safeAttachmentName(basename(opts.filename.replace(/\\/g, "/")), "download");
  return { allow: true, name };
}

/**
 * Holds grants and runs one download to completion.
 *
 * One grant per browser id at a time. `run` is the only thing that arms one, and it disarms in a
 * `finally`, so there is no path that leaves a pane armed after its op returned — the mutant that
 * would let a page bank an approval and spend it later.
 */
export class DownloadGovernor {
  private readonly grants = new Map<string, DownloadGrant>();
  private readonly waiters = new Map<string, (r: BrowserDownloadResult) => void>();

  constructor(private readonly d: DownloadGovernorDeps) {}

  /**
   * Arm, click, and wait for the outcome. `click` is the caller's already-validated act — this class
   * never resolves a ref or talks to CDP itself.
   *
   * A click that lands but produces no download (a link that turned out to be an ordinary
   * navigation) resolves as an honest failure when the grant expires, NOT as a hang: the wait is
   * bounded by the grant's own TTL, so there is exactly one timeout in the system rather than two
   * that can disagree.
   */
  async run(
    browserId: string,
    grant: DownloadGrant,
    click: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<BrowserDownloadResult> {
    if (this.grants.has(browserId)) {
      return { ok: false, error: "a download is already in flight on this pane — wait for it to finish" };
    }
    this.d.mkdirp(grant.dir);
    this.grants.set(browserId, grant);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = new Promise<BrowserDownloadResult>((resolve) => {
        this.waiters.set(browserId, resolve);
        timer = setTimeout(
          () => resolve({ ok: false, error: "that click did not start a download — it may be an ordinary link, or the site may require the file to be opened in its own viewer" }),
          Math.max(0, grant.expiresAt - this.d.now()),
        );
        timer.unref?.();
      });
      try {
        const clicked = await click();
        if (!clicked.ok) return { ok: false, error: clicked.error ?? "the download link could not be clicked" };
        return await settled;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      this.grants.delete(browserId);
      this.waiters.delete(browserId);
    }
  }

  /**
   * The `will-download` entry point. Returns whether the item was allowed; the caller calls
   * `event.preventDefault()` on false.
   *
   * The grant is consumed BEFORE the item is wired up, so a second `will-download` in the same tick
   * sees no grant.
   */
  handle(browserId: string | null, item: DownloadItemLike): DownloadDecision {
    const grant = browserId === null ? null : this.grants.get(browserId) ?? null;
    const decision = decideDownload({ grant, url: item.getURL(), filename: item.getFilename(), now: this.d.now() });
    // `grant` is re-tested rather than asserted: `decideDownload` already refuses a null grant, so
    // this narrows the type without a non-null assertion that a future edit to `decideDownload`
    // could silently invalidate.
    if (!decision.allow || grant === null || browserId === null) {
      const refused = decision.allow ? "download_blocked" : decision.refused;
      this.settle(browserId, { ok: false, error: refusalText(refused), refused });
      return { allow: false, refused };
    }
    this.grants.delete(browserId); // one-shot: consumed here, before anything can await

    const path = this.uniquePath(grant.dir, decision.name);
    item.setSavePath(path);
    // Cap enforced on RECEIVED bytes. `getTotalBytes()` is 0 for chunked responses and is a number
    // the server chose in every case — trusting it is trusting the thing being defended against.
    item.on("updated", () => {
      if (item.getReceivedBytes() > DOWNLOAD_MAX_BYTES) {
        item.cancel();
        this.settle(browserId, { ok: false, error: `that file is larger than ${Math.round(DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB and was cancelled part-way`, refused: "too_large" });
      }
    });
    item.once("done", (state) => {
      const name = basename(path);
      if (state === "completed") this.d.onSaved?.(browserId, { name, path });
      this.settle(browserId, state === "completed"
        // Project-relative, so what the agent is handed is directly usable by its own file tools and
        // is never an absolute path to somewhere on the machine.
        ? { ok: true, name, bytes: item.getReceivedBytes(), relPath: `${DOWNLOAD_DIRNAME}/${name}` }
        : { ok: false, error: `the download did not finish (${state === "cancelled" ? "cancelled" : "interrupted"})` });
    });
    return decision;
  }

  /** First free `name`, `name (2)`, `name (3)`… — a collision never overwrites, and never lets a page
   *  pick an existing path by naming its file after one. */
  private uniquePath(dir: string, name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 1000; n++) {
      const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      if (!this.d.exists(candidate)) return candidate;
    }
    return join(dir, `${stem} (${this.d.now()})${ext}`);
  }

  /** Resolve the op's promise once. Later settles (a `done` after a cap cancel) are ignored. */
  private settle(browserId: string | null, result: BrowserDownloadResult): void {
    if (browserId === null) return;
    const waiter = this.waiters.get(browserId);
    if (!waiter) return;
    this.waiters.delete(browserId);
    waiter(result);
  }
}

/** Refusal wording for the agent. Names the rule, never the file, never the page's own text. */
export function refusalText(refused: BrowserRefusal): string {
  switch (refused) {
    case "download_blocked":
      return "that download was blocked — Realm only saves a file as part of a download you approved, and that approval had not been given, had expired, or was already spent";
    case "origin_mismatch":
      return "the download came from a different origin than the page you approved, so it was cancelled";
    case "too_large":
      return "that file was too large and was cancelled part-way";
    default:
      return "that download was refused";
  }
}

/* --------------------------- W4: the user's own downloads --------------------------- */

/**
 * A blocked download, kept so the pane can tell the user it happened and offer to fetch it.
 *
 * Retained state is deliberately thin: the URL never leaves main (the renderer gets an id and a
 * sanitized name), and entries expire, so a pane's bar cannot accumulate a list of everywhere the
 * user has been.
 */
type BlockedEntry = BlockedDownload & { url: string; origin: string };

/** Per-pane cap. A page that fires a download loop should not be able to grow this without bound;
 *  the oldest entries fall off, which is also what the user would want to see (the most recent). */
const BLOCKED_MAX = 5;

export class BlockedDownloads {
  private readonly byBrowser = new Map<string, BlockedEntry[]>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  /**
   * Remember one blocked download. Returns the entry for broadcasting, or null when there is nothing
   * worth telling the user about.
   *
   * The one case not worth telling about is an item with no http(s) origin — a `blob:` or `data:`
   * download there is no address to re-request. Everything else is offerable: with no allowlist,
   * every blocked download is one the user's own Save button can actually complete.
   */
  note(browserId: string, url: string, filename: string): BlockedDownload | null {
    const origin = normalizeOrigin(url);
    if (!origin) return null; // no address to re-request, and nothing meaningful to name
    const name = safeAttachmentName(basename(filename.replace(/\\/g, "/")), "download");
    const entry: BlockedEntry = {
      id: `bd_${++this.seq}`,
      name,
      ts: this.now(),
      url,
      origin,
    };
    const list = this.live(browserId);
    list.push(entry);
    while (list.length > BLOCKED_MAX) list.shift();
    this.byBrowser.set(browserId, list);
    return strip(entry);
  }

  /** What the pane shows. Expired entries are dropped on read rather than on a timer. */
  list(browserId: string): BlockedDownload[] {
    const list = this.live(browserId);
    this.byBrowser.set(browserId, list);
    return list.map(strip);
  }

  dismiss(browserId: string, id: string): void {
    this.byBrowser.set(browserId, this.live(browserId).filter((e) => e.id !== id));
  }

  release(browserId: string): void {
    this.byBrowser.delete(browserId);
  }

  /** Take one entry for a retry — removed as it is taken, so a double-click cannot fetch twice. */
  take(browserId: string, id: string): BlockedEntry | null {
    const list = this.live(browserId);
    const entry = list.find((e) => e.id === id) ?? null;
    if (entry) this.byBrowser.set(browserId, list.filter((e) => e.id !== id));
    return entry;
  }

  private live(browserId: string): BlockedEntry[] {
    const cutoff = this.now() - BLOCKED_DOWNLOAD_TTL_MS;
    return (this.byBrowser.get(browserId) ?? []).filter((e) => e.ts >= cutoff);
  }
}

const strip = (e: BlockedEntry): BlockedDownload => ({ id: e.id, name: e.name, ts: e.ts });

/** How many saved downloads a pane's ⋯ menu remembers. A submenu, not a downloads manager: the files
 *  themselves are in the folder, and the Finder lists every one of them. */
const SAVED_MAX = 8;

/**
 * What each pane has saved, newest last — the other half of the ⋯ menu's Downloads (Plan 26 W7b),
 * beside `BlockedDownloads`. Fed by the governor's `onSaved`, so the user's own Save and an approved
 * agent download are listed alike: both are files this pane put in the project.
 */
export class SavedDownloads {
  private readonly byBrowser = new Map<string, SavedDownload[]>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  note(browserId: string, saved: { name: string; path: string }): void {
    const list = this.byBrowser.get(browserId) ?? [];
    list.push({ id: `sd_${++this.seq}`, name: saved.name, path: saved.path, ts: this.now() });
    while (list.length > SAVED_MAX) list.shift();
    this.byBrowser.set(browserId, list);
  }

  list(browserId: string): SavedDownload[] {
    return [...(this.byBrowser.get(browserId) ?? [])];
  }

  find(browserId: string, id: string): SavedDownload | null {
    return this.byBrowser.get(browserId)?.find((s) => s.id === id) ?? null;
  }

  release(browserId: string): void {
    this.byBrowser.delete(browserId);
  }
}

/**
 * Fetch a previously-blocked download because the USER asked for it in the pane.
 *
 * Same governor, same grant, same confinement, same cap — the only difference from
 * the agent path is what starts it (`webContents.downloadURL` rather than a click) and where the
 * grant's origin comes from (the blocked item's own origin, not the pane's current one: the user is
 * approving *this file*, which they can see by name, and the pane may have navigated since).
 *
 * **Limit, stated plainly:** a re-fetch is a fresh GET carrying the session's cookies. A download
 * that was generated by a POST, or handed out behind a one-time token, will not come back this way —
 * it fails honestly rather than appearing to work.
 */
export async function retryBlockedDownload(
  governor: DownloadGovernor,
  blocked: BlockedDownloads,
  opts: { browserId: string; id: string; dir: string; downloadURL: (url: string) => void; now: () => number },
): Promise<BrowserDownloadResult> {
  const entry = blocked.take(opts.browserId, opts.id);
  if (!entry) return { ok: false, error: "that download is no longer available to save — it may have expired or already been saved" };
  return governor.run(
    opts.browserId,
    { origin: entry.origin, dir: opts.dir, expiresAt: opts.now() + DOWNLOAD_GRANT_TTL_MS },
    async () => { opts.downloadURL(entry.url); return { ok: true }; },
  );
}
