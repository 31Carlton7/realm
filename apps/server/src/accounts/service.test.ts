import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { AccountKind, AgentKind, AgentSignIn } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { AccountsStore } from "../store/accounts";
import type { SignInAccount } from "../agents/signin-service";
import { AccountsService, accountsRoot } from "./service";
import { codexIdentity, type AccountProbe } from "./probe";

function fresh(o: { probe?: (kind: AccountKind, dir: string | null) => AccountProbe; busy?: boolean } = {}) {
  const home = tempDir("realm-accounts-");
  const db = openDatabase(join(home, "realm.db"));
  const store = new AccountsStore(db);
  const started: { kind: AgentKind; account: SignInAccount | null }[] = [];
  const loggedOut: string[] = [];
  const stopped: string[] = [];
  const broadcasts: string[] = [];
  const defaults = { claude: join(home, "dot-claude"), codex: join(home, "dot-codex") };
  const svc = new AccountsService({
    home, store, rpc: { broadcast: (name) => { broadcasts.push(name); } },
    signIn: { start: async (kind, account) => { started.push({ kind, account }); return { id: "si1", kind, accountId: account?.id ?? null, state: "starting", url: null, detail: null } satisfies AgentSignIn; } },
    probe: async (kind, dir) => o.probe?.(kind, dir) ?? { signedIn: true, email: dir ? "work@example.com" : "me@example.com", plan: "max" },
    logout: async (_kind, dir) => { loggedOut.push(dir); },
    defaults,
    sessions: { busy: () => o.busy ?? false, stopOn: async (id) => { stopped.push(id); } },
  });
  return { home, db, store, svc, started, loggedOut, stopped, broadcasts, defaults };
}

describe("AccountsService", () => {
  it("starts with each CLI's own account, which runs on the CLI's own folder", async () => {
    const { svc } = fresh();
    const all = await svc.list();
    expect(all.map((a) => [a.id, a.kind, a.label, a.configDir])).toEqual([["default-claude", "claude", "Default", null], ["default-codex", "codex", "Default", null]]);
    expect(svc.envFor("claude", "default-claude")).toEqual({});
    expect(svc.envFor("claude", null)).toEqual({});
  });

  it("adds an account as a folder under Realm's home, and signs it in there", async () => {
    const { home, svc, started } = fresh();
    const { account, signIn } = await svc.add("claude", "Work");
    expect(account.configDir).toBe(join(accountsRoot(home), "claude", account.id));
    expect(existsSync(account.configDir!)).toBe(true);
    expect(signIn).toMatchObject({ accountId: account.id, state: "starting" });
    // The CLI's own login, run with the account's folder named the way the CLI reads it.
    expect(started[0]!.account!.dirEnv).toEqual({ CLAUDE_CONFIG_DIR: account.configDir });
    expect(svc.envFor("claude", account.id)).toEqual({ CLAUDE_CONFIG_DIR: account.configDir });
    // Another agent's session never picks up this folder.
    expect(svc.envFor("codex", account.id)).toEqual({});
    const codex = await svc.add("codex");
    expect(codex.account.label).toBe("Account 2");
    expect(started[1]!.account!.dirEnv).toEqual({ CODEX_HOME: codex.account.configDir });
  });

  it("asks the CLI who is signed in, and keeps the email and plan it reports", async () => {
    const asked: (string | null)[] = [];
    const { svc, started } = fresh({ probe: (_k, dir) => { asked.push(dir); return { signedIn: true, email: "work@example.com", plan: "max" }; } });
    const { account } = await svc.add("claude", "Work");
    // The sign-in's own check asks the account's folder, not the agent's default one.
    expect(await started[0]!.account!.signedIn()).toBe(true);
    expect(asked).toEqual([account.configDir]);
    await svc.list({ refresh: true });
    expect((await svc.list()).find((a) => a.id === account.id)).toMatchObject({ signedIn: true, email: "work@example.com", plan: "max" });
  });

  it("refuses an agent whose CLI keeps one login", async () => {
    const { svc } = fresh();
    await expect(svc.add("acp:cursor")).rejects.toThrow(/keeps one login/);
  });

  it("removes an added account: signed out with its CLI, folder deleted, sessions put back", async () => {
    const { svc, loggedOut, stopped, broadcasts } = fresh();
    const { account } = await svc.add("claude", "Work");
    await svc.remove(account.id);
    expect(loggedOut).toEqual([account.configDir]);
    expect(stopped).toEqual([account.id]);
    expect(existsSync(account.configDir!)).toBe(false);
    expect((await svc.list()).some((a) => a.id === account.id)).toBe(false);
    expect(broadcasts).toContain("accounts.changed");
  });

  it("keeps the CLI's own account, and an account a session is working on", async () => {
    const { svc } = fresh();
    await expect(svc.remove("default-claude")).rejects.toThrow(/own account can't be removed/);
    const busy = fresh({ busy: true });
    const { account } = await busy.svc.add("codex", "Work");
    await expect(busy.svc.remove(account.id)).rejects.toThrow(/is working/);
  });

  it("offers the agent's other accounts, but not one known to be signed out", async () => {
    const { svc } = fresh({ probe: (_k, dir) => ({ signedIn: dir === null, email: null, plan: null }) });
    const { account } = await svc.add("claude", "Work");
    expect(svc.others("claude", "default-claude")).toEqual([{ id: account.id, label: "Work" }]);
    await svc.list({ refresh: true });
    expect(svc.others("claude", "default-claude")).toEqual([]);
    expect(svc.others("claude", account.id)).toEqual([{ id: "default-claude", label: "Default" }]);
  });
});

describe("carrying a conversation between accounts", () => {
  it("copies Claude's transcript into the new folder's project, so a resume finds it", async () => {
    const { svc, defaults } = fresh();
    const { account } = await svc.add("claude", "Work");
    const project = join(defaults.claude, "projects", "-work-app");
    mkdirSync(join(project, "sess-1", "tool-results"), { recursive: true });
    writeFileSync(join(project, "sess-1.jsonl"), "{\"type\":\"user\"}\n");
    writeFileSync(join(project, "sess-1", "tool-results", "r.txt"), "x");
    expect(await svc.carry("claude", "sess-1", null, account.id)).toBe(true);
    expect(readFileSync(join(account.configDir!, "projects", "-work-app", "sess-1.jsonl"), "utf8")).toBe("{\"type\":\"user\"}\n");
    expect(existsSync(join(account.configDir!, "projects", "-work-app", "sess-1", "tool-results", "r.txt"))).toBe(true);
  });

  it("copies Codex's rollout to the same dated place in the new home", async () => {
    const { svc, defaults } = fresh();
    const { account } = await svc.add("codex", "Work");
    const day = join(defaults.codex, "sessions", "2026", "11", "02");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-11-02T10-00-00-th_abc.jsonl"), "{}\n");
    expect(await svc.carry("codex", "th_abc", null, account.id)).toBe(true);
    expect(existsSync(join(account.configDir!, "sessions", "2026", "11", "02", "rollout-2026-11-02T10-00-00-th_abc.jsonl"))).toBe(true);
  });

  it("says so when there is nothing to carry, so the caller hands over as text", async () => {
    const { svc } = fresh();
    const { account } = await svc.add("claude", "Work");
    expect(await svc.carry("claude", "missing", null, account.id)).toBe(false);
  });
});

describe("codexIdentity", () => {
  it("reads the email and plan out of the ID token Codex's login keeps", async () => {
    const home = tempDir("realm-codex-id-");
    const claims = { email: "you@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } };
    const token = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: token } }));
    expect(await codexIdentity(home)).toEqual({ email: "you@example.com", plan: "pro" });
    expect(await codexIdentity(join(home, "nowhere"))).toEqual({ email: null, plan: null });
  });
});

describe("re-homing a conversation for a new working directory", () => {
  const project = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const seed = (cfg: string, cwd: string, id: string, body: string) => {
    const dir = join(cfg, "projects", project(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), body);
    return join(dir, `${id}.jsonl`);
  };

  it("copies Claude's record into the new cwd's project, preferring the copy the old cwd resumes, and undoes it", async () => {
    const { svc, defaults, home: h } = fresh();
    // The CLI names a project after the cwd with symlinks resolved — /var is /private/var on a Mac.
    const home = realpathSync(h);
    const from = join(home, "repo"), to = join(home, "wt");
    mkdirSync(from); mkdirSync(to);
    seed(defaults.claude, "/elsewhere", "s1", "stale\n");
    seed(defaults.claude, from, "s1", "current\n");
    mkdirSync(join(defaults.claude, "projects", project(from), "s1", "tool-results"), { recursive: true });
    const undo = await svc.rehome("claude", "s1", null, { from, to });
    const dest = join(defaults.claude, "projects", project(to), "s1.jsonl");
    expect(readFileSync(dest, "utf8")).toBe("current\n");
    expect(existsSync(join(defaults.claude, "projects", project(to), "s1", "tool-results"))).toBe(true);
    await undo!();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(defaults.claude, "projects", project(to), "s1"))).toBe(false);
  });

  it("writes over an older copy at the destination, and puts that copy back on undo", async () => {
    const { svc, defaults, home: h } = fresh();
    const home = realpathSync(h);
    const from = join(home, "wt"), to = join(home, "repo");
    mkdirSync(from); mkdirSync(to);
    seed(defaults.claude, from, "s1", "newer\n");
    const dest = seed(defaults.claude, to, "s1", "older\n");
    const undo = await svc.rehome("claude", "s1", null, { from, to });
    expect(readFileSync(dest, "utf8")).toBe("newer\n");
    await undo!();
    expect(readFileSync(dest, "utf8")).toBe("older\n");
  });

  it("needs nothing for Codex, and cannot for an agent with no record Realm can find", async () => {
    const { svc, home } = fresh();
    expect(await svc.rehome("codex", "th", null, { from: home, to: home })).toBeTypeOf("function");
    expect(await svc.rehome("claude", "missing", null, { from: home, to: join(home, "x") })).toBeNull();
    expect(await svc.rehome("acp:cursor", "s", null, { from: home, to: join(home, "x") })).toBeNull();
  });

  it("refuses a cwd whose project name the CLI would shorten", async () => {
    const { svc, defaults, home } = fresh();
    seed(defaults.claude, home, "s1", "x\n");
    expect(await svc.rehome("claude", "s1", null, { from: home, to: join(home, "d".repeat(220)) })).toBeNull();
  });
});
