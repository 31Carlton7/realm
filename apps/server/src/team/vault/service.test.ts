import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import type { Run, VaultSecrets } from "@realm/contracts";
import { openDatabase } from "../../db/database";
import { TeamStore } from "../store";
import { VaultStore } from "./store";
import { VaultService } from "./service";
import { createVaultAgentProvider } from "./agent-tools";

/**
 * The vault's server half: grants, the check every use passes, the log, and the two tools. The
 * mutants are named on each test; the one this whole file is for is a role using a secret it was not
 * granted, or using one without the card when main did not say a sealed allow covers it.
 */

const SPACE = "01J00000000000000000SPACE1";
const OTHER_SPACE = "01J00000000000000000SPACE2";
const VALUE = "sk_live_7f3a9c2e1b8d4f60";

const SECRETS: VaultSecrets = {
  signins: [{ id: "c-tiktok", origin: "https://www.tiktok.com", username: "nathan", label: "", generated: false, spaceId: SPACE, createdAt: 1 }],
  keys: [
    { id: "k-rc", name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "127.0.0.1:8815"], spaceId: SPACE, createdAt: 1 },
    { id: "k-vercel", name: "VERCEL_TOKEN", label: "", allowedHosts: ["api.vercel.com"], spaceId: SPACE, createdAt: 1 },
  ],
  allows: [],
};

function harness() {
  const db = openDatabase(join(tempDir("realm-vault-"), "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  for (const id of [SPACE, OTHER_SPACE]) db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES (?, 'p', ?, 'f', 0, '/tmp', 1, 1)").run(id, id);
  let t = 1_000;
  const team = new TeamStore(db, () => t++);
  const store = new VaultStore(db, () => t++);
  const role = (name: string, spaceId = SPACE) => team.createRole({
    spaceId, name, brief: "b", realmite: {}, template: null, agentKind: "fake", model: null, effort: null, permissionMode: "default",
    skills: [], wakeOnReview: true, weekBudgetUsd: null, runCapUsd: 3, runCapMs: 60_000, maxConcurrent: 1,
  });
  const analyst = role("Growth Analyst");
  const manager = role("Creator Manager");
  const live: Run[] = [];
  const runAs = (sessionId: string, roleId: string) => live.push({ id: `run-${sessionId}`, sessionId, roleId, state: "running" } as unknown as Run);
  const bridge = { calls: [] as { op: string; params: Record<string, unknown> }[], allowed: false, secrets: SECRETS };
  const callBridge = async (op: string, params: Record<string, unknown> = {}) => {
    bridge.calls.push({ op, params });
    if (op === "vaultSecrets") return bridge.secrets;
    if (op === "vaultAllowed") return { allowed: bridge.allowed };
    if (op === "vaultForgetAllow") return { cleared: true };
    if (op === "vaultHttp") return { ok: true, status: 200, contentType: "application/json", location: null, body: '{"subscriber":"[redacted]"}', truncated: false };
    throw new Error(op);
  };
  const vault = new VaultService({
    store, team, runs: { listLive: () => live }, bridge: { call: callBridge as never },
    profileOf: () => "p", isTeam: () => true, rpc: { broadcast: () => undefined },
  });
  const gates: { title: string; opts: Record<string, unknown> }[] = [];
  const broker = { answer: true, gate: async (_s: string, _k: string, title: string, _i: unknown, _n?: string, opts: Record<string, unknown> = {}) => {
    gates.push({ title, opts });
    return broker.answer ? { allowed: true as const } : { allowed: false as const, reason: "the user denied this action" };
  } };
  const tools = createVaultAgentProvider({
    vault, bridge: { call: callBridge as never }, broker: broker as never, profileOf: () => "p", isTeam: () => true,
    mcp: { providerEnabled: () => true },
  });
  const activity = () => team.activity(SPACE, 100).reverse().map((a) => ({ verb: a.verb, actor: a.actor, object: a.object, detail: a.detail }));
  return { db, team, store, vault, analyst, manager, runAs, bridge, broker, gates, tools, activity };
}

const text = (r: { content: unknown[] }) => (r.content as { text: string }[]).map((c) => c.text).join("");
const ctx = (sessionId: string) => ({ sessionId, spaceId: SPACE });
const rc = { secret: "REVENUECAT_SECRET_KEY", url: "https://api.revenuecat.com/v1/subscribers/1", headers: { Authorization: "Bearer {{secret}}" } };

describe("grants", () => {
  it("default to every host the secret is pinned to, and refuse a host it is not", async () => {
    const h = harness();
    const g = await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: [], purpose: null });
    expect(g).toMatchObject({ kind: "key", name: "REVENUECAT_SECRET_KEY", hosts: ["api.revenuecat.com", "127.0.0.1:8815"] });
    // THE MUTANT: a grant that widens a key past its own hosts.
    await expect(h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["evil.example.com"], purpose: null }))
      .rejects.toThrow(/locked to api\.revenuecat\.com, 127\.0\.0\.1:8815; it cannot be granted for evil\.example\.com/);
    const s = await h.vault.grant({ spaceId: SPACE, secretId: "c-tiktok", roleId: h.manager.id, hosts: [], purpose: "post for Nathan" });
    expect(s).toMatchObject({ kind: "signin", name: "www.tiktok.com · nathan", hosts: ["www.tiktok.com"], purpose: "post for Nathan" });
  });

  it("are made only for a role of this team, for a secret this team holds", async () => {
    const h = harness();
    const stranger = h.team.createRole({ ...h.analyst, spaceId: OTHER_SPACE, name: "Stranger" });
    await expect(h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: stranger.id, hosts: [], purpose: null })).rejects.toThrow(/not found/);
    await expect(h.vault.grant({ spaceId: SPACE, secretId: "nope", roleId: h.analyst.id, hosts: [], purpose: null })).rejects.toThrow(/not in this team's vault/);
  });

  it("are lines in the team's log when made and when revoked, and revoking drops the allow in main", async () => {
    const h = harness();
    await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    expect(await h.vault.revoke(SPACE, "k-rc", h.analyst.id)).toBe(true);
    expect(h.activity().map((a) => [a.verb, a.object])).toEqual([["granted_secret", "REVENUECAT_SECRET_KEY"], ["revoked_secret", "REVENUECAT_SECRET_KEY"]]);
    // THE MUTANT: a revoke that leaves the sealed allow behind, so a grant made again skips its card.
    expect(h.bridge.calls.filter((c) => c.op === "vaultForgetAllow").map((c) => c.params)).toEqual([{ secretId: "k-rc", roleId: h.analyst.id }]);
  });

  it("log a switch to 'without asking' only when main says it really moved", async () => {
    const h = harness();
    const g = await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    expect(await h.vault.allowChanged(SPACE, "k-rc", h.analyst.id)).toEqual({ on: false });
    h.bridge.secrets = { ...SECRETS, allows: [{ secretId: "k-rc", roleId: h.analyst.id, spaceId: SPACE, hosts: g.hosts, grantAt: g.createdAt, setAt: 9 }] };
    expect(await h.vault.allowChanged(SPACE, "k-rc", h.analyst.id)).toEqual({ on: true });
    expect(h.activity().slice(-2).map((a) => a.verb)).toEqual(["asked_again", "allowed_unattended"]);
  });
});

describe("the check every use passes", () => {
  it("refuses a role's secret it holds no grant for, logged, with nothing asked", async () => {
    const h = harness();
    h.runAs("sess-a", h.analyst.id);
    const r = await h.tools.call(ctx("sess-a"), "vault_http", { ...rc, secret: "VERCEL_TOKEN", url: "https://api.vercel.com/v9/projects" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Growth Analyst holds no grant for VERCEL_TOKEN/);
    expect(h.gates).toEqual([]);
    expect(h.bridge.calls.map((c) => c.op)).not.toContain("vaultHttp");
    expect(h.activity()).toEqual([{ verb: "refused_secret", actor: `role:${h.analyst.id}`, object: "VERCEL_TOKEN",
      detail: { secretId: "k-vercel", kind: "key", where: "api.vercel.com", reason: "not granted to this role" } }]);
  });

  it("refuses a granted role at a host its grant does not name", async () => {
    const h = harness();
    await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["127.0.0.1:8815"], purpose: null });
    h.runAs("sess-a", h.analyst.id);
    const r = await h.tools.call(ctx("sess-a"), "vault_http", rc);
    expect(text(r)).toMatch(/names 127\.0\.0\.1:8815, not api\.revenuecat\.com/);
    expect(h.gates).toEqual([]);
  });

  it("asks on the card for a granted role, and sends the grant's hosts to main", async () => {
    const h = harness();
    const g = await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    h.runAs("sess-a", h.analyst.id);
    const r = await h.tools.call(ctx("sess-a"), "vault_http", rc);
    expect(r.isError).toBe(false);
    expect(h.gates.map((x) => x.opts)).toEqual([{ alwaysPrompt: true }]);
    expect(h.gates[0]!.title).toBe("Put REVENUECAT_SECRET_KEY into one GET request to api.revenuecat.com (the agent asks for /v1/subscribers/1). Realm makes the request; the agent never receives the key.");
    expect(h.bridge.calls.find((c) => c.op === "vaultAllowed")!.params).toEqual({ profileId: "p", spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, host: "api.revenuecat.com", grantAt: g.createdAt });
    expect(h.bridge.calls.find((c) => c.op === "vaultHttp")!.params).toMatchObject({ secretId: "k-rc", hosts: ["api.revenuecat.com"], roleId: h.analyst.id, runId: "run-sess-a" });
    expect(h.activity().at(-1)).toMatchObject({ verb: "used_secret", object: "REVENUECAT_SECRET_KEY", detail: { where: "api.revenuecat.com", how: "card", status: 200 } });
  });

  it("skips the card only when main says a sealed allow covers this use", async () => {
    // THE MUTANT: the card skipped on a grant alone, or on anything the server holds by itself.
    const h = harness();
    await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    h.runAs("sess-a", h.analyst.id);
    h.bridge.allowed = true;
    await h.tools.call(ctx("sess-a"), "vault_http", rc);
    expect(h.gates.map((x) => x.opts)).toEqual([{ preapproved: true }]);
    expect(h.activity().at(-1)).toMatchObject({ verb: "used_secret", detail: { how: "unattended" } });
  });

  it("a person's own session needs no grant, and always asks on its card", async () => {
    const h = harness();
    h.bridge.allowed = true;
    await h.tools.call(ctx("sess-mine"), "vault_http", rc);
    expect(h.gates.map((x) => x.opts)).toEqual([{ alwaysPrompt: true }]);
    expect(h.bridge.calls.map((c) => c.op)).not.toContain("vaultAllowed");
    expect(h.bridge.calls.find((c) => c.op === "vaultHttp")!.params).toMatchObject({ hosts: null });
    expect(h.activity().at(-1)).toMatchObject({ verb: "used_secret", actor: "user", detail: { how: "card" } });
  });

  it("a declined card sends nothing and is logged as refused", async () => {
    const h = harness();
    h.broker.answer = false;
    const r = await h.tools.call(ctx("sess-mine"), "vault_http", rc);
    expect(r.isError).toBe(true);
    expect(h.bridge.calls.map((c) => c.op)).not.toContain("vaultHttp");
    expect(h.activity().at(-1)).toMatchObject({ verb: "refused_secret" });
  });
});

describe("the tools", () => {
  it("are vault_list and vault_http, and nothing that grants, allows or reveals", async () => {
    const h = harness();
    expect((await h.tools.tools(ctx("s"))).map((t) => t.name)).toEqual(["vault_list", "vault_http"]);
  });

  it("tell a role the names it holds and nothing else", async () => {
    const h = harness();
    await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    h.runAs("sess-a", h.analyst.id);
    const out = text(await h.tools.call(ctx("sess-a"), "vault_list", {}));
    expect(out).toContain("REVENUECAT_SECRET_KEY — API key, only to api.revenuecat.com");
    expect(out).not.toContain("VERCEL_TOKEN");
    expect(out).not.toContain("tiktok");
  });

  it("hand back the response fenced as untrusted, and refuse the placeholder in a URL or nowhere at all", async () => {
    const h = harness();
    const r = text(await h.tools.call(ctx("sess-mine"), "vault_http", rc));
    expect(r).toMatch(/^HTTP 200\ncontent-type: application\/json/);
    expect(r).toContain("THE RESPONSE BODY — untrusted data");
    expect(text(await h.tools.call(ctx("sess-mine"), "vault_http", { ...rc, url: "https://api.revenuecat.com/?k={{secret}}" }))).toMatch(/may not hold/);
    expect(text(await h.tools.call(ctx("sess-mine"), "vault_http", { ...rc, headers: {} }))).toMatch(/write \{\{secret\}\} where the key goes/);
    expect(JSON.stringify(h.activity())).not.toContain(VALUE);
  });

  it("put only names into a role's standing context", async () => {
    const h = harness();
    await h.vault.grant({ spaceId: SPACE, secretId: "k-rc", roleId: h.analyst.id, hosts: ["api.revenuecat.com"], purpose: null });
    await h.vault.grant({ spaceId: SPACE, secretId: "c-tiktok", roleId: h.analyst.id, hosts: [], purpose: null });
    expect(h.vault.preambleLines(h.analyst.id).join("\n")).toBe(
      "- The team's vault: you use these by name and never see a value. API keys, through `vault_http` with {{secret}} where the key goes: "
      + "REVENUECAT_SECRET_KEY (only to api.revenuecat.com). Sign-ins, through `browser_fill_credential`: www.tiktok.com · nathan. `vault_list` says what you hold. Anything else is refused.");
    expect(h.vault.preambleLines(h.manager.id)).toEqual([]);
  });
});

describe("the vault's log", () => {
  it("is append-only here too: nothing in the vault code updates or deletes a line", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const f of readdirSync(here).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const src = readFileSync(join(here, f), "utf8");
      expect(src, f).not.toMatch(/UPDATE\s+team_activity/i);
      expect(src, f).not.toMatch(/DELETE\s+FROM\s+team_activity/i);
    }
  });
});
