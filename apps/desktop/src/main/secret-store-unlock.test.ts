import { describe, expect, it } from "vitest";
import { newSecretKey, seal } from "@realm/contracts/src/secret-box";
import { SecretStore, type SecretStoreDeps } from "./secret-store";
import type { PolicyStamp } from "./policy-stamp";

/**
 * Unlock policies (Settings ▸ Sign-ins ▸ Unlock). The mutants this file is for:
 *   - a fill under `touch-id` that does not prompt, or prompts by password;
 *   - `device-password` or `session` prompting by Touch ID alone when the password check can run;
 *   - a session that never opens, never closes, outlives a restart, or leaks into another profile;
 *   - `unattended` prompting anyway (useless) or — worse — set without macOS confirming the user;
 *   - a weakening that skips the check, or a revocation that asks for one;
 *   - a policy forged by editing the file, moved between profiles, or carried to another Mac;
 *   - an unlock that leaves no audit line, `unattended` above all;
 *   - a store file from before policies losing its sign-ins on the first launch after the update.
 */

const SECRET = "correct horse battery staple";
const LAB = "pLab";
const PERSONAL = "pPersonal";
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

/** The Mac's Keychain, as the stamp helper sees it: one number per scope, set only by moving it on.
 *  It rides on the disk, so a second store over the same disk is the same Mac after a restart. */
type Disk = { file: string | null; audit: string[]; keychain?: Map<string, number> };

function fakeStamp(disk: Disk): PolicyStamp {
  const keychain = (disk.keychain ??= new Map());
  return {
    read: (scope) => keychain.get(scope) ?? null,
    bump: (scope) => { const next = (keychain.get(scope) ?? 1_000) + 1; keychain.set(scope, next); return next; },
  };
}

function makeStore(opts: { disk?: Disk; machine?: string | null; canOwner?: boolean; canTouchId?: boolean; clock?: { now: number }; stamp?: PolicyStamp | null } = {}) {
  const disk: Disk = opts.disk ?? { file: null, audit: [] };
  const clock = opts.clock ?? { now: 1_000_000 };
  /** Every prompt raised, as `touch:<reason>` or `owner:<reason>`; `grant` answers both. */
  const prompts = { asked: [] as string[], grant: true };
  let n = 0;
  const deps: SecretStoreDeps = {
    safeStorage: fakeSafeStorage(),
    readFile: () => disk.file,
    writeFile: (t) => { disk.file = t; },
    appendAudit: (l) => { disk.audit.push(l); },
    promptPresence: async (reason) => { prompts.asked.push(`touch:${reason}`); return prompts.grant; },
    promptDeviceOwner: async (reason) => { prompts.asked.push(`owner:${reason}`); return prompts.grant; },
    canPromptDeviceOwner: () => opts.canOwner ?? true,
    canPromptTouchID: () => opts.canTouchId ?? true,
    machineId: () => (opts.machine === undefined ? MAC : opts.machine),
    policyStamp: opts.stamp === undefined ? fakeStamp(disk) : opts.stamp,
    now: () => clock.now,
    newId: () => `id-${++n}`,
    defaultProfileId: () => PERSONAL,
  };
  return { store: new SecretStore(deps), disk, clock, prompts };
}

const signIn = { origin: "https://www.tiktok.com", username: "nathan", label: "", value: SECRET };

async function fill(store: SecretStore, profileId: string, id: string): Promise<{ ok: boolean; typed: string | null }> {
  let typed: string | null = null;
  const r = await store.withCredentialValue(profileId, id, async (v) => { typed = v; });
  return { ok: r.ok, typed };
}

const unlockLines = (disk: Disk) => disk.audit.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === "unlock");
const policyLines = (disk: Disk) => disk.audit.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === "unlock-policy");
const lab = { kind: "profile", id: LAB } as const;

describe("unlock policy — touch-id, the default", () => {
  it("is every profile's policy until the user changes it, and asks Touch ID — not the password — on each fill", async () => {
    const { store, prompts, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    expect(await fill(store, LAB, row.id)).toEqual({ ok: true, typed: SECRET });
    expect(await fill(store, LAB, row.id)).toEqual({ ok: true, typed: SECRET });
    expect(prompts.asked).toEqual([
      "touch:fill your saved sign-in for nathan on https://www.tiktok.com",
      "touch:fill your saved sign-in for nathan on https://www.tiktok.com",
    ]);
    expect(unlockLines(disk)).toEqual([
      { ts: 1_000_000, kind: "unlock", scope: "profile:pLab", policy: "touch-id", how: "prompted" },
      { ts: 1_000_000, kind: "unlock", scope: "profile:pLab", policy: "touch-id", how: "prompted" },
    ]);
  });

  it("refuses when Touch ID is cancelled, and says so in the audit", async () => {
    const { store, prompts, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    prompts.grant = false;
    expect(await fill(store, LAB, row.id)).toEqual({ ok: false, typed: null });
    expect(unlockLines(disk).at(-1)).toMatchObject({ policy: "touch-id", how: "refused" });
  });
});

describe("unlock policy — device-password", () => {
  it("asks the device-owner check (Touch ID or the login password), not Touch ID alone", async () => {
    const { store, prompts, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    expect((await store.setUnlockPolicy(lab, { kind: "device-password" })).ok).toBe(true);
    prompts.asked.length = 0;
    expect(await fill(store, LAB, row.id)).toEqual({ ok: true, typed: SECRET });
    expect(prompts.asked).toEqual(["owner:fill your saved sign-in for nathan on https://www.tiktok.com"]);
    expect(unlockLines(disk).at(-1)).toMatchObject({ policy: "device-password", how: "prompted" });
  });

  it("falls back to Touch ID where the device-owner check cannot run", async () => {
    const { store, prompts } = makeStore({ canOwner: false });
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "device-password" });
    prompts.asked.length = 0;
    await fill(store, LAB, row.id);
    expect(prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
  });

  it("a password typed for one profile does not open the Touch ID window another profile honours", async () => {
    const { store, prompts } = makeStore();
    store.setPresenceTtlMs(300_000);
    const labRow = store.addCredential(LAB, signIn);
    const mine = store.addCredential(PERSONAL, signIn);
    await store.setUnlockPolicy(lab, { kind: "device-password" });
    prompts.asked.length = 0;
    await fill(store, LAB, labRow.id);
    await fill(store, PERSONAL, mine.id);
    expect(prompts.asked.map((p) => p.split(":")[0])).toEqual(["owner", "touch"]);
  });
});

describe("unlock policy — session", () => {
  it("one check unlocks the profile for its hours, then asks again", async () => {
    const { store, prompts, clock, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 8 });
    prompts.asked.length = 0;
    expect((await fill(store, LAB, row.id)).ok).toBe(true);
    clock.now += 7 * 3_600_000;
    expect((await fill(store, LAB, row.id)).ok).toBe(true);
    expect(prompts.asked).toHaveLength(1);
    expect(prompts.asked[0]).toMatch(/^owner:/);
    expect(store.unlockStatus(lab).sessionUntil).toBe(1_000_000 + 8 * 3_600_000);
    clock.now += 2 * 3_600_000;
    expect((await fill(store, LAB, row.id)).ok).toBe(true);
    expect(prompts.asked).toHaveLength(2);
    expect(unlockLines(disk).map((e) => e.how)).toEqual(["prompted", "session", "prompted"]);
  });

  it("a denied check opens no session", async () => {
    const { store, prompts } = makeStore();
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 1 });
    prompts.grant = false;
    expect((await fill(store, LAB, row.id)).ok).toBe(false);
    prompts.grant = true;
    prompts.asked.length = 0;
    await fill(store, LAB, row.id);
    expect(prompts.asked).toHaveLength(1);
  });

  it("is the profile's own: another profile still asks", async () => {
    const { store, prompts } = makeStore();
    const labRow = store.addCredential(LAB, signIn);
    const mine = store.addCredential(PERSONAL, signIn);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 24 });
    await fill(store, LAB, labRow.id);
    prompts.asked.length = 0;
    expect((await fill(store, PERSONAL, mine.id)).ok).toBe(true);
    expect(prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
  });

  it("an open session in one profile does not unlock another profile's session", async () => {
    const { store, prompts } = makeStore();
    const labRow = store.addCredential(LAB, signIn);
    const mine = store.addCredential(PERSONAL, signIn);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 8 });
    await store.setUnlockPolicy({ kind: "profile", id: PERSONAL }, { kind: "session", hours: 8 });
    await fill(store, LAB, labRow.id);
    prompts.asked.length = 0;
    await fill(store, PERSONAL, mine.id);
    expect(prompts.asked).toHaveLength(1);
  });

  it("does not survive a restart — the policy does, the open session does not", async () => {
    const first = makeStore();
    const row = first.store.addCredential(LAB, signIn);
    await first.store.setUnlockPolicy(lab, { kind: "session", hours: 8 });
    await fill(first.store, LAB, row.id);
    const second = makeStore({ disk: first.disk, clock: first.clock });
    expect(second.store.unlockPolicy(lab)).toEqual({ kind: "session", hours: 8 });
    await fill(second.store, LAB, row.id);
    expect(second.prompts.asked).toHaveLength(1);
  });
});

describe("unlock policy — unattended", () => {
  it("fills with no prompt of any kind, and logs every one", async () => {
    const { store, prompts, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    prompts.asked.length = 0;
    expect(await fill(store, LAB, row.id)).toEqual({ ok: true, typed: SECRET });
    expect(await fill(store, LAB, row.id)).toEqual({ ok: true, typed: SECRET });
    expect(prompts.asked).toEqual([]);
    expect(unlockLines(disk)).toEqual([
      { ts: 1_000_000, kind: "unlock", scope: "profile:pLab", policy: "unattended", how: "unattended" },
      { ts: 1_000_000, kind: "unlock", scope: "profile:pLab", policy: "unattended", how: "unattended" },
    ]);
    // …and none of those lines, nor the file, carries the value.
    expect(disk.audit.join("")).not.toContain(SECRET);
    expect(disk.file).not.toContain(SECRET);
  });

  it("covers a generated password and a passkey too: one policy per profile", async () => {
    const { store, prompts } = makeStore();
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    prompts.asked.length = 0;
    const minted = await store.withGeneratedCredentialValue(LAB, { origin: "https://www.tiktok.com", username: "n", label: "", length: 24, symbols: true }, async () => {});
    expect(minted.ok).toBe(true);
    const passkey = await store.withPasskeysFor(LAB, "tiktok.com", "create", async () => {});
    expect(passkey.ok).toBe(true);
    expect(prompts.asked).toEqual([]);
  });

  it("is only that profile's: Personal still asks for Touch ID", async () => {
    const { store, prompts } = makeStore();
    const mine = store.addCredential(PERSONAL, signIn);
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    prompts.asked.length = 0;
    await fill(store, PERSONAL, mine.id);
    expect(prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
  });

  it("can always be unlocked, even on a Mac with no Touch ID and no password check", async () => {
    // Turned on while this Mac could still confirm the user — a Touch ID keyboard since unplugged.
    const before = makeStore();
    await before.store.setUnlockPolicy(lab, { kind: "unattended" });
    const after = makeStore({ disk: before.disk, canOwner: false, canTouchId: false });
    expect(after.store.canUnlock(LAB)).toBe(true);
    expect(after.store.canUnlock(PERSONAL)).toBe(false);
  });
});

describe("unlock policy — who can change it", () => {
  it("turning on Without asking needs macOS to confirm the user first", async () => {
    const { store, prompts, disk } = makeStore();
    prompts.grant = false;
    const r = await store.setUnlockPolicy(lab, { kind: "unattended" });
    expect(r).toEqual({ ok: false, error: "macOS did not confirm it was you, so nothing changed." });
    expect(prompts.asked).toEqual(["owner:let agents fill saved sign-ins on this Mac without asking"]);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    expect(policyLines(disk)).toEqual([{ ts: 1_000_000, kind: "unlock-policy", scope: "profile:pLab", from: "touch-id", to: "unattended", outcome: "refused" }]);
  });

  it("every weakening is confirmed — a longer session included", async () => {
    const { store, prompts } = makeStore();
    await store.setUnlockPolicy(lab, { kind: "device-password" });
    await store.setUnlockPolicy(lab, { kind: "session", hours: 1 });
    await store.setUnlockPolicy(lab, { kind: "session", hours: 24 });
    expect(prompts.asked).toHaveLength(3);
  });

  it("turning a gate back on is never asked about, and prompting resumes at once", async () => {
    const { store, prompts, disk } = makeStore();
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    prompts.asked.length = 0;
    prompts.grant = false;
    expect(await store.setUnlockPolicy(lab, { kind: "touch-id" })).toMatchObject({ ok: true });
    expect(prompts.asked).toEqual([]);
    expect(await fill(store, LAB, row.id)).toEqual({ ok: false, typed: null });
    expect(prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
    expect(policyLines(disk).at(-1)).toMatchObject({ from: "unattended", to: "touch-id", outcome: "set" });
  });

  it("a session in progress closes when the policy changes", async () => {
    const { store, prompts } = makeStore();
    const row = store.addCredential(LAB, signIn);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 24 });
    await fill(store, LAB, row.id);
    await store.setUnlockPolicy(lab, { kind: "session", hours: 1 });
    prompts.asked.length = 0;
    await fill(store, LAB, row.id);
    expect(prompts.asked).toHaveLength(1);
  });

  it("refuses Without asking when it cannot tie it to this Mac", async () => {
    const { store, prompts } = makeStore({ machine: null });
    const r = await store.setUnlockPolicy(lab, { kind: "unattended" });
    expect(r.ok).toBe(false);
    expect(prompts.asked).toEqual([]);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });

  it("an unknown policy is read as the default, never as something weaker", async () => {
    const { store } = makeStore();
    await store.setUnlockPolicy(lab, { kind: "none" } as never);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    await store.setUnlockPolicy(lab, { kind: "session", hours: 720 } as never);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });
});

describe("unlock policy — what the file cannot do", () => {
  it("a hand-written policy in secrets.json is ignored (an agent's shell can edit the file)", async () => {
    const { store, disk } = makeStore();
    store.addCredential(LAB, signIn);
    const file = JSON.parse(disk.file!) as Record<string, unknown>;
    // Every shape an editor could write: plain JSON, plain text, and a well-formed blob under a key
    // that is not the keyring's.
    for (const forged of [
      JSON.stringify({ scope: "profile:pLab", machine: MAC, policy: { kind: "unattended" } }),
      "unattended",
      seal(newSecretKey(), "unlock", JSON.stringify({ scope: "profile:pLab", machine: MAC, policy: { kind: "unattended" } })),
    ]) {
      const next = makeStore({ disk: { file: JSON.stringify({ ...file, unlock: { "profile:pLab": forged } }), audit: [] } });
      expect(next.store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    }
  });

  it("a policy moved onto another profile opens as the default there", async () => {
    const { store, disk } = makeStore();
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    const file = JSON.parse(disk.file!) as { unlock: Record<string, string> };
    file.unlock["profile:pPersonal"] = file.unlock["profile:pLab"]!;
    const next = makeStore({ disk: { file: JSON.stringify(file), audit: [], keychain: disk.keychain } });
    expect(next.store.unlockPolicy({ kind: "profile", id: PERSONAL })).toEqual({ kind: "touch-id" });
    expect(next.store.unlockPolicy(lab)).toEqual({ kind: "unattended" });
  });

  it("Without asking stays on THIS Mac: the same files on another Mac ask for Touch ID", async () => {
    const here = makeStore();
    const row = here.store.addCredential(LAB, signIn);
    await here.store.setUnlockPolicy(lab, { kind: "unattended" });
    const restarted = makeStore({ disk: { file: here.disk.file, audit: [], keychain: here.disk.keychain } });
    expect(restarted.store.unlockPolicy(lab)).toEqual({ kind: "unattended" });
    // Even with this Mac's Keychain carried along (Migration Assistant copies the login Keychain).
    const elsewhere = makeStore({ disk: { file: here.disk.file, audit: [], keychain: here.disk.keychain }, machine: "99999999-8888-7777-6666-555555555555" });
    expect(elsewhere.store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    await fill(elsewhere.store, LAB, row.id);
    expect(elsewhere.prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
  });

  it("a copy of the file saved under Without asking and put back after the user tightened it reads as Touch ID", async () => {
    // PR #134's residual risk: an agent with a shell saves secrets.json while the profile is on
    // Without asking, the user tightens it, the agent puts the copy back, and the next launch reads
    // the copy. THE mutant: a policy honoured without its stamp matching the Keychain's.
    const here = makeStore();
    const row = here.store.addCredential(LAB, signIn);
    await here.store.setUnlockPolicy(lab, { kind: "unattended" });
    const saved = here.disk.file;
    here.prompts.asked.length = 0;
    expect(await here.store.setUnlockPolicy(lab, { kind: "touch-id" })).toMatchObject({ ok: true });
    expect(here.prompts.asked).toEqual([]); // tightening never asks
    here.disk.file = saved; // put back
    const restarted = makeStore({ disk: here.disk });
    expect(restarted.store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    await fill(restarted.store, LAB, row.id);
    expect(restarted.prompts.asked).toEqual(["touch:fill your saved sign-in for nathan on https://www.tiktok.com"]);
  });

  it("the same goes for a copy taken under one looser policy and put back under another", async () => {
    const here = makeStore();
    await here.store.setUnlockPolicy(lab, { kind: "unattended" });
    const saved = here.disk.file;
    await here.store.setUnlockPolicy(lab, { kind: "session", hours: 1 });
    here.disk.file = saved;
    expect(makeStore({ disk: here.disk }).store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });

  it("a stamp gone from the Keychain puts the profile back on Touch ID; it never loosens anything", async () => {
    const here = makeStore();
    await here.store.setUnlockPolicy(lab, { kind: "unattended" });
    here.disk.keychain!.delete("profile:pLab");
    expect(makeStore({ disk: here.disk }).store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });

  it("with no stamp to keep, a looser policy is refused and nothing changes; a tightening still goes through", async () => {
    const { store, disk, prompts } = makeStore({ stamp: null });
    const r = await store.setUnlockPolicy(lab, { kind: "unattended" });
    expect(r).toMatchObject({ ok: false });
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    expect(policyLines(disk).at(-1)).toMatchObject({ outcome: "refused", to: "unattended" });
    prompts.asked.length = 0;
    expect(await store.setUnlockPolicy(lab, { kind: "touch-id" })).toMatchObject({ ok: true });
    expect(prompts.asked).toEqual([]);
  });

  it("a deleted profile's policy goes with it", async () => {
    const { store, disk } = makeStore();
    await store.setUnlockPolicy(lab, { kind: "unattended" });
    store.forgetProfile(LAB);
    expect(JSON.parse(disk.file!).unlock).toEqual({});
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });
});

describe("unlock policy — a store file from before policies", () => {
  /**
   * Written out by hand, as version 2 wrote it: five keys in the keyring (no `unlock`), no `unlock`
   * map, one sign-in and one passkey. The keys are fixed bytes so the sealed values can be made here.
   */
  function previousFile(): { text: string; credentialKey: Buffer } {
    const k = (b: number) => Buffer.alloc(32, b);
    const keyring = { oauth: k(1), credential: k(2), machine: k(3), eggs: k(4), passkey: k(5) };
    const text = JSON.stringify({
      version: 2,
      keyring: Buffer.from(`kc:${JSON.stringify(Object.fromEntries(Object.entries(keyring).map(([n, v]) => [n, v.toString("base64")])))}`).toString("base64"),
      credentials: [{ id: "c1", profileId: LAB, origin: "https://www.tiktok.com", username: "nathan", label: "", createdAt: 5, generated: false, sealed: seal(keyring.credential, "credential", SECRET) }],
      passkeys: [{ id: "k1", profileId: LAB, rpId: "tiktok.com", userName: "n", userDisplayName: "N", createdAt: 5, lastUsedAt: null, credentialId: "cid", userHandle: null, signCount: 3, sealed: seal(keyring.passkey, "passkey", "pk") }],
      presenceTtlMs: 60_000,
    });
    return { text, credentialKey: keyring.credential };
  }

  it("keeps every sign-in, passkey and setting, and starts every profile on Touch ID", async () => {
    const { store, prompts } = makeStore({ disk: { file: previousFile().text, audit: [] } });
    expect(store.listCredentials(LAB).map((c) => c.id)).toEqual(["c1"]);
    expect(store.listPasskeys(LAB).map((p) => p.id)).toEqual(["k1"]);
    expect(store.presenceTtlMs).toBe(60_000);
    expect(store.unlockPolicy(lab)).toEqual({ kind: "touch-id" });
    expect(await fill(store, LAB, "c1")).toEqual({ ok: true, typed: SECRET });
    expect(prompts.asked).toHaveLength(1);
  });

  it("adds the unlock key beside the old ones without touching them, once", async () => {
    const disk: Disk = { file: previousFile().text, audit: [] };
    const first = makeStore({ disk });
    first.store.listCredentials(LAB);
    const keyringOf = (text: string) => JSON.parse(Buffer.from(JSON.parse(text).keyring, "base64").toString("utf8").slice(3)) as Record<string, string>;
    const after = keyringOf(disk.file!);
    expect(Object.keys(after).sort()).toEqual(["credential", "eggs", "machine", "oauth", "passkey", "unlock", "vault-allow", "vault-key"]);
    expect(after.credential).toBe(Buffer.alloc(32, 2).toString("base64"));
    // Idempotent: a second launch mints nothing new and loses nothing.
    const written = disk.file;
    const second = makeStore({ disk });
    expect(second.store.listCredentials(LAB)).toHaveLength(1);
    expect(keyringOf(disk.file!).unlock).toBe(after.unlock);
    expect(disk.file).toBe(written);
  });

  it("a policy set after the update survives the next launch", async () => {
    const disk: Disk = { file: previousFile().text, audit: [] };
    await makeStore({ disk }).store.setUnlockPolicy(lab, { kind: "device-password" });
    expect(makeStore({ disk }).store.unlockPolicy(lab)).toEqual({ kind: "device-password" });
  });
});
