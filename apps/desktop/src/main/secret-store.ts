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
  CREDENTIAL_PRESENCE_TTLS, normalizeOrigin, PASSKEY_NAME_MAX,
  type BrowserCredential, type BrowserCredentialInput, type Passkey,
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

/** One line of the passkey audit log, written to the same file for the same reason: an auditor asks
 *  "was a key of mine used, for which site, and did it go through", and every answer past that is
 *  the key leaking by instalments. `rpId` is Realm's own derivation from the pane's URL, never the
 *  page's claim, so a log line cannot be authored by a page. */
export type PasskeyAuditEntry = {
  ts: number;
  rpId: string;
  kind: "create" | "get";
  outcome: "used" | "created" | "rp_mismatch" | "no_passkey" | "no_presence" | "error";
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

/** A passkey as it sits on disk. `sealed` is the PKCS#8 private key under the `passkey` domain;
 *  everything beside it is what the virtual authenticator needs handed back to reconstitute the
 *  credential, and `signCount` is the one field that MUST be written back after every assertion —
 *  a relying party that sees a counter go backwards is looking at what it is entitled to treat as a
 *  cloned authenticator. */
type StoredPasskey = Passkey & {
  credentialId: string;
  userHandle: string | null;
  signCount: number;
  sealed: string;
};

/** What `withPasskeysFor` hands its callback: the door the private key leaves by, and the only one.
 *  Deliberately declared here rather than in `@realm/contracts` — a type with a `privateKey` field
 *  has no business being importable by the renderer, the server, or the MCP surface. */
export type PasskeyKeyMaterial = {
  credentialId: string;
  rpId: string;
  userHandle: string | null;
  privateKey: string;
  signCount: number;
};

/** What a caller hands `recordPasskey` after a registration the user approved. One way, like
 *  `BrowserCredentialInput`: there is no matching read shape because there is no read. */
export type PasskeyInput = {
  rpId: string;
  userName: string;
  userDisplayName: string;
  credentialId: string;
  userHandle: string | null;
  signCount: number;
  privateKey: string;
};

type StoreFile = {
  version: number;
  keyring: string;
  credentials: StoredCredential[];
  passkeys: StoredPasskey[];
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

    const who = row.username ? `${row.username} on ${row.origin}` : row.origin;
    if (!(await this.requirePresence(`fill your saved sign-in for ${who}`))) {
      return { ok: false, refused: "no_presence" };
    }

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
   *
   * Passwords and passkeys share this ONE window rather than keeping a private one each. A sign-in
   * that is a fill and then a passkey assertion is the same sign-in to the person doing it, and the
   * alternative is a second timeout nobody configured and no screen mentions.
   */
  private async requirePresence(reason: string): Promise<boolean> {
    if (this.presenceTtlMs > 0 && this.d.now() < this.presenceUntil) return true;
    const granted = await this.d.promptPresence(reason).catch(() => false);
    // Only a SUCCESSFUL check opens the window; a denial does not shorten or extend an existing one.
    if (granted && this.presenceTtlMs > 0) this.presenceUntil = this.d.now() + this.presenceTtlMs;
    return granted;
  }

  /* ---------------------------------- passkeys ---------------------------------- */

  /** Metadata for every passkey Realm holds. `sealed` is stripped HERE, at the boundary, for the
   *  same reason it is for credentials. */
  listPasskeys(): Passkey[] {
    return this.load().passkeys.map(stripPasskey);
  }

  /**
   * Whether any passkey exists for this rp id — the question that decides whether a Touch ID prompt
   * is raised at all.
   *
   * It is metadata, deliberately answerable WITHOUT presence, because the alternative is worse: a
   * page that asks for a passkey Realm does not hold would otherwise raise a fingerprint prompt that
   * could only ever fail. A prompt a user cannot satisfy teaches them to dismiss prompts, which is
   * the reflex the whole gate depends on them not having.
   */
  hasPasskeyFor(rpId: string): boolean {
    return this.load().passkeys.some((p) => p.rpId === rpId);
  }

  /**
   * Remember a passkey the user just registered. Takes a private key and returns metadata: one way,
   * like `addCredential`, and with no matching read.
   *
   * Unlike `addCredential` this IS reachable from a page-initiated flow, and that is not an
   * oversight — registering a passkey is a thing a website asks for by design. What bounds it is the
   * step before: the caller only gets here after the user answered Touch ID for a create on an rp id
   * Realm derived from the pane's own URL. A page that is never approved never reaches this method,
   * and one that is approved has been told exactly which site it is registering with.
   */
  recordPasskey(input: PasskeyInput): Passkey {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a passkey.");
    }
    const file = this.load();
    const row: StoredPasskey = {
      id: this.d.newId(),
      rpId: input.rpId,
      userName: clipName(input.userName),
      userDisplayName: clipName(input.userDisplayName),
      createdAt: this.d.now(),
      lastUsedAt: null,
      credentialId: input.credentialId,
      userHandle: input.userHandle,
      signCount: input.signCount,
      sealed: seal(this.key("passkey"), "passkey", input.privateKey),
    };
    // A site that re-registers replaces rather than accumulates: the relying party has just been
    // told the OLD credential id is gone, and keeping it would offer the user a key the site will
    // refuse. Matched on the credential id the authenticator minted, which is unique per key.
    file.passkeys = file.passkeys.filter((p) => p.credentialId !== row.credentialId);
    file.passkeys.push(row);
    this.save();
    return stripPasskey(row);
  }

  /**
   * Run `use` with every private key Realm holds for `rpId`, after the OS says a human is present.
   *
   * The same callback shape as `withCredentialValue`, made structural for the same reason: no return
   * path for the material, the keys are a parameter and never a resolution, and `use`'s result is
   * discarded. The caller loads them into a pane's virtual authenticator, lets the one request the
   * user approved run, and clears them out again before this promise resolves.
   *
   * ORDER MATTERS and is fixed by the caller: the rp id is derived from the pane's REAL url by
   * `passkeyRpIdForPageUrl` before this is called, so a page claiming to be `github.com` is refused
   * without the user ever seeing a fingerprint prompt.
   */
  async withPasskeysFor(
    rpId: string,
    kind: "create" | "get",
    use: (keys: PasskeyKeyMaterial[]) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_passkey" | "no_presence" }> {
    const rows = this.load().passkeys.filter((p) => p.rpId === rpId);
    // A `get` with nothing to assert is refused before the prompt — see `hasPasskeyFor`. A `create`
    // with nothing is the ordinary case: that is what registering a first passkey looks like.
    if (kind === "get" && rows.length === 0) return { ok: false, refused: "no_passkey" };

    const reason = kind === "create" ? `create a passkey for ${rpId}` : `use your passkey for ${rpId}`;
    if (!(await this.requirePresence(reason))) return { ok: false, refused: "no_presence" };

    const keys: PasskeyKeyMaterial[] = [];
    for (const row of rows) {
      const privateKey = this.available ? open(this.key("passkey"), "passkey", row.sealed) : null;
      // An unopenable blob is a key that is gone — a Keychain item revoked, a file restored from
      // another Mac's backup. Skipped rather than fatal: the other passkeys for this site still
      // work, and a `get` that ends up with none refuses at the authenticator like any other.
      if (privateKey === null) continue;
      keys.push({
        credentialId: row.credentialId, rpId: row.rpId, userHandle: row.userHandle,
        privateKey, signCount: row.signCount,
      });
    }
    if (kind === "get" && keys.length === 0) return { ok: false, refused: "no_passkey" };

    await use(keys);
    return { ok: true };
  }

  /**
   * Write back what an assertion changed. The signature counter is the whole point: a relying party
   * that sees one go backwards is entitled to treat the authenticator as cloned and lock the
   * account, so a counter that only lived in the pane would break the passkey on the pane's next
   * restart rather than at the moment the bug was written.
   */
  notePasskeyUse(credentialId: string, signCount: number): void {
    const file = this.load();
    const row = file.passkeys.find((p) => p.credentialId === credentialId);
    if (!row) return;
    // Never backwards: a stale report from a pane whose keys were cleared mid-request must not undo
    // a later assertion's count.
    row.signCount = Math.max(row.signCount, signCount);
    row.lastUsedAt = this.d.now();
    this.save();
  }

  /** Forget one. Returns whether anything was there, so Settings reports honestly rather than
   *  claiming a deletion that removed nothing. Note what this cannot do: the relying party still
   *  lists the passkey, and only the user can remove it there. */
  removePasskey(id: string): boolean {
    const file = this.load();
    const before = file.passkeys.length;
    file.passkeys = file.passkeys.filter((p) => p.id !== id);
    if (file.passkeys.length === before) return false;
    this.save();
    return true;
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
  audit(entry: CredentialAuditEntry | PasskeyAuditEntry): void {
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

  /**
   * The `machine` key (Plan 25 W3), base64, for realm-server — the second and last key that leaves
   * this process. There is still deliberately no `credentialKey()`.
   *
   * The server needs it because the server is what authenticates: a machine's RFB handshake happens
   * in `MachineWsProxy`, so a VNC password must be openable there and must never reach the renderer.
   *
   * Null is a REAL answer here, and it means something different from what it means for oauth. With
   * no key, oauth keeps writing plaintext; a machine refuses to store a password at all, and the
   * connect form says so. A VNC password is frequently the user's login, and writing one into
   * realm.db in the clear is not a degradation to choose on their behalf.
   */
  exportMachineKey(): string | null {
    if (!this.available) return null;
    try { return this.key("machine").toString("base64"); } catch { return null; }
  }

  /** The `eggs` key: what remembers a friend group's word between launches.
   *
   *  Null degrades the way oauth's does rather than the way machine's does — the word is remembered
   *  in the clear instead of not at all. What it unlocks is a joke about somebody's friends, and the
   *  alternative is asking them to type it at every launch forever. */
  exportEggsKey(): string | null {
    if (!this.available) return null;
    try { return this.key("eggs").toString("base64"); } catch { return null; }
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
      passkeys: Array.isArray(parsed?.passkeys) ? parsed.passkeys.filter(isStoredPasskey) : [],
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
        if (oauth.length === SECRET_KEY_BYTES && credential.length === SECRET_KEY_BYTES) {
          /* `machine` (Plan 25 W3) was added after this keyring's shape was settled, so every
             keyring written before it lacks the key — and a MISSING DOMAIN IS NOT A CORRUPT
             KEYRING. Requiring all three here would send an existing install down the branch below,
             which empties `file.credentials`: every enrolled sign-in destroyed, silently, on first
             launch after an update, because a feature nobody had used yet wanted a third key.
             Minted and folded in beside the other two instead — the existing keys are untouched, so
             nothing sealed under them stops opening. */
          /* `machine`, `eggs` and `passkey` were each added after this keyring's shape was settled,
             and all three are folded in the same way and for the reason above: a missing domain is a
             key to mint, never a corrupt keyring to discard. */
          const added: Record<string, string> = {};
          const fold = (name: "machine" | "eggs" | "passkey"): Buffer => {
            const existing = Buffer.from(String(json[name] ?? ""), "base64");
            if (existing.length === SECRET_KEY_BYTES) return existing;
            const minted = newSecretKey();
            added[name] = minted.toString("base64");
            return minted;
          };
          const machine = fold("machine");
          const eggs = fold("eggs");
          const passkey = fold("passkey");
          if (Object.keys(added).length > 0) {
            file.keyring = this.d.safeStorage.encryptString(JSON.stringify({ ...json, ...added })).toString("base64");
            this.file = file;
            this.save();
          }
          return { oauth, credential, machine, eggs, passkey };
        }
      } catch { /* falls through to a fresh keyring */ }
      file.credentials = [];
      // Sealed under keys that are gone, so every assertion would refuse with no way for the user to
      // see why. Dropped for the same reason the credentials are, and recovered the same way: by
      // registering a new passkey from the site's own settings.
      file.passkeys = [];
    }
    const keys = {
      oauth: newSecretKey(), credential: newSecretKey(), machine: newSecretKey(),
      eggs: newSecretKey(), passkey: newSecretKey(),
    };
    file.keyring = this.d.safeStorage
      .encryptString(JSON.stringify({
        oauth: keys.oauth.toString("base64"),
        credential: keys.credential.toString("base64"),
        machine: keys.machine.toString("base64"),
        eggs: keys.eggs.toString("base64"),
        passkey: keys.passkey.toString("base64"),
      }))
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

/** `Passkey` from a stored row — the projection that drops `sealed` and the authenticator's own
 *  fields. Written as an explicit field list, like `strip`, so that adding a field to the stored
 *  shape cannot silently start returning it. */
function stripPasskey(p: StoredPasskey): Passkey {
  return {
    id: p.id, rpId: p.rpId, userName: p.userName, userDisplayName: p.userDisplayName,
    createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
  };
}

/** The two relying-party-authored strings on a passkey, clipped on the way IN rather than on the way
 *  out, so no surface has to remember to do it. */
function clipName(v: string): string {
  const trimmed = v.trim();
  return trimmed.length > PASSKEY_NAME_MAX ? trimmed.slice(0, PASSKEY_NAME_MAX) : trimmed;
}

function isStoredCredential(v: unknown): v is StoredCredential {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.origin === "string" && typeof c.username === "string"
    && typeof c.label === "string" && typeof c.createdAt === "number"
    && typeof c.sealed === "string" && isSealed(c.sealed);
}

function isStoredPasskey(v: unknown): v is StoredPasskey {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.rpId === "string" && typeof p.userName === "string"
    && typeof p.userDisplayName === "string" && typeof p.createdAt === "number"
    && (p.lastUsedAt === null || typeof p.lastUsedAt === "number")
    && typeof p.credentialId === "string" && (p.userHandle === null || typeof p.userHandle === "string")
    && typeof p.signCount === "number" && typeof p.sealed === "string" && isSealed(p.sealed);
}
