import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Methods } from "@realm/contracts/src/rpc";

/**
 * An agent cannot change how sign-ins are unlocked.
 *
 * The policy is written by exactly one door: Settings' `credentials:set-unlock-policy` IPC handler in
 * Electron main, which only Realm's own renderer can invoke (a browser pane has no preload), whose
 * control carries `data-no-agent` (asserted in no-agent-surfaces.test.tsx), and which asks macOS to
 * confirm the user before any weakening (secret-store-unlock.test.ts). What this file pins down is that
 * no OTHER door exists: no RPC method (anything holding daemon.json's token can call those), no MCP
 * tool, no bridge op from realm-server, and no realm.db setting the store reads.
 *
 * Read as text, like no-agent-surfaces: what is asserted is the absence of a path, and the place a
 * path would appear is in these files.
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

describe("nothing an agent can call changes an unlock policy", () => {
  it("no RPC method names one (the WebSocket is reachable by anything that reads daemon.json)", () => {
    // THE MUTANT: a `credentials.setUnlockPolicy` method added to the server's surface.
    // (`eggs.unlock` is a friend group's word, unrelated to sign-ins — named here so it cannot hide one.)
    expect(Object.keys(Methods).filter((m) => /unlock|presence|credential|passkey/i.test(m))).toEqual(["eggs.unlock"]);
  });

  it("realm-server has no code that reads, writes or forwards one — so no MCP tool or bridge op can", () => {
    const hits = sourceFiles("apps/server/src")
      .filter((f) => /setUnlockPolicy|set-unlock-policy|UnlockPolicy|unlockPolicy/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it("no MCP tool is named for it", () => {
    const names = sourceFiles("apps/server/src")
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bname:\s*"([a-z]+_[a-z_]+)"/g)].map((m) => m[1]!));
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => /unlock|presence|policy|touch/i.test(n))).toEqual([]);
  });

  it("main calls setUnlockPolicy from the Settings IPC handler and nowhere else", () => {
    const lines = read("apps/desktop/src/main/index.ts").split("\n");
    const calls = lines.flatMap((l, i) => (l.includes(".setUnlockPolicy(") ? [i] : []));
    const handler = lines.findIndex((l) => l.includes('ipcMain.handle("credentials:set-unlock-policy"'));
    expect(handler).toBeGreaterThan(-1);
    expect(calls).toHaveLength(1);
    expect(calls[0]! - handler).toBeGreaterThan(0);
    expect(calls[0]! - handler).toBeLessThan(8);
  });

  it("the bridge-facing hosts are handed no way to it", () => {
    // The agent host's and the passkey broker's reach into the store is a bag of named methods;
    // neither bag may carry the setter.
    for (const f of ["apps/desktop/src/main/browser-agent-host.ts", "apps/desktop/src/main/passkeys.ts", "apps/desktop/src/main/app-drive.ts"]) {
      expect(read(f), f).not.toMatch(/setUnlockPolicy/);
    }
  });

  it("the store reads its policy from its own sealed file, never from realm.db's settings", () => {
    const store = read("apps/desktop/src/main/secret-store.ts");
    expect(store).not.toMatch(/settings\.(get|set)\(|realm\.db"/);
  });
});
