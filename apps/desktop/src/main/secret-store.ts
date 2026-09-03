/**
 * Realm's encrypted secret store — the one `apps/server/src/mcp/oauth.ts` has been asking for, built
 * once and shared by both things that need it.
 *
 * Electron-free, like `browser-agent.ts` and for the same reason: everything Electron (safeStorage,
 * the Touch ID prompt, the filesystem) arrives through `SecretStoreDeps`, so the rules that matter —
 * a credential value never leaving, presence being required, an audit line existing for every
 * outcome — die in unit tests against fakes rather than only on a signed build with a fingerprint
 * reader attached.
 *
 * ## Shape
 *
 * One JSON file under Realm's home. The interesting field is `keyring`: two AES-256 keys, minted
 * once, sealed as a unit by `safeStorage` (macOS: an item in the login Keychain, protected by the
 * user's login). Nothing on disk is readable without that Keychain item, and Realm holds no
 * passphrase of its own.
 *
 *     { version, keyring: "<safeStorage blob>", credentials: [ { id, origin, username, label,
 *                                                                createdAt, sealed } ], presenceTtlMs }
 *
 * ## Why two keys and not one
 *
 * The two consumers have deliberately unequal reach, and the keyring is where that inequality is
 * enforced rather than merely intended:
 *
 *   - **`oauth`** — realm-server holds sealed OAuth blobs in `realm.db` and reads them from
 *     synchronous code paths (`readOauthState`, and `mcp.list`'s status mapping through it). It is
 *     handed this key once over the browser-host bridge and seals/opens its own blobs. Tokens stop
 *     being plaintext in `realm.db`, which is the entire ask.
 *   - **`credential`** — this key is never exported, over the bridge or anywhere else. There is no
 *     method on this class that returns it and no bridge op that would carry it. Browser credential
 *     ciphertext never enters `realm.db` either, so realm-server has neither the key nor the blob.
 *
 * `secret-box`'s domain-as-AAD means these are not just two variables with different scopes: a
 * credential blob will not open under the oauth key even if both ever ended up in one process.
 *
 * ## The invariant
 *
 * A credential's plaintext leaves this module through exactly one door — the `use` callback of
 * `withCredentialValue` — and that door is only ever opened by the fill executor in Electron main,
 * with the value going straight into CDP key events. `listCredentials` returns `BrowserCredential`,
 * a type with no field for a value. Nothing here returns, logs, throws, or broadcasts one.
 */
import {
  isSealed, newSecretKey, open, seal, SECRET_KEY_BYTES, type SecretDomain,
} from "@realm/contracts/src/secret-box";
import {
  CREDENTIAL_PRESENCE_TTLS, normalizeOrigin,
  type BrowserCredential, type BrowserCredentialInput,
} from "@realm/contracts";

/** The slice of Electron's `safeStorage` this needs. */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** One line of the credential audit log. Note what is absent and always will be: the value, the
 *  page's title, the page's text, the field's name, the length of anything. An auditor needs to know
 *  that a fill for an origin happened and how it ended; everything past that is the secret leaking
 *  by instalments. */
export type CredentialAuditEntry = {
  ts: number;
  origin: string;
  credentialId: string;
  outcome: "filled" | "origin_mismatch" | "no_credential" | "no_presence" | "error";
};

export type SecretStoreDeps = {
  safeStorage: SafeStorageLike;
  /** The store file's contents, or null when it does not exist yet. */
  readFile(): string | null;
  writeFile(text: string): void;
  /** Append one JSONL audit line. Failures are swallowed by the caller — an unwritable log must not
   *  be a reason a sign-in fails, but it also must never be the reason one silently succeeds
   *  unlogged, which is why the append happens before the fill is reported ok. */
  appendAudit(line: string): void;
  /**
   * OS user presence: `systemPreferences.promptTouchID` on macOS. That API is BIOMETRICS ONLY — it
   * offers no login-password fallback, so a Mac without a Touch ID sensor cannot satisfy it and
   * fills there will always refuse with `no_presence`. That is a real limitation, surfaced in
   * Settings rather than worked around: the alternatives (a Realm-owned passphrase, or dropping the
   * presence requirement) are both worse than telling the user plainly.
   *
   * MUST resolve false — never throw, never true — when the platform cannot check, when the user
   * cancels, and when the check fails.
   */
  promptPresence(reason: string): Promise<boolean>;
  now(): number;
  newId(): string;
};

type StoredCredential = BrowserCredential & { sealed: string };
type StoreFile = {
  version: number;
  keyring: string;
  credentials: StoredCredential[];
  presenceTtlMs: number;
};

const FILE_VERSION = 1;

/** Enrollment refused, in the user's words. Thrown to the IPC caller (the Settings UI), which is the
 *  only thing that can enroll — so these strings are read by a person, not an agent. */
export class SecretStoreError extends Error {}

export class SecretStore {
  private file: StoreFile | null = null;
  private keys: Record<SecretDomain, Buffer> | null = null;
  /** When the last successful presence check happened. In memory only: a TTL that survived a restart
   *  would be a TTL the user never granted in this run of the app. */
  private presenceUntil = 0;

  constructor(private readonly d: SecretStoreDeps) {}

  /** Whether the OS will encrypt for us at all. False means no store: Realm enrolls nothing rather
   *  than falling back to plaintext, because a credential file that is "encrypted unless it isn't"
   *  is worse than no feature — the user would have been told their password is in the Keychain. */
  get available(): boolean {
    try { return this.d.safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  /* --------------------------------- credentials --------------------------------- */

  /** Metadata for every enrolled credential. The `sealed` column is stripped HERE, at the boundary,
   *  rather than trusted to every caller to omit. */
  listCredentials(): BrowserCredential[] {
    return this.load().credentials.map(strip);
  }

  getCredential(id: string): BrowserCredential | null {
    const row = this.load().credentials.find((c) => c.id === id);
    return row ? strip(row) : null;
  }

  /**
   * Enroll one credential. Reachable ONLY from the Settings UI's IPC handler — there is no tool, no
   * RPC method, no file importer and no chat path that lands here, which is the design's second
   * hard requirement after the value never coming back out. If a model could call this, the
   * anti-phishing gate would be a formality: it could enroll a credential for the origin it is
   * standing on and then "fill" it.
   */
  addCredential(input: BrowserCredentialInput): BrowserCredential {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a sign-in. Nothing was stored.");
    }
    const origin = normalizeOrigin(input.origin);
    if (!origin) {
      throw new SecretStoreError(`"${input.origin}" is not an http(s) address Realm can pin a sign-in to. Enter the site's address, for example https://example.com.`);
    }
    const file = this.load();
    const row: StoredCredential = {
      id: this.d.newId(),
      origin,
      username: input.username.trim(),
      label: input.label.trim(),
      createdAt: this.d.now(),
      sealed: seal(this.key("credential"), "credential", input.value),
    };
    file.credentials.push(row);
    this.save();
    return strip(row);
  }

  /** Forget one. Returns whether anything was there — the UI reports honestly rather than claiming a
   *  deletion that removed nothing. */
  removeCredential(id: string): boolean {
    const file = this.load();
    const before = file.credentials.length;
    file.credentials = file.credentials.filter((c) => c.id !== id);
    if (file.credentials.length === before) return false;
    this.save();
    return true;
  }

  /* ------------------------------- the one door out ------------------------------- */

  /**
   * Run `use` with one credential's plaintext, after the OS says a human is present.
   *
   * The callback shape is the invariant made structural. This method has no return path for the
   * value: `use`'s result is discarded, the value is a parameter and never a resolution, and every
   * failure resolves to a `refused` code that names a reason without quoting anything secret. A
   * future caller who wanted the value back would have to change this signature, which is a diff a
   * reviewer notices — unlike `const v = await store.get(id)`, which is not.
   *
   * ORDER MATTERS and is fixed by the caller, not here: the fill executor checks the page's origin
   * BEFORE calling this, so a phishing page is refused without the user ever seeing a Touch ID
   * prompt. A prompt on a lookalike page is worse than no prompt — it trains the reflex the gate
   * exists to protect.
   */
  async withCredentialValue(
    id: string,
    use: (value: string) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }> {
    const row = this.load().credentials.find((c) => c.id === id);
    if (!row) return { ok: false, refused: "no_credential" };

    if (!(await this.requirePresence(row))) return { ok: false, refused: "no_presence" };

    const value = this.available ? open(this.key("credential"), "credential", row.sealed) : null;
    // An unopenable blob is a credential that is gone — a Keychain item revoked, a file restored from
    // another machine's backup. Reported as `no_credential`, the same as an id that never existed:
    // the user's fix is identical (re-enroll in Settings) and distinguishing the two would tell a
    // caller something about the store's contents it has no use for.
    if (value === null) return { ok: false, refused: "no_credential" };

    await use(value);
    return { ok: true };
  }

  /**
   * Touch ID, unless a previous successful check is still inside the TTL. The default TTL is 0,
   * meaning every fill prompts; the longer settings exist because one sign-in is often two fills
   * across an SSO redirect, and prompting twice in six seconds teaches people to approve without
   * reading — which costs more than the window does.
   */
  private async requirePresence(row: StoredCredential): Promise<boolean> {
    if (this.presenceTtlMs > 0 && this.d.now() < this.presenceUntil) return true;
    const who = row.username ? `${row.username} on ${row.origin}` : row.origin;
    const granted = await this.d.promptPresence(`fill your saved sign-in for ${who}`).catch(() => false);
    // Only a SUCCESSFUL check opens the window; a denial does not shorten or extend an existing one.
    if (granted && this.presenceTtlMs > 0) this.presenceUntil = this.d.now() + this.presenceTtlMs;
    return granted;
  }

  /* ---------------------------------- settings ---------------------------------- */

  get presenceTtlMs(): number {
    return this.load().presenceTtlMs;
  }

  /** Clamped to the offered set: an out-of-range TTL arriving from a stale renderer or a
   *  hand-edited file becomes 0 (prompt every time), never something longer than the UI offers. */
  setPresenceTtlMs(ms: number): number {
    const file = this.load();
    file.presenceTtlMs = (CREDENTIAL_PRESENCE_TTLS as readonly number[]).includes(ms) ? ms : 0;
    // A shortened window takes effect now rather than after the old one expires.
    this.presenceUntil = 0;
    this.save();
    return file.presenceTtlMs;
  }

  /* ------------------------------------ audit ------------------------------------ */

  /** One JSONL line per fill attempt, whatever the outcome. Never throws: an unwritable log is a
   *  degraded audit trail, not a reason to fail a sign-in the user just approved with their
   *  fingerprint. */
  audit(entry: CredentialAuditEntry): void {
    try { this.d.appendAudit(`${JSON.stringify(entry)}\n`); } catch { /* see above */ }
  }

  /* ------------------------------- the oauth handoff ------------------------------- */

  /**
   * The `oauth` key, base64, for realm-server. This is the ONLY key that is ever exported and the
   * method name says so; there is deliberately no `credentialKey()` beside it.
   *
   * Null when the OS will not encrypt, which realm-server reads as "keep writing plaintext, exactly
   * as before" — a degradation that is honest (`MCP_SECRET_STORAGE_NOTE` still describes it) rather
   * than a silent failure to persist tokens at all.
   */
  exportOauthKey(): string | null {
    if (!this.available) return null;
    try { return this.key("oauth").toString("base64"); } catch { return null; }
  }

  /* ------------------------------------ file ------------------------------------ */

  private key(domain: SecretDomain): Buffer {
    if (!this.keys) {
      this.load();
      if (!this.keys) throw new SecretStoreError("Realm's secret keyring could not be unlocked.");
    }
    return this.keys[domain];
  }

  private load(): StoreFile {
    if (this.file) return this.file;
    const raw = this.d.readFile();
    let parsed: Partial<StoreFile> | null = null;
    if (raw) {
      try { parsed = JSON.parse(raw) as Partial<StoreFile>; } catch { parsed = null; }
    }
    const file: StoreFile = {
      version: FILE_VERSION,
      keyring: typeof parsed?.keyring === "string" ? parsed.keyring : "",
      credentials: Array.isArray(parsed?.credentials) ? parsed.credentials.filter(isStoredCredential) : [],
      presenceTtlMs: (CREDENTIAL_PRESENCE_TTLS as readonly number[]).includes(parsed?.presenceTtlMs as number)
        ? (parsed!.presenceTtlMs as number) : 0,
    };
    this.file = file;
    this.keys = this.unlockKeyring(file);
    return file;
  }

  /**
   * Open the keyring, minting one on first run. A keyring that will not open (Keychain item deleted,
   * file copied from another Mac) is REPLACED with a fresh one and the credential rows that were
   * sealed under the old keys are dropped — they are permanently unopenable, and keeping them would
   * mean a Settings list full of sign-ins that refuse at every fill with no way for the user to see
   * why. OAuth rows degrade the same way on the server side, to `unconfigured`; the recovery for
   * both is the flow that created them.
   */
  private unlockKeyring(file: StoreFile): Record<SecretDomain, Buffer> | null {
    if (!this.available) return null;
    if (file.keyring) {
      try {
        const json = JSON.parse(this.d.safeStorage.decryptString(Buffer.from(file.keyring, "base64"))) as Record<string, string>;
        const oauth = Buffer.from(String(json.oauth ?? ""), "base64");
        const credential = Buffer.from(String(json.credential ?? ""), "base64");
        if (oauth.length === SECRET_KEY_BYTES && credential.length === SECRET_KEY_BYTES) return { oauth, credential };
      } catch { /* falls through to a fresh keyring */ }
      file.credentials = [];
    }
    const keys = { oauth: newSecretKey(), credential: newSecretKey() };
    file.keyring = this.d.safeStorage
      .encryptString(JSON.stringify({ oauth: keys.oauth.toString("base64"), credential: keys.credential.toString("base64") }))
      .toString("base64");
    this.file = file;
    this.save();
    return keys;
  }

  private save(): void {
    if (!this.file) return;
    this.d.writeFile(JSON.stringify(this.file, null, 2));
  }
}

/** `BrowserCredential` from a stored row — the projection that drops `sealed`. Written as an
 *  explicit field list rather than `{ sealed, ...rest }` so that adding a field to the stored shape
 *  cannot silently start returning it. */
function strip(c: StoredCredential): BrowserCredential {
  return { id: c.id, origin: c.origin, username: c.username, label: c.label, createdAt: c.createdAt };
}

function isStoredCredential(v: unknown): v is StoredCredential {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.origin === "string" && typeof c.username === "string"
    && typeof c.label === "string" && typeof c.createdAt === "number"
    && typeof c.sealed === "string" && isSealed(c.sealed);
}
