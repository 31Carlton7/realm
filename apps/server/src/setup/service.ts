import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inspectCodexSetup } from "@realm/adapters";
import { CodexSetupBindingSchema, CodexSetupReceiptSchema, CodexSetupScanSchema, type CodexSetupBinding, type CodexSetupScan } from "@realm/contracts";
import { scan } from "../skills/discovery";
import { parseFrontmatter } from "../skills/frontmatter";
import { RpcError } from "../store/rows";

const sameBinding = (a: CodexSetupBinding, b: Omit<CodexSetupBinding, "receiptId" | "appliedAt">) =>
  a.profileId === b.profileId && a.codexHome === b.codexHome && a.fingerprint === b.fingerprint &&
  JSON.stringify(a.extraSkillRoots) === JSON.stringify(b.extraSkillRoots) && JSON.stringify(a.overrides) === JSON.stringify(b.overrides);

/** Read-only inventory. Deliberately has no settings/database or filesystem-write dependency. */
export class CodexSetupService {
  constructor(private d: { realmHome: string; userHome?: string; codexHome?: string; inspect?: typeof inspectCodexSetup; settings?: { get(key: string): unknown; set(key: string, value: unknown): void; transaction<T>(work: () => T): T }; profileExists?: (id: string) => boolean }) {}
  private key(profileId: string) { return `codexSetup.binding:${profileId}`; }
  private receiptKey(profileId: string, receiptId: string) { return `codexSetup.receipt:${profileId}:${receiptId}`; }

  async scan(input: { cwd: string; codexHome?: string; extraSkillRoots?: string[] }): Promise<CodexSetupScan> {
    const user = this.d.userHome ?? homedir();
    const codex = input.codexHome ?? this.d.codexHome ?? process.env.CODEX_HOME ?? join(user, ".codex");
    const extras = [...new Set(input.extraSkillRoots ?? [])];
    if (![input.cwd, user, codex, this.d.realmHome, ...extras].every(isAbsolute)) throw new RpcError("BAD_REQUEST", "Setup source directories must be absolute");
    const cwd = resolve(input.cwd);
    const runtime = await (this.d.inspect ?? inspectCodexSetup)({ cwd, codexHome: codex });
    const warnings: string[] = [];
    const sources: CodexSetupScan["sources"] = [];
    const stamps: unknown[] = [];
    const seen = new Set<string>();
    const source = (path: string, kind: CodexSetupScan["sources"][number]["kind"]) => {
      if (!isAbsolute(path)) { warnings.push("Runtime reported a relative source path; it was not read."); return null; }
      let canonical = resolve(path);
      let state: "present" | "missing" | "unreadable" = "present";
      try {
        canonical = realpathSync(path);
        const s = statSync(canonical);
        accessSync(canonical, constants.R_OK);
        stamps.push([canonical, s.mtimeMs, s.size]);
      } catch (e) { state = (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
      if (!seen.has(canonical)) { sources.push({ path: canonical, kind, state }); seen.add(canonical); }
      return canonical;
    };
    source(join(codex, "config.toml"), "config");
    source(join(codex, "AGENTS.md"), "instructions");
    source(join(codex, "memories"), "memory");
    source(join(codex, "memories", "memory_summary.md"), "memory");
    source(join(codex, "memories", "MEMORY.md"), "memory");
    for (let p = cwd; ; p = dirname(p)) {
      source(join(p, "AGENTS.md"), "instructions");
      if (dirname(p) === p) break;
    }
    const skillPaths = new Set<string>();
    runtime.skills = runtime.skills.filter(skill => {
      const path = source(skill.path, "skill");
      if (!path || skillPaths.has(path)) return false;
      skill.path = path; skillPaths.add(path); return true;
    });
    for (const [index, root] of extras.entries()) {
      source(root, "skillRoot");
      const entries = scan([{ kind: "extra", key: `selected-${index}`, label: "Selected source", path: root }]);
      if (!entries.length) warnings.push(`Selected root ${index + 1} contains no directly discoverable skills; nested plugin versions were not guessed.`);
      for (const entry of entries) {
        const path = source(join(entry.dir, "SKILL.md"), "skill");
        if (!path || skillPaths.has(path)) continue;
        try {
          const meta = parseFrontmatter(readFileSync(path, "utf8"));
          if (!meta?.name || !meta.description) { warnings.push(`Selected source ${index + 1} contains invalid skill metadata.`); continue; }
          runtime.skills.push({ name: meta.name, path, enabled: null, origin: "supplemental" });
          skillPaths.add(path);
        } catch { warnings.push(`Selected source ${index + 1} contains an unreadable skill.`); }
      }
    }
    for (const [name, state] of Object.entries(runtime.components)) if (state !== "available") warnings.push(`Codex ${name} inspection is ${state}; no capability success is inferred.`);
    const inventory = { cwd, homes: { user, codex, realm: this.d.realmHome }, runtime, sources, warnings };
    const fingerprint = createHash("sha256").update(JSON.stringify([inventory, stamps])).digest("hex");
    return CodexSetupScanSchema.parse({ ...inventory, fingerprint });
  }

  async apply(input: { profileId: string; scan: { cwd: string; codexHome?: string; extraSkillRoots?: string[]; fingerprint: string }; overrides?: CodexSetupBinding["overrides"] }): Promise<CodexSetupBinding> {
    if (!this.d.settings) throw new RpcError("INTERNAL", "Setup bindings are unavailable");
    const current = await this.scan(input.scan);
    if (current.fingerprint !== input.scan.fingerprint) throw new RpcError("STALE_PREVIEW", "Codex setup changed since preview");
    const prior = CodexSetupBindingSchema.safeParse(this.d.settings.get(this.key(input.profileId)));
    const desired = { profileId: input.profileId, codexHome: current.homes.codex, extraSkillRoots: input.scan.extraSkillRoots ?? [], overrides: input.overrides ?? {}, fingerprint: current.fingerprint };
    if (prior.success && sameBinding(prior.data, desired)) return prior.data;
    const binding: CodexSetupBinding = { ...desired, receiptId: randomUUID(), appliedAt: Date.now() };
    return this.d.settings.transaction(() => {
      if (this.d.profileExists && !this.d.profileExists(input.profileId)) throw new RpcError("NOT_FOUND", `profile ${input.profileId} not found`);
      this.d.settings!.set(this.receiptKey(input.profileId, binding.receiptId), { receiptId: binding.receiptId, applied: binding, previous: prior.success ? prior.data : null });
      this.d.settings!.set(this.key(input.profileId), binding);
      return binding;
    });
  }

  rollback(profileId: string, receiptId: string): { rolledBack: boolean; conflict: boolean } {
    if (!this.d.settings) throw new RpcError("INTERNAL", "Setup bindings are unavailable");
    return this.d.settings.transaction(() => {
      const receipt = CodexSetupReceiptSchema.safeParse(this.d.settings!.get(this.receiptKey(profileId, receiptId)));
      if (!receipt.success) return { rolledBack: false, conflict: false };
      const current = this.d.settings!.get(this.key(profileId));
      const binding = CodexSetupBindingSchema.safeParse(current);
      if (!binding.success || !sameBinding(binding.data, receipt.data.applied) || binding.data.receiptId !== receiptId || binding.data.appliedAt !== receipt.data.applied.appliedAt) return { rolledBack: false, conflict: true };
      this.d.settings!.set(this.key(profileId), receipt.data.previous);
      this.d.settings!.set(this.receiptKey(profileId, receiptId), null);
      return { rolledBack: true, conflict: false };
    });
  }
}
