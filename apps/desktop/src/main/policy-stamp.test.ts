import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keychainPolicyStamp } from "./policy-stamp";
import { SecretStore, type SecretStoreDeps } from "./secret-store";

/**
 * The stamp against the REAL login Keychain, through the real helper — under a service of its own
 * ("Realm Test …", unique to this run), never the one Realm keeps its stamps under, and removed
 * afterwards. Skipped where the helper is not built (not a Mac, or no swiftc).
 */
const helper = join(__dirname, "..", "..", "native", "bin", "policystamp");
const service = `Realm Test unlock stamp ${process.pid}-${Date.now()}`;
const scopes = new Set<string>();
const scope = (s: string) => { scopes.add(s); return s; };

afterAll(() => {
  if (!existsSync(helper)) return;
  for (const s of scopes) spawnSync(helper, ["forget", service, s]);
  for (const s of scopes) expect(spawnSync(helper, ["read", service, s]).status).toBe(3);
});

describe.skipIf(process.platform !== "darwin" || !existsSync(helper))("the unlock-policy stamp in the Keychain", () => {
  it("starts somewhere no one would guess and only ever moves on by one", () => {
    const stamp = keychainPolicyStamp(helper, service)!;
    const s = scope("profile:stampA");
    expect(stamp.read(s)).toBeNull();
    const first = stamp.bump(s)!;
    expect(first).toBeGreaterThan(2 ** 40);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(stamp.read(s)).toBe(first);
    expect(stamp.bump(s)).toBe(first + 1);
    expect(stamp.read(s)).toBe(first + 1);
  });

  it("offers no way to set a number, and will not remove a stamp outside a test service", () => {
    const s = scope("profile:stampB");
    expect(spawnSync(helper, ["set", service, s, "1"]).status).toBe(2);
    expect(spawnSync(helper, ["forget", "Realm unlock policy", s]).status).toBe(2);
  });

  it("a copy of secrets.json put back after the user tightened the policy reads as Touch ID", async () => {
    const s = scope("profile:stampLab");
    const disk = { file: null as string | null };
    const prompts: string[] = [];
    const deps = (): SecretStoreDeps => ({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (t: string) => Buffer.from(`kc:${t}`, "utf8"),
        decryptString: (b: Buffer) => b.toString("utf8").slice(3),
      },
      readFile: () => disk.file,
      writeFile: (t) => { disk.file = t; },
      appendAudit: () => {},
      promptPresence: async (reason) => { prompts.push(reason); return true; },
      promptDeviceOwner: async (reason) => { prompts.push(reason); return true; },
      canPromptDeviceOwner: () => true,
      canPromptTouchID: () => true,
      machineId: () => "11111111-2222-3333-4444-555555555555",
      policyStamp: keychainPolicyStamp(helper, service),
      now: () => 1_000,
      newId: () => "id",
      defaultProfileId: () => "stampLab",
    });
    const lab = { kind: "profile", id: s.slice("profile:".length) } as const;
    const here = new SecretStore(deps());
    expect(await here.setUnlockPolicy(lab, { kind: "unattended" })).toMatchObject({ ok: true });
    expect(new SecretStore(deps()).unlockPolicy(lab)).toEqual({ kind: "unattended" }); // survives a restart
    const saved = disk.file;
    prompts.length = 0;
    expect(await here.setUnlockPolicy(lab, { kind: "touch-id" })).toMatchObject({ ok: true });
    expect(prompts).toEqual([]);
    disk.file = saved;
    expect(new SecretStore(deps()).unlockPolicy(lab)).toEqual({ kind: "touch-id" });
  });
});
