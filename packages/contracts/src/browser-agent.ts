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
 *   - `download_blocked` — a download that arrived with no live grant, or with one that had already
 *     expired or been spent. Default-deny is the resting state of the download handler; this is what
 *     the agent sees when it stays that way.
 *   - `too_large` — a download that streamed past `DOWNLOAD_MAX_BYTES` and was cancelled mid-flight.
 *   - `no_destination` — the space has no project, so there is nowhere a download could land that any
 *     other Realm surface would show the user.
 *
 * A refusal NEVER carries the secret, the page's own text, or anything derived from either.
 */
export type BrowserRefusal =
  | "password" | "origin_mismatch" | "no_credential" | "no_presence"
  | "download_blocked" | "too_large" | "no_destination"
  /** The element is inside one of Realm's OWN protected surfaces — the places it asks for permission
   *  and grants things. Only `app_act` can produce this, and it is the refusal that makes driving
   *  Realm's interface survivable at all: every approval in Realm ends up as a button in that
   *  window, so an agent able to press them could answer the request it is blocked on. */
  | "realm_protected";

/**
 * The attribute a renderer element wears to say "no agent may act in here", and what `app_act`
 * refuses anything inside of — the `realm_protected` refusal above is what it produces.
 *
 * In contracts because it is a contract, held between two halves that cannot import each other: the
 * renderer writes it onto the surfaces that grant things, and Electron main reads it off the live
 * DOM at act time. The desktop app compiles those as separate composite projects, so there is no
 * third place for it that both can reach.
 *
 * The VALUE on the element names the surface, so a refusal can say which one it was rather than
 * "a protected one". An attribute with no value still refuses.
 */
export const NO_AGENT_ATTR = "data-no-agent";

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
 * There is no file-type allowlist here, and that is a decision rather than an omission.
 *
 * There was one — documents, archives, images, audio, video — and it refused everything else,
 * including through the user's own Save button. It was the wrong boundary. The web serves `.7z`,
 * `.parquet`, `.ipynb`, `.sqlite`, a firmware `.bin`, a font, a file with no extension at all, and
 * an allowlist is a list of the formats somebody thought of on the day: it is wrong again every
 * year, and it is wrong in the direction that makes the feature useless for the file you actually
 * need. Refusing a download because Realm cannot name its type is a guess dressed as a guard.
 *
 * What bounds the risk is the part that never depended on the file's name, and none of it moved:
 *
 *   - `will-download` is DEFAULT-DENY. Nothing is written without a one-shot grant minted by an
 *     approved act, consumed on first use, and disarmed when that act's op returns.
 *   - The grant names an origin, and the item's own URL must still match it at download time.
 *   - The name is reduced by `safeAttachmentName` to a bare basename over `[\w.\- ]` with leading
 *     dots stripped, so nothing lands outside the destination whatever the server called it.
 *   - The destination is a fixed `downloads/` under the space's project — never page-influenced,
 *     never per-call — and a collision gets a suffix rather than an overwrite.
 *   - `DOWNLOAD_MAX_BYTES` is enforced on bytes actually RECEIVED.
 *
 * What an extension list never was, is a defence against execution. Realm does not open what it
 * saves. A `.dmg` in a project folder is bytes until someone double-clicks it, and that is the
 * user's decision at the moment they make it — the same decision they make about a file downloaded
 * in any browser, and not one an enumeration in this file can make better on their behalf.
 */

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
 * holds a list of addresses the user visited.
 *
 * Every entry is offerable. There used to be a `retryable` flag for the types the allowlist would
 * refuse anyway — shown, but with no Save button, because a button that cannot work is a lie. With
 * the allowlist gone the flag was always true, and a field that is always true is a branch the UI
 * has to carry for a case that can no longer happen.
 */
export type BlockedDownload = { id: string; name: string; ts: number };

/** How long a blocked download stays offerable. Short: the bar is about the click the user just
 *  made, not a history of everything a page ever tried. */
export const BLOCKED_DOWNLOAD_TTL_MS = 5 * 60_000;

/** `download` op result. `relPath` is project-relative (`downloads/<name>`), so it is directly
 *  usable by the agent's own file tools without handing it an absolute path to anywhere. */
export type BrowserDownloadResult =
  | { ok: true; name: string; bytes: number; relPath: string }
  | { ok: false; error: string; refused?: BrowserRefusal };

/* ------------------------------------ element picking ------------------------------------ */

/**
 * One element the USER picked out of a browser pane, on its way into a prompt.
 *
 * Everything from `rect` down is PAGE-AUTHORED. A page chooses its own ids, classes and text, and
 * all of it — the rect included — is computed by script evaluated in the page's own world, where the
 * page could have replaced `querySelectorAll`, `Element.prototype.cloneNode` or
 * `getBoundingClientRect` and lied about the answer. The clamps
 * are the only reason a hostile page cannot make a picked element arbitrarily large; they are not a
 * reason to believe it, and nothing downstream may read these fields as instructions.
 *
 * `url` and `title` are only PARTLY better. Main fills them from `webContents` rather than from the
 * page's own words, and script cannot move a webContents off its origin — so the origin of `url` is
 * a fact. Everything after it is not: `history.pushState` writes the path and query, and `title` is
 * `document.title` outright. `elementContext` fences accordingly.
 *
 * `ref` is a CDP backendNodeId like every other ref here, and carries the same caveat: it names the
 * node for as long as the node lives, and a reload invalidates it. It travels so that a follow-up
 * `browser_act` can address the element the user pointed at without re-snapshotting.
 */
export type BrowserPickedElement = {
  ref: number;
  url: string;
  title: string;
  rect: { x: number; y: number; w: number; h: number };
  /** CSS path that resolved to exactly this node when it was picked, verified unique in the page. */
  selector: string;
  tag: string;
  role: string;
  /** Accessible name, or the first attribute that stands in for one — may be empty. */
  name: string;
  /** Collapsed `innerText`. */
  text: string;
  /** `outerHTML`, truncated rather than elided so what is shown is exactly what is there. */
  html: string;
  /**
   * Present only when the pick landed inside a STREAMED DEVICE surface — a simulator mirrored into
   * the pane by serve-sim — rather than on an ordinary page element.
   *
   * The device's UI is pixels as far as the DOM is concerned: the whole screen is one `<canvas>` or
   * `<img>`, so `elementFromPoint` can only ever return the surface itself. What the device DOES
   * publish is its accessibility tree, and this is one element out of it, chosen by the point the
   * user clicked. The DOM half of this object then describes the SURFACE (that is what was picked,
   * and saying otherwise would be a lie the agent acts on) while `role`, `name` and `rect` are
   * overwritten with the device element's own, because those three are what the chip is FOR.
   *
   * `selector` and `html` stay empty rather than being filled with something selector-shaped: there
   * is no CSS path to a thing that is not in the document, and `elementContext` prints the device
   * block instead.
   *
   * The consequence the agent has to know: `browser_act` cannot address this. `ref` names the
   * surface, so acting on it would click the middle of the screen. Driving it means the device's own
   * input channel, which is why `frame` and `screen` travel — they are what a tap is computed from.
   */
  device?: {
    /** The device's identifier for the element (`com.apple.settings.general`), stable across snapshots. */
    id: string;
    /** Index path in the device's accessibility tree (`0.1.1`). Stable only within one screen state. */
    path: string;
    /** Whether the device reports the element as enabled. */
    enabled: boolean;
    /** The element's frame in DEVICE POINTS, relative to `screen` — not pane pixels. */
    frame: { x: number; y: number; width: number; height: number };
    /** The device screen those points are in, so a normalized tap is `(frame.x + frame.width / 2) / screen.width`. */
    screen: { width: number; height: number };
  };
};

/** Clamps for the device half. `id` and `path` are the device's own strings and travel into a prompt
 *  like every other picked field, so they are bounded at the same place. */
export const PICK_DEVICE_ID_MAX = 200;

/** Clamps for the page-authored halves of a `BrowserPickedElement`. A picked element is headed for a
 *  prompt, where every character is paid for twice — once in the composer's width and once in the
 *  agent's context — so the markup budget is a paragraph, not a document. */
export const PICK_SELECTOR_MAX = 200;
export const PICK_NAME_MAX = 120;
export const PICK_TEXT_MAX = 240;
export const PICK_HTML_MAX = 1200;
/** And for the two fields main reads off the webContents: a page controls its own title, and its own
 *  path via `pushState`, and can make either enormous. */
export const PICK_URL_MAX = 2048;
export const PICK_TITLE_MAX = 300;

/**
 * Per space: may Realm finish a sign-in by itself, including the click on Authorize?
 *
 * Off by default, and the default is the decision rather than a placeholder. With it off the flow
 * still does every mechanical step — opens the terminal, runs the login command, reads the URL,
 * puts the consent page in front of you — and stops at the one act that grants a durable capability.
 * That is one click instead of a six-step errand, and no security boundary moves.
 *
 * Turning it on does not license authorizing anything: it lets `SignInTickets` mint a ticket for the
 * exact page Realm read out of the terminal it just started, and only that page, for five minutes.
 * The whole argument for why that is different from a standing grant is in `browsers/signin.ts`.
 *
 * Keyed per space like the computer allowlist, and for its reason: a switch that reached wider than
 * the space it was flipped in would silently arm spaces nobody had said it about.
 */
export const AGENT_SIGNIN_KEY = "browsers.agentSignIn";
export const AGENT_SIGNIN_DEFAULT = false;

/* ---------------------------------- passkeys ---------------------------------- */

/**
 * A passkey Realm holds, as every surface outside the secret store sees it.
 *
 * Same shape of promise as `BrowserCredential` and for the same reason: NO FIELD FOR A PRIVATE KEY.
 * The key exists as ciphertext in Electron main's secret store and, for the duration of one request
 * the user approved with Touch ID, inside the pane's virtual authenticator. It is cleared out of the
 * authenticator when that request settles, so a pane sitting idle holds no key material at all.
 *
 * `rpId` is a bare hostname (`github.com`), not an origin — that is what WebAuthn scopes a credential
 * to, and it is deliberately NOT the origin rule `normalizeOrigin` implements for passwords. A
 * passkey for `github.com` is designed to work on `gist.github.com`; a password for
 * `https://github.com` is designed not to. Both rules are correct for their own credential type, and
 * `passkeyRpIdForPageUrl` is where the WebAuthn one is written down.
 *
 * `userName` and `userDisplayName` come from the relying party at registration — they are the only
 * page-authored strings here, they are clipped on the way in, and they are shown only in Settings
 * beside the `rpId` Realm derived itself.
 */
export type Passkey = {
  id: string;
  rpId: string;
  userName: string;
  userDisplayName: string;
  createdAt: number;
  lastUsedAt: number | null;
};

/** Clip for the two relying-party-authored strings on a passkey. Long enough for a real email
 *  address and a real display name; short enough that a row in Settings cannot be made into a
 *  paragraph by the site that registered it. */
export const PASSKEY_NAME_MAX = 128;

/**
 * Why a passkey request was refused, in the words the pane's notice uses.
 *
 * Each of these is a DIFFERENT thing for the user to do next, which is why they are not one message:
 * `none` means register one, `no_presence` means the fingerprint check did not pass, `rp_mismatch`
 * means the page asked for a passkey belonging to some other site, and `unavailable` means this Mac
 * cannot do the Touch ID check at all.
 */
export type PasskeyRefusal = "none" | "no_presence" | "rp_mismatch" | "unavailable";

/** What the pane is told when a passkey request did not go through. `rpId` is Realm's own derivation
 *  from the pane's real URL, never the page's claim, so the notice can name a site safely. */
export type PasskeyNotice = {
  browserId: string;
  rpId: string;
  kind: "create" | "get";
  refused: PasskeyRefusal;
};

/**
 * The rp id a page at `pageUrl` is allowed to ask for, or null when it may not ask at all.
 *
 * This is the WebAuthn scoping rule, and Chromium enforces it again below us — it is written here
 * anyway because Realm makes two decisions BEFORE dispatch that Chromium never sees: whether to
 * raise a Touch ID prompt, and which of the user's private keys to unseal. Both must be made on the
 * page's real origin rather than on the `rp.id` the page put in the options object, or a page could
 * name `github.com` and have Realm prompt for, and unseal, a passkey that is not its own.
 *
 *   - `null` rpId means "my own host", which is what the spec says and what most sites send.
 *   - A stated rpId must be the page's host or a dot-suffix of it: `github.com` from
 *     `gist.github.com` is allowed, `github.com` from `github.com.evil.example` is not, because the
 *     suffix must begin at a label boundary.
 *   - http(s) only, and never a bare IP or a host with no dot — `localhost` is the one exception,
 *     because it is a secure context and it is where anyone testing a sign-in flow works.
 *
 * Note what this does NOT do: consult the public suffix list. Chromium refuses `co.uk` at dispatch
 * and Realm's answer to a request it should not have prompted for is a refusal the user sees, not a
 * silent success — so the cost of being stricter here than the spec is zero and the cost of being
 * looser is a prompt for the wrong site.
 */
export function passkeyRpIdForPageUrl(rpId: string | null | undefined, pageUrl: string): string | null {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (host !== "localhost" && !host.includes(".")) return null;
  const claimed = (rpId ?? "").trim().toLowerCase();
  if (!claimed) return host;
  if (claimed === host) return claimed;
  // The dot is part of the suffix on purpose: without it "notgithub.com" ends with "github.com".
  return host.endsWith(`.${claimed}`) ? claimed : null;
}

/** Where passkeys live and what using one costs, said once so no surface invents its own wording —
 *  the `CREDENTIAL_STORAGE_NOTE` of this feature, and just as unhedged about its limits. */
export const PASSKEY_STORAGE_NOTE =
  "Passkeys created in Realm's browser are held by Realm: the private key is encrypted with a key in your macOS Keychain and stored in Realm's home directory, and it is loaded into a page's authenticator only for the one request you approved with Touch ID. Realm cannot reach the passkeys in your iCloud Keychain — macOS only offers those to browsers Apple has entitled — so a site you already use a passkey on needs a second one registered here.";
