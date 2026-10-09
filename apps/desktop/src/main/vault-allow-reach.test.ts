import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Methods } from "@realm/contracts/src/rpc";

/**
 * An agent cannot let a role use a secret without asking, and cannot make or widen a grant.
 *
 * A grant's "use without asking" is written by exactly one door: the Vault page's `vault:set-allow`
 * IPC handler in Electron main (`vault-ipc.ts`), which only Realm's own renderer can invoke, whose
 * controls carry `data-no-agent` (vault-page.test.tsx), and which asks macOS to confirm the person
 * (secret-store-vault.test.ts). Grants themselves are made only by the Vault page's RPC methods; no
 * tool makes one. What this file pins down is that no OTHER door exists. Read as text, like
 * unlock-policy-reach: the place a path would appear is in these files.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try { if (statSync(join(dir, "pnpm-workspace.yaml")).isFile()) return dir; } catch { /* keep climbing */ }
    dir = dirname(dir);
  }
  throw new Error(`cannot find the repo root from ${process.cwd()}`);
}
const root = repoRoot();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function sourceFiles(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(join(root, rel));
  return out;
}

describe("nothing an agent can call lets a grant through without asking", () => {
  it("the RPC surface can grant and revoke for the page, and only READ whether an allow moved", () => {
    // THE MUTANT: a `team.vaultSetAllow` method — anything holding daemon.json's token could call it.
    // (`computer.allowedApps.*` and `mcp.setAllowedTools` are other features' lists, named here so a
    // vault method cannot hide among them.)
    expect(Object.keys(Methods).filter((m) => /vault|allow|unattended/i.test(m) && !/^computer\.allowedApps\.|^mcp\.setAllowedTools$/.test(m)).sort())
      .toEqual(["team.vaultAllowChanged", "team.vaultGrant", "team.vaultGrants", "team.vaultRevoke", "team.vaultUses"]);
  });

  it("realm-server has no code that sets an allow — so no MCP tool or bridge op can", () => {
    const hits = sourceFiles("apps/server/src")
      .filter((f) => /setVaultAllow|vault:set-allow|vaultSetAllow/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it("the vault's MCP tools read and use, and none grants, allows or reveals", () => {
    const names = sourceFiles("apps/server/src")
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bname:\s*"([a-z]+_[a-z_]+)"/g)].map((m) => m[1]!));
    expect(names.filter((n) => /^vault_|grant|allow|unattended|secret/i.test(n)).sort()).toEqual(["vault_http", "vault_list"]);
  });

  it("only the Vault page's RPC methods make a grant", () => {
    const callers = sourceFiles("apps/server/src")
      .filter((f) => /vault\.grant\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(callers).toEqual(["apps/server/src/team/vault/rpc.ts"]);
  });

  it("the bridge carries no op that sets an allow, adds a secret or opens one", () => {
    const bridge = read("apps/server/src/browsers/host-bridge.ts");
    const ops = [...bridge.slice(bridge.indexOf("export const VAULT_HOST_OPS")).split("] as const")[0]!.matchAll(/^\s+"(\w+)",/gm)].map((m) => m[1]);
    expect(ops).toEqual(["vaultSecrets", "vaultAllowed", "vaultForgetAllow", "vaultHttp"]);
  });

  it("main calls setVaultAllow from the Vault page's IPC handler and nowhere else", () => {
    const callers = sourceFiles("apps/desktop/src/main")
      .filter((f) => /\.setVaultAllow\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(callers).toEqual(["apps/desktop/src/main/vault-ipc.ts"]);
    const ipc = read("apps/desktop/src/main/vault-ipc.ts").split("\n");
    const handler = ipc.findIndex((l) => l.includes('d.handle("vault:set-allow"'));
    const call = ipc.findIndex((l) => l.includes(".setVaultAllow("));
    expect(handler).toBeGreaterThan(-1);
    expect(call - handler).toBeGreaterThan(0);
    expect(call - handler).toBeLessThan(8);
  });

  it("the store keeps allows in its own sealed file, never in realm.db's settings", () => {
    expect(read("apps/desktop/src/main/secret-store.ts")).not.toMatch(/settings\.(get|set)\(|realm\.db"/);
    expect(read("apps/desktop/src/main/vault-host.ts")).not.toMatch(/setVaultAllow|addKey|addCredential/);
  });
});
