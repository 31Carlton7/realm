import { describe, expect, it } from "vitest";
import { generatePassword, SecretStore, SecretStoreError, type SecretStoreDeps } from "./secret-store";
import { GENERATED_PASSWORD_LENGTH, GENERATED_PASSWORD_MAX_LENGTH, GENERATED_PASSWORD_MIN_LENGTH } from "@realm/contracts";

/**
 * The store's mutants:
 *   - a credential value readable back out (a getter, a list field, the file on disk);
 *   - presence not required, or required only on the first fill;
 *   - a denied Touch ID opening the TTL window anyway;
 *   - a plaintext fallback when safeStorage is unavailable;
 *   - the credential key exportable alongside the oauth one;
 *   - an audit line missing, or carrying the value;
 *   - a GENERATED password minted before presence, minted with nowhere to keep it, or typed before the
 *     row that holds it was written.
 */

const SECRET = "correct horse battery staple";
/** The profile every test below saves into unless it says otherwise — and the one that inherits rows
 *  written before sign-ins were a profile's own. */
const P = "pPersonal";
/** Another profile, which must see none of P's rows until one is shared with it. */
const WORK = "pWork";

/** safeStorage stood in for: a reversible wrapper, NOT real crypto. What is under test is that the
 *  store seals credential values with its own AES key before they reach the file — a fake that
 *  actually encrypted would hide a store that forgot to. */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("kc:")) throw new Error("not ours");
      return s.slice(3);
    },
  };
}

function makeStore(over: Partial<SecretStoreDeps> & { available?: boolean } = {}) {
  const disk = { file: null as string | null, audit: [] as string[] };
  const clock = { now: 1_000_000 };
  const presence = { asked: [] as string[], grant: true };
  let n = 0;
  const deps: SecretStoreDeps = {
    safeStorage: fakeSafeStorage(over.available ?? true),
    readFile: () => disk.file,
    writeFile: (t) => { disk.file = t; },
    appendAudit: (l) => { disk.audit.push(l); },
    promptPresence: async (reason) => { presence.asked.push(reason); return presence.grant; },
    now: () => clock.now,
    newId: () => `cred-${++n}`,
    defaultProfileId: () => P,
    ...over,
  };
  return { store: new SecretStore(deps), disk, clock, presence, deps };
}

const input = (over: Partial<{ origin: string; username: string; label: string; value: string }> = {}) => ({
  origin: "https://example.com", username: "ada", label: "Work", value: SECRET, ...over,
});

describe("SecretStore — enrollment", () => {
  it("stores a credential and answers with metadata that has NO field for the value", () => {
    const { store } = makeStore();
    const row = store.addCredential(P, input());
    expect(row).toEqual({ id: "cred-1", origin: "https://example.com", username: "ada", label: "Work", createdAt: 1_000_000, generated: false });
    expect(Object.keys(row)).not.toContain("sealed");
    expect(JSON.stringify(store.listCredentials(P))).not.toContain(SECRET);
  });

  it("the FILE on disk holds no plaintext value (mutant: sealing skipped)", () => {
    const { store, disk } = makeStore();
    store.addCredential(P, input());
    expect(disk.file).not.toBeNull();
    expect(disk.file).not.toContain(SECRET);
  });

  it("normalizes the origin on the way in, so the exact-match gate compares like with like", () => {
    const { store } = makeStore();
    expect(store.addCredential(P, input({ origin: "https://EXAMPLE.com:443/login?next=1" })).origin).toBe("https://example.com");
  });

  it("refuses an address it cannot pin a sign-in to, rather than storing a credential that fills nowhere", () => {
    const { store } = makeStore();
    for (const origin of ["example.com", "about:blank", "file:///etc/passwd", "", "javascript:alert(1)"]) {
      expect(() => store.addCredential(P, input({ origin })), origin).toThrow(SecretStoreError);
    }
    expect(store.listCredentials(P)).toEqual([]);
  });

  it("with safeStorage unavailable it enrolls NOTHING — there is no plaintext fallback", () => {
    const { store, disk } = makeStore({ available: false });
    expect(() => store.addCredential(P, input())).toThrow(SecretStoreError);
    expect(store.listCredentials(P)).toEqual([]);
    expect(disk.file ?? "").not.toContain(SECRET);
  });

  it("removeCredential reports honestly whether anything was there", () => {
    const { store } = makeStore();
    const row = store.addCredential(P, input());
    expect(store.removeCredential(P, "nope")).toBe(false);
    expect(store.removeCredential(P, row.id)).toBe(true);
    expect(store.listCredentials(P)).toEqual([]);
  });
});

describe("SecretStore — the one door out", () => {
  it("hands the value to the callback and returns NOTHING that contains it", async () => {
    const { store } = makeStore();
    const row = store.addCredential(P, input());
    let seen: string | null = null;
    const result = await store.withCredentialValue(P, row.id, async (v) => { seen = v; });

    expect(seen).toBe(SECRET);
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("requires presence BEFORE unsealing, and a refusal types nothing (mutant: presence not required)", async () => {
    const { store, presence } = makeStore();
    const row = store.addCredential(P, input());
    presence.grant = false;
    let called = false;
    const result = await store.withCredentialValue(P, row.id, async () => { called = true; });

    expect(result).toEqual({ ok: false, refused: "no_presence" });
    expect(called).toBe(false);
    expect(presence.asked).toHaveLength(1);
    // The prompt names who and where — the user is authorizing a specific sign-in, not "an action".
    expect(presence.asked[0]).toContain("ada");
    expect(presence.asked[0]).toContain("https://example.com");
    expect(presence.asked[0]).not.toContain(SECRET);
  });

  it("an unknown id refuses without prompting", async () => {
    const { store, presence } = makeStore();
    expect(await store.withCredentialValue(P, "ghost", async () => {})).toEqual({ ok: false, refused: "no_credential" });
    expect(presence.asked).toHaveLength(0);
  });

  it("prompts on EVERY fill by default (mutant: presence checked once and remembered)", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(P, input());
    await store.withCredentialValue(P, row.id, async () => {});
    clock.now += 1;
    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("a TTL lets a second fill through inside the window, and prompts again past it", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(P, input());
    store.setPresenceTtlMs(60_000);

    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(1);

    clock.now += 30_000;                       // inside the window: the SSO second field
    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(1);

    clock.now += 60_000;                       // past it
    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("a DENIED check opens no window (mutant: the TTL set before the answer is known)", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(P, input());
    store.setPresenceTtlMs(60_000);

    presence.grant = false;
    expect(await store.withCredentialValue(P, row.id, async () => {})).toEqual({ ok: false, refused: "no_presence" });
    clock.now += 1;
    presence.grant = true;
    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(2); // the denial did not license the next one
  });

  it("shortening the TTL takes effect immediately rather than after the old window expires", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(P, input());
    store.setPresenceTtlMs(300_000);
    await store.withCredentialValue(P, row.id, async () => {});
    store.setPresenceTtlMs(0);
    clock.now += 1;
    await store.withCredentialValue(P, row.id, async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("clamps an out-of-range TTL to 'every time' rather than to something longer than the UI offers", () => {
    const { store } = makeStore();
    expect(store.setPresenceTtlMs(86_400_000)).toBe(0);
    expect(store.setPresenceTtlMs(-1)).toBe(0);
    expect(store.setPresenceTtlMs(60_000)).toBe(60_000);
  });

  it("a promptPresence that THROWS is a denial, never an approval (fail closed)", async () => {
    const { store } = makeStore({ promptPresence: () => Promise.reject(new Error("LAContext exploded")) });
    const row = store.addCredential(P, input());
    expect(await store.withCredentialValue(P, row.id, async () => {})).toEqual({ ok: false, refused: "no_presence" });
  });
});

describe("SecretStore — generated passwords", () => {
  const ask = (over: Partial<{ origin: string; username: string; label: string; length: number; symbols: boolean }> = {}) => ({
    origin: "https://example.com", username: "ada", label: "Sign-up", length: GENERATED_PASSWORD_LENGTH, symbols: true, ...over,
  });

  it("mints a value, keeps it, types it, and returns metadata with no field for it", async () => {
    const { store, disk } = makeStore();
    let typed: string | null = null;
    const minted = await store.withGeneratedCredentialValue(P, ask(), async (v) => { typed = v; });

    expect(minted.ok).toBe(true);
    expect(typed).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect(minted.ok && minted.credential).toEqual({
      id: "cred-1", origin: "https://example.com", username: "ada", label: "Sign-up",
      createdAt: 1_000_000, generated: true,
    });
    // The value reached the callback and nothing else: not the resolution, not the list, not the file.
    expect(JSON.stringify(minted)).not.toContain(typed!);
    expect(JSON.stringify(store.listCredentials(P))).not.toContain(typed!);
    expect(disk.file).not.toContain(typed!);
  });

  it("is fillable afterwards by id, from a store reopened over the same file — the confirm-field case", async () => {
    const { store, disk, deps } = makeStore();
    let typed: string | null = null;
    const minted = await store.withGeneratedCredentialValue(P, ask(), async (v) => { typed = v; });

    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    let refilled: string | null = null;
    expect(await reopened.withCredentialValue(P, (minted as { credential: { id: string } }).credential.id, async (v) => { refilled = v; })).toEqual({ ok: true });
    expect(refilled).toBe(typed);
  });

  it("two mints for the same origin are different passwords (mutant: a fixed or derived value)", async () => {
    const { store } = makeStore();
    const seen: string[] = [];
    await store.withGeneratedCredentialValue(P, ask(), async (v) => { seen.push(v); });
    await store.withGeneratedCredentialValue(P, ask(), async (v) => { seen.push(v); });
    expect(seen[0]).not.toBe(seen[1]);
    expect(store.listCredentials(P)).toHaveLength(2);
  });

  it("asks for presence BEFORE minting, and a cancelled check creates nothing", async () => {
    const { store, presence } = makeStore();
    presence.grant = false;
    let typed = false;
    expect(await store.withGeneratedCredentialValue(P, ask(), async () => { typed = true; })).toEqual({ ok: false, refused: "no_presence" });
    expect(typed).toBe(false);
    expect(store.listCredentials(P)).toEqual([]);
    expect(presence.asked).toEqual(["create and fill a new saved password for ada on https://example.com"]);
  });

  it("with safeStorage unavailable it refuses no_store WITHOUT prompting — a password Realm cannot keep is never typed", async () => {
    const { store, presence } = makeStore({ available: false });
    let typed = false;
    expect(await store.withGeneratedCredentialValue(P, ask(), async () => { typed = true; })).toEqual({ ok: false, refused: "no_store" });
    expect(typed).toBe(false);
    expect(presence.asked).toEqual([]);
    expect(store.listCredentials(P)).toEqual([]);
  });

  it("refuses an origin it cannot pin a sign-in to, and normalizes the one it can", async () => {
    const { store } = makeStore();
    expect(await store.withGeneratedCredentialValue(P, ask({ origin: "about:blank" }), async () => {})).toEqual({ ok: false, refused: "no_store" });
    const minted = await store.withGeneratedCredentialValue(P, ask({ origin: "https://EXAMPLE.com:443/signup" }), async () => {});
    expect(minted.ok && minted.credential.origin).toBe("https://example.com");
  });

  it("writes the row BEFORE typing, so a fill that fails leaves a password the user can find", async () => {
    // The order that matters: the other way round, a failed fill would leave the page holding a secret
    // nothing on this Mac has, and the account would only be reachable by the site's reset.
    const { store } = makeStore();
    await expect(store.withGeneratedCredentialValue(P, ask(), async () => { throw new Error("CDP went away"); })).rejects.toThrow();
    expect(store.listCredentials(P)).toHaveLength(1);
    expect(store.listCredentials(P)[0]!.generated).toBe(true);
  });

  it("marks the row generated, and an enrolled one not — the distinction Settings shows the user", async () => {
    const { store } = makeStore();
    store.addCredential(P, input());
    await store.withGeneratedCredentialValue(P, ask(), async () => {});
    expect(store.listCredentials(P).map((c) => c.generated)).toEqual([false, true]);
  });

  it("a row written before `generated` existed still loads, as an enrolled one", () => {
    const { store, disk, deps } = makeStore();
    store.addCredential(P, input());
    const shipped = JSON.parse(disk.file!) as { credentials: Record<string, unknown>[] };
    delete shipped.credentials[0]!.generated;
    const reopened = new SecretStore({ ...deps, readFile: () => JSON.stringify(shipped) });
    // The trap this guards: a required field drops every sign-in enrolled before the update.
    expect(reopened.listCredentials(P)).toHaveLength(1);
    expect(reopened.listCredentials(P)[0]!.generated).toBe(false);
  });

  it("shared into another profile, a generated row is still marked generated there", async () => {
    // THE mutant: the copy built from an explicit field list that leaves `generated` out — the other
    // profile's Settings would show a password nobody has seen as one the user typed.
    const { store } = makeStore();
    const minted = await store.withGeneratedCredentialValue(P, ask(), async () => {});
    const id = (minted as { credential: { id: string } }).credential.id;
    expect(store.shareCredential(P, id, "pWork")?.generated).toBe(true);
    expect(store.listCredentials("pWork").map((c) => c.generated)).toEqual([true]);
  });

  it("is the minting profile's own: another profile neither lists it nor fills it", async () => {
    // THE mutant: a generated row written without the profile, or under another — the per-profile
    // jar that keeps Work's agents off Personal's sign-ins would leak through the one door a
    // model can open.
    const { store } = makeStore();
    const minted = await store.withGeneratedCredentialValue(P, ask(), async () => {});
    const id = (minted as { credential: { id: string } }).credential.id;
    expect(store.listCredentials("pWork")).toEqual([]);
    expect(await store.withCredentialValue("pWork", id, async () => {})).toEqual({ ok: false, refused: "no_credential" });
    expect(store.listCredentials(P).map((c) => c.id)).toEqual([id]);
  });
});

describe("generatePassword", () => {
  it("honors the length asked for, within the bounds the schema offers", () => {
    expect(generatePassword(GENERATED_PASSWORD_MIN_LENGTH, true)).toHaveLength(GENERATED_PASSWORD_MIN_LENGTH);
    expect(generatePassword(32, true)).toHaveLength(32);
  });

  it("clamps a length the schema would have refused, rather than looping forever on a short one", () => {
    expect(generatePassword(1, true)).toHaveLength(GENERATED_PASSWORD_MIN_LENGTH);
    expect(generatePassword(9_000, true)).toHaveLength(GENERATED_PASSWORD_MAX_LENGTH);
  });

  it("always includes every class it draws from, because sites enforce class rules", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword(GENERATED_PASSWORD_MIN_LENGTH, true);
      expect(password, password).toMatch(/[a-z]/);
      expect(password, password).toMatch(/[A-Z]/);
      expect(password, password).toMatch(/[0-9]/);
      expect(password, password).toMatch(/[-_.!@#$%&*+=?]/);
    }
  });

  it("omits punctuation entirely when the site rejects it (mutant: symbols ignored)", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword(20, false);
      expect(password, password).toMatch(/^[A-Za-z0-9]+$/);
      expect(password, password).toMatch(/[0-9]/);
    }
  });
});

describe("SecretStore — persistence and the keyring", () => {
  it("a second store over the same file opens the same credential", async () => {
    const { store, disk, deps } = makeStore();
    const row = store.addCredential(P, input());

    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    expect(reopened.listCredentials(P)).toEqual([row]);
    let seen: string | null = null;
    await reopened.withCredentialValue(P, row.id, async (v) => { seen = v; });
    expect(seen).toBe(SECRET);
  });

  it("a keyring the OS will no longer open DROPS the rows it sealed, rather than listing sign-ins that refuse forever", () => {
    const { store, disk, deps } = makeStore();
    store.addCredential(P, input());
    expect(store.listCredentials(P)).toHaveLength(1);

    // The real scenario: the file restored onto another Mac, whose Keychain has no matching item.
    const foreign = new SecretStore({
      ...deps,
      readFile: () => disk.file,
      safeStorage: { ...fakeSafeStorage(), decryptString: () => { throw new Error("item not found"); } },
    });
    expect(foreign.listCredentials(P)).toEqual([]);
    // ...and it is usable again immediately, with a fresh keyring rather than a wedged one.
    expect(foreign.addCredential(P, input({ value: "new" })).origin).toBe("https://example.com");
  });

  it("a corrupt file degrades to an empty store instead of throwing on every read", () => {
    const { deps } = makeStore();
    const store = new SecretStore({ ...deps, readFile: () => "{ not json" });
    expect(store.listCredentials(P)).toEqual([]);
  });
});

describe("SecretStore — the key handoff and the audit log", () => {
  it("exports the oauth key and has NO method that exports the credential key (mutant: a sibling getter)", () => {
    const { store } = makeStore();
    const key = store.exportOauthKey();
    expect(typeof key).toBe("string");
    expect(Buffer.from(key!, "base64")).toHaveLength(32);
    // Structural, not cosmetic: realm-server reaches this class through a bridge op that calls
    // `exportOauthKey`. If a `exportCredentialKey` ever appears, one bridge op away is a server that
    // can open credential blobs, and this assertion is where that lands.
    expect(Object.getOwnPropertyNames(SecretStore.prototype)).not.toContain("exportCredentialKey");
    expect(Object.getOwnPropertyNames(SecretStore.prototype).filter((m) => /credential/i.test(m) && /key|export|reveal|value/i.test(m)))
      .toEqual(["withCredentialValue", "withGeneratedCredentialValue"]);
  });

  it("with no encryption available there is no key to hand out — realm-server keeps its old plaintext posture", () => {
    const { store } = makeStore({ available: false });
    expect(store.exportOauthKey()).toBeNull();
    expect(store.exportMachineKey()).toBeNull();
    expect(store.exportEggsKey()).toBeNull();
  });

  it("exports the machine key too, and it is a DIFFERENT key from oauth's", () => {
    const { store } = makeStore();
    const machine = store.exportMachineKey();
    expect(Buffer.from(machine!, "base64")).toHaveLength(32);
    // Separate domains with separate keys is what makes `secret-box`'s AAD binding worth anything:
    // one key for both would let a machine's box open an oauth blob, which is the whole property the
    // domain byte exists to deny.
    expect(machine).not.toBe(store.exportOauthKey());
    /* …and the credential key is STILL not exported. The list is enumerated rather than counted so
       that adding an export is a deliberate edit to this line: `exportEggsKey` (the word that
       unlocks a friend pack) joined it on purpose, and the one that must never appear is a
       credential key — one bridge op away from a server that can open somebody's saved sign-ins. */
    expect(Object.getOwnPropertyNames(SecretStore.prototype).filter((m) => m.startsWith("export")).sort())
      .toEqual(["exportEggsKey", "exportMachineKey", "exportOauthKey"]);
    expect(store.exportEggsKey()).not.toBe(machine);
    expect(store.exportEggsKey()).not.toBe(store.exportOauthKey());
  });

  /* The upgrade that would otherwise have been silent data loss. `machine` is a domain added after
     the keyring's shape was settled, so an existing keyring carries only two keys. Treating that as
     a corrupt keyring — which requiring all three would do — runs the reset branch, and the reset
     branch empties the credential list. Every enrolled sign-in gone on first launch after an update,
     for a feature the user had not touched yet. */
  it("adopts a keyring written before the machine domain existed, without dropping a credential", async () => {
    const { store, disk, deps } = makeStore();
    store.addCredential(P, input());
    expect(store.listCredentials(P)).toHaveLength(1);

    // Rewind the stored keyring to its two-key shape, exactly as an older build wrote it.
    const file = JSON.parse(disk.file!) as { keyring: string };
    const json = JSON.parse(deps.safeStorage.decryptString(Buffer.from(file.keyring, "base64"))) as Record<string, string>;
    delete json.machine;
    file.keyring = deps.safeStorage.encryptString(JSON.stringify(json)).toString("base64");
    disk.file = JSON.stringify(file);

    const upgraded = new SecretStore({ ...deps, readFile: () => disk.file, writeFile: (t) => { disk.file = t; } });
    expect(upgraded.listCredentials(P), "the enrolled sign-in survived the upgrade").toHaveLength(1);
    // …and the pre-existing key still opens what it sealed, so nothing was re-keyed behind the user.
    let seen: string | null = null;
    await upgraded.withCredentialValue(P, upgraded.listCredentials(P)[0]!.id, async (v) => { seen = v; });
    expect(seen).toBe(SECRET);
    // The third key exists now, and is genuinely new rather than a copy of one already there.
    const machine = upgraded.exportMachineKey();
    expect(Buffer.from(machine!, "base64")).toHaveLength(32);
    expect(machine).not.toBe(upgraded.exportOauthKey());
  });

  it("writes one audit line of exactly timestamp, origin, credentialId, outcome — and never the value", () => {
    const { store, disk } = makeStore();
    store.audit({ ts: 1_000_000, origin: "https://example.com", credentialId: "cred-1", outcome: "filled" });
    expect(disk.audit).toHaveLength(1);
    expect(JSON.parse(disk.audit[0]!)).toEqual({ ts: 1_000_000, origin: "https://example.com", credentialId: "cred-1", outcome: "filled" });
    expect(disk.audit[0]).not.toContain(SECRET);
    expect(disk.audit[0]!.endsWith("\n")).toBe(true);
  });

  it("an unwritable audit log never fails the caller — a degraded trail, not a broken sign-in", () => {
    const { store } = makeStore({ appendAudit: () => { throw new Error("read-only volume"); } });
    expect(() => store.audit({ ts: 1, origin: "https://example.com", credentialId: "c", outcome: "filled" })).not.toThrow();
  });
});

/**
 * The passkey half's mutants:
 *   - a private key readable back out (a getter, a list field, the file on disk);
 *   - presence not required for an assertion, or required only the first time;
 *   - a `get` for a site with no passkey raising a Touch ID prompt that can only fail;
 *   - the signature counter not written back, or written backwards;
 *   - a keyring adopted from before the passkey domain existed dropping the credentials beside it.
 */
const PRIVATE_KEY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg-not-a-real-key";

const passkey = (over: Partial<Parameters<SecretStore["recordPasskey"]>[1]> = {}) => ({
  rpId: "github.com", userName: "ada", userDisplayName: "Ada Lovelace",
  credentialId: "Y3JlZC0x", userHandle: "dXNlci0x", signCount: 1, privateKey: PRIVATE_KEY, ...over,
});

describe("SecretStore — passkeys", () => {
  it("records one and answers with metadata that has NO field for the private key", () => {
    const { store, disk } = makeStore();
    const row = store.recordPasskey(P, passkey());
    expect(row).toEqual({
      id: "cred-1", rpId: "github.com", userName: "ada", userDisplayName: "Ada Lovelace",
      createdAt: 1_000_000, lastUsedAt: null,
    });
    expect(Object.keys(row)).not.toContain("sealed");
    expect(JSON.stringify(store.listPasskeys(P))).not.toContain(PRIVATE_KEY);
    // …and the mutant this really guards: sealing skipped on the way to the file.
    expect(disk.file).not.toContain(PRIVATE_KEY);
  });

  it("hands the key to the callback and returns NOTHING that contains it", async () => {
    const { store } = makeStore();
    store.recordPasskey(P, passkey());
    const seen: string[] = [];
    const result = await store.withPasskeysFor(P, "github.com", "get", async (keys) => {
      for (const k of keys) seen.push(k.privateKey);
    });
    expect(seen).toEqual([PRIVATE_KEY]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("requires presence BEFORE unsealing, and a refusal hands over nothing", async () => {
    const { store, presence } = makeStore();
    store.recordPasskey(P, passkey());
    presence.grant = false;
    let called = false;
    const result = await store.withPasskeysFor(P, "github.com", "get", async () => { called = true; });
    expect(result).toEqual({ ok: false, refused: "no_presence" });
    expect(called).toBe(false);
    expect(presence.asked).toEqual(["use your passkey for github.com"]);
  });

  it("a `get` for a site with no passkey refuses WITHOUT prompting (a prompt that can only fail teaches the wrong reflex)", async () => {
    const { store, presence } = makeStore();
    store.recordPasskey(P, passkey({ rpId: "example.com" }));
    const result = await store.withPasskeysFor(P, "github.com", "get", async () => {});
    expect(result).toEqual({ ok: false, refused: "no_passkey" });
    expect(presence.asked).toEqual([]);
  });

  it("a `create` with nothing stored still prompts — that is what registering a first passkey looks like", async () => {
    const { store, presence } = makeStore();
    let handed: unknown[] = [];
    const result = await store.withPasskeysFor(P, "github.com", "create", async (keys) => { handed = keys; });
    expect(result).toEqual({ ok: true });
    expect(handed).toEqual([]);
    expect(presence.asked).toEqual(["create a passkey for github.com"]);
  });

  it("hands over only the keys for the rp asked about (mutant: the filter dropped)", async () => {
    const { store } = makeStore();
    store.recordPasskey(P, passkey({ rpId: "github.com", credentialId: "a" }));
    store.recordPasskey(P, passkey({ rpId: "example.com", credentialId: "b" }));
    const seen: string[] = [];
    await store.withPasskeysFor(P, "github.com", "get", async (keys) => {
      for (const k of keys) seen.push(k.credentialId);
    });
    expect(seen).toEqual(["a"]);
  });

  it("prompts on EVERY use by default (mutant: presence checked once and remembered)", async () => {
    const { store, presence } = makeStore();
    store.recordPasskey(P, passkey());
    await store.withPasskeysFor(P, "github.com", "get", async () => {});
    await store.withPasskeysFor(P, "github.com", "get", async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("shares the ONE presence window with saved sign-ins rather than keeping a second nobody configured", async () => {
    const { store, presence } = makeStore();
    store.setPresenceTtlMs(60_000);
    const cred = store.addCredential(P, input());
    store.recordPasskey(P, passkey());
    await store.withCredentialValue(P, cred.id, async () => {});
    await store.withPasskeysFor(P, "github.com", "get", async () => {});
    expect(presence.asked).toHaveLength(1);
  });

  it("writes the signature counter back, and never backwards (a counter that goes back reads as a cloned authenticator)", async () => {
    const { store, disk, clock, deps } = makeStore();
    store.recordPasskey(P, passkey({ signCount: 1 }));
    clock.now = 2_000_000;
    store.notePasskeyUse(P, "Y3JlZC0x", 7);
    expect(store.listPasskeys(P)[0]!.lastUsedAt).toBe(2_000_000);

    // A stale report from a pane whose keys were cleared mid-request must not undo a later assertion.
    store.notePasskeyUse(P, "Y3JlZC0x", 3);

    // The counter is only ever read where it is used, so read it there: a cold store over the same
    // file, handing the key to an authenticator.
    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    let restored = -1;
    await reopened.withPasskeysFor(P, "github.com", "get", async (keys) => { restored = keys[0]!.signCount; });
    expect(restored).toBe(7);
  });

  it("a re-registration REPLACES the credential of the same id rather than stacking a key the site has forgotten", () => {
    const { store } = makeStore();
    store.recordPasskey(P, passkey({ userName: "old" }));
    store.recordPasskey(P, passkey({ userName: "new" }));
    expect(store.listPasskeys(P)).toHaveLength(1);
    expect(store.listPasskeys(P)[0]!.userName).toBe("new");
  });

  it("clips the two relying-party-authored strings on the way IN", () => {
    const { store } = makeStore();
    const row = store.recordPasskey(P, passkey({ userName: "x".repeat(400), userDisplayName: "y".repeat(400) }));
    expect(row.userName).toHaveLength(128);
    expect(row.userDisplayName).toHaveLength(128);
  });

  it("hasPasskeyFor answers without a prompt — it is what decides whether to raise one at all", () => {
    const { store, presence } = makeStore();
    store.recordPasskey(P, passkey());
    expect(store.hasPasskeyFor(P, "github.com")).toBe(true);
    expect(store.hasPasskeyFor(P, "example.com")).toBe(false);
    expect(presence.asked).toEqual([]);
  });

  it("removePasskey reports honestly whether anything was there", () => {
    const { store } = makeStore();
    const row = store.recordPasskey(P, passkey());
    expect(store.removePasskey(P, row.id)).toBe(true);
    expect(store.removePasskey(P, row.id)).toBe(false);
    expect(store.listPasskeys(P)).toEqual([]);
  });

  it("a second store over the same file opens the same passkey", async () => {
    const { store, disk, deps } = makeStore();
    store.recordPasskey(P, passkey());
    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    const seen: string[] = [];
    await reopened.withPasskeysFor(P, "github.com", "get", async (keys) => {
      for (const k of keys) seen.push(k.privateKey);
    });
    expect(seen).toEqual([PRIVATE_KEY]);
  });

  it("with safeStorage unavailable it stores NOTHING — there is no plaintext fallback", () => {
    const { store } = makeStore({ available: false });
    expect(() => store.recordPasskey(P, passkey())).toThrow(SecretStoreError);
  });

  it("adopts a keyring written before the passkey domain existed, WITHOUT dropping the credentials beside it", async () => {
    const { store, disk, deps } = makeStore();
    const cred = store.addCredential(P, input());
    // Rewrite the keyring as an older Realm would have: no `passkey` key at all.
    const file = JSON.parse(disk.file!) as { keyring: string };
    const ring = JSON.parse(deps.safeStorage.decryptString(Buffer.from(file.keyring, "base64"))) as Record<string, string>;
    delete ring.passkey;
    file.keyring = deps.safeStorage.encryptString(JSON.stringify(ring)).toString("base64");
    disk.file = JSON.stringify(file);

    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    let filled = "";
    expect(await reopened.withCredentialValue(P, cred.id, async (v) => { filled = v; })).toEqual({ ok: true });
    expect(filled).toBe(SECRET);
    // …and the freshly minted key works for what it was minted for.
    expect(reopened.recordPasskey(P, passkey())).toMatchObject({ rpId: "github.com" });
  });

  it("a keyring the OS will no longer open DROPS the passkeys it sealed rather than listing keys that refuse forever", () => {
    const { store, disk, deps } = makeStore();
    store.recordPasskey(P, passkey());
    const file = JSON.parse(disk.file!) as { keyring: string };
    file.keyring = Buffer.from("not ours at all", "utf8").toString("base64");
    disk.file = JSON.stringify(file);
    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    expect(reopened.listPasskeys(P)).toEqual([]);
  });
});

/**
 * Plan 27 Phase 2: sign-ins and passkeys are a profile's own. The mutants:
 *   - a profile reading, filling or removing another profile's row;
 *   - a share that MOVES the row instead of copying it, or stacks duplicates on a second share;
 *   - a shared passkey whose copies count signatures apart (the site would read the second as a clone);
 *   - rows from before profiles left unadopted, dropped on the next save, or adopted twice.
 */
describe("SecretStore — a profile's own", () => {
  it("a sign-in saved in one profile is invisible to another — listed, looked up and filled alike", async () => {
    const { store, presence } = makeStore();
    const row = store.addCredential(P, input());
    expect(store.listCredentials(WORK)).toEqual([]);
    expect(store.getCredential(WORK, row.id)).toBeNull();
    // Refused as an id that does not exist, and before the prompt: no Touch ID for a fill that
    // could never have been allowed.
    expect(await store.withCredentialValue(WORK, row.id, async () => {})).toEqual({ ok: false, refused: "no_credential" });
    expect(presence.asked).toEqual([]);
    expect(store.removeCredential(WORK, row.id)).toBe(false);
    expect(store.listCredentials(P)).toEqual([row]);
  });

  it("sharing COPIES a sign-in into the other profile — the original stays, and each removes alone", async () => {
    const { store } = makeStore();
    const mine = store.addCredential(P, input());
    const copy = store.shareCredential(P, mine.id, WORK)!;
    expect(copy).toMatchObject({ origin: "https://example.com", username: "ada", label: "Work" });
    expect(copy.id).not.toBe(mine.id);
    expect(store.listCredentials(P)).toEqual([mine]);
    expect(store.listCredentials(WORK)).toEqual([copy]);
    // The copy opens to the same secret, in the profile it was shared into.
    let seen = "";
    expect(await store.withCredentialValue(WORK, copy.id, async (v) => { seen = v; })).toEqual({ ok: true });
    expect(seen).toBe(SECRET);
    expect(store.removeCredential(P, mine.id)).toBe(true);
    expect(store.listCredentials(WORK)).toEqual([copy]);
  });

  it("sharing the same account again brings the copy up to date rather than adding a second row", async () => {
    const { store } = makeStore();
    const first = store.addCredential(P, input({ value: "old" }));
    const copy = store.shareCredential(P, first.id, WORK)!;
    const newer = store.addCredential(P, input({ value: "new", label: "Renewed" }));
    const again = store.shareCredential(P, newer.id, WORK)!;
    expect(again.id).toBe(copy.id);
    expect(store.listCredentials(WORK)).toHaveLength(1);
    expect(store.listCredentials(WORK)[0]!.label).toBe("Renewed");
    let seen = "";
    await store.withCredentialValue(WORK, copy.id, async (v) => { seen = v; });
    expect(seen).toBe("new");
  });

  it("a share from the wrong profile, of nothing, or into the same profile copies nothing", () => {
    const { store } = makeStore();
    const mine = store.addCredential(P, input());
    expect(store.shareCredential(WORK, mine.id, "pSchool")).toBeNull();
    expect(store.shareCredential(P, "ghost", WORK)).toBeNull();
    expect(store.shareCredential(P, mine.id, P)).toBeNull();
    expect(store.listCredentials(WORK)).toEqual([]);
    expect(store.listCredentials("pSchool")).toEqual([]);
    expect(store.listCredentials(P)).toHaveLength(1);
  });

  it("a passkey is the profile's own: another profile is told it has none, without a prompt", async () => {
    const { store, presence } = makeStore();
    store.recordPasskey(P, passkey());
    expect(store.hasPasskeyFor(WORK, "github.com")).toBe(false);
    expect(store.listPasskeys(WORK)).toEqual([]);
    expect(await store.withPasskeysFor(WORK, "github.com", "get", async () => {})).toEqual({ ok: false, refused: "no_passkey" });
    expect(presence.asked).toEqual([]);
  });

  it("sharing a passkey copies the key; a second share adds nothing; removing one copy leaves the other", async () => {
    const { store } = makeStore();
    const mine = store.recordPasskey(P, passkey());
    const copy = store.sharePasskey(P, mine.id, WORK)!;
    expect(copy).toMatchObject({ rpId: "github.com", userName: "ada", lastUsedAt: null });
    expect(store.sharePasskey(P, mine.id, WORK)!.id).toBe(copy.id);
    expect(store.listPasskeys(WORK)).toHaveLength(1);
    const keys: string[] = [];
    await store.withPasskeysFor(WORK, "github.com", "get", async (k) => { for (const x of k) keys.push(x.privateKey); });
    expect(keys).toEqual([PRIVATE_KEY]);
    expect(store.removePasskey(P, mine.id)).toBe(true);
    expect(store.listPasskeys(WORK)).toEqual([copy]);
  });

  it("a shared passkey's copies count signatures TOGETHER — the site sees one authenticator", async () => {
    const { store, clock } = makeStore();
    const mine = store.recordPasskey(P, passkey({ signCount: 1 }));
    store.sharePasskey(P, mine.id, WORK);
    clock.now = 2_000_000;
    store.notePasskeyUse(WORK, "Y3JlZC0x", 7);
    // Personal's copy must start from 7 next time, or its assertion would read as a cloned key.
    let next = -1;
    await store.withPasskeysFor(P, "github.com", "get", async (k) => { next = k[0]!.signCount; });
    expect(next).toBe(7);
    // …but only the profile that used it is told it was used.
    expect(store.listPasskeys(WORK)[0]!.lastUsedAt).toBe(2_000_000);
    expect(store.listPasskeys(P)[0]!.lastUsedAt).toBeNull();
    // A profile that does not hold the key cannot move its counter.
    store.notePasskeyUse("pSchool", "Y3JlZC0x", 99);
    await store.withPasskeysFor(P, "github.com", "get", async (k) => { next = k[0]!.signCount; });
    expect(next).toBe(7);
  });

  it("a re-registration replaces the key within its profile, and leaves another profile's shared copy", () => {
    const { store } = makeStore();
    const mine = store.recordPasskey(P, passkey({ userName: "old" }));
    store.sharePasskey(P, mine.id, WORK);
    store.recordPasskey(P, passkey({ userName: "new" }));
    expect(store.listPasskeys(P).map((p) => p.userName)).toEqual(["new"]);
    expect(store.listPasskeys(WORK).map((p) => p.userName)).toEqual(["old"]);
  });

  it("forgetProfile takes a deleted profile's rows, and leaves the copies it shared", () => {
    const { store } = makeStore();
    const mine = store.addCredential(WORK, input());
    store.shareCredential(WORK, mine.id, P);
    store.recordPasskey(WORK, passkey());
    store.forgetProfile(WORK);
    expect(store.listCredentials(WORK)).toEqual([]);
    expect(store.listPasskeys(WORK)).toEqual([]);
    expect(store.listCredentials(P)).toHaveLength(1);
  });
});

/**
 * The upgrade. A `secrets.json` written before sign-ins were a profile's own: version 1, rows with no
 * `profileId`. Written out by hand rather than produced by the current store, for the reason the
 * server's migration fixtures are — it stands in for a real user's file and must not move when this
 * module does.
 */
describe("SecretStore — rows from before profiles (file version 1)", () => {
  /** A v1 file: one sign-in and one passkey sealed under the store's own keys, minus any profile. */
  function v1File(): { text: string; deps: SecretStoreDeps } {
    // Seal with a real store so the blobs open, then strip what version 2 added — exactly the shape
    // an older Realm wrote.
    const { store, disk, deps } = makeStore({ defaultProfileId: () => "seed" });
    store.addCredential("seed", input());
    store.recordPasskey("seed", passkey());
    const file = JSON.parse(disk.file!) as { version: number; credentials: Record<string, unknown>[]; passkeys: Record<string, unknown>[] };
    file.version = 1;
    for (const row of [...file.credentials, ...file.passkeys]) delete row.profileId;
    return { text: JSON.stringify(file), deps };
  }

  it("gives every old row to the profile that kept the shared browser partition, and writes it back", async () => {
    const { text, deps } = v1File();
    const disk = { file: text as string | null };
    const store = new SecretStore({ ...deps, readFile: () => disk.file, writeFile: (t) => { disk.file = t; }, defaultProfileId: () => P });
    expect(store.listCredentials(P).map((c) => c.origin)).toEqual(["https://example.com"]);
    expect(store.listPasskeys(P).map((p) => p.rpId)).toEqual(["github.com"]);
    expect(store.listCredentials(WORK)).toEqual([]);
    // Written back, as version 2, every row naming its profile.
    const written = JSON.parse(disk.file!) as { version: number; credentials: { profileId?: string }[]; passkeys: { profileId?: string }[] };
    expect(written.version).toBe(2);
    expect([...written.credentials, ...written.passkeys].map((r) => r.profileId)).toEqual([P, P]);
    // …and the secret still opens where it now lives.
    let seen = "";
    await store.withCredentialValue(P, store.listCredentials(P)[0]!.id, async (v) => { seen = v; });
    expect(seen).toBe(SECRET);
  });

  it("is idempotent: a later answer naming a different profile moves nothing", () => {
    const { text, deps } = v1File();
    const disk = { file: text as string | null };
    const io = { readFile: () => disk.file, writeFile: (t: string) => { disk.file = t; } };
    new SecretStore({ ...deps, ...io, defaultProfileId: () => P }).listCredentials(P);
    // The user reordered profiles, or deleted the one that inherited them: still Personal's.
    const later = new SecretStore({ ...deps, ...io, defaultProfileId: () => WORK });
    expect(later.listCredentials(P)).toHaveLength(1);
    expect(later.listCredentials(WORK)).toEqual([]);
  });

  it("adoptUnownedRows places them as soon as main can name the profile, with no read needed", () => {
    /* THE mutant: adopt only on a read. A profile deleted before anyone opened Settings would leave
       its old sign-ins owned by nobody, on disk, forever — `forgetProfile` cannot find rows with no
       profile. */
    const { text, deps } = v1File();
    const disk = { file: text as string | null };
    const store = new SecretStore({ ...deps, readFile: () => disk.file, writeFile: (t) => { disk.file = t; }, defaultProfileId: () => P });
    store.adoptUnownedRows();
    const written = JSON.parse(disk.file!) as { credentials: { profileId?: string }[]; passkeys: { profileId?: string }[] };
    expect([...written.credentials, ...written.passkeys].map((r) => r.profileId)).toEqual([P, P]);
    store.forgetProfile(P);
    expect((JSON.parse(disk.file!) as { credentials: unknown[] }).credentials).toEqual([]);
  });

  it("waits, offered to nobody and untouched on disk, while main cannot yet say which profile", () => {
    const { text, deps } = v1File();
    const disk = { file: text as string | null };
    const io = { readFile: () => disk.file, writeFile: (t: string) => { disk.file = t; } };
    let owner: string | null = null;
    const store = new SecretStore({ ...deps, ...io, defaultProfileId: () => owner });
    expect(store.listCredentials(P)).toEqual([]);
    expect(store.listPasskeys(P)).toEqual([]);
    // A write meanwhile (a new sign-in in another profile) must not drop the waiting rows.
    store.addCredential(WORK, input({ origin: "https://work.example" }));
    expect((JSON.parse(disk.file!) as { credentials: unknown[] }).credentials).toHaveLength(2);
    owner = P;
    expect(store.listCredentials(P).map((c) => c.origin)).toEqual(["https://example.com"]);
    expect(store.listCredentials(WORK).map((c) => c.origin)).toEqual(["https://work.example"]);
  });
});
