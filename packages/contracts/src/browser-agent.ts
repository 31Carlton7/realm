import { z } from "zod";

/**
 * The browser agent bridge's op payloads (Plan 11 W3) — the vocabulary realm-server (where the
 * `realm-browser` gateway provider lives) and Electron main (where the `WebContentsView`s and their
 * `webContents.debugger` live) speak across the `browserHost.op` / `browserHost.result` channel.
 * Shared through contracts so the two processes cannot drift: the server validates what it forwards,
 * main trusts the shapes it receives, and both compile against this one file.
 *
 * Refs are CDP **backendNodeId**s — stable for the node's lifetime, never the frontend nodeIds that
 * renumber on every DOM agent reattach (capability research §5). A ref is only ever a *name* here:
 * every act re-resolves it to geometry via `DOM.getContentQuads` at act time, so a stale layout can
 * make an act fail honestly but never make it click the wrong place.
 */

/**
 * The read-only half of the `realm-browser` tool surface — ONE list, shared by everything that
 * treats "read-only" as a privilege boundary: the gateway provider (these run without a broker
 * prompt, and a `browser_batch` of only these runs unprompted) and the Claude adapter (these are
 * pre-allowed via the SDK's `allowedTools`, so Claude's own per-MCP-tool prompt never stacks on
 * top of nothing — W4's double-prompt fix).
 *
 * NEVER add a mutating tool here. A name on this list runs promptless in every session: an
 * addition weakens two independent gates at once, which is exactly why the list lives in one place
 * where a test can pin its exact contents.
 *
 * `browser_credentials` belongs here despite the word: it lists enrolled sign-ins as
 * `BrowserCredential`, a type with no field for a value, so there is no secret for a promptless call
 * to disclose. What it returns is the origin, username and label the USER typed into Settings — the
 * same three facts the fill's permission card shows them. `browser_fill_credential` is emphatically
 * NOT here.
 */
export const BROWSER_READ_ONLY_TOOLS = ["browser_list", "browser_snapshot", "browser_read", "browser_screenshot", "browser_credentials"] as const;

export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    ref: z.number().int().positive(),
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(z.enum(["alt", "ctrl", "meta", "shift"])).default([]),
  }),
  z.object({
    kind: z.literal("type"),
    ref: z.number().int().positive(),
    text: z.string().max(4000),
    /** "keys" (default) dispatches full per-character key events — required for React-style inputs
     *  that ignore `value` writes; "insertText" is the documented fallback for large pastes and IME-ish
     *  content where per-key events are pointless. Both are preceded by a real focus. */
    method: z.enum(["keys", "insertText"]).default("keys"),
    /** Press Enter after the text (form submit). */
    submit: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("key"),
    /** A named key: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", … */
    key: z.string().min(1).max(24),
    ref: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    ref: z.number().int().positive().optional(),
    deltaX: z.number().default(0),
    deltaY: z.number().default(0),
  }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

/** What `browser_read` can read. `text` is the page's article-first inner text; `console` and
 *  `network` are the host's ring buffers since the pane opened (or the buffers' capacity). */
export const BrowserReadKindSchema = z.enum(["text", "console", "network"]);
export type BrowserReadKind = z.infer<typeof BrowserReadKindSchema>;

/**
 * Why an executor refused, as a closed set — every member is a HARD block decided against the live
 * page in Electron main, never a permission prompt and never mode-dependent.
 *
 *   - `password` — `browser_act` tried to type into a password field. The oldest of these and the
 *     one that stays unconditional: there is no argument, no mode and no enrolled credential that
 *     turns a plain `type` into a password field into an allowed act. `browser_fill_credential` is
 *     a different op, not an escape hatch for this one.
 *   - `origin_mismatch` — a fill was asked for on a page whose CURRENT origin is not the origin the
 *     credential was enrolled against. The anti-phishing gate: a lookalike page gets nothing, and
 *     it is decided BEFORE the user is asked for presence, so a phishing page cannot even train the
 *     user into a Touch ID reflex.
 *   - `no_credential` — nothing is enrolled under that id (or it was removed since the agent last
 *     listed credentials).
 *   - `no_presence` — the OS declined or the user cancelled the Touch ID / password prompt.
 *   - `download_blocked` — a download whose filename is not on `DOWNLOAD_ALLOWED_EXTENSIONS`, or that
 *     arrived with no live grant. Default-deny is the resting state of the download handler; this is
 *     what the agent sees when it stays that way.
 *   - `too_large` — a download that streamed past `DOWNLOAD_MAX_BYTES` and was cancelled mid-flight.
 *   - `no_destination` — the space has no project, so there is nowhere a download could land that any
 *     other Realm surface would show the user.
 *
 * A refusal NEVER carries the secret, the page's own text, or anything derived from either.
 */
export type BrowserRefusal =
  | "password" | "origin_mismatch" | "no_credential" | "no_presence"
  | "download_blocked" | "too_large" | "no_destination";

/** `act` and `fillCredential` op result. `refused` marks the hard blocks — decided in the executor
 *  against the live DOM, REGARDLESS of permission mode; the tool surface turns each into a
 *  "hand this to the user" error rather than something the agent can retry its way past.
 *
 *  `detail` is Realm's own words about what it did. For a credential fill it names the origin and
 *  nothing else — no length, no prefix, no masked rendering: a character count is a fact about a
 *  secret, and this type is the last place that could have leaked one. */
export type BrowserActResult =
  | { ok: true; detail: string }
  | { ok: false; error: string; refused?: BrowserRefusal };

/** `describe` op result — the trustworthy page identity (url/title from CDP, not page text) plus,
 *  when a ref was asked about, that element's AX identity for permission prompts. `open: false` means
 *  the pane's native view does not exist right now (pane not mounted in the app). */
export type BrowserDescribeResult = {
  open: boolean;
  url: string;
  title: string;
  element?: { role: string; name: string; tag: string; inputType: string | null } | null;
};

export type BrowserSnapshotResult = { url: string; title: string; text: string; elementCount: number };
export type BrowserReadResult = { text: string };
export type BrowserScreenshotResult = { data: string; mimeType: string };
export type BrowserNavigateResult = { url: string | null };

/**
 * `browser_agent_run`'s constraints (Plan 11 W5). Both optional:
 *
 * - `allowedOrigins` narrows which origins the CHILD session's own `browser_open`/`browser_navigate`
 *   may target — enforced server-side in the `realm-browser` provider for the child's calls only
 *   (the SPACE allowlist, enforced in Electron main per view, still governs in-page navigation).
 * - `maxActs` caps the child's mutating browser tool calls AND scales its settle deadline; a run
 *   that exhausts either is reported to the parent as exactly that, with whatever partial text exists.
 */
export const BrowserAgentConstraintsSchema = z.object({
  allowedOrigins: z.array(z.string().min(1)).max(50).optional(),
  maxActs: z.number().int().min(1).max(100).optional(),
});
export type BrowserAgentConstraints = z.infer<typeof BrowserAgentConstraintsSchema>;

/* ------------------------------- saved credentials ------------------------------- */

/**
 * One enrolled sign-in, as EVERY surface outside Electron main is allowed to know it.
 *
 * The governing invariant of this feature is that credential plaintext never enters the model's
 * context, a snapshot, an act result, the transcript, or a log line — and the first line of defence
 * is that this type, the only credential shape the renderer, the RPC wire, the bridge and the MCP
 * tool surface ever see, HAS NO FIELD FOR A VALUE. There is nothing to accidentally serialize,
 * nothing to widen a `select *` into, and nothing a future `JSON.stringify` can spill. The value
 * exists as ciphertext in Electron main's secret store and, for a few milliseconds per fill, as
 * key events on their way into a page. Nowhere else.
 *
 * `origin` is a normalized `URL.origin` (`https://host[:port]`, lowercased scheme+host, default
 * port elided) — see `normalizeOrigin`. `username` and `label` exist for ONE reason: so the
 * permission card can say which account is about to be typed where. They are the user's own words,
 * entered in Settings; no page ever authors them.
 */
export type BrowserCredential = {
  id: string;
  origin: string;
  username: string;
  label: string;
  createdAt: number;
};

/** Enrollment input. `value` appears HERE and in no other exported type: this schema is used only by
 *  the renderer→main IPC that saves a credential, a channel that runs one way. There is deliberately
 *  no matching read shape, because there is deliberately no read. */
export const BrowserCredentialInputSchema = z.object({
  origin: z.string().min(1).max(255),
  username: z.string().max(255).default(""),
  label: z.string().max(255).default(""),
  value: z.string().min(1).max(4096),
});
export type BrowserCredentialInput = z.infer<typeof BrowserCredentialInputSchema>;

/**
 * How long a successful OS presence check (Touch ID / watch / password) licenses further fills.
 *
 * `0` — the default and the honest one — means every single fill prompts. The longer options exist
 * because a real sign-in is often two fills (username page, then password page) behind an SSO
 * redirect, and making the user Touch-ID twice in six seconds teaches them to stop reading the
 * prompt. Capped at five minutes: this is a convenience window, not a session.
 */
export const CREDENTIAL_PRESENCE_TTLS = [0, 60_000, 300_000] as const;

/**
 * Where saved sign-ins actually live, stated plainly because the alternative is a false sense of
 * security — the same duty `MCP_SECRET_STORAGE_NOTE` discharges for MCP keys, and the opposite
 * answer. UI copy: any surface that takes a credential has to show it.
 */
export const CREDENTIAL_STORAGE_NOTE =
  "Saved sign-ins are encrypted with a key held in your macOS Keychain and stored in Realm's home directory. A value is only ever decrypted inside Realm's own main process, to type it into a page you approved — it is never sent to an agent, never written to a log or transcript, and cannot be read back, by you or by anything else, once saved. Every fill needs Touch ID, so a Mac without a Touch ID sensor can store sign-ins but cannot fill them.";

/** The part of a credentialed sign-in Realm cannot do for you, said once, in one place, so no
 *  surface has to invent its own wording for it. Deliberately NOT hedged: Duo/Okta push approvals
 *  and TOTP prompts are not automated here and no amount of retrying makes them so. */
export const CREDENTIAL_2FA_NOTE =
  "Two-factor steps are not automated. If the site sends a push (Duo, Okta Verify) or asks for a code, you complete that part yourself in the pane — Realm fills the saved username and password and stops there.";

/**
 * Normalize a URL to the origin string credentials are compared on, or null when the input is not a
 * URL with a comparable origin.
 *
 * The comparison this feeds is EXACT string equality, which is the whole anti-phishing gate, so this
 * function's job is to make sure two spellings of the same origin normalize together and two
 * different origins never do:
 *
 *   - `null` for anything without a real host (`about:blank`, `data:`, `file:`) — `URL.origin`
 *     answers the literal string `"null"` for those, and a stored `"null"` matching a live `"null"`
 *     would be a credential that fills on every opaque page. Refusing them is the only safe answer.
 *   - only http(s). A credential is a web sign-in; no scheme Realm's panes cannot navigate to needs
 *     to be representable here.
 *   - default ports elided and host lowercased by `URL` itself; `https://EXAMPLE.com:443/login` and
 *     `https://example.com/` both become `https://example.com`.
 *
 * Note what is NOT done: no registrable-domain fallback, no subdomain wildcarding, no `www.`
 * stripping. `https://login.example.com` and `https://example.com` are different origins and a
 * credential for one must not fill on the other — that leniency is exactly the hole a lookalike
 * host is built to walk through.
 */
export function normalizeOrigin(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  const origin = url.origin;
  return origin && origin !== "null" ? origin : null;
}

/* ---------------------------------- downloads ---------------------------------- */

/**
 * What a browser pane is allowed to write to disk, as an ALLOWLIST.
 *
 * This is the single most load-bearing constant in the download feature, and the choice of an
 * allowlist over a denylist is the whole argument for why reversing the old blanket block is safe.
 * A denylist of executables is a list of the ones somebody thought of on the day: `.dmg`, `.pkg`,
 * `.command`, `.scpt`, `.jar`, `.webloc`, `.terminal`, `.workflow`, whatever ships next. The risk
 * this feature actually introduces is turning "an agent reads the web" into "an agent writes files
 * to your disk", and only an allowlist bounds that — an extension nobody enumerated is refused
 * rather than permitted.
 *
 * Documents and archives, because that is what the feature exists for (course materials, papers,
 * spreadsheets). A file with NO extension is refused: `safeAttachmentName` preserves extensions
 * precisely so `mimeForPath` can read them, and a name that carries none is a name Realm cannot
 * reason about.
 *
 * Adding to this list is a security change, not a convenience change. `.html` and `.svg` are here
 * deliberately — both are inert on disk and only dangerous when opened, which is Gatekeeper's and
 * the user's decision, not Realm's — but anything that executes on double-click must never be.
 */
export const DOWNLOAD_ALLOWED_EXTENSIONS = [
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "tsv",
  "txt", "md", "rtf", "tex", "epub", "json", "xml", "html",
  "zip", "tar", "gz", "png", "jpg", "jpeg", "gif", "webp", "svg", "heic",
  "mp3", "m4a", "wav", "mp4", "mov", "webm",
] as const;

/**
 * The cap, enforced against bytes actually RECEIVED rather than any total the server declared —
 * `getTotalBytes()` is 0 for a chunked response and is attacker-controlled in every response.
 *
 * Separate from `MAX_ATTACHMENT_BYTES` (20 MB, what a user may paste into a message) and larger,
 * because the motivating case is a lecture deck or a recorded session.
 */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** How long a download grant stays live after the approved click. Long enough for a redirect chain
 *  and a slow server to produce the response; short enough that a page which does nothing on click
 *  cannot bank the grant for a download it fires later. */
export const DOWNLOAD_GRANT_TTL_MS = 30_000;

/** The subdirectory of the space's project root that downloads land in — a fixed name, never
 *  page-influenced and never configurable per call. Files appear here as untracked in the diff pane,
 *  which is the review the feature relies on the user actually getting. */
export const DOWNLOAD_DIRNAME = "downloads";

/**
 * A download Realm blocked, as the pane's bar shows it (Plan 23 W4).
 *
 * Note what is NOT here: the URL. The renderer gets an opaque id and a name already reduced by
 * `safeAttachmentName`, so nothing page-authored reaches the UI unsanitized and the renderer never
 * holds a list of addresses the user visited. `retryable` is false for anything the extension
 * allowlist would refuse anyway — those are shown (a silent failure is what this exists to remove)
 * but not offered, because a Save button that cannot work is a lie.
 */
export type BlockedDownload = { id: string; name: string; retryable: boolean; ts: number };

/** How long a blocked download stays offerable. Short: the bar is about the click the user just
 *  made, not a history of everything a page ever tried. */
export const BLOCKED_DOWNLOAD_TTL_MS = 5 * 60_000;

/** `download` op result. `relPath` is project-relative (`downloads/<name>`), so it is directly
 *  usable by the agent's own file tools without handing it an absolute path to anywhere. */
export type BrowserDownloadResult =
  | { ok: true; name: string; bytes: number; relPath: string }
  | { ok: false; error: string; refused?: BrowserRefusal };

/**
 * Whether a filename's extension is on the allowlist. Case-insensitive, and deliberately reads only
 * the FINAL extension: `notes.pdf.command` is a `.command`, which is exactly the trick this has to
 * catch. A name with no dot, a name ending in a dot, and a dotfile with no extension all refuse.
 */
export function downloadExtensionAllowed(filename: string): boolean {
  const base = filename.trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return (DOWNLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(base.slice(dot + 1));
}
