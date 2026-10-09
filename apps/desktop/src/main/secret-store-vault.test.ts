import { describe, expect, it } from "vitest";
import { SecretStore, type SecretStoreDeps } from "./secret-store";

/**
 * The team vault in the secret store (Teams Phase 2). The mutants this file is for:
 *   - a key's value leaving by any door but `withKeyValue` — a list, a getter, the file, the audit;
 *   - a `vault-key` blob opening as a sign-in (domain confusion);
 *   - a team's sign-in offered in another space, or filled from one;
 *   - a key locked to a wildcard, or a second key quietly replacing the first's name;
 *   - an allow set without macOS confirming, or for a host the secret is not pinned to;
 *   - an allow that lets a use through on a profile that still asks, or for another role, host, grant
 *     or Mac, or after its secret is gone — or one forged by editing the file;
 *   - a keyring from before the vault losing its sign-ins on the first launch after the update.
 */

const KEY = "sk_live_7f3a9c2e1b8d4f60";
const PASSWORD = "correct horse battery staple";
const P = "pLab";
const TEAM = "01J0000000000000000000TEAM";
const OTHER = "01J000000000000000000OTHER";
const ROLE = "01J0000000000000000000ROLE";
const MAC = "11111111-2222-3333-4444-555555555555";

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("kc:")) throw new Error("not ours");
      return s.slice(3);
    },
  };
}

type Disk = { file: string | null; audit: string[] };

function makeStore(opts: { disk?: Disk; machine?: string } = {}) {
  const disk: Disk = opts.disk ?? { file: null, audit: [] };
  const prompts = { asked: [] as string[], grant: true };
  let n = 0;
  const deps: SecretStoreDeps = {
    safeStorage: fakeSafeStorage(),
    readFile: () => disk.file,
    writeFile: (t) => { disk.file = t; },
    appendAudit: (l) => { disk.audit.push(l); },
    promptPresence: async (reason) => { prompts.asked.push(`touch:${reason}`); return prompts.grant; },
    promptDeviceOwner: async (reason) => { prompts.asked.push(`owner:${reason}`); return prompts.grant; },
    canPromptDeviceOwner: () => true,
    canPromptTouchID: () => true,
    machineId: () => opts.machine ?? MAC,
    now: () => 5_000,
    newId: () => `id-${++n}`,
    defaultProfileId: () => P,
  };
  return { store: new SecretStore(deps), disk, prompts };
}

const revenuecat = { name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "https://api2.revenuecat.com/v1"], value: KEY };
const allowArgs = (secretId: string, over: Record<string, unknown> = {}) => ({
  spaceId: TEAM, secretId, roleId: ROLE, hosts: ["api.revenuecat.com"], grantAt: 42, roleName: "Growth Analyst", secretName: "REVENUECAT_SECRET_KEY", ...over,
});
const query = (secretId: string, over: Record<string, unknown> = {}) => ({ spaceId: TEAM, secretId, roleId: ROLE, host: "api.revenuecat.com", grantAt: 42, ...over });

async function goUnattended(store: SecretStore) {
  expect((await store.setUnlockPolicy({ kind: "profile", id: P }, { kind: "unattended" })).ok).toBe(true);
}

describe("team keys", () => {
  it("leave only through withKeyValue: no list, getter, file or audit line carries the value", async () => {
    // THE MUTANT: a projection that keeps `sealed`, or a store that writes the value in the clear.
    const { store, disk } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    expect(key).toEqual({ id: key.id, name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "api2.revenuecat.com"], spaceId: TEAM, createdAt: 5_000 });
    let seen: string | null = null;
    expect(await store.withKeyValue(P, TEAM, key.id, async (v) => { seen = v; })).toEqual({ ok: true });
    expect(seen).toBe(KEY);
    const everything = JSON.stringify([store.vaultSecrets(P, TEAM), store.getKey(P, TEAM, key.id), store.listCredentials(P), disk.file, disk.audit]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(Buffer.from(KEY).toString("base64"));
  });

  it("is the team's own: another space, or another profile, gets no_key without being asked anything", async () => {
    const { store, prompts } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    expect(await store.withKeyValue(P, OTHER, key.id, async () => undefined)).toEqual({ ok: false, refused: "no_key" });
    expect(await store.withKeyValue("pOther", TEAM, key.id, async () => undefined)).toEqual({ ok: false, refused: "no_key" });
    expect(store.vaultSecrets(P, OTHER).keys).toEqual([]);
    expect(prompts.asked).toEqual([]);
  });

  it("asks by the profile's unlock policy before it opens", async () => {
    const { store, prompts } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    prompts.grant = false;
    let ran = false;
    expect(await store.withKeyValue(P, TEAM, key.id, async () => { ran = true; })).toEqual({ ok: false, refused: "no_presence" });
    expect(ran).toBe(false);
    expect(prompts.asked[0]).toMatch(/^touch:put the key REVENUECAT_SECRET_KEY into a request to api\.revenuecat\.com/);
  });

  it("refuses a wildcard or path-only host, and a second key under a name the team already uses", () => {
    const { store } = makeStore();
    expect(() => store.addKey(P, TEAM, { ...revenuecat, allowedHosts: ["*.revenuecat.com"] })).toThrow(/no wildcards/);
    expect(() => store.addKey(P, TEAM, { ...revenuecat, allowedHosts: ["revenuecat"] })).toThrow(/no wildcards/);
    store.addKey(P, TEAM, revenuecat);
    expect(() => store.addKey(P, TEAM, { ...revenuecat, value: "another" })).toThrow(/already has a key named/);
    expect(store.addKey(P, OTHER, revenuecat).spaceId).toBe(OTHER);
  });

  it("a key's blob will not open as a sign-in: moved into a credential row, the fill finds nothing", async () => {
    // THE MUTANT: keys sealed under the credential domain (or the credential key) — then a blob moved
    // between the two lists would open, and a key could be typed into a page.
    const { store, disk } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    const cred = store.addCredential(P, { origin: "https://evil.example", username: "x", label: "", value: PASSWORD });
    const file = JSON.parse(disk.file!) as { keys: { sealed: string }[]; credentials: { sealed: string }[] };
    file.credentials[0]!.sealed = file.keys[0]!.sealed;
    const reopened = makeStore({ disk: { file: JSON.stringify(file), audit: [] } }).store;
    let typed: string | null = null;
    expect(await reopened.withCredentialValue(P, cred.id, async (v) => { typed = v; })).toEqual({ ok: false, refused: "no_credential" });
    expect(typed).toBeNull();
    void key;
  });
});

describe("team sign-ins", () => {
  it("are offered in their own space and the profile's own everywhere, never another team's", async () => {
    const { store } = makeStore();
    const mine = store.addCredential(P, { origin: "https://www.tiktok.com", username: "nathan", label: "", value: PASSWORD }, TEAM);
    const profiles = store.addCredential(P, { origin: "https://github.com", username: "me", label: "", value: PASSWORD });
    expect(mine.spaceId).toBe(TEAM);
    expect(store.credentialsForSpace(P, TEAM).map((c) => c.id)).toEqual([mine.id, profiles.id]);
    expect(store.credentialsForSpace(P, OTHER).map((c) => c.id)).toEqual([profiles.id]);
    expect(store.credentialsForSpace(P, null).map((c) => c.id)).toEqual([profiles.id]);
    // Settings lists the profile's every sign-in, the team's included, so its owner can see them.
    expect(store.listCredentials(P).map((c) => c.id)).toEqual([mine.id, profiles.id]);
  });

  it("fill only from their own space — another space, or one that names none, is refused before the prompt", async () => {
    const { store, prompts } = makeStore();
    const mine = store.addCredential(P, { origin: "https://www.tiktok.com", username: "nathan", label: "", value: PASSWORD }, TEAM);
    const use = async () => undefined;
    expect(await store.withCredentialValue(P, mine.id, use, { spaceId: OTHER })).toEqual({ ok: false, refused: "no_credential" });
    expect(await store.withCredentialValue(P, mine.id, use)).toEqual({ ok: false, refused: "no_credential" });
    expect(prompts.asked).toEqual([]);
    expect(await store.withCredentialValue(P, mine.id, use, { spaceId: TEAM })).toEqual({ ok: true });
  });

  it("are not shared into another profile", () => {
    const { store } = makeStore();
    const mine = store.addCredential(P, { origin: "https://www.tiktok.com", username: "nathan", label: "", value: PASSWORD }, TEAM);
    expect(store.shareCredential(P, mine.id, "pOther")).toBeNull();
  });
});

describe("a grant's use without asking", () => {
  it("is confirmed by macOS before it is written, and a refusal writes nothing but its audit line", async () => {
    const { store, prompts, disk } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    prompts.grant = false;
    expect(await store.setVaultAllow(P, allowArgs(key.id))).toEqual({ ok: false, error: "macOS did not confirm it was you, so nothing changed." });
    expect(prompts.asked).toEqual(["owner:let Growth Analyst use REVENUECAT_SECRET_KEY without asking"]);
    expect(store.vaultAllows(P, TEAM)).toEqual([]);
    expect(disk.audit.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === "vault-allow").map((e) => e.outcome)).toEqual(["refused"]);
  });

  it("names only hosts the secret itself is pinned to", async () => {
    const { store } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    const r = await store.setVaultAllow(P, allowArgs(key.id, { hosts: ["api.revenuecat.com", "evil.example.com"] }));
    expect(r).toEqual({ ok: false, error: "A role can be let through only to the hosts the secret itself is locked to." });
  });

  it("lets a use through only on a profile that also unlocks without asking — unattended needs both", async () => {
    // THE MUTANT: an allow that is enough on its own, leaving a Touch ID prompt nobody is there for.
    const { store } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    expect((await store.setVaultAllow(P, allowArgs(key.id))).ok).toBe(true);
    expect(store.vaultAllowed(P, query(key.id))).toBe(false);
    await goUnattended(store);
    expect(store.vaultAllowed(P, query(key.id))).toBe(true);
  });

  it("covers exactly its secret, role, team, host and grant — anything else asks", async () => {
    const { store } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    await goUnattended(store);
    await store.setVaultAllow(P, allowArgs(key.id));
    expect(store.vaultAllowed(P, query(key.id))).toBe(true);
    expect(store.vaultAllowed(P, query(key.id, { roleId: "01J000000000000000000OTHERR" }))).toBe(false);
    expect(store.vaultAllowed(P, query(key.id, { host: "api2.revenuecat.com" }))).toBe(false);
    expect(store.vaultAllowed(P, query(key.id, { spaceId: OTHER }))).toBe(false);
    // A grant revoked and made again is a new grant: its allow was sealed against the old one.
    expect(store.vaultAllowed(P, query(key.id, { grantAt: 43 }))).toBe(false);
    expect(store.vaultAllowed("pOther", query(key.id))).toBe(false);
  });

  it("asks again once cleared, or once its secret is removed", async () => {
    const { store } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    await goUnattended(store);
    await store.setVaultAllow(P, allowArgs(key.id));
    expect(store.clearVaultAllow(key.id, ROLE)).toBe(true);
    expect(store.vaultAllowed(P, query(key.id))).toBe(false);
    await store.setVaultAllow(P, allowArgs(key.id));
    store.removeKey(P, key.id);
    expect(store.vaultAllowed(P, query(key.id))).toBe(false);
    expect(store.vaultAllows(P, TEAM)).toEqual([]);
  });

  it("set on this Mac, means nothing in a copy of Realm's files on another", async () => {
    const { store, disk } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    await goUnattended(store);
    await store.setVaultAllow(P, allowArgs(key.id));
    const elsewhere = makeStore({ disk: { file: disk.file, audit: [] }, machine: "99999999-0000-0000-0000-000000000000" }).store;
    expect(elsewhere.vaultAllowed(P, query(key.id))).toBe(false);
    expect(elsewhere.vaultAllows(P, TEAM)).toEqual([]);
  });

  it("cannot be forged by editing the file: an allow sealed under another domain, or written plain, is no allow", async () => {
    const { store, disk } = makeStore();
    const key = store.addKey(P, TEAM, revenuecat);
    await goUnattended(store);
    const file = JSON.parse(disk.file!) as { allow: Record<string, string>; unlock: Record<string, string>; keys: { sealed: string }[] };
    // The profile's own sealed unlock policy, and the key's own sealed value, dressed up as allows.
    file.allow[`${key.id}|${ROLE}`] = Object.values(file.unlock)[0]!;
    const forged = makeStore({ disk: { file: JSON.stringify(file), audit: [] } }).store;
    expect(forged.vaultAllowed(P, query(key.id))).toBe(false);
    file.allow[`${key.id}|${ROLE}`] = file.keys[0]!.sealed;
    expect(makeStore({ disk: { file: JSON.stringify(file), audit: [] } }).store.vaultAllowed(P, query(key.id))).toBe(false);
  });
});

describe("a keyring from before the vault", () => {
  it("gains the vault's two keys without losing a sign-in", async () => {
    // THE MUTANT: requiring every domain in the keyring, which sends an old install down the
    // corrupt-keyring branch and drops every saved sign-in on the first launch after the update.
    const { store, disk } = makeStore();
    const cred = store.addCredential(P, { origin: "https://github.com", username: "me", label: "", value: PASSWORD });
    const file = JSON.parse(disk.file!) as { keyring: string; keys?: unknown; allow?: unknown };
    const ring = JSON.parse(Buffer.from(file.keyring, "base64").toString("utf8").slice(3)) as Record<string, string>;
    delete ring["vault-key"]; delete ring["vault-allow"];
    file.keyring = Buffer.from(`kc:${JSON.stringify(ring)}`).toString("base64");
    delete file.keys; delete file.allow;
    const later = makeStore({ disk: { file: JSON.stringify(file), audit: [] } }).store;
    let typed: string | null = null;
    expect(await later.withCredentialValue(P, cred.id, async (v) => { typed = v; })).toEqual({ ok: true });
    expect(typed).toBe(PASSWORD);
    expect(later.addKey(P, TEAM, revenuecat).name).toBe("REVENUECAT_SECRET_KEY");
  });
});
