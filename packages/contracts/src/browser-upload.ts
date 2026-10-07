/**
 * Putting a file INTO a page — the vocabulary `browser_upload` and `browser_dismiss_dialog` speak
 * across the `browserHost.op` bridge, plus the pure rules that decide which files may go.
 *
 * ## Why this exists at all
 *
 * A pane's agent could read, click, type and scroll, and every route to attaching a file dead-ended:
 * `browser_act` can only click or type, and typing a path into `<input type="file">` does nothing;
 * clicking "Choose files" opens a native macOS open panel, which nothing in the toolset can drive —
 * and which is MODAL, so the pane stays wedged until a human dismisses it. Driving that panel would
 * mean Accessibility/UI scripting, and asking for blanket accessibility so an agent can work a file
 * picker is the wrong trade for the capability it buys.
 *
 * So Realm never opens the panel. Files are set on the input directly (`DOM.setFileInputFiles`), or
 * the chooser is INTERCEPTED before the click that would open it and fulfilled from Realm's side.
 * Both are CDP operations on a node; neither involves the OS, and neither depends on a TCC grant.
 *
 * ## What bounds the risk
 *
 * An upload is the most outward-facing thing a browser pane can do: it takes bytes off this Mac and
 * gives them to a site. The rules below are the whole of what stands between a page and the disk,
 * and they are pure functions here so they die in unit tests rather than only against a live page:
 *
 *   - `uploadPathRefusal` — the paths no approval can license (`~/.ssh`, `~/.aws`, keychains,
 *     `*.pem`, `.env`). Checked BEFORE the user is asked, because a prompt for a private key is a
 *     prompt that should never have been raised.
 *   - `isUnderRoot` — containment, applied to the SYMLINK-RESOLVED path, so a link inside the space
 *     folder pointing at `~/Documents` is outside and is named as outside.
 *   - `acceptsUpload` — the page's own `accept` attribute, enforced by Realm so the agent learns why
 *     a file was wrong here rather than after the site silently drops it.
 */

/** How many files one `browser_upload` call may attach. A gallery is the motivating case; a hundred
 *  files in one prompt is a list nobody reads, which is the same as no prompt. */
export const UPLOAD_MAX_FILES = 20;

/**
 * Per-file cap for the ordinary (`DOM.setFileInputFiles`) path.
 *
 * Generous because the motivating upload is a demo video, and the bytes never pass through Realm:
 * Chromium's browser process opens the path itself. What the cap is really for is making a mistake
 * — a path that turns out to be a disk image, a database — fail at the prompt with a size on it
 * rather than halfway up someone's connection.
 */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Per-file cap for the DROP path, which is three orders of magnitude smaller and for a reason: a
 * synthesized drop has to materialize the file's bytes as a `DataTransfer` inside the page, so they
 * travel base64 through one CDP string and land in the renderer's heap. 25 MB of that is already a
 * ~34 MB string; a video would take the renderer down. A dropzone that cannot be fed this way fails
 * with the cap named, which is a better answer than a page that dies mid-upload.
 */
export const UPLOAD_DROP_MAX_BYTES = 25 * 1024 * 1024;

/** How long `browser_upload` waits for `Page.fileChooserOpened` after clicking a picker-opening
 *  element. Long enough for a handler behind a React render and a network-gated menu; short enough
 *  that "that click opens no chooser" is answered while the agent is still interested. */
export const UPLOAD_CHOOSER_TIMEOUT_MS = 5_000;

/**
 * How long file-chooser interception stays armed after an ordinary `browser_act` click.
 *
 * Every agent click arms interception, because ANY click can be the one that opens a picker and a
 * native panel is not recoverable from this side. It is disarmed again after this window so the
 * USER's own clicks still get a real panel — interception is a property of the page, not of the
 * caller, and a pane left permanently armed is a pane where the human's own "Choose files" button
 * silently does nothing.
 */
export const UPLOAD_ARM_WINDOW_MS = 2_500;

/** One file, resolved and vetted server-side, on its way to the executor. `path` is absolute and
 *  already symlink-resolved: main passes it to CDP, which opens it, so the string that arrives here
 *  is the string that gets read. */
export type BrowserUploadFile = { path: string; name: string; bytes: number };

/** How the executor actually attached the files — reported back so the agent (and the ticker) can
 *  say which route worked, and so "it opened no chooser" is distinguishable from "it is not an
 *  input at all". */
export type BrowserUploadMethod = "input" | "chooser" | "drop";

/**
 * `upload` op result.
 *
 * `names` is what is ATTACHED according to the input afterwards — read back off `input.files`, not
 * echoed from the request — so an agent can confirm the upload landed without a screenshot.
 *
 * `value` is that same post-state the way a snapshot would render it, and it is NULLABLE on purpose:
 * null means the input could not be read back (a drop target has no input at all; a node replaced by
 * a re-render between the set and the read has none either). An empty string is a different claim —
 * the input was read and holds nothing — and collapsing the two would have the tool report "the page
 * cleared it" every time a readback merely failed.
 */
export type BrowserUploadResult =
  | { ok: true; method: BrowserUploadMethod; names: string[]; value: string | null; accept: string | null; multiple: boolean }
  | { ok: false; error: string; refused?: BrowserUploadRefusal };

/**
 * Why an upload was refused, as a closed set. These are the failures the spec requires be told
 * apart, because each sends the agent somewhere different:
 *
 *   - `not_a_file_target` — the ref is neither a file input nor associated with one, clicking it
 *     opened no chooser, and it is not a dropzone. Take a fresh snapshot and pick another element.
 *   - `no_chooser` — interception was armed and the click landed, but no file chooser ever opened.
 *     Distinct from the above: the element WAS clickable, it just does not pick files.
 *   - `accept_mismatch` — the page's own `accept` attribute excludes one of the files.
 *   - `too_many` — more files than a single-file input will hold.
 *   - `too_large` — a file past the cap for the route that was going to carry it.
 */
export type BrowserUploadRefusal = "not_a_file_target" | "no_chooser" | "accept_mismatch" | "too_many" | "too_large";

/** `dismissDialog` op result. `dismissed` is false when there was nothing open — not an error: the
 *  agent asking twice, or asking after the page moved on, should learn the state rather than fail. */
export type BrowserDismissDialogResult = { dismissed: boolean; detail: string };

/* ------------------------------------ path rules ------------------------------------ */

/**
 * Paths Realm will not upload from, whatever the user approved.
 *
 * This is deliberately a REFUSAL rather than a second prompt. The directories and suffixes here hold
 * exactly one kind of thing — the credential that opens everything else — and there is no legitimate
 * "upload my private key to this web page" the user needs Realm's help with. Approving the enclosing
 * directory does not reach them: the check runs per FILE, after symlink resolution, so
 * `~/uploads/key -> ~/.ssh/id_rsa` is refused by its real name.
 *
 * Note what this is not: an exhaustive list of secrets. A file called `passwords.txt` goes through,
 * and the prompt naming it is what catches that one. This list covers the paths whose CONTENT is a
 * credential by construction, where a prompt is the wrong instrument because nobody reads the
 * hundredth prompt carefully and the first mistake is unrecoverable.
 *
 * Returns the reason (naming the rule, and quoting the path — the spec's "refused with the path
 * named"), or null when nothing here objects.
 */
export function uploadPathRefusal(absPath: string): string | null {
  const path = absPath.replace(/\\/g, "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = path.toLowerCase();
  const lowerName = name.toLowerCase();

  for (const dir of SECRET_DIRS) {
    if (lower.includes(`/${dir}/`) || lower.endsWith(`/${dir}`)) {
      return `refused: ${absPath} is inside a ${dir}/ directory, which holds credentials. Realm never uploads from there, in any permission mode and whatever the user approved.`;
    }
  }
  for (const suffix of SECRET_SUFFIXES) {
    if (lowerName.endsWith(suffix)) {
      return `refused: ${absPath} ends in ${suffix}, which is a key or a secrets file. Realm never uploads one, in any permission mode and whatever the user approved.`;
    }
  }
  if (SECRET_NAMES.has(lowerName) || lowerName.startsWith(".env.")) {
    return `refused: ${absPath} is a ${name} file, which holds secrets. Realm never uploads one, in any permission mode and whatever the user approved.`;
  }
  return null;
}

/** Directory names whose whole purpose is credential storage. Matched as a path SEGMENT, so a file
 *  honestly called `ssh-notes.md` is unaffected. `Keychains` covers both `~/Library/Keychains` and
 *  `/Library/Keychains`; `.gnupg` and `.docker` hold keys and registry logins respectively. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".gpg", "keychains", ".docker", ".kube", ".config/gcloud"];

/** Suffixes that name key material or a secrets file outright. `.keychain-db` is the modern macOS
 *  keychain; `.p12`/`.pfx` and `.jks` are certificate bundles; `.kdbx` is a password database. */
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keychain", ".keychain-db", ".kdbx", ".asc", ".ppk"];

/** Exact names. `.env` and every `.env.<something>` (handled by the caller's prefix test) are the
 *  motivating case; `id_rsa` and friends are here so a key COPIED out of `~/.ssh` is still refused. */
const SECRET_NAMES = new Set([
  ".env", ".netrc", ".pgpass", ".npmrc", ".pypirc", "credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);

/**
 * Is `abs` inside `root`? Both must already be absolute and symlink-resolved by the caller — this
 * function does no I/O, which is what makes it testable, and it is the caller's job not to hand it
 * a lie.
 *
 * The separator in the prefix test is load-bearing: without it `/Users/me/realm-secrets` is "inside"
 * `/Users/me/realm`.
 */
export function isUnderRoot(root: string, abs: string): boolean {
  const r = trimSlash(root);
  const a = trimSlash(abs);
  return a === r || a.startsWith(`${r}/`);
}

const trimSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/**
 * Does this file satisfy an `<input type="file" accept="…">`?
 *
 * The attribute's grammar is a comma-separated list of extensions (`.png`), exact mime types
 * (`image/png`) and wildcard mime groups (`image/*`), and a file passes if it matches ANY entry.
 * Empty or absent `accept` accepts everything, which is what the HTML spec says.
 *
 * Realm enforces it because the alternative is worse than a refusal: `setFileInputFiles` will
 * cheerfully attach a `.mov` to an image-only input, the browser will not complain, and the site
 * rejects it later with a message the agent has to go find in the page. The error here names the
 * file and the attribute, which is a fact the agent can act on immediately.
 *
 * Unknown entries are treated as NOT matching rather than as a free pass. An `accept` Realm cannot
 * parse is a constraint it cannot check, and letting the file through on that basis would be
 * claiming a check that did not happen.
 */
export function acceptsUpload(accept: string | null | undefined, name: string, mime: string): boolean {
  const raw = (accept ?? "").trim();
  if (raw === "") return true;
  const lowerName = name.toLowerCase();
  const lowerMime = mime.toLowerCase();
  return raw.split(",").some((entryRaw) => {
    const entry = entryRaw.trim().toLowerCase();
    if (entry === "") return false;
    if (entry === "*" || entry === "*/*") return true;
    if (entry.startsWith(".")) return lowerName.endsWith(entry);
    if (entry.endsWith("/*")) return lowerMime.startsWith(entry.slice(0, -1));
    return lowerMime === entry;
  });
}

/** A byte count as the permission card and the tool result say it. Whole units below a megabyte,
 *  one decimal above, so "1.2 MB" and "880 KB" both read at a glance and neither pretends to a
 *  precision the reader needs. */
export function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
