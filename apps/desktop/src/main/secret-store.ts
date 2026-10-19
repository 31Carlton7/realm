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
 *   - A looser policy also carries the scope's stamp (`policy-stamp.ts`), a number kept in the
 *     Keychain and moved on by every change, tightening included. The seal cannot stop a copy of the
 *     file saved under "Without asking" being put back after the user tightened it; the stamp can,
 *     because the copy carries the number it was sealed with and the Keychain has moved on. A
 *     restored file, a missing stamp or no stamp helper all read as the default.
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
 * A credential's plaintext leaves this module through exactly three doors — the `use` callbacks of
 * `withCredentialValue`, `withGeneratedCredentialValue` and `withCredentialValueForPerson` — and all
 * three are the same shape on purpose: the value is a parameter, `use`'s result is discarded, and
 * what resolves is metadata. The first two are opened by the fill executors in Electron main, with the
 * value going straight into CDP key events; the third by Settings' Show and Copy, with the value going
 * into a native sheet or onto the clipboard, never into a renderer. `listCredentials` returns
 * `BrowserCredential`, a type with no field for a value. Nothing here returns, logs, throws, or
 * broadcasts one.
 *
 * ## Where a row comes from
 *
 * Typed in Settings (`addCredential`), minted for an approved agent fill (`withGeneratedCredentialValue`),
 * imported from a file the user picked in Settings (`importCredentials`), kept from a form the user
 * sent when they pressed Save on the pane's bar (`saveOffered`) — or not stored here at all: the login
 * keychain's internet passwords (`SecretStoreDeps.keychain`) are listed from there and read from there
 * at fill time. Every door that takes a value is reached from a person's press in Realm's own window;
 * none is an RPC method, a bridge op or a tool.
 */
import { createHash, randomInt } from "node:crypto";
import type { PolicyStamp } from "./policy-stamp";
import {
  isSealed, newSecretKey, open, seal, SECRET_KEY_BYTES, type SecretDomain,
} from "@realm/contracts/src/secret-box";
import {
  CREDENTIAL_PRESENCE_TTLS, DEFAULT_UNLOCK_POLICY, GENERATED_PASSWORD_MAX_LENGTH, GENERATED_PASSWORD_MIN_LENGTH,
  normalizeOrigin, PASSKEY_NAME_MAX, parseUnlockPolicy, unlockPolicyRank, unlockScopeKey,
  type BrowserCredential, type BrowserCredentialInput, type Passkey,
  type UnlockPolicy, type UnlockPolicyKind, type UnlockPolicyStatus, type UnlockScope,
  hostAllowed, normalizeVaultHost, type VaultAllow, type VaultKey, type VaultKeyInput, type VaultSecrets,
  type BrowserCredentialEdit, type KeychainPasswordsStatus, type PasswordFillAllow, type SiteCredential,
} from "@realm/contracts";
import { credentialsForPage } from "./password-match";
import type { ImportedPassword } from "./password-csv";

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
  /** `person`: the fill was the person's own pick in a pane's password menu, not an agent's call. */
  by?: "person";
  /** Who asked, when a team's role did (the team vault): which team, which role, which run. Absent for
   *  a person's own session, as every line before teams was. */
  spaceId?: string;
  roleId?: string;
  runId?: string;
};

/** One line per `vault_http` request a key went into, whatever became of it. The method and the host,
 *  never the path or the body: those are the agent's to choose, and an audit that kept them would be
 *  one place a value the agent smuggled in could end up. */
export type VaultHttpAuditEntry = {
  ts: number;
  kind: "vault-http";
  secretId: string;
  host: string;
  method: string;
  outcome: "used" | "host_refused" | "no_key" | "no_presence" | "error";
  status?: number;
  spaceId: string;
  roleId?: string;
  runId?: string;
};

/** One line per change to a grant's "use without asking". `refused` is a turn-on macOS did not confirm. */
export type VaultAllowAuditEntry = {
  ts: number;
  kind: "vault-allow";
  secretId: string;
  roleId: string;
  spaceId: string;
  outcome: "set" | "refused" | "cleared";
};

/** One line per press on a team's Policies page that loosens a rule or a tool's class. `refused` is a
 *  press macOS did not confirm, or one Realm could not keep a stamp for. */
export type TeamPolicyAuditEntry = {
  ts: number;
  kind: "team-policy";
  scope: string;
  outcome: "sealed" | "refused";
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
 *  because the profile is set to fill without asking (`unattended`). `gesture` is a person's own pick
 *  in a pane's password menu on a system with no presence check to ask (not a Mac). `refused` is a
 *  check that failed or was cancelled. */
export type UnlockAuditEntry = {
  ts: number;
  kind: "unlock";
  scope: string;
  policy: UnlockPolicyKind;
  how: "prompted" | "window" | "session" | "unattended" | "gesture" | "refused";
};

/** One line per Show password or Copy password in Settings, whatever became of it. */
export type RevealAuditEntry = {
  ts: number;
  kind: "reveal";
  credentialId: string;
  origin: string;
  action: "show" | "copy";
  outcome: "shown" | "copied" | "refused" | "no_credential";
};

/** One line per import, and per password kept from a pane's Save. Counts and an origin: never a row
 *  of the file, and never a username. */
export type PasswordStoreAuditEntry = {
  ts: number;
  kind: "import" | "save-offer" | "fill-allow";
  outcome: "imported" | "saved" | "updated" | "set" | "cleared";
  origin?: string;
  added?: number;
  updated?: number;
};

/** One internet password in the login keychain, as the helper lists it — attributes only. The
 *  password is read with `KeychainSource.read`, one item at a time, when it is filled. */
export type KeychainItem = {
  server: string;
  account: string;
  /** `https` or `http`; nothing else is listed. */
  protocol: "https" | "http";
  /** 0 when the item names none, which is the scheme's default. */
  port: number;
  path: string;
  label: string;
  /** When the item last changed, ms since the epoch; 0 when the keychain does not say. */
  modified: number;
};

/** The login keychain, through the native helper (`keychain-passwords.ts`). Null off macOS. */
export type KeychainSource = {
  list(): Promise<KeychainItem[]>;
  /** One item's password, or null when there is none, macOS refused, or the person said no. macOS
   *  raises its own prompt here unless the item already trusts Realm. */
  read(item: KeychainItem): Promise<string | null>;
};

/** How long a person's own pick in a pane's password menu keeps the next one from asking again. Only
 *  for those picks: an agent's fill never opens or uses it. */
export const GESTURE_PRESENCE_WINDOW_MS = 60_000;

/** How long the keychain's list is kept before it is read again. */
export const KEYCHAIN_LIST_TTL_MS = 60_000;

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
  /** The store file's contents, or null when it does not exist yet. Throws when it exists and cannot
   *  be read right now — which says nothing about what is in it, so the store writes nothing. */
  readFile(): string | null;
  writeFile(text: string): void;
  /**
   * Move the store file aside, unopened and unchanged, and return where it went: the store could not
   * read it (not JSON, or a keyring this Mac's Keychain will not open), and starting fresh must not
   * mean writing over every sign-in in it. Throws when it cannot be moved — then nothing is written
   * over it either. Absent, an unreadable file is refused rather than replaced.
   */
  setAside?(): string;
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
  /**
   * The Keychain stamp a looser policy must match (`policy-stamp.ts`). Absent or null — not a Mac,
   * no helper — means no looser policy can be kept: every scope stays on the default.
   */
  policyStamp?: PolicyStamp | null;
  /**
   * The login keychain's internet passwords. Absent or null: not a Mac, or no helper — Settings says
   * so and nothing else changes.
   */
  keychain?: KeychainSource | null;
  /**
   * Whether this system has any presence check to ask (Touch ID, the login password). False off macOS,
   * where the only proof a person is there is their own pick in a pane's menu or their press in
   * Settings — so those, and only those, stand in for the check. An agent's fill on such a system
   * still has no check to pass and is refused.
   */
  platformPresence?(): boolean;
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
 *  has not been adopted yet — see `adopt`. `source` is only ever `imported` on disk: a keychain row is
 *  never stored. */
type StoredCredential = BrowserCredential & { sealed: string; profileId?: string };

/** What a sealed "Always allow" for an agent's fill says, inside its seal. Checked field by field when
 *  read; any mismatch, or another Mac, is "ask". */
type FillAllowRecord = { profileId: string; credentialId: string; origin: string; machine: string; setAt: number };

const fillAllowKey = (profileId: string, credentialId: string, origin: string): string => `${profileId}|${credentialId}|${origin}`;

/** A keychain row's id: stable across launches, and derived from the item's own attributes so the
 *  same item is the same row however often the list is read. */
function keychainId(item: KeychainItem): string {
  const digest = createHash("sha256").update([item.protocol, item.server, item.port, item.path, item.account].join("\n")).digest("hex");
  return `kc_${digest.slice(0, 24)}`;
}

/** A team's API key as it sits on disk: the value sealed under the `vault-key` domain, beside the
 *  hosts it may be sent to. */
type StoredKey = VaultKey & { profileId: string; sealed: string };

/** What a sealed allow says, inside its seal. Every field is checked when it is read; any mismatch is
 *  "ask", never "allow". */
type AllowRecord = {
  profileId: string; spaceId: string; secretId: string; roleId: string;
  hosts: string[]; grantAt: number; machine: string; setAt: number;
};

const allowKey = (secretId: string, roleId: string): string => `${secretId}|${roleId}`;

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
  /** A team's API keys (Teams Phase 2). Absent from files written before the vault. */
  keys: StoredKey[];
  /** `secretId|roleId` → that grant's "use without asking", sealed under `vault-allow`. Absent from
   *  files written before the vault, which is every grant asking. */
  allow: Record<string, string>;
  /** Profile id → the origins it never offers to save a password for ("Never for this site"). Not a
   *  secret: a list of sites, kept in the clear like the rows' origins. */
  neverSave: Record<string, string[]>;
  /** `profileId|credentialId|origin` → an agent's "Always allow", sealed under `fill-allow`. */
  fillAllow: Record<string, string>;
  /** Whether the login keychain's passwords are offered. Off until the person turns it on. */
  keychainEnabled: boolean;
  /** Where the last store Realm could not read was kept, and when — until the person has read
   *  Settings ▸ Passwords' notice about it. */
  unreadable: SetAside | null;
};

/** A store file moved aside because it could not be read. */
export type SetAside = { path: string; at: number };

/**
 * What safeStorage throws when the Keychain is shut to Realm rather than the blob being bad: access
 * refused, or not available yet (Electron 37's own words). The keyring is fine then, and so is the
 * file. Every other failure to open it — "Ciphertext does not appear to be encrypted", the bare
 * "Error while decrypting…", a blob that opens to garbage — is the content.
 */
const KEYCHAIN_SHUT = /(De|En)cryption is not available|cannot be used before app is ready/;

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
  /** Each scope's Keychain stamp as last read or moved by this process. Read once per launch: a file
   *  put back while Realm runs is not read again until the next launch, which is when it is judged. */
  private readonly stamps = new Map<string, number | null | "unreadable">();
  /** Rows without a profile are on disk and still waiting for `defaultProfileId` to name one. */
  private unadopted = false;
  /** The window a person's own pick in a pane's menu opens (`GESTURE_PRESENCE_WINDOW_MS`). In memory,
   *  and apart from `presenceUntil`, so no agent fill is ever let through by it. */
  private gestureUntil = 0;
  /** The keychain's last listing, and when it was read. */
  private keychainCache: { at: number; rows: Map<string, { item: KeychainItem; credential: BrowserCredential }>; error: string | null } | null = null;

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

  /** One row, by id: the profile's own, or a keychain item from the last listing. */
  getCredential(profileId: string, id: string): BrowserCredential | null {
    const row = this.credentialOf(profileId, id);
    if (row) return strip(row);
    return this.keychainRow(id)?.credential ?? null;
  }

  /**
   * Enroll one credential the USER typed. Reachable only from the Settings UI's IPC handler — there
   * is no tool, no RPC method, no bridge op and no chat path that lands here, which is the design's
   * second hard requirement after the value never coming back out. If a model could call this, the
   * anti-phishing gate would be a formality: it could enroll a password the user already uses
   * elsewhere against the origin it is standing on, and then "fill" it. The other doors that take a
   * value — `importCredentials` and `saveOffered` — hold to the same rule: a person's press in
   * Realm's own window is the only thing that reaches them.
   *
   * `withGeneratedCredentialValue` is the one other way a row comes into being, and it does not
   * reopen that hole: the value there is Realm's own random string rather than anything the caller
   * supplied, so a row minted for a lookalike page is a secret that page could have invented itself.
   * What the gate protects is the user's OWN secrets, and no caller can put one of those here.
   */
  addCredential(profileId: string, input: BrowserCredentialInput, spaceId?: string): BrowserCredential {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a sign-in. Nothing was stored.");
    }
    const origin = normalizeOrigin(input.origin);
    if (!origin) {
      throw new SecretStoreError(`"${input.origin}" is not an http(s) address Realm can pin a sign-in to. Enter the site's address, for example https://example.com.`);
    }
    return this.enroll(profileId, { origin, username: input.username, label: input.label, generated: false, ...(spaceId ? { spaceId } : {}) }, input.value);
  }

  /** Seal one value under an already-normalized origin and write the row as this profile's. The two
   *  callers that reach here are the only two routes into this file: Settings' own form, and a
   *  generated fill. */
  private enroll(profileId: string, meta: { origin: string; username: string; label: string; generated: boolean; spaceId?: string }, value: string): BrowserCredential {
    const file = this.rows();
    const row: StoredCredential = {
      id: this.d.newId(),
      profileId,
      origin: meta.origin,
      username: meta.username.trim(),
      label: meta.label.trim(),
      createdAt: this.d.now(),
      generated: meta.generated,
      ...(meta.spaceId ? { spaceId: meta.spaceId } : {}),
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
    this.pruneAllows(file);
    for (const k of Object.keys(file.fillAllow)) if (k.startsWith(`${profileId}|${id}|`)) delete file.fillAllow[k];
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
    // A team's sign-in is that team's: a copy in another profile would be one no space of it could
    // be offered, or — made the profile's own — one offered in every space. Neither is a share.
    if (!source || source.spaceId || toProfileId === "" || toProfileId === fromProfileId) return null;
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

  /**
   * Bring in the passwords of an export the person picked in Settings ▸ Passwords — the Passwords
   * app's, or another manager's (`password-csv.ts`). Reachable from that handler alone, which opens
   * the file through the system's own open panel; no tool, RPC method or bridge op names a file here.
   *
   * A row for an origin and username this profile already holds brings that row's password up to
   * date rather than adding a second; one whose password is the same is counted and left. New rows
   * are marked `imported`, so Settings can say where they came from. One write for the whole file.
   */
  importCredentials(profileId: string, rows: readonly ImportedPassword[]): { added: number; updated: number; unchanged: number } {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not import passwords. Nothing was stored.");
    }
    const file = this.rows();
    let added = 0, updated = 0, unchanged = 0;
    for (const r of rows) {
      const origin = normalizeOrigin(r.origin);
      if (!origin || r.password === "") continue;
      const username = r.username.trim();
      const same = file.credentials.find((c) => c.profileId === profileId && c.spaceId === undefined && c.origin === origin && c.username === username);
      if (same) {
        if (this.opens(same, r.password)) { unchanged++; continue; }
        same.sealed = seal(this.key("credential"), "credential", r.password);
        updated++;
        continue;
      }
      file.credentials.push({
        id: this.d.newId(), profileId, origin, username, label: r.title.trim().slice(0, 255),
        createdAt: this.d.now(), generated: false, source: "imported",
        sealed: seal(this.key("credential"), "credential", r.password),
      });
      added++;
    }
    if (added + updated > 0) this.save();
    this.audit({ ts: this.d.now(), kind: "import", outcome: "imported", added, updated });
    return { added, updated, unchanged };
  }

  /**
   * Change one of this profile's rows from Settings: its username and label, and — when the person
   * typed one — its password. Settings' edit sheet is the only caller. A row Realm generated stays
   * marked generated until its password is replaced by one the person chose.
   */
  updateCredential(profileId: string, id: string, edit: BrowserCredentialEdit): BrowserCredential | null {
    const row = this.credentialOf(profileId, id);
    if (!row) return null;
    if (edit.value !== undefined && !this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so the password was not changed.");
    }
    row.username = edit.username.trim();
    row.label = edit.label.trim();
    if (edit.value !== undefined) {
      row.sealed = seal(this.key("credential"), "credential", edit.value);
      row.generated = false;
    }
    this.save();
    return strip(row);
  }

  /**
   * What a pane should offer after a form went out with this username and password on `origin`:
   * `save` for a sign-in the profile does not hold, `update` (naming the row) for one it holds with
   * another password, and null for nothing to offer — the same password is saved already (which is
   * also every fill Realm itself just typed), or the person said never for this site.
   *
   * The comparison happens HERE, behind the seal, and what leaves is the verdict: a page learns
   * nothing from it, since the pane's bar is Realm's and not the page's.
   */
  saveOfferFor(profileId: string, origin: string, username: string, value: string): { kind: "save" } | { kind: "update"; id: string } | null {
    const site = normalizeOrigin(origin);
    if (!site || value === "" || !this.available) return null;
    if (this.neverSaveSites(profileId).includes(site)) return null;
    const user = username.trim();
    const mine = this.rows().credentials.filter((c) => c.profileId === profileId && c.spaceId === undefined && c.origin === site);
    if (mine.some((c) => this.opens(c, value))) return null;
    const same = mine.find((c) => c.username === user);
    return same ? { kind: "update", id: same.id } : { kind: "save" };
  }

  /**
   * Keep a password the person sent in a form, after they pressed Save (or Update) on the pane's bar.
   * Main holds the value between the form going out and that press; this is where it is sealed.
   * Decided again here rather than trusted from the offer, so a row deleted in between is made anew.
   */
  saveOffered(profileId: string, input: { origin: string; username: string; value: string }): BrowserCredential | null {
    const origin = normalizeOrigin(input.origin);
    if (!origin || input.value === "" || !this.available) return null;
    const offer = this.saveOfferFor(profileId, origin, input.username, input.value);
    if (offer === null) return null;
    if (offer.kind === "update") {
      const row = this.credentialOf(profileId, offer.id)!;
      row.sealed = seal(this.key("credential"), "credential", input.value);
      row.generated = false;
      this.save();
      this.audit({ ts: this.d.now(), kind: "save-offer", outcome: "updated", origin });
      return strip(row);
    }
    const row = this.enroll(profileId, { origin, username: input.username, label: "", generated: false }, input.value);
    this.audit({ ts: this.d.now(), kind: "save-offer", outcome: "saved", origin });
    return row;
  }

  /** The sites this profile never offers to save a password for. */
  neverSaveSites(profileId: string): string[] {
    return [...(this.load().neverSave[profileId] ?? [])];
  }

  /** Add or take back one "Never for this site". */
  setNeverSave(profileId: string, origin: string, never: boolean): string[] {
    const site = normalizeOrigin(origin);
    const file = this.load();
    const list = new Set(file.neverSave[profileId] ?? []);
    if (site) { if (never) list.add(site); else list.delete(site); }
    if (list.size > 0) file.neverSave[profileId] = [...list].sort(); else delete file.neverSave[profileId];
    this.save();
    return this.neverSaveSites(profileId);
  }

  /** Whether `value` is this row's password. Inside the store, so the answer is all that leaves. */
  private opens(row: StoredCredential, value: string): boolean {
    try { return open(this.key("credential"), "credential", row.sealed) === value; } catch { return false; }
  }

  /* ------------------------------ agents' "Always allow" ------------------------------ */

  /**
   * Keep an agent's "Always allow" for one password on one exact origin — the person's answer on the
   * fill's own card, carried here by main's bridge handler. What it removes is the CARD: every fill it
   * lets through still unlocks by the profile's policy, so under the default it is still a Touch ID.
   * Sealed with the profile, the password's id, the origin and this Mac inside, so a hand-written
   * entry, one moved to another password or site, or a copy on another Mac reads as "ask".
   */
  setFillAllow(profileId: string, credentialId: string, origin: string): boolean {
    const site = normalizeOrigin(origin);
    const machine = this.machine();
    if (!site || !machine || !this.available || !this.getCredential(profileId, credentialId)) return false;
    const record: FillAllowRecord = { profileId, credentialId, origin: site, machine, setAt: this.d.now() };
    this.load().fillAllow[fillAllowKey(profileId, credentialId, site)] = seal(this.key("fill-allow"), "fill-allow", JSON.stringify(record));
    this.save();
    this.audit({ ts: this.d.now(), kind: "fill-allow", outcome: "set", origin: site });
    return true;
  }

  fillAllowed(profileId: string, credentialId: string, origin: string): boolean {
    const site = normalizeOrigin(origin);
    if (!site) return false;
    const sealed = this.load().fillAllow[fillAllowKey(profileId, credentialId, site)];
    const r = sealed ? this.openFillAllow(sealed) : null;
    return r !== null && r.profileId === profileId && r.credentialId === credentialId && r.origin === site && r.machine === this.machine();
  }

  fillAllows(profileId: string): PasswordFillAllow[] {
    const out: PasswordFillAllow[] = [];
    for (const sealed of Object.values(this.load().fillAllow)) {
      const r = this.openFillAllow(sealed);
      if (r && r.profileId === profileId && r.machine === this.machine()) out.push({ credentialId: r.credentialId, origin: r.origin, setAt: r.setAt });
    }
    return out.sort((a, b) => a.origin.localeCompare(b.origin));
  }

  /** Back to the card. Never confirmed: putting a gate back is always one click. */
  clearFillAllow(profileId: string, credentialId: string, origin: string): boolean {
    const file = this.load();
    const k = fillAllowKey(profileId, credentialId, normalizeOrigin(origin) ?? origin);
    if (!(k in file.fillAllow)) return false;
    delete file.fillAllow[k];
    this.save();
    this.audit({ ts: this.d.now(), kind: "fill-allow", outcome: "cleared", origin });
    return true;
  }

  private openFillAllow(sealed: string): FillAllowRecord | null {
    if (!this.available) return null;
    try {
      const text = open(this.key("fill-allow"), "fill-allow", sealed);
      if (text === null) return null;
      const r = JSON.parse(text) as Partial<FillAllowRecord>;
      return typeof r.profileId === "string" && typeof r.credentialId === "string" && typeof r.origin === "string"
        && typeof r.machine === "string" && typeof r.setAt === "number" ? r as FillAllowRecord : null;
    } catch {
      return null;
    }
  }

  /* --------------------------------- the login keychain --------------------------------- */

  keychainStatus(): KeychainPasswordsStatus {
    const supported = this.d.keychain != null;
    const enabled = supported && this.load().keychainEnabled;
    return {
      supported, enabled,
      count: enabled && this.keychainCache && this.keychainCache.error === null ? this.keychainCache.rows.size : null,
      error: enabled ? this.keychainCache?.error ?? null : null,
    };
  }

  /** Turn the keychain's passwords on or off. Settings' switch is the only caller. Off forgets the
   *  listing at once, so nothing offers a keychain row a moment after the person said no. */
  async setKeychainEnabled(enabled: boolean): Promise<KeychainPasswordsStatus> {
    const file = this.load();
    file.keychainEnabled = enabled && this.d.keychain != null;
    this.save();
    this.keychainCache = null;
    if (file.keychainEnabled) await this.refreshKeychain(true);
    return this.keychainStatus();
  }

  /** Read the keychain's list again when the last one is older than `KEYCHAIN_LIST_TTL_MS` (or
   *  `force`). Attributes only: listing never asks macOS for a password, so it raises no prompt. */
  async refreshKeychain(force = false): Promise<void> {
    const source = this.d.keychain;
    if (!source || !this.load().keychainEnabled) { this.keychainCache = null; return; }
    if (!force && this.keychainCache && this.d.now() - this.keychainCache.at < KEYCHAIN_LIST_TTL_MS) return;
    const rows = new Map<string, { item: KeychainItem; credential: BrowserCredential }>();
    let error: string | null = null;
    try {
      for (const item of await source.list()) {
        const port = item.port > 0 && item.port !== (item.protocol === "https" ? 443 : 80) ? `:${item.port}` : "";
        const origin = normalizeOrigin(`${item.protocol}://${item.server}${port}`);
        if (!origin) continue;
        const id = keychainId(item);
        rows.set(id, { item, credential: { id, origin, username: item.account, label: item.label === item.server ? "" : item.label, createdAt: item.modified, generated: false, source: "keychain" } });
      }
    } catch {
      error = "Realm couldn't read the login keychain's list.";
    }
    this.keychainCache = { at: this.d.now(), rows, error };
  }

  /** The keychain's rows from the last listing — none while it is off. */
  fromKeychain(): BrowserCredential[] {
    if (!this.load().keychainEnabled) return [];
    return [...(this.keychainCache?.rows.values() ?? [])].map((r) => r.credential);
  }

  private keychainRow(id: string): { item: KeychainItem; credential: BrowserCredential } | null {
    if (!id.startsWith("kc_") || !this.load().keychainEnabled) return null;
    return this.keychainCache?.rows.get(id) ?? null;
  }

  /**
   * Every password this profile may be offered on `pageOrigin`, exact origin first: its own, its
   * team's when `spaceId` is that team's, and the keychain's. Metadata, with whether an agent has
   * "Always allow" for each on this exact origin.
   */
  credentialsForSite(profileId: string, spaceId: string | null, pageOrigin: string): SiteCredential[] {
    const origin = normalizeOrigin(pageOrigin);
    if (!origin) return [];
    return credentialsForPage(this.credentialsForSpace(profileId, spaceId), origin)
      .map((c) => ({ ...c, agentAllowed: this.fillAllowed(profileId, c.id, origin) }));
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
    scope: { spaceId?: string | null } = {},
    how: { gesture?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }> {
    // A keychain row is read from the keychain, behind the same presence check — and then macOS's own
    // prompt, unless the item already trusts Realm. The person answers Realm's first, so a page that
    // could never have been filled never puts a keychain sheet in front of them.
    const kc = this.keychainRow(id);
    if (kc) {
      const who = kc.credential.username ? `${kc.credential.username} on ${kc.credential.origin}` : kc.credential.origin;
      if (!(await this.requirePresence(profileId, `fill your keychain password for ${who}`, how.gesture === true))) {
        return { ok: false, refused: "no_presence" };
      }
      const value = await this.d.keychain!.read(kc.item).catch(() => null);
      if (value === null || value === "") return { ok: false, refused: "no_credential" };
      await use(value);
      return { ok: true };
    }

    // Another profile's sign-in is refused exactly as one that does not exist — and before the
    // prompt, so a Touch ID sheet is never raised for a fill that could not have been allowed. So is
    // a team's sign-in asked for from anywhere but that team's space: a caller that names no space
    // reaches only the profile's own.
    const row = this.credentialOf(profileId, id);
    if (!row || (row.spaceId !== undefined && row.spaceId !== scope.spaceId)) return { ok: false, refused: "no_credential" };

    const who = row.username ? `${row.username} on ${row.origin}` : row.origin;
    if (!(await this.requirePresence(profileId, `fill your saved sign-in for ${who}`, how.gesture === true))) {
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
   * Run `use` with one password for the PERSON — Settings' Show password and Copy password — after
   * macOS confirms them: Touch ID, or the login password where that can run. Always asked, whatever
   * the profile's policy and whatever window is open: "Without asking" and the short window are for
   * fills, and neither says a person wants a password on their screen.
   *
   * The caller puts the value in a native sheet or on the clipboard from main. Neither is a renderer,
   * so nothing an agent can read of Realm's window ever holds it.
   */
  async withCredentialValueForPerson(
    profileId: string,
    id: string,
    action: "show" | "copy",
    use: (value: string) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }> {
    const kc = this.keychainRow(id);
    const row = kc ? null : this.credentialOf(profileId, id);
    const credential = kc?.credential ?? (row ? strip(row) : null);
    if (!credential) return { ok: false, refused: "no_credential" };
    const entry = { ts: 0, kind: "reveal" as const, credentialId: id, origin: credential.origin, action };
    const who = credential.username ? `${credential.username} on ${credential.origin}` : credential.origin;
    const asked = this.d.platformPresence?.() === false
      ? true
      : await this.confirmOwner(`${action === "show" ? "show" : "copy"} the password for ${who}`);
    if (!asked) {
      this.audit({ ...entry, ts: this.d.now(), outcome: "refused" });
      return { ok: false, refused: "no_presence" };
    }
    const value = kc
      ? await this.d.keychain!.read(kc.item).catch(() => null)
      : this.available ? open(this.key("credential"), "credential", row!.sealed) : null;
    if (value === null || value === "") {
      this.audit({ ...entry, ts: this.d.now(), outcome: "no_credential" });
      return { ok: false, refused: "no_credential" };
    }
    this.audit({ ...entry, ts: this.d.now(), outcome: action === "show" ? "shown" : "copied" });
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
  private async requirePresence(profileId: string, reason: string, gesture = false): Promise<boolean> {
    const scope = unlockScopeKey({ kind: "profile", id: profileId });
    const policy = this.readPolicy(scope);
    const how = gesture ? await this.unlockForGesture(scope, policy, reason) : await this.unlock(scope, policy, reason);
    this.audit({ ts: this.d.now(), kind: "unlock", scope, policy: policy.kind, how });
    return how !== "refused";
  }

  /**
   * The unlock for a person's own pick in a pane's password menu. The policy still decides — a
   * session or "Without asking" lets it through as it would an agent's fill — but a person who just
   * answered Touch ID for one pick is not asked again for the next minute
   * (`GESTURE_PRESENCE_WINDOW_MS`), and where the system has no check to ask at all the pick itself
   * is the person. Neither applies to an agent's fill, which never comes through here.
   */
  private async unlockForGesture(scope: string, policy: UnlockPolicy, reason: string): Promise<UnlockAuditEntry["how"]> {
    if (this.d.platformPresence?.() === false) return "gesture";
    if ((policy.kind === "touch-id" || policy.kind === "device-password") && this.d.now() < this.gestureUntil) return "window";
    const how = await this.unlock(scope, policy, reason);
    if (how === "prompted") this.gestureUntil = this.d.now() + GESTURE_PRESENCE_WINDOW_MS;
    return how;
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
    /* The stamp moves on with EVERY change, a tightening included and before the file is written:
       that is what makes a copy of the file saved under the old policy read as Touch ID when it is
       put back. A stamp that will not move keeps a looser policy from being set at all — and never
       holds up a tightening, which must always be one click. */
    let gen: number | null = null;
    try { gen = this.d.policyStamp?.bump(key) ?? null; } catch { gen = null; }
    this.stamps.delete(key);
    if (gen !== null) this.stamps.set(key, gen);
    if (gen === null && policy.kind !== "touch-id") {
      this.audit({ ts: this.d.now(), kind: "unlock-policy", scope: key, from: current.kind, to: policy.kind, outcome: "refused" });
      return { ok: false, error: "Realm could not keep a record of this setting in your Keychain, so nothing changed." };
    }
    const file = this.load();
    if (policy.kind === "touch-id") delete file.unlock[key];
    else file.unlock[key] = seal(this.key("unlock"), "unlock", JSON.stringify({ scope: key, machine, policy, setAt: this.d.now(), gen }));
    // Any change starts over: a session opened under the old policy is not one the new one granted.
    this.sessionUntil.delete(key);
    this.save();
    this.audit({ ts: this.d.now(), kind: "unlock-policy", scope: key, from: current.kind, to: policy.kind, outcome: "set" });
    return { ok: true, status: this.unlockStatus(scope) };
  }

  /**
   * The policy sealed for this scope, or the default. EVERY failure is the default, never a weaker
   * policy: no entry, a keyring that will not open, a blob that does not open under the `unlock` key
   * (hand-written, or tampered), a blob sealed for another scope (moved), an `unattended` blob set
   * on another Mac (copied), or a blob whose stamp is not the Keychain's (put back from an older copy
   * of the file, or sealed before stamps existed).
   */
  private readPolicy(key: string): UnlockPolicy {
    const sealed = this.load().unlock[key];
    if (!sealed || !this.available) return DEFAULT_UNLOCK_POLICY;
    let record: { scope?: unknown; machine?: unknown; policy?: unknown; gen?: unknown };
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
    if (policy.kind !== DEFAULT_UNLOCK_POLICY.kind) {
      const stamp = this.stampOf(key);
      if (typeof stamp !== "number" || record.gen !== stamp) return DEFAULT_UNLOCK_POLICY;
    }
    return policy;
  }

  private stampOf(key: string): number | null | "unreadable" {
    if (!this.stamps.has(key)) {
      let stamp: number | null | "unreadable";
      try { stamp = this.d.policyStamp?.read(key) ?? null; } catch { stamp = "unreadable"; }
      this.stamps.set(key, stamp);
    }
    return this.stamps.get(key)!;
  }

  private machineCache: string | null | undefined;
  private machine(): string | null {
    if (this.machineCache === undefined) {
      try { this.machineCache = this.d.machineId?.() ?? null; } catch { this.machineCache = null; }
    }
    return this.machineCache;
  }

  /* --------------------------------- the team vault --------------------------------- */

  /**
   * What one team's Vault page and its server half may know: the profile's sign-ins that space is
   * offered (the profile's own, and the team's), and the team's keys. Metadata only.
   */
  vaultSecrets(profileId: string, spaceId: string): VaultSecrets {
    const file = this.rows();
    return {
      signins: file.credentials
        .filter((c) => c.profileId === profileId && (c.spaceId === undefined || c.spaceId === spaceId))
        .map((c) => ({ id: c.id, origin: c.origin, username: c.username, label: c.label, generated: c.generated === true, spaceId: c.spaceId ?? null, createdAt: c.createdAt })),
      keys: file.keys.filter((k) => k.profileId === profileId && k.spaceId === spaceId).map(stripKey),
    };
  }

  /** The sign-ins an agent in `spaceId` is offered: the profile's own and that team's, never another
   *  team's. `null` is a caller that cannot say its space, and gets the profile's own alone. */
  credentialsForSpace(profileId: string, spaceId: string | null): BrowserCredential[] {
    return [
      ...this.rows().credentials
        .filter((c) => c.profileId === profileId && (c.spaceId === undefined || c.spaceId === spaceId))
        .map(strip),
      // The keychain is the Mac user's, not a profile's: every profile is offered it once it is on.
      ...this.fromKeychain(),
    ];
  }

  /**
   * Enroll one API key the USER typed into a team's Vault page — reachable from that page's IPC
   * handler alone, for `addCredential`'s reason: a model that could enroll a key could put a value it
   * chose behind a host it chose. Its hosts are normalized here and must all be hosts; a key whose
   * name the team already uses is refused rather than replaced, so a second key never quietly takes
   * over the first one's grants.
   */
  addKey(profileId: string, spaceId: string, input: VaultKeyInput): VaultKey {
    if (!this.available) {
      throw new SecretStoreError("macOS is not offering Realm an encryption key right now (Keychain unavailable), so Realm will not save a key. Nothing was stored.");
    }
    const hosts = [...new Set(input.allowedHosts.map((h) => normalizeVaultHost(h)))];
    if (hosts.length === 0 || hosts.some((h) => h === null)) {
      throw new SecretStoreError("Each host must be a site's address, such as api.revenuecat.com — no wildcards and no paths.");
    }
    const file = this.rows();
    const name = input.name.trim();
    if (file.keys.some((k) => k.profileId === profileId && k.spaceId === spaceId && k.name === name)) {
      throw new SecretStoreError(`This team already has a key named ${name}. Remove it first to replace it.`);
    }
    const row: StoredKey = {
      id: this.d.newId(), profileId, spaceId, name, label: input.label.trim(), allowedHosts: hosts as string[],
      createdAt: this.d.now(), sealed: seal(this.key("vault-key"), "vault-key", input.value),
    };
    file.keys.push(row);
    this.save();
    return stripKey(row);
  }

  removeKey(profileId: string, id: string): boolean {
    const file = this.rows();
    const before = file.keys.length;
    file.keys = file.keys.filter((k) => !(k.id === id && k.profileId === profileId));
    if (file.keys.length === before) return false;
    this.pruneAllows(file);
    this.save();
    return true;
  }

  /**
   * Run `use` with one key's plaintext — the vault's door out, the same shape as
   * `withCredentialValue` and for the same reason: the value is a parameter, never a resolution.
   *
   * The caller has already checked the request's host against the key's before calling, so a request
   * to a host the key is not locked to is refused without anyone being asked anything. Presence is
   * the profile's unlock policy, exactly as for a sign-in.
   */
  async withKeyValue(
    profileId: string,
    spaceId: string,
    id: string,
    use: (value: string, key: VaultKey) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_key" | "no_presence" }> {
    const row = this.rows().keys.find((k) => k.id === id && k.profileId === profileId && k.spaceId === spaceId);
    if (!row) return { ok: false, refused: "no_key" };
    if (!(await this.requirePresence(profileId, `put the key ${row.name} into a request to ${row.allowedHosts.join(", ")}`))) {
      return { ok: false, refused: "no_presence" };
    }
    const value = this.available ? open(this.key("vault-key"), "vault-key", row.sealed) : null;
    if (value === null) return { ok: false, refused: "no_key" };
    await use(value, stripKey(row));
    return { ok: true };
  }

  /** One of the team's keys, by id. Metadata. */
  getKey(profileId: string, spaceId: string, id: string): VaultKey | null {
    const row = this.rows().keys.find((k) => k.id === id && k.profileId === profileId && k.spaceId === spaceId);
    return row ? stripKey(row) : null;
  }

  /**
   * Let one granted role use one secret without the session's card — the lab's switch.
   *
   * Reachable ONLY from the Vault page's IPC handler, for `setUnlockPolicy`'s reason, and confirmed
   * by macOS (Touch ID or the login password) every time it is turned on: there is no tool, RPC method,
   * bridge op or setting key that lands here, and the control carries `data-no-agent`. What it seals is
   * narrow on purpose — this secret, this role, this team, these hosts, this grant, this Mac — and every
   * one of those is checked again when it is read, so a grant revoked and remade, a host added later,
   * or a copy of Realm's files on another Mac all read as "ask".
   *
   * `hosts` must be hosts the secret itself is pinned to: a sign-in's one origin, or a subset of a
   * key's. An allow can narrow what a secret reaches, never widen it.
   */
  async setVaultAllow(profileId: string, a: { spaceId: string; secretId: string; roleId: string; hosts: string[]; grantAt: number; roleName: string; secretName: string }):
    Promise<{ ok: true; allow: VaultAllow } | { ok: false; error: string }> {
    if (!this.available) return { ok: false, error: "macOS is not offering Realm an encryption key right now (Keychain unavailable), so nothing changed." };
    const machine = this.machine();
    if (!machine) return { ok: false, error: "Realm could not read this Mac's hardware ID, so it cannot tie this to this Mac. Nothing changed." };
    const pinned = this.pinnedHosts(profileId, a.spaceId, a.secretId);
    if (!pinned) return { ok: false, error: "That secret is no longer in this team's vault." };
    const hosts = [...new Set(a.hosts.map((h) => normalizeVaultHost(h)).filter((h): h is string => h !== null))];
    if (hosts.length === 0 || hosts.some((h) => !hostAllowed(h, pinned))) {
      return { ok: false, error: "A role can be let through only to the hosts the secret itself is locked to." };
    }
    const confirmed = await this.confirmOwner(`let ${a.roleName} use ${a.secretName} without asking`);
    if (!confirmed) {
      this.audit({ ts: this.d.now(), kind: "vault-allow", secretId: a.secretId, roleId: a.roleId, spaceId: a.spaceId, outcome: "refused" });
      return { ok: false, error: "macOS did not confirm it was you, so nothing changed." };
    }
    const record: AllowRecord = {
      profileId, spaceId: a.spaceId, secretId: a.secretId, roleId: a.roleId, hosts, grantAt: a.grantAt, machine, setAt: this.d.now(),
    };
    const file = this.rows();
    file.allow[allowKey(a.secretId, a.roleId)] = seal(this.key("vault-allow"), "vault-allow", JSON.stringify(record));
    this.save();
    this.audit({ ts: this.d.now(), kind: "vault-allow", secretId: a.secretId, roleId: a.roleId, spaceId: a.spaceId, outcome: "set" });
    return { ok: true, allow: toAllow(record) };
  }

  /** Back to asking. Never confirmed: putting a gate back must always be one click. */
  clearVaultAllow(secretId: string, roleId: string): boolean {
    const file = this.rows();
    const k = allowKey(secretId, roleId);
    if (!(k in file.allow)) return false;
    const record = this.openAllow(file.allow[k]!);
    delete file.allow[k];
    this.save();
    this.audit({ ts: this.d.now(), kind: "vault-allow", secretId, roleId, spaceId: record?.spaceId ?? "", outcome: "cleared" });
    return true;
  }

  /** The team's allows, as the Vault page draws its switches. Each one opened and checked; one that
   *  does not open, or was set on another Mac, is not listed — it would not let anything through. */
  vaultAllows(profileId: string, spaceId: string): VaultAllow[] {
    const machine = this.machine();
    const out: VaultAllow[] = [];
    for (const sealed of Object.values(this.rows().allow)) {
      const r = this.openAllow(sealed);
      if (r && r.profileId === profileId && r.spaceId === spaceId && machine && r.machine === machine) out.push(toAllow(r));
    }
    return out;
  }

  /**
   * Whether this one use may go ahead with no card: a sealed allow for exactly this secret, role, team
   * and grant, naming this host, set on this Mac — AND the profile's own unlock policy is "without
   * asking". Either alone is not enough: an allow on a profile that still asks for Touch ID would take
   * the card away and leave a fingerprint prompt nobody is there to answer.
   */
  vaultAllowed(profileId: string, q: { spaceId: string; secretId: string; roleId: string; host: string; grantAt: number }): boolean {
    if (this.readPolicy(unlockScopeKey({ kind: "profile", id: profileId })).kind !== "unattended") return false;
    const sealed = this.rows().allow[allowKey(q.secretId, q.roleId)];
    const r = sealed ? this.openAllow(sealed) : null;
    if (!r) return false;
    const machine = this.machine();
    return r.profileId === profileId && r.spaceId === q.spaceId && r.secretId === q.secretId && r.roleId === q.roleId
      && r.grantAt === q.grantAt && machine !== null && r.machine === machine && hostAllowed(q.host, r.hosts)
      && this.pinnedHosts(profileId, q.spaceId, q.secretId) !== null;
  }

  /** The hosts a secret is pinned to: a sign-in's origin host, a key's hosts. Null when this team
   *  has no such secret. */
  private pinnedHosts(profileId: string, spaceId: string, secretId: string): string[] | null {
    const file = this.rows();
    const key = file.keys.find((k) => k.id === secretId && k.profileId === profileId && k.spaceId === spaceId);
    if (key) return key.allowedHosts;
    const cred = file.credentials.find((c) => c.id === secretId && c.profileId === profileId && (c.spaceId === undefined || c.spaceId === spaceId));
    const host = cred ? normalizeVaultHost(cred.origin) : null;
    return host ? [host] : null;
  }

  private openAllow(sealed: string): AllowRecord | null {
    if (!this.available) return null;
    try {
      const text = open(this.key("vault-allow"), "vault-allow", sealed);
      if (text === null) return null;
      const r = JSON.parse(text) as Partial<AllowRecord>;
      if (typeof r.profileId !== "string" || typeof r.spaceId !== "string" || typeof r.secretId !== "string" || typeof r.roleId !== "string"
        || !Array.isArray(r.hosts) || !r.hosts.every((h) => typeof h === "string") || typeof r.grantAt !== "number"
        || typeof r.machine !== "string" || typeof r.setAt !== "number") return null;
      return r as AllowRecord;
    } catch {
      return null;
    }
  }

  /** Drop allows whose secret is gone. Returns whether any went. Read by key, not by opening: the map
   *  key names the secret, and a secret that no longer exists can let nothing through either way. */
  private pruneAllows(file: StoreFile): boolean {
    const ids = new Set([...file.credentials.map((c) => c.id), ...file.keys.map((k) => k.id)]);
    let pruned = false;
    for (const k of Object.keys(file.allow)) {
      if (!ids.has(k.split("|")[0]!)) { delete file.allow[k]; pruned = true; }
    }
    return pruned;
  }

  /* -------------------------------- team policies -------------------------------- */

  /**
   * Seal one loosening from a team's Policies page: a rule, or a tool's class, that lets a role do more
   * without the person. Reachable ONLY from the page's press handler (`policy-presses.ts`), for
   * `setUnlockPolicy`'s reason — there is no tool, RPC method or bridge op that makes a seal — and
   * confirmed by macOS (Touch ID or the login password) every time.
   *
   * What it seals is the exact text the server will store (`policySealText`, `toolClassSealText`), the
   * scope it belongs to, this Mac, and the scope's Keychain stamp, moved on first. So a row edited in
   * realm.db no longer matches its text, one copied to another Mac carries the wrong machine, and an
   * older sealed row put back after a tightening carries an older stamp: each reads as not sealed, which
   * the server reads as the floor. A stamp that will not move keeps the loosening from being made at all.
   */
  async sealTeamPolicy(scope: string, text: string, reason: string): Promise<{ ok: true; seal: string } | { ok: false; error: string }> {
    if (!this.available) return { ok: false, error: "macOS is not offering Realm an encryption key right now (Keychain unavailable), so nothing changed." };
    const machine = this.machine();
    if (!machine) return { ok: false, error: "Realm could not read this Mac's hardware ID, so it cannot tie this to this Mac. Nothing changed." };
    if (!(await this.confirmOwner(reason))) {
      this.audit({ ts: this.d.now(), kind: "team-policy", scope, outcome: "refused" });
      return { ok: false, error: "macOS did not confirm it was you, so nothing changed." };
    }
    let gen: number | null = null;
    try { gen = this.d.policyStamp?.bump(scope) ?? null; } catch { gen = null; }
    this.stamps.delete(scope);
    if (gen === null) {
      this.audit({ ts: this.d.now(), kind: "team-policy", scope, outcome: "refused" });
      return { ok: false, error: "Realm could not keep a record of this in your Keychain, so nothing changed." };
    }
    this.stamps.set(scope, gen);
    const sealed = seal(this.key("team-policy"), "team-policy", JSON.stringify({ scope, text, machine, gen }));
    this.audit({ ts: this.d.now(), kind: "team-policy", scope, outcome: "sealed" });
    return { ok: true, seal: sealed };
  }

  /** Whether each seal opens under the `team-policy` key and covers exactly this scope and text, on this
   *  Mac, at the scope's current stamp. Every failure is false — never a reason, which would be an oracle. */
  teamPolicySealed(items: readonly { scope: string; text: string; seal: string }[]): boolean[] {
    const machine = this.machine();
    return items.map((i) => {
      if (!this.available || !machine) return false;
      try {
        const text = open(this.key("team-policy"), "team-policy", i.seal);
        if (text === null) return false;
        const r = JSON.parse(text) as { scope?: unknown; text?: unknown; machine?: unknown; gen?: unknown };
        const stamp = this.stampOf(i.scope);
        return r.scope === i.scope && r.text === i.text && r.machine === machine && typeof stamp === "number" && r.gen === stamp;
      } catch {
        return false;
      }
    });
  }

  /** A tightening at this scope: move its stamp on, so an older seal there stops checking out. Never
   *  confirmed — putting a gate back must always be one click — and never prompts. */
  bumpTeamPolicy(scope: string): boolean {
    let gen: number | null = null;
    try { gen = this.d.policyStamp?.bump(scope) ?? null; } catch { gen = null; }
    this.stamps.delete(scope);
    if (gen !== null) this.stamps.set(scope, gen);
    return gen !== null;
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
    const keysBefore = file.keys.length;
    file.keys = file.keys.filter((k) => k.profileId !== profileId);
    const pruned = this.pruneAllows(file);
    const scope = unlockScopeKey({ kind: "profile", id: profileId });
    const hadPolicy = scope in file.unlock;
    delete file.unlock[scope];
    this.sessionUntil.delete(scope);
    const hadNever = profileId in file.neverSave;
    delete file.neverSave[profileId];
    const allows = Object.keys(file.fillAllow).filter((k) => k.startsWith(`${profileId}|`));
    for (const k of allows) delete file.fillAllow[k];
    if (hadPolicy || hadNever || allows.length > 0 || pruned || file.keys.length !== keysBefore || file.credentials.length + file.passkeys.length !== before) this.save();
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
    this.gestureUntil = 0;
    this.save();
    return file.presenceTtlMs;
  }

  /* ------------------------------------ audit ------------------------------------ */

  /** One JSONL line per fill attempt, whatever the outcome. Never throws: an unwritable log is a
   *  degraded audit trail, not a reason to fail a sign-in the user just approved with their
   *  fingerprint. */
  audit(entry: CredentialAuditEntry | PasskeyAuditEntry | UnlockAuditEntry | UnlockPolicyAuditEntry | VaultHttpAuditEntry | VaultAllowAuditEntry | TeamPolicyAuditEntry | RevealAuditEntry | PasswordStoreAuditEntry): void {
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

  /** The `remote` key (Plan 28): what seals this Mac's Realm Mobile identity, the private keys every
   *  paired phone has pinned. realm-server dials the relay and runs each phone's handshake, so it is
   *  what has to open them.
   *
   *  Null degrades the way machine's does: with no key the server writes no identity at all and
   *  reports Realm Mobile locked until a Realm that can unlock the keyring attaches. */
  exportRemoteKey(): string | null {
    if (!this.available) return null;
    try { return this.key("remote").toString("base64"); } catch { return null; }
  }

  /** The store Realm last could not read and kept aside, for Settings ▸ Passwords to say so once.
   *  Null when there is nothing to say. */
  unreadableNotice(): SetAside | null {
    return this.load().unreadable;
  }

  /** The person has read the notice. The file it named stays where it is. */
  dismissUnreadableNotice(): void {
    const file = this.load();
    if (!file.unreadable) return;
    file.unreadable = null;
    this.save();
  }

  /** Saved sign-ins this launch cannot open because macOS has not let Realm into the Keychain —
   *  refused, or not available yet. The file is as it was; Settings ▸ Passwords offers Try again. */
  keychainNeeded(): boolean {
    const file = this.load();
    return this.keys === null && file.keyring !== "";
  }

  /** Settings' Try again: read the file and ask the Keychain afresh. Whether it is still needed. */
  retryKeychain(): boolean {
    if (this.keys) return false;
    this.file = null;
    return this.keychainNeeded();
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
    let setAside: SetAside | null = null;
    if (raw !== null) {
      try { parsed = JSON.parse(raw) as Partial<StoreFile>; } catch { parsed = null; }
      // Not JSON, or JSON that is no store — an empty file included, which is what a write cut off
      // by a crash used to leave. Nothing in it can be read here, and that is not the same as
      // nothing being in it.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        parsed = null;
        setAside = this.setAside();
      }
    }
    const file: StoreFile = {
      version: FILE_VERSION,
      keyring: typeof parsed?.keyring === "string" ? parsed.keyring : "",
      credentials: Array.isArray(parsed?.credentials) ? parsed.credentials.filter(isStoredCredential) : [],
      passkeys: Array.isArray(parsed?.passkeys) ? parsed.passkeys.filter(isStoredPasskey) : [],
      presenceTtlMs: (CREDENTIAL_PRESENCE_TTLS as readonly number[]).includes(parsed?.presenceTtlMs as number)
        ? (parsed!.presenceTtlMs as number) : 0,
      unlock: readUnlockMap(parsed?.unlock),
      keys: Array.isArray(parsed?.keys) ? parsed.keys.filter(isStoredKey) : [],
      allow: readUnlockMap(parsed?.allow),
      neverSave: readSiteLists(parsed?.neverSave),
      fillAllow: readUnlockMap(parsed?.fillAllow),
      keychainEnabled: parsed?.keychainEnabled === true,
      unreadable: setAside ?? readSetAside(parsed?.unreadable),
    };
    this.file = file;
    // Written at once, so the notice outlives this launch even if no keyring can be minted yet.
    if (setAside) this.save();
    try {
      this.keys = this.unlockKeyring(file);
    } catch (e) {
      // Nothing was replaced; the next read starts again from the file.
      this.file = null;
      throw e;
    }
    this.unadopted = file.credentials.some((c) => c.profileId === undefined) || file.passkeys.some((p) => p.profileId === undefined);
    return file;
  }

  /**
   * Open the keyring, minting one on first run. A keyring that will not open (Keychain item deleted,
   * file copied from another Mac) is REPLACED with a fresh one and the credential rows that were
   * sealed under the old keys leave the store — they cannot be opened here, and keeping them would
   * mean a Settings list full of sign-ins that refuse at every fill with no way for the user to see
   * why. The file holding them is moved aside first, whole, never written over: the Keychain that
   * sealed them may still open it. OAuth rows degrade the same way on the server side, to
   * `unconfigured`; the recovery for both is the flow that created them.
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
          /* `machine`, `eggs`, `passkey`, `unlock`, the vault's two, `team-policy` and `remote` were each
             added after this keyring's shape was settled, and each is folded in the same way and for the
             reason above: a missing domain is a key to mint, never a corrupt keyring to discard. */
          const added: Record<string, string> = {};
          const fold = (name: "machine" | "eggs" | "passkey" | "unlock" | "vault-key" | "vault-allow" | "team-policy" | "fill-allow" | "remote"): Buffer => {
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
          const vaultKey = fold("vault-key");
          const vaultAllow = fold("vault-allow");
          const teamPolicy = fold("team-policy");
          const fillAllow = fold("fill-allow");
          const remote = fold("remote");
          if (Object.keys(added).length > 0) {
            file.keyring = this.d.safeStorage.encryptString(JSON.stringify({ ...json, ...added })).toString("base64");
            this.file = file;
            this.save();
          }
          return { oauth, credential, machine, eggs, passkey, unlock, "vault-key": vaultKey, "vault-allow": vaultAllow, "team-policy": teamPolicy, "fill-allow": fillAllow, remote };
        }
      } catch (e) {
        // Refused, or not ready: nothing is moved or replaced, and `retryKeychain` asks again.
        if (e instanceof Error && KEYCHAIN_SHUT.test(e.message)) return null;
        /* otherwise falls through to a fresh keyring */
      }
      file.unreadable = this.setAside();
      file.credentials = [];
      // Sealed under keys that are gone, so every assertion would refuse with no way for the user to
      // see why. Dropped for the same reason the credentials are, and recovered the same way: by
      // registering a new passkey from the site's own settings.
      file.passkeys = [];
      // Policies too: sealed under a key that is gone, every one would read as the default anyway,
      // and the default is what a fresh keyring means.
      file.unlock = {};
      // A team's keys and its allows were sealed under keys that are gone too, and go the same way.
      file.keys = [];
      file.allow = {};
      file.fillAllow = {};
    }
    const keys = {
      oauth: newSecretKey(), credential: newSecretKey(), machine: newSecretKey(),
      eggs: newSecretKey(), passkey: newSecretKey(), unlock: newSecretKey(),
      "vault-key": newSecretKey(), "vault-allow": newSecretKey(), "team-policy": newSecretKey(), "fill-allow": newSecretKey(), remote: newSecretKey(),
    };
    file.keyring = this.d.safeStorage
      .encryptString(JSON.stringify({
        oauth: keys.oauth.toString("base64"),
        credential: keys.credential.toString("base64"),
        machine: keys.machine.toString("base64"),
        eggs: keys.eggs.toString("base64"),
        passkey: keys.passkey.toString("base64"),
        unlock: keys.unlock.toString("base64"),
        "vault-key": keys["vault-key"].toString("base64"),
        "vault-allow": keys["vault-allow"].toString("base64"),
        "team-policy": keys["team-policy"].toString("base64"),
        "fill-allow": keys["fill-allow"].toString("base64"),
        remote: keys.remote.toString("base64"),
      }))
      .toString("base64");
    this.file = file;
    this.save();
    return keys;
  }

  /** Move the unreadable file aside, or throw so that nothing is written over it. */
  private setAside(): SetAside {
    if (!this.d.setAside) throw new SecretStoreError("Realm couldn't read your saved passwords, and left the file as it was.");
    return { path: this.d.setAside(), at: this.d.now() };
  }

  private save(): void {
    if (!this.file) return;
    this.d.writeFile(JSON.stringify(this.file, null, 2));
  }
}

function readSetAside(v: unknown): SetAside | null {
  const r = v as Partial<SetAside> | null | undefined;
  return typeof r?.path === "string" && typeof r.at === "number" ? { path: r.path, at: r.at } : null;
}

/** `BrowserCredential` from a stored row — the projection that drops `sealed`. Written as an
 *  explicit field list rather than `{ sealed, ...rest }` so that adding a field to the stored shape
 *  cannot silently start returning it. */
function strip(c: StoredCredential): BrowserCredential {
  return {
    id: c.id, origin: c.origin, username: c.username, label: c.label, createdAt: c.createdAt, generated: c.generated === true,
    ...(c.spaceId ? { spaceId: c.spaceId } : {}),
    ...(c.source === "imported" ? { source: "imported" as const } : {}),
  };
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
    && (c.spaceId === undefined || typeof c.spaceId === "string")
    && typeof c.id === "string" && typeof c.origin === "string" && typeof c.username === "string"
    && typeof c.label === "string" && typeof c.createdAt === "number"
    && (c.generated === undefined || typeof c.generated === "boolean")
    && (c.source === undefined || c.source === "imported")
    && typeof c.sealed === "string" && isSealed(c.sealed);
}

/** `neverSave` as read off disk: profile id → origins, anything else dropped. */
function readSiteLists(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[k] = list.filter((o): o is string => typeof o === "string");
  }
  return out;
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

/** `VaultKey` from a stored row — the projection that drops `sealed` and the owning profile. */
function stripKey(k: StoredKey): VaultKey {
  return { id: k.id, name: k.name, label: k.label, allowedHosts: [...k.allowedHosts], spaceId: k.spaceId, createdAt: k.createdAt };
}

function toAllow(r: AllowRecord): VaultAllow {
  return { secretId: r.secretId, roleId: r.roleId, spaceId: r.spaceId, hosts: [...r.hosts], grantAt: r.grantAt, setAt: r.setAt };
}

function isStoredKey(v: unknown): v is StoredKey {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.id === "string" && typeof k.profileId === "string" && typeof k.spaceId === "string"
    && typeof k.name === "string" && typeof k.label === "string" && typeof k.createdAt === "number"
    && Array.isArray(k.allowedHosts) && k.allowedHosts.every((h) => typeof h === "string")
    && typeof k.sealed === "string" && isSealed(k.sealed);
}
