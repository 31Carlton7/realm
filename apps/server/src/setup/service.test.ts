import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSetupRuntime } from "@realm/contracts";
import { CodexSetupService } from "./service";

let root: string, user: string, codex: string, realm: string, cwd: string;
const runtime = (): CodexSetupRuntime => ({ state: "available", components: { config: "available", skills: "available", hooks: "available" }, settings: { model: "model", provider: "proxy", reasoning: "medium", approvalPolicy: "never", sandbox: "read-only" }, skills: [], hooks: [], connections: [] });
const skill = (dir: string, name = "example") => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`); };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "RealmSetup"));
  user = join(root, "User"); codex = join(root, "Codex"); realm = join(root, "Realm"); cwd = join(user, "Projects", "Example");
  for (const p of [user, codex, realm, cwd]) mkdirSync(p, { recursive: true });
  writeFileSync(join(codex, "config.toml"), 'model = "fixture"\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("CodexSetupService.scan", () => {
  it("uses distinct homes and does not create binding or source files", async () => {
    const before = readFileSync(join(codex, "config.toml"), "utf8");
    const inspect = vi.fn(async () => runtime());
    const service = new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect });
    const result = await service.scan({ cwd });
    expect(result.homes).toEqual({ user, codex, realm });
    expect(inspect).toHaveBeenCalledWith({ cwd, codexHome: codex });
    expect(readdirSync(realm)).toEqual([]);
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe(before);
    expect(result.sources).toContainEqual({ path: join(codex, "memories"), kind: "memory", state: "missing" });
    utimesSync(join(codex, "config.toml"), new Date(), new Date(Date.now() + 1_000));
    expect((await service.scan({ cwd })).fingerprint).toBe(result.fingerprint);
  });
  it("honors an explicitly selected Codex home and rejects relative directories", async () => {
    const inspect = vi.fn(async () => runtime());
    const service = new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect });
    await service.scan({ cwd, codexHome: user });
    expect(inspect).toHaveBeenCalledWith({ cwd, codexHome: user });
    await expect(service.scan({ cwd: "relative" })).rejects.toThrow("absolute");
    await expect(service.scan({ cwd, extraSkillRoots: ["relative"] })).rejects.toThrow("absolute");
  });
  it("deduplicates symlinks while preserving a native disabled skill", async () => {
    const path = join(codex, "skills", "one"); skill(path);
    const extra = join(root, "Extra"); mkdirSync(extra); symlinkSync(path, join(extra, "alias")); skill(join(extra, "two"), "other");
    const inspect = async () => ({ ...runtime(), skills: [{ name: "example", path: join(path, "SKILL.md"), enabled: false, origin: "native" as const }] });
    const result = await new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect }).scan({ cwd, extraSkillRoots: [extra] });
    expect(result.runtime.skills).toHaveLength(2);
    expect(result.runtime.skills[0]).toMatchObject({ enabled: false, origin: "native" });
    expect(result.runtime.skills[1]).toMatchObject({ enabled: null, origin: "supplemental" });
  });
  it("detects source edits and missing roots without choosing nested plugin versions", async () => {
    const extra = join(root, "Plugin"); skill(join(extra, "v1", "skills", "one")); skill(join(extra, "v2", "skills", "one"));
    const service = new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect: async () => runtime() });
    const a = await service.scan({ cwd, extraSkillRoots: [extra, join(root, "Missing")] });
    expect(a.runtime.skills).toEqual([]);
    expect(a.warnings.some(w => w.includes("not guessed"))).toBe(true);
    writeFileSync(join(codex, "config.toml"), 'model = "different fixture"\n');
    expect((await service.scan({ cwd, extraSkillRoots: [extra, join(root, "Missing")] })).fingerprint).not.toBe(a.fingerprint);
  });
  it("reports malformed supplemental skills without exposing their contents", async () => {
    const extra = join(root, "Extra"); mkdirSync(join(extra, "bad"), { recursive: true }); writeFileSync(join(extra, "bad", "SKILL.md"), "SECRET");
    const result = await new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect: async () => runtime() }).scan({ cwd, extraSkillRoots: [extra] });
    expect(result.runtime.skills).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("applies idempotent profile binding and rejects stale preview", async () => {
    const values = new Map<string, unknown>();
    const settings = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: unknown) => values.set(key, value), transaction: <T>(work: () => T) => work() };
    const inspect = vi.fn(async () => runtime());
    const service = new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect, settings, profileExists: () => true });
    const preview = await service.scan({ cwd });
    const binding = await service.apply({ profileId: "profile", scan: { cwd, fingerprint: preview.fingerprint }, overrides: { approvalPolicy: "never" } });
    expect(binding.overrides.approvalPolicy).toBe("never");
    expect(await service.apply({ profileId: "profile", scan: { cwd, fingerprint: preview.fingerprint }, overrides: { approvalPolicy: "never" } })).toEqual(binding);
    await expect(service.apply({ profileId: "profile", scan: { cwd, fingerprint: "stale" } })).rejects.toThrow("changed");
    values.set("codexSetup.binding:profile", { ...binding, overrides: { approvalPolicy: "on-request" } });
    expect(service.rollback("profile", binding.receiptId)).toEqual({ rolledBack: false, conflict: true });
    values.set("codexSetup.binding:profile", binding);
    expect(service.rollback("profile", binding.receiptId)).toEqual({ rolledBack: true, conflict: false });
    expect(values.get("codexSetup.binding:profile")).toBeNull();
  });
  it("refreshes drift without changing overrides and disconnects only the current receipt", async () => {
    const values = new Map<string, unknown>();
    const settings = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: unknown) => values.set(key, value), transaction: <T>(work: () => T) => work() };
    const service = new CodexSetupService({ realmHome: realm, userHome: user, codexHome: codex, inspect: async () => runtime(), settings, profileExists: () => true, spaceIdsForProfile: () => ["space"] });
    const preview = await service.scan({ cwd });
    const original = await service.apply({ profileId: "profile", scan: { cwd, fingerprint: preview.fingerprint }, overrides: { model: "chosen" } });
    writeFileSync(join(codex, "config.toml"), 'model = "changed"\n');
    const refreshed = await service.refresh("profile", cwd);
    expect(refreshed).toMatchObject({ changed: true, previousFingerprint: original.fingerprint, binding: { overrides: { model: "chosen" } } });
    expect(refreshed.binding.receiptId).not.toBe(original.receiptId);
    values.set("codexSetup.overrides:space:space", { reasoning: "high" });
    expect(service.disconnect("profile", original.receiptId)).toEqual({ disconnected: false, conflict: true });
    expect(service.disconnect("profile", refreshed.binding.receiptId)).toEqual({ disconnected: true, conflict: false });
    expect(values.get("codexSetup.binding:profile")).toBeNull();
    expect(values.get("codexSetup.overrides:space:space")).toBeNull();
  });
});
