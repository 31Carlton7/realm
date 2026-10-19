/**
 * What a shared page must not carry: keys and tokens that slipped into a transcript, and the name of
 * the account the work was done under.
 *
 * Saved passwords never reach a transcript — Realm fills them without the agent seeing them — but an
 * agent can still `cat .env`, echo a header or paste a key into its reply, and a page sent to someone
 * else is the last place that should survive. Each pattern here is a credential's own published
 * shape (a GitHub token's `ghp_` prefix, an AWS key id's `AKIA`), or an assignment whose NAME says it
 * holds one (`OPENAI_API_KEY=…`). A shape that merely looks random — a commit hash, a UUID, a base64
 * blob — is left alone: hiding it would make the page harder to read and protect nothing.
 */

/** Credentials that are recognisable on their own, wherever they appear. Longest-prefix shapes first,
 *  so `sk-ant-…` is not half-matched as an OpenAI `sk-…`. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  /(?<![\w-])sk-ant-[\w-]{20,}/g,
  /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[\w-]{20,}/g,
  /(?<!\w)(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /(?<!\w)github_pat_\w{30,}/g,
  /(?<![\w-])glpat-[\w-]{20,}/g,
  /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<!\w)(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![\w-])AIza[\w-]{35}/g,
  /(?<!\w)(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /(?<!\w)whsec_[A-Za-z0-9]{20,}/g,
  /(?<!\w)npm_[A-Za-z0-9]{36,}/g,
  /(?<!\w)hf_[A-Za-z0-9]{30,}/g,
  /(?<![\w.])SG\.[\w-]{16,}\.[\w-]{16,}/g,
  /(?<![\w-])eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
];

/** A credential that only its CONTEXT identifies, as `[prefix, secret]` pairs: the prefix stays, so
 *  the reader still sees what was there. */
const IN_CONTEXT: readonly RegExp[] = [
  // `Authorization: Bearer …`, and a bare `Bearer …` in a curl line.
  /(\bBearer\s+)([\w.~+/=-]{16,})/g,
  // The password in a URL's userinfo: `postgres://app:hunter2@db/…`.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/gi,
  // An environment variable whose name says it holds a secret: `GITHUB_TOKEN=…`, `DB_PASSWORD: "…"`.
  /(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*[=:]\s*["']?)(?!\d+\b)([^\s"'`]{8,})/g,
  // The same in JSON or YAML, lower case and quoted: `"client_secret": "…"`.
  /(["']?(?:password|passwd|secret|client_secret|api_?key|access_token|refresh_token|auth_token|token)["']?\s*:\s*["'])([^"'\s]{8,})(?=["'])/gi,
];

/**
 * `text` with every credential replaced by `mark`, and how many there were. The mark is a parameter
 * because the page draws it as a styled note while a test reads it as plain text.
 */
export function scrubSecrets(text: string, mark = "[hidden]"): { text: string; hidden: number } {
  let hidden = 0;
  let out = text;
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, () => { hidden++; return mark; });
  // A value an earlier shape already hid is the mark itself, and is not hidden — or counted — twice.
  for (const shape of IN_CONTEXT) out = out.replace(shape, (whole: string, prefix: string, secret: string) => {
    if (secret.includes(mark)) return whole;
    hidden++;
    return `${prefix}${mark}`;
  });
  return { text: out, hidden };
}

/**
 * A home folder where it starts a path — `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` — so it
 * can become `~`. Any account's, not only this Mac's: the name is what identifies someone, whoever's
 * folder it is. `/Users/Shared` is not anyone's home and stays.
 *
 * Only at the START of a path: after a space, a quote, a bracket, `=`, `:` or `file://`. The same
 * letters inside a URL (`https://example.com/Users/bob`) are a page on someone else's site.
 */
const HOME_FOLDER = /(?<=^|[\s"'`([{<>=:,;|]|file:\/\/)(?:\/Users\/(?!Shared(?![\w.-]))|\/home\/|[A-Za-z]:\\Users\\)[\w-][\w.-]*(?<!\.)/gm;

export function hideHomeFolders(text: string): string {
  return text.replace(HOME_FOLDER, "~");
}
