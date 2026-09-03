import { describe, expect, it } from "vitest";
import { SecretStore, SecretStoreError, type SecretStoreDeps } from "./secret-store";

/**
 * The store's mutants:
 *   - a credential value readable back out (a getter, a list field, the file on disk);
 *   - presence not required, or required only on the first fill;
 *   - a denied Touch ID opening the TTL window anyway;
 *   - a plaintext fallback when safeStorage is unavailable;
 *   - the credential key exportable alongside the oauth one;
 *   - an audit line missing, or carrying the value.
 */

const SECRET = "correct horse battery staple";

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
    const row = store.addCredential(input());
    expect(row).toEqual({ id: "cred-1", origin: "https://example.com", username: "ada", label: "Work", createdAt: 1_000_000 });
    expect(Object.keys(row)).not.toContain("sealed");
    expect(JSON.stringify(store.listCredentials())).not.toContain(SECRET);
  });

  it("the FILE on disk holds no plaintext value (mutant: sealing skipped)", () => {
    const { store, disk } = makeStore();
    store.addCredential(input());
    expect(disk.file).not.toBeNull();
    expect(disk.file).not.toContain(SECRET);
  });

  it("normalizes the origin on the way in, so the exact-match gate compares like with like", () => {
    const { store } = makeStore();
    expect(store.addCredential(input({ origin: "https://EXAMPLE.com:443/login?next=1" })).origin).toBe("https://example.com");
  });

  it("refuses an address it cannot pin a sign-in to, rather than storing a credential that fills nowhere", () => {
    const { store } = makeStore();
    for (const origin of ["example.com", "about:blank", "file:///etc/passwd", "", "javascript:alert(1)"]) {
      expect(() => store.addCredential(input({ origin })), origin).toThrow(SecretStoreError);
    }
    expect(store.listCredentials()).toEqual([]);
  });

  it("with safeStorage unavailable it enrolls NOTHING — there is no plaintext fallback", () => {
    const { store, disk } = makeStore({ available: false });
    expect(() => store.addCredential(input())).toThrow(SecretStoreError);
    expect(store.listCredentials()).toEqual([]);
    expect(disk.file ?? "").not.toContain(SECRET);
  });

  it("removeCredential reports honestly whether anything was there", () => {
    const { store } = makeStore();
    const row = store.addCredential(input());
    expect(store.removeCredential("nope")).toBe(false);
    expect(store.removeCredential(row.id)).toBe(true);
    expect(store.listCredentials()).toEqual([]);
  });
});

describe("SecretStore — the one door out", () => {
  it("hands the value to the callback and returns NOTHING that contains it", async () => {
    const { store } = makeStore();
    const row = store.addCredential(input());
    let seen: string | null = null;
    const result = await store.withCredentialValue(row.id, async (v) => { seen = v; });

    expect(seen).toBe(SECRET);
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("requires presence BEFORE unsealing, and a refusal types nothing (mutant: presence not required)", async () => {
    const { store, presence } = makeStore();
    const row = store.addCredential(input());
    presence.grant = false;
    let called = false;
    const result = await store.withCredentialValue(row.id, async () => { called = true; });

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
    expect(await store.withCredentialValue("ghost", async () => {})).toEqual({ ok: false, refused: "no_credential" });
    expect(presence.asked).toHaveLength(0);
  });

  it("prompts on EVERY fill by default (mutant: presence checked once and remembered)", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(input());
    await store.withCredentialValue(row.id, async () => {});
    clock.now += 1;
    await store.withCredentialValue(row.id, async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("a TTL lets a second fill through inside the window, and prompts again past it", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(input());
    store.setPresenceTtlMs(60_000);

    await store.withCredentialValue(row.id, async () => {});
    expect(presence.asked).toHaveLength(1);

    clock.now += 30_000;                       // inside the window: the SSO second field
    await store.withCredentialValue(row.id, async () => {});
    expect(presence.asked).toHaveLength(1);

    clock.now += 60_000;                       // past it
    await store.withCredentialValue(row.id, async () => {});
    expect(presence.asked).toHaveLength(2);
  });

  it("a DENIED check opens no window (mutant: the TTL set before the answer is known)", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(input());
    store.setPresenceTtlMs(60_000);

    presence.grant = false;
    expect(await store.withCredentialValue(row.id, async () => {})).toEqual({ ok: false, refused: "no_presence" });
    clock.now += 1;
    presence.grant = true;
    await store.withCredentialValue(row.id, async () => {});
    expect(presence.asked).toHaveLength(2); // the denial did not license the next one
  });

  it("shortening the TTL takes effect immediately rather than after the old window expires", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(input());
    store.setPresenceTtlMs(300_000);
    await store.withCredentialValue(row.id, async () => {});
    store.setPresenceTtlMs(0);
    clock.now += 1;
    await store.withCredentialValue(row.id, async () => {});
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
    const row = store.addCredential(input());
    expect(await store.withCredentialValue(row.id, async () => {})).toEqual({ ok: false, refused: "no_presence" });
  });
});

describe("SecretStore — persistence and the keyring", () => {
  it("a second store over the same file opens the same credential", async () => {
    const { store, disk, deps } = makeStore();
    const row = store.addCredential(input());

    const reopened = new SecretStore({ ...deps, readFile: () => disk.file });
    expect(reopened.listCredentials()).toEqual([row]);
    let seen: string | null = null;
    await reopened.withCredentialValue(row.id, async (v) => { seen = v; });
    expect(seen).toBe(SECRET);
  });

  it("a keyring the OS will no longer open DROPS the rows it sealed, rather than listing sign-ins that refuse forever", () => {
    const { store, disk, deps } = makeStore();
    store.addCredential(input());
    expect(store.listCredentials()).toHaveLength(1);

    // The real scenario: the file restored onto another Mac, whose Keychain has no matching item.
    const foreign = new SecretStore({
      ...deps,
      readFile: () => disk.file,
      safeStorage: { ...fakeSafeStorage(), decryptString: () => { throw new Error("item not found"); } },
    });
    expect(foreign.listCredentials()).toEqual([]);
    // ...and it is usable again immediately, with a fresh keyring rather than a wedged one.
    expect(foreign.addCredential(input({ value: "new" })).origin).toBe("https://example.com");
  });

  it("a corrupt file degrades to an empty store instead of throwing on every read", () => {
    const { deps } = makeStore();
    const store = new SecretStore({ ...deps, readFile: () => "{ not json" });
    expect(store.listCredentials()).toEqual([]);
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
      .toEqual(["withCredentialValue"]);
  });

  it("with no encryption available there is no key to hand out — realm-server keeps its old plaintext posture", () => {
    const { store } = makeStore({ available: false });
    expect(store.exportOauthKey()).toBeNull();
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
