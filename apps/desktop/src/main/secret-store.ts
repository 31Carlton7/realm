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
 *     { version, keyring: "<safeStorage blob>", credentials: [ { id, profileId, origin, username,
 *                                         label, createdAt, generated, sealed } ], passkeys, presenceTtlMs,
 *       unlock: { "profile:<id>": "<sealed policy>" } }
 *
 * ## How a fill is unlocked
 *
 * Touch ID, by default and everywhere. A profile can be given another unlock policy (`UnlockPolicy`):
 * Touch ID or the login password, one check for a session of hours, or — for a profile that runs on
 * a Mac set aside for it — no check at all. Three rules hold whichever it is:
 *
 *   - Only the user changes one, from Settings, and a change that lets more through without a person
 *     is confirmed by macOS (Touch ID or the login password) before it is written. No tool, RPC method
 *     or bridge op reaches `setUnlockPolicy`.
 *   - The policy is sealed under its own keyring domain, with the scope it belongs to and the Mac it
 *     was set on inside the seal. Editing `secrets.json` cannot forge one, moving one to another
 *     profile opens as the default, and `unattended` copied to another Mac opens as the default.
 *   - Every unlock writes an audit line naming the policy and how it was satisfied — including the
 *     ones nobody was asked about, which are the ones most worth a record.
 *
 * ## A profile's own
 *
 * Every saved sign-in and passkey belongs to ONE profile (Plan 27 Phase 2), as its browser cookie jar
 * does: an agent in a Work space is offered Work's sign-ins, and a Personal pane's passkey prompt finds
 * Personal's keys. Every read and write below names the profile it is for, and a row of another
 * profile is answered exactly as a row that does not exist. Sharing COPIES a row into another profile;
 * the original stays where it was.
 *
 * Rows from before that (file version 1) carry no profile. They were made while every profile shared
 * one cookie jar, so they go to the profile that kept that jar (`SecretStoreDeps.defaultProfileId`) —
 * once, written back, so the answer can never move later.
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
 * A credential's plaintext leaves this module through exactly two doors — the `use` callbacks of
 * `withCredentialValue` and `withGeneratedCredentialValue` — and both are only ever opened by the
 * fill executor in Electron main, with the value going straight into CDP key events. The second door
 * is the one Realm mints a password behind, and it is the same shape as the first on purpose: the
 * value is a parameter, `use`'s result is discarded, and what resolves is metadata. `listCredentials`
 * returns `BrowserCredential`, a type with no field for a value. Nothing here returns, logs, throws,
 * or broadcasts one.
 */
import { randomInt } from "node:crypto";
import {
  isSealed, newSecretKey, open, seal, SECRET_KEY_BYTES, type SecretDomain,
} from "@realm/contracts/src/secret-box";
import {
  CREDENTIAL_PRESENCE_TTLS, DEFAULT_UNLOCK_POLICY, GENERATED_PASSWORD_MAX_LENGTH, GENERATED_PASSWORD_MIN_LENGTH,
  normalizeOrigin, PASSKEY_NAME_MAX, parseUnlockPolicy, unlockPolicyRank, unlockScopeKey,
  type BrowserCredential, type BrowserCredentialInput, type Passkey,
  type UnlockPolicy, type UnlockPolicyKind, type UnlockPolicyStatus, type UnlockScope,
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
  /** `generated` is a fill that minted its own password on the way in — one line, not two, because it
   *  is one thing that happened: a new sign-in for this origin now exists AND was typed into it.
   *  `no_store` is that fill refused for having nowhere to keep the password. */
  outcome: "filled" | "generated" | "origin_mismatch" | "no_credential" | "no_store" | "no_presence" | "error";
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

/** One line per unlock, whatever the policy. `how` is what satisfied it: a check the person answered
 *  (`prompted`), the short Touch ID window (`window`), an open session (`session`), or nothing,
 *  because the profile is set to fill without asking (`unattended`). `refused` is a check that failed
 *  or was cancelled. */
export type UnlockAuditEntry = {
  ts: number;
  kind: "unlock";
  scope: string;
  policy: UnlockPolicyKind;
  how: "prompted" | "window" | "session" | "unattended" | "refused";
};

/** One line per attempt to change a scope's policy. `refused` is a weakening macOS did not confirm. */
export type UnlockPolicyAuditEntry = {
  ts: number;
  kind: "unlock-policy";
  scope: string;
  from: UnlockPolicyKind;
  to: UnlockPolicyKind;
  outcome: "set" | "refused";
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
  /**
   * LocalAuthentication's device-owner check: Touch ID, or the Mac's login password when there is no
   * sensor or nobody's finger on it. What `device-password` and `session` ask, and what confirms a
   * weakened policy. Absent, or unable to run, means those fall back to `promptPresence`.
   *
   * Same contract as `promptPresence`: resolves false on every failure, never throws.
   */
  promptDeviceOwner?(reason: string): Promise<boolean>;
  /** Whether `promptDeviceOwner` can run here at all (a login password is set, the helper exists). */
  canPromptDeviceOwner?(): boolean;
  /** Whether `promptPresence` can be satisfied here (a Touch ID sensor is present and enrolled). */
  canPromptTouchID?(): boolean;
  /**
   * A stable id for THIS Mac (its hardware UUID), sealed into every policy. An `unattended` policy that
   * opens on a Mac with another id — a restored backup, a Migration Assistant copy of the home and the
   * login Keychain — is read as the default. Null when it cannot be read: `unattended` then cannot be
   * turned on.
   */
  machineId?(): string | null;
  now(): number;
  newId(): string;
  /**
   * The profile that inherits rows written before sign-ins were a profile's own — the one that kept
   * the browser partition every pane used to share. Null while main cannot say yet (realm-server has
   * not answered): those rows then belong to nobody, visible to no profile and kept on disk untouched,
   * until it can.
   */
  defaultProfileId(): string | null;
};

/** `profileId` is absent only on a row written before profiles had their own (file version 1) that
 *  has not been adopted yet — see `adopt`. */
type StoredCredential = BrowserCredential & { sealed: string; profileId?: string };

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
  profileId?: string;
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
  /** Scope key (`unlockScopeKey`) → that scope's policy, sealed under the `unlock` domain. A scope
   *  with no entry is on the default, Touch ID. Absent from files written before policies existed. */
  unlock: Record<string, string>;
};

/** 2: every row names its profile. 1 had none — see `adopt`. Policies did not need a new version:
 *  a file without `unlock` is every scope on the default, which is exactly what it was. */
const FILE_VERSION = 2;

/** Enrollment refused, in the user's words. Thrown to the IPC caller (the Settings UI), which is the
 *  only thing that can enroll — so these strings are read by a person, not an agent. */
export class SecretStoreError extends Error {}

export class SecretStore {
  private file: StoreFile | null = null;
  private keys: Record<SecretDomain, Buffer> | null = null;
  /** When the last successful presence check happened. In memory only: a TTL that survived a restart
   *  would be a TTL the user never granted in this run of the app. */
  private presenceUntil = 0;
  /** The same window, opened by a device-owner check (password or Touch ID through LocalAuthentication).
   *  Kept apart so a typed password never opens a window that a Touch ID–only profile would honour. */
  private ownerUntil = 0;
  /** Open `session` unlocks: scope key → when they close. In memory only, like the window above: a
   *  restart asks again. */
  private readonly sessionUntil = new Map<string, number>();
  /** Rows without a profile are on disk and still waiting for `defaultProfileId` to name one. */
  private unadopted = false;

  constructor(private readonly d: SecretStoreDeps) {}

  /** Whether the OS will encrypt for us at all. False means no store: Realm enrolls nothing rather
   *  than falling back to plaintext, because a credential file that is "encrypted unless it isn't"
   *  is worse than no feature — the user would have been told their password is in the Keychain. */
  get available(): boolean {
    try { return this.d.safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  /* --------------------------------- credentials --------------------------------- */

  /** Metadata for every credential this profile holds. The `sealed` column is stripped HERE, at the
   *  boundary, rather than trusted to every caller to omit. */
  listCredentials(profileId: string): BrowserCredential[] {
    return this.rows().credentials.filter((c) => c.profileId === profileId).map(strip);
  }

  getCredential(profileId: string, id: string): BrowserCredential | null {
    const row = this.credentialOf(profileId, id);
    return row ? strip(row) : null;
  }

  /**
   * Enroll one credential the USER typed. Reachable only from the Settings UI's IPC handler — there
   * is no tool, no RPC method, no file importer and no chat path that lands here, which is the
   * design's second hard requirement after the value never coming back out. If a model could call
   * this, the anti-phishing gate would be a formality: it could enroll a password the user already
   * uses elsewhere against the origin it is standing on, and then "fill" it.
   *
   * `withGeneratedCredentialValue` is the one other way a row comes into being, and it does not
   * reopen that hole: the value there is Realm's own random string rather than anything the caller
   * supplied, so a row minted for a lookalike page is a secret that page could have invented itself.
   * What the gate protects is the user's OWN secrets, and no caller can put one of those here.
   */
  addCredential(profileId: string, input: BrowserCredentialInput): BrowserCredential {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a sign-in. Nothing was stored.");
    }
    const origin = normalizeOrigin(input.origin);
    if (!origin) {
      throw new SecretStoreError(`"${input.origin}" is not an http(s) address Realm can pin a sign-in to. Enter the site's address, for example https://example.com.`);
    }
    return this.enroll(profileId, { origin, username: input.username, label: input.label, generated: false }, input.value);
  }

  /** Seal one value under an already-normalized origin and write the row as this profile's. The two
   *  callers that reach here are the only two routes into this file: Settings' own form, and a
   *  generated fill. */
  private enroll(profileId: string, meta: { origin: string; username: string; label: string; generated: boolean }, value: string): BrowserCredential {
    const file = this.rows();
    const row: StoredCredential = {
      id: this.d.newId(),
      profileId,
      origin: meta.origin,
      username: meta.username.trim(),
      label: meta.label.trim(),
      createdAt: this.d.now(),
      generated: meta.generated,
      sealed: seal(this.key("credential"), "credential", value),
    };
    file.credentials.push(row);
    this.save();
    return strip(row);
  }

  /** Forget one of this profile's. Returns whether anything was there — the UI reports honestly rather
   *  than claiming a deletion that removed nothing. Another profile's copy of a shared sign-in stays. */
  removeCredential(profileId: string, id: string): boolean {
    const file = this.rows();
    const before = file.credentials.length;
    file.credentials = file.credentials.filter((c) => !(c.id === id && c.profileId === profileId));
    if (file.credentials.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Copy one of this profile's sign-ins into another profile. The original stays; the copy is the
   * target profile's own from then on — removing either leaves the other.
   *
   * A target that already holds a sign-in for the same address and username has THAT row brought up
   * to date rather than a second one added beside it: two rows for one account is a choice the fill
   * tool would put to an agent, and the newer secret is the one being shared. The sealed value is
   * copied as it is — it never leaves its ciphertext on the way, and nothing here returns it.
   */
  shareCredential(fromProfileId: string, id: string, toProfileId: string): BrowserCredential | null {
    const file = this.rows();
    const source = this.credentialOf(fromProfileId, id);
    if (!source || toProfileId === "" || toProfileId === fromProfileId) return null;
    const same = file.credentials.find((c) => c.profileId === toProfileId && c.origin === source.origin && c.username === source.username);
    // A copy says who made its value, as the original does: a Realm-made password shared into another
    // profile is still one nobody has seen, and that profile's Settings has to say so too.
    if (same) {
      same.sealed = source.sealed;
      same.label = source.label;
      same.generated = source.generated === true;
      this.save();
      return strip(same);
    }
    const row: StoredCredential = {
      id: this.d.newId(), profileId: toProfileId, origin: source.origin, username: source.username,
      label: source.label, createdAt: this.d.now(), generated: source.generated === true, sealed: source.sealed,
    };
    file.credentials.push(row);
    this.save();
    return strip(row);
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
    profileId: string,
    id: string,
    use: (value: string) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }> {
    // Another profile's sign-in is refused exactly as one that does not exist — and before the
    // prompt, so a Touch ID sheet is never raised for a fill that could not have been allowed.
    const row = this.credentialOf(profileId, id);
    if (!row) return { ok: false, refused: "no_credential" };

    const who = row.username ? `${row.username} on ${row.origin}` : row.origin;
    if (!(await this.requirePresence(profileId, `fill your saved sign-in for ${who}`))) {
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
   * Mint a password for `origin`, keep it, and run `use` with it — the generated half of
   * `browser_fill_credential`, and the second door out. Same shape as `withCredentialValue` for the
   * same structural reason: the value is a parameter, never a resolution, and what comes back is the
   * metadata row so a caller can fill the SAME new password again (a confirm field) by id.
   *
   * `origin` arrives already normalized, and from the pane's own URL rather than from anything the
   * agent said — see `BrowserGeneratedCredentialSchema`. It is re-normalized here anyway, because
   * this is the method that decides what a row is pinned to and a store that trusts its caller on
   * that point is one refactor away from an unpinned credential.
   *
   * ORDER, and every step of it is load-bearing:
   *
   *   1. **No store, no mint.** Refused before the prompt, like `hasPasskeyFor`: a fingerprint check
   *      that could only ever fail teaches the user to swat prompts away. And a password Realm typed
   *      but could not keep is worse than no password at all — the account would exist with a secret
   *      nothing on this Mac has ever known.
   *   2. **Presence.** The same check, the same shared window, and the same reason as an enrolled
   *      fill: the question left at this point is whether the human is there.
   *   3. **Write, THEN type.** Not the other way round. If typing fails after the write, the user has
   *      a row in Settings they can delete; if the write failed after typing, the page would hold a
   *      password that exists nowhere else, and the only way back into that account is the site's
   *      reset. The cheap failure is the one to choose, so the row survives a failed fill on purpose.
   */
  async withGeneratedCredentialValue(
    profileId: string,
    input: { origin: string; username: string; label: string; length: number; symbols: boolean },
    use: (value: string) => Promise<void>,
  ): Promise<{ ok: true; credential: BrowserCredential } | { ok: false; refused: "no_store" | "no_presence" }> {
    const origin = normalizeOrigin(input.origin);
    if (!origin || !this.available) return { ok: false, refused: "no_store" };

    const who = input.username ? `${input.username} on ${origin}` : origin;
    if (!(await this.requirePresence(profileId, `create and fill a new saved password for ${who}`))) {
      return { ok: false, refused: "no_presence" };
    }

    const value = generatePassword(input.length, input.symbols);
    const credential = this.enroll(profileId, { origin, username: input.username, label: input.label, generated: true }, value);
    await use(value);
    return { ok: true, credential };
  }

  /**
   * Unlock one fill for this profile, by its policy, and write the audit line that says how.
   *
   * Under the default the answer is Touch ID, unless a previous successful check is still inside the
   * TTL. The default TTL is 0, meaning every fill prompts; the longer settings exist because one
   * sign-in is often two fills across an SSO redirect, and prompting twice in six seconds teaches
   * people to approve without reading — which costs more than the window does.
   *
   * Passwords and passkeys share this ONE window rather than keeping a private one each. A sign-in
   * that is a fill and then a passkey assertion is the same sign-in to the person doing it, and the
   * alternative is a second timeout nobody configured and no screen mentions.
   *
   * The audit line is written BEFORE this resolves, so no value leaves under a policy that left no
   * record — `unattended` least of all.
   */
  private async requirePresence(profileId: string, reason: string): Promise<boolean> {
    const scope = unlockScopeKey({ kind: "profile", id: profileId });
    const policy = this.readPolicy(scope);
    const how = await this.unlock(scope, policy, reason);
    this.audit({ ts: this.d.now(), kind: "unlock", scope, policy: policy.kind, how });
    return how !== "refused";
  }

  private async unlock(scope: string, policy: UnlockPolicy, reason: string): Promise<UnlockAuditEntry["how"]> {
    const now = this.d.now();
    switch (policy.kind) {
      case "unattended":
        return "unattended";
      case "session": {
        if (now < (this.sessionUntil.get(scope) ?? 0)) return "session";
        if (!(await this.confirmOwner(reason))) return "refused";
        this.sessionUntil.set(scope, this.d.now() + policy.hours * 3_600_000);
        return "prompted";
      }
      case "device-password": {
        // A Touch ID window satisfies a password policy (it is the stronger check); not the reverse.
        if (this.presenceTtlMs > 0 && (now < this.presenceUntil || now < this.ownerUntil)) return "window";
        if (!(await this.confirmOwner(reason))) return "refused";
        if (this.presenceTtlMs > 0) this.ownerUntil = this.d.now() + this.presenceTtlMs;
        return "prompted";
      }
      case "touch-id": {
        if (this.presenceTtlMs > 0 && now < this.presenceUntil) return "window";
        const granted = await this.d.promptPresence(reason).catch(() => false);
        // Only a SUCCESSFUL check opens the window; a denial does not shorten or extend an existing one.
        if (granted && this.presenceTtlMs > 0) this.presenceUntil = this.d.now() + this.presenceTtlMs;
        return granted ? "prompted" : "refused";
      }
    }
  }

  /** Touch ID or the login password, through LocalAuthentication; Touch ID alone where that cannot run. */
  private async confirmOwner(reason: string): Promise<boolean> {
    if (this.d.promptDeviceOwner && (this.d.canPromptDeviceOwner?.() ?? false)) {
      return this.d.promptDeviceOwner(reason).catch(() => false);
    }
    return this.d.promptPresence(reason).catch(() => false);
  }

  /* -------------------------------- unlock policy -------------------------------- */

  unlockPolicy(scope: UnlockScope): UnlockPolicy {
    return this.readPolicy(unlockScopeKey(scope));
  }

  unlockStatus(scope: UnlockScope): UnlockPolicyStatus {
    const key = unlockScopeKey(scope);
    const policy = this.readPolicy(key);
    const until = this.sessionUntil.get(key) ?? 0;
    return { policy, sessionUntil: policy.kind === "session" && until > this.d.now() ? until : null };
  }

  /**
   * Whether a fill in this profile could be unlocked here at all — what the passkey broker asks before
   * raising anything, and what Settings uses to say a fill will be refused on this Mac.
   */
  canUnlock(profileId: string): boolean {
    const key = unlockScopeKey({ kind: "profile", id: profileId });
    const policy = this.readPolicy(key);
    if (policy.kind === "unattended") return true;
    if (policy.kind === "session" && this.d.now() < (this.sessionUntil.get(key) ?? 0)) return true;
    const touchId = this.d.canPromptTouchID?.() ?? true;
    if (policy.kind === "touch-id") return touchId;
    return touchId || (this.d.canPromptDeviceOwner?.() ?? false);
  }

  /**
   * Set a scope's unlock policy. Reachable ONLY from Settings' IPC handler, for the reason
   * `addCredential` is: a model that could call this would turn every gate in this file into a
   * formality. There is no tool, no RPC method and no bridge op that lands here, and the Settings
   * control carries `data-no-agent` so an agent driving Realm's window cannot press it either.
   *
   * A change that lets MORE through without a person — any step down the ladder, a longer session —
   * is confirmed by macOS first (Touch ID or the login password). That is the guard that holds even
   * if something did reach this method: an agent cannot answer Touch ID and does not know the
   * password. A change that lets less through is never asked about; turning a gate back on must
   * always be one click.
   */
  async setUnlockPolicy(scope: UnlockScope, requested: UnlockPolicy): Promise<{ ok: true; status: UnlockPolicyStatus } | { ok: false; error: string }> {
    const key = unlockScopeKey(scope);
    const policy = parseUnlockPolicy(requested);
    if (!this.available) {
      return { ok: false, error: "macOS is not offering Realm an encryption key right now (Keychain unavailable), so the setting was not changed." };
    }
    const current = this.readPolicy(key);
    const machine = this.machine();
    if (policy.kind === "unattended" && !machine) {
      return { ok: false, error: "Realm could not read this Mac's hardware ID, so it cannot tie this setting to this Mac. Nothing changed." };
    }
    if (unlockPolicyRank(policy) > unlockPolicyRank(current)) {
      const confirmed = await this.confirmOwner(policy.kind === "unattended"
        ? "let agents fill saved sign-ins on this Mac without asking"
        : "change how saved sign-ins are unlocked");
      if (!confirmed) {
        this.audit({ ts: this.d.now(), kind: "unlock-policy", scope: key, from: current.kind, to: policy.kind, outcome: "refused" });
        return { ok: false, error: "macOS did not confirm it was you, so nothing changed." };
      }
    }
    const file = this.load();
    if (policy.kind === "touch-id") delete file.unlock[key];
    else file.unlock[key] = seal(this.key("unlock"), "unlock", JSON.stringify({ scope: key, machine, policy, setAt: this.d.now() }));
    // Any change starts over: a session opened under the old policy is not one the new one granted.
    this.sessionUntil.delete(key);
    this.save();
    this.audit({ ts: this.d.now(), kind: "unlock-policy", scope: key, from: current.kind, to: policy.kind, outcome: "set" });
    return { ok: true, status: this.unlockStatus(scope) };
  }

  /**
   * The policy sealed for this scope, or the default. EVERY failure is the default, never a weaker
   * policy: no entry, a keyring that will not open, a blob that does not open under the `unlock` key
   * (hand-written, or tampered), a blob sealed for another scope (moved), or an `unattended` blob set
   * on another Mac (copied).
   */
  private readPolicy(key: string): UnlockPolicy {
    const sealed = this.load().unlock[key];
    if (!sealed || !this.available) return DEFAULT_UNLOCK_POLICY;
    let record: { scope?: unknown; machine?: unknown; policy?: unknown };
    try {
      const text = open(this.key("unlock"), "unlock", sealed);
      if (text === null) return DEFAULT_UNLOCK_POLICY;
      record = JSON.parse(text) as typeof record;
    } catch {
      return DEFAULT_UNLOCK_POLICY;
    }
    if (record.scope !== key) return DEFAULT_UNLOCK_POLICY;
    const policy = parseUnlockPolicy(record.policy);
    if (policy.kind === "unattended") {
      const machine = this.machine();
      if (!machine || record.machine !== machine) return DEFAULT_UNLOCK_POLICY;
    }
    return policy;
  }

  private machineCache: string | null | undefined;
  private machine(): string | null {
    if (this.machineCache === undefined) {
      try { this.machineCache = this.d.machineId?.() ?? null; } catch { this.machineCache = null; }
    }
    return this.machineCache;
  }

  /* ---------------------------------- passkeys ---------------------------------- */

  /** Metadata for every passkey this profile holds. `sealed` is stripped HERE, at the boundary, for
   *  the same reason it is for credentials. */
  listPasskeys(profileId: string): Passkey[] {
    return this.rows().passkeys.filter((p) => p.profileId === profileId).map(stripPasskey);
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
  hasPasskeyFor(profileId: string, rpId: string): boolean {
    return this.rows().passkeys.some((p) => p.profileId === profileId && p.rpId === rpId);
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
  recordPasskey(profileId: string, input: PasskeyInput): Passkey {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a passkey.");
    }
    const file = this.rows();
    const row: StoredPasskey = {
      id: this.d.newId(),
      profileId,
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
    // refuse. Matched on the credential id the authenticator minted, which is unique per key — within
    // this profile, since a shared copy in another profile is that profile's to keep or remove.
    file.passkeys = file.passkeys.filter((p) => !(p.profileId === profileId && p.credentialId === row.credentialId));
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
    profileId: string,
    rpId: string,
    kind: "create" | "get",
    use: (keys: PasskeyKeyMaterial[]) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_passkey" | "no_presence" }> {
    const rows = this.rows().passkeys.filter((p) => p.profileId === profileId && p.rpId === rpId);
    // A `get` with nothing to assert is refused before the prompt — see `hasPasskeyFor`. A `create`
    // with nothing is the ordinary case: that is what registering a first passkey looks like.
    if (kind === "get" && rows.length === 0) return { ok: false, refused: "no_passkey" };

    const reason = kind === "create" ? `create a passkey for ${rpId}` : `use your passkey for ${rpId}`;
    if (!(await this.requirePresence(profileId, reason))) return { ok: false, refused: "no_presence" };

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
   *
   * The counter belongs to the KEY, not to a profile's row. A shared passkey is one key in two
   * profiles, and the site sees one authenticator: if Work's copy signs at 7 and Personal's copy then
   * signs at 4, that is the counter going backwards. So every copy moves together, and only the
   * profile that used it is told it was used.
   */
  notePasskeyUse(profileId: string, credentialId: string, signCount: number): void {
    const file = this.rows();
    const copies = file.passkeys.filter((p) => p.credentialId === credentialId);
    const mine = copies.find((p) => p.profileId === profileId);
    if (!mine) return;
    // Never backwards: a stale report from a pane whose keys were cleared mid-request must not undo
    // a later assertion's count.
    for (const row of copies) row.signCount = Math.max(row.signCount, signCount);
    mine.lastUsedAt = this.d.now();
    this.save();
  }

  /**
   * Copy one of this profile's passkeys into another profile. The original stays. A target that holds
   * the same key already (an earlier share) is left as it is: there is nothing newer to copy, since
   * the counter moves on every copy at once (`notePasskeyUse`).
   */
  sharePasskey(fromProfileId: string, id: string, toProfileId: string): Passkey | null {
    const file = this.rows();
    const source = file.passkeys.find((p) => p.id === id && p.profileId === fromProfileId);
    if (!source || toProfileId === "" || toProfileId === fromProfileId) return null;
    const same = file.passkeys.find((p) => p.profileId === toProfileId && p.credentialId === source.credentialId);
    if (same) return stripPasskey(same);
    const row: StoredPasskey = {
      id: this.d.newId(), profileId: toProfileId, rpId: source.rpId, userName: source.userName,
      userDisplayName: source.userDisplayName, createdAt: this.d.now(), lastUsedAt: null,
      credentialId: source.credentialId, userHandle: source.userHandle, signCount: source.signCount, sealed: source.sealed,
    };
    file.passkeys.push(row);
    this.save();
    return stripPasskey(row);
  }

  /** Forget one. Returns whether anything was there, so Settings reports honestly rather than
   *  claiming a deletion that removed nothing. Note what this cannot do: the relying party still
   *  lists the passkey, and only the user can remove it there. */
  removePasskey(profileId: string, id: string): boolean {
    const file = this.rows();
    const before = file.passkeys.length;
    file.passkeys = file.passkeys.filter((p) => !(p.id === id && p.profileId === profileId));
    if (file.passkeys.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Give rows from before profiles to their profile NOW, rather than at the first read that needs
   * them. Main calls this whenever it learns the profiles, so the hand-over happens at launch — before
   * anyone could delete the profile that inherits them, which would otherwise leave them owned by
   * nobody for good. A no-op once they are placed, and while the profile cannot be named yet.
   */
  adoptUnownedRows(): void {
    this.rows();
  }

  /** A deleted profile's sign-ins and passkeys go with it. Copies shared into other profiles are
   *  theirs, and stay. */
  forgetProfile(profileId: string): void {
    const file = this.rows();
    const before = file.credentials.length + file.passkeys.length;
    file.credentials = file.credentials.filter((c) => c.profileId !== profileId);
    file.passkeys = file.passkeys.filter((p) => p.profileId !== profileId);
    const scope = unlockScopeKey({ kind: "profile", id: profileId });
    const hadPolicy = scope in file.unlock;
    delete file.unlock[scope];
    this.sessionUntil.delete(scope);
    if (hadPolicy || file.credentials.length + file.passkeys.length !== before) this.save();
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
    this.ownerUntil = 0;
    this.save();
    return file.presenceTtlMs;
  }

  /* ------------------------------------ audit ------------------------------------ */

  /** One JSONL line per fill attempt, whatever the outcome. Never throws: an unwritable log is a
   *  degraded audit trail, not a reason to fail a sign-in the user just approved with their
   *  fingerprint. */
  audit(entry: CredentialAuditEntry | PasskeyAuditEntry | UnlockAuditEntry | UnlockPolicyAuditEntry): void {
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

  /** The file, with any rows from before profiles adopted first — what every profile-scoped read and
   *  write goes through, so no reader can see a row the adoption has not placed yet. */
  private rows(): StoreFile {
    const file = this.load();
    if (this.unadopted) this.adopt(file);
    return file;
  }

  private credentialOf(profileId: string, id: string): StoredCredential | undefined {
    return this.rows().credentials.find((c) => c.id === id && c.profileId === profileId);
  }

  /**
   * Give every row from before profiles (no `profileId`) to the profile that kept the shared browser
   * partition, and write the file back. Idempotent by construction: a row that names a profile is
   * never touched again, so a later answer to `defaultProfileId` — the user reordered, or deleted the
   * profile that inherited them — cannot move a sign-in. Until main can name the profile, the rows
   * wait on disk exactly as they were, offered to nobody.
   */
  private adopt(file: StoreFile): void {
    const owner = this.d.defaultProfileId();
    if (!owner) return;
    for (const c of file.credentials) c.profileId ??= owner;
    for (const p of file.passkeys) p.profileId ??= owner;
    this.unadopted = false;
    this.save();
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
      unlock: readUnlockMap(parsed?.unlock),
    };
    this.file = file;
    this.keys = this.unlockKeyring(file);
    this.unadopted = file.credentials.some((c) => c.profileId === undefined) || file.passkeys.some((p) => p.profileId === undefined);
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
          /* `machine`, `eggs`, `passkey` and `unlock` were each added after this keyring's shape was settled,
             and each is folded in the same way and for the reason above: a missing domain is a
             key to mint, never a corrupt keyring to discard. */
          const added: Record<string, string> = {};
          const fold = (name: "machine" | "eggs" | "passkey" | "unlock"): Buffer => {
            const existing = Buffer.from(String(json[name] ?? ""), "base64");
            if (existing.length === SECRET_KEY_BYTES) return existing;
            const minted = newSecretKey();
            added[name] = minted.toString("base64");
            return minted;
          };
          const machine = fold("machine");
          const eggs = fold("eggs");
          const passkey = fold("passkey");
          const unlock = fold("unlock");
          if (Object.keys(added).length > 0) {
            file.keyring = this.d.safeStorage.encryptString(JSON.stringify({ ...json, ...added })).toString("base64");
            this.file = file;
            this.save();
          }
          return { oauth, credential, machine, eggs, passkey, unlock };
        }
      } catch { /* falls through to a fresh keyring */ }
      file.credentials = [];
      // Sealed under keys that are gone, so every assertion would refuse with no way for the user to
      // see why. Dropped for the same reason the credentials are, and recovered the same way: by
      // registering a new passkey from the site's own settings.
      file.passkeys = [];
      // Policies too: sealed under a key that is gone, every one would read as the default anyway,
      // and the default is what a fresh keyring means.
      file.unlock = {};
    }
    const keys = {
      oauth: newSecretKey(), credential: newSecretKey(), machine: newSecretKey(),
      eggs: newSecretKey(), passkey: newSecretKey(), unlock: newSecretKey(),
    };
    file.keyring = this.d.safeStorage
      .encryptString(JSON.stringify({
        oauth: keys.oauth.toString("base64"),
        credential: keys.credential.toString("base64"),
        machine: keys.machine.toString("base64"),
        eggs: keys.eggs.toString("base64"),
        passkey: keys.passkey.toString("base64"),
        unlock: keys.unlock.toString("base64"),
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
  return { id: c.id, origin: c.origin, username: c.username, label: c.label, createdAt: c.createdAt, generated: c.generated === true };
}

/** The character classes a generated password draws from. Punctuation is the subset that survives
 *  real sign-up forms: no quotes, no backslash, no angle brackets, nothing a site is likely to strip,
 *  escape or reject — the agent cannot read the value back to find out which happened. */
const PASSWORD_CLASSES = ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789", "-_.!@#$%&*+=?"] as const;

/**
 * A password for a site, from `randomInt` (uniform, rejection-sampled by node itself — never
 * `Math.random`, and never a modulo over raw bytes, which biases the low end of the alphabet).
 *
 * Every class the alphabet includes is guaranteed to appear, by drawing the whole string again when
 * one is missing rather than by placing required characters at fixed positions — a placement rule is
 * a pattern, and rejection keeps the distribution uniform over the strings that satisfy the rule.
 * The guarantee is not cryptographic (24 random characters are overwhelmingly likely to contain a
 * digit anyway); it is there because sites enforce class rules and reject what breaks them, and the
 * caller cannot look at the value to find out why a form complained.
 *
 * `length` is clamped rather than trusted: the redraw loop only terminates while the length is at
 * least the number of classes, and a bound that lives in the function cannot be argued away by a
 * future caller that skips the schema.
 */
export function generatePassword(length: number, symbols: boolean): string {
  const classes = symbols ? PASSWORD_CLASSES : PASSWORD_CLASSES.slice(0, 3);
  const alphabet = classes.join("");
  const chars = Math.min(Math.max(Math.trunc(length), GENERATED_PASSWORD_MIN_LENGTH), GENERATED_PASSWORD_MAX_LENGTH);
  for (;;) {
    let password = "";
    for (let i = 0; i < chars; i++) password += alphabet.charAt(randomInt(alphabet.length));
    if (classes.every((set) => [...password].some((ch) => set.includes(ch)))) return password;
  }
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
  // `generated` is NOT required: it was added after this shape was settled, and every row written
  // before it lacks the field. Requiring it here would drop every sign-in a user enrolled before the
  // update — the same trap `unlockKeyring` documents for a missing keyring domain. A missing field
  // reads as false, which is what those rows are.
  return (c.profileId === undefined || typeof c.profileId === "string")
    && typeof c.id === "string" && typeof c.origin === "string" && typeof c.username === "string"
    && typeof c.label === "string" && typeof c.createdAt === "number"
    && (c.generated === undefined || typeof c.generated === "boolean")
    && typeof c.sealed === "string" && isSealed(c.sealed);
}

/** The `unlock` map as read off disk: only string keys to sealed strings survive. Anything else is
 *  dropped, which reads as the default — the safe direction for every malformed entry. */
function readUnlockMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, sealed] of Object.entries(v as Record<string, unknown>)) {
    if (typeof sealed === "string" && isSealed(sealed)) out[k] = sealed;
  }
  return out;
}

function isStoredPasskey(v: unknown): v is StoredPasskey {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (p.profileId === undefined || typeof p.profileId === "string")
    && typeof p.id === "string" && typeof p.rpId === "string" && typeof p.userName === "string"
    && typeof p.userDisplayName === "string" && typeof p.createdAt === "number"
    && (p.lastUsedAt === null || typeof p.lastUsedAt === "number")
    && typeof p.credentialId === "string" && (p.userHandle === null || typeof p.userHandle === "string")
    && typeof p.signCount === "number" && typeof p.sealed === "string" && isSealed(p.sealed);
}
