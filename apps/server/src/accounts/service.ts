import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  ACCOUNT_DIR_ENV, agentLabel, hasAccounts, newId,
  type Account, type AccountKind, type AgentKind, type AgentSignIn,
} from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import type { SignInAccount } from "../agents/signin-service";
import type { AccountRow, AccountsStore } from "../store/accounts";
import { RpcError } from "../store/rows";
import type { AccountProbe } from "./probe";
import { claudeProjectName } from "../memory/claude-backfill";

/** Where added accounts keep their folders: `accounts/<kind>/<id>`, one per account, under Realm's
 *  home beside its other folders of its own. */
export const accountsRoot = (home: string): string => join(home, "accounts");

/** How long a CLI's answer about an account is reused before a list asks it again. */
export const ACCOUNT_PROBE_TTL_MS = 30_000;

export type AccountsDeps = {
  home: string;
  store: AccountsStore;
  rpc: Pick<RpcServer, "broadcast">;
  signIn: { start(kind: AgentKind, account: SignInAccount | null): Promise<AgentSignIn> };
  /** Ask a CLI about one account, in its folder. */
  probe: (kind: AccountKind, configDir: string | null) => Promise<AccountProbe>;
  /** The CLI's own logout, run in an account's folder before the folder goes, so its credential — a
   *  Keychain item for Claude — goes with it. Best effort. */
  logout?: (kind: AccountKind, configDir: string) => Promise<void>;
  /** Where each CLI keeps its own default account, for carrying a conversation out of it or into it;
   *  null where it must not be read (a suite, a live check). */
  defaults?: Partial<Record<AccountKind, string | null>>;
  /** The sessions on an account: whether one is mid-turn, and stopping their engines so the next start
   *  is on whatever account they are left on. */
  sessions: { busy(accountId: string): boolean; stopOn(accountId: string): Promise<void> };
  now?: () => number;
};

/**
 * The accounts each agent CLI runs on (contracts/accounts.ts): listing them with what their CLI says,
 * adding one — a folder made here and the CLI's own login run in it — renaming, signing in again and
 * removing, and the two things a session needs from one: the environment its engine starts under, and
 * a way to carry its conversation from one account's folder to another's.
 */
export class AccountsService {
  private seen = new Map<string, AccountProbe & { at: number }>();
  private asking = new Map<string, Promise<AccountProbe>>();

  constructor(private d: AccountsDeps) {}

  private now = () => this.d.now?.() ?? Date.now();

  /** Every account, with what its CLI last said. `refresh` asks again of any not asked lately. */
  async list(o: { refresh?: boolean } = {}): Promise<Account[]> {
    const rows = this.d.store.list();
    if (o.refresh) {
      await Promise.all(rows.filter((r) => this.now() - (this.seen.get(r.id)?.at ?? 0) > ACCOUNT_PROBE_TTL_MS).map((r) => this.ask(r)));
    }
    return this.d.store.list().map((r) => this.view(r));
  }

  /** Make an account's folder and start its CLI's login there. The account stays if the person never
   *  finishes, signed out, to be signed in or removed later; one whose login could not even start goes. */
  async add(kind: AgentKind, label?: string): Promise<{ account: Account; signIn: AgentSignIn }> {
    if (!hasAccounts(kind)) throw new RpcError("BAD_REQUEST", `${agentLabel(kind)} keeps one login, so Realm can't add another account for it.`);
    const id = newId();
    const dir = join(accountsRoot(this.d.home), kind, id);
    await mkdir(dir, { recursive: true });
    const n = this.d.store.list().filter((a) => a.kind === kind).length + 1;
    const row = this.d.store.create({ id, kind, label: label ?? `Account ${n}`, configDir: dir });
    let signIn: AgentSignIn;
    try {
      signIn = await this.startSignIn(row);
    } catch (e) {
      this.d.store.remove(id);
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    this.changed();
    return { account: this.view(row), signIn };
  }

  async signIn(id: string): Promise<AgentSignIn> {
    return this.startSignIn(this.d.store.require(id));
  }

  rename(id: string, label: string): Account {
    const row = this.d.store.rename(id, label);
    this.changed();
    return this.view(row);
  }

  /** Sign an added account out and delete the folder Realm made for it. Its sessions go back to the
   *  default account, their engines stopped so the next turn starts there. */
  async remove(id: string): Promise<void> {
    const a = this.d.store.require(id);
    if (a.configDir === null) throw new RpcError("BAD_REQUEST", `${agentLabel(a.kind)}'s own account can't be removed.`);
    if (this.d.sessions.busy(id)) throw new RpcError("ACCOUNT_IN_USE", `A session on ${a.label} is working. Stop it or let it finish, then remove the account.`);
    await this.d.sessions.stopOn(id);
    await this.d.logout?.(a.kind, a.configDir).catch(() => {});
    this.d.store.remove(id);
    this.seen.delete(id);
    // Only a folder this service made: a row naming anywhere else is not Realm's to delete.
    if (inside(accountsRoot(this.d.home), a.configDir)) await rm(a.configDir, { recursive: true, force: true });
    this.changed();
  }

  /** What an engine for `kind` starts under to run on `accountId`: the CLI's folder variable, or
   *  nothing for the default account — or an account that is not this agent's. */
  envFor(kind: AgentKind, accountId: string | null | undefined): Record<string, string> {
    if (!accountId || !hasAccounts(kind)) return {};
    const a = this.d.store.get(accountId);
    return a && a.kind === kind && a.configDir ? { [ACCOUNT_DIR_ENV[kind]]: a.configDir } : {};
  }

  /** The account a session names, if it is one of its agent's; null otherwise. */
  accountFor(kind: AgentKind, accountId: string | null | undefined): Account | null {
    const a = accountId ? this.d.store.get(accountId) : null;
    return a && a.kind === kind ? this.view(a) : null;
  }

  /** The agent's other accounts not known to be signed out, as a usage limit offers them. */
  others(kind: AgentKind, exceptId: string): { id: string; label: string }[] {
    return this.d.store.list()
      .filter((a) => a.kind === kind && a.id !== exceptId && this.seen.get(a.id)?.signedIn !== false)
      .map((a) => ({ id: a.id, label: a.label }));
  }

  /**
   * Copy the provider's record of a conversation from one account's folder into another's, so the CLI
   * resumes it there as it was. Claude keeps it at `<folder>/projects/<project>/<id>.jsonl` (with a
   * folder of the same name beside it for large tool results); Codex at
   * `<home>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`; the Claude copy taken is `cwd`'s, the one the
   * session resumes. Answers false where the record cannot be found or copied, and the caller carries
   * the conversation as text instead.
   */
  async carry(kind: AgentKind, providerSessionId: string, fromId: string | null, toId: string | null, cwd?: string): Promise<boolean> {
    if (!hasAccounts(kind)) return false;
    const from = this.folderOf(kind, fromId);
    const to = this.folderOf(kind, toId);
    if (!from || !to) return false;
    if (from === to) return true;
    try {
      const found = kind === "claude"
        ? await claudeRecord(from, providerSessionId, cwd === undefined ? undefined : claudeProjectName(realOr(cwd)))
        : await codexRollout(from, providerSessionId);
      if (!found) return false;
      const dest = join(to, relative(from, found));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(found, dest);
      const beside = found.replace(/\.jsonl$/, "");
      if (kind === "claude" && existsSync(beside)) await cp(beside, join(to, relative(from, beside)), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Make the provider's record of a conversation findable from a new working directory, for a session
   * moving there. Answers how to undo it, or null where the record cannot be made findable and the
   * caller carries the conversation as text instead.
   *
   * Claude resumes from `<folder>/projects/<name of the cwd>/<id>.jsonl`, and when that file is
   * missing it searches every project and resumes only a record it finds exactly once (CLI 2.1.316,
   * measured), so the record is copied into the new cwd's project — over an older copy left by an
   * earlier move to the same place — and the old cwd's copy is renamed out of the CLI's reach, so no
   * stale copy is left for a later resume or account switch to find. Codex keeps its rollouts by date
   * rather than by cwd and resumes with the cwd it is given, so there is nothing to copy.
   */
  async rehome(kind: AgentKind, providerSessionId: string, accountId: string | null, cwd: { from: string; to: string }): Promise<(() => Promise<void>) | null> {
    if (kind === "codex") return async () => {};
    if (kind !== "claude") return null;
    const folder = this.folderOf(kind, accountId);
    if (!folder) return null;
    const name = claudeProjectName(realOr(cwd.to));
    // Past this the CLI shortens the name with a hash of its own, which is not worth guessing at.
    if (name.length > CLAUDE_PROJECT_NAME_MAX) return null;
    try {
      const found = await claudeRecord(folder, providerSessionId, claudeProjectName(realOr(cwd.from)));
      if (!found) return null;
      const dest = join(folder, "projects", name, basename(found));
      if (dest === found) return async () => {};
      const before = existsSync(dest) ? await readFile(dest) : null;
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(found, dest);
      const beside = found.replace(/\.jsonl$/, "");
      const besideDest = dest.replace(/\.jsonl$/, "");
      const besideNew = existsSync(beside) && !existsSync(besideDest);
      if (existsSync(beside)) await cp(beside, besideDest, { recursive: true });
      await rename(found, `${found}${CLAUDE_MOVED_SUFFIX}`);
      return async () => {
        await rename(`${found}${CLAUDE_MOVED_SUFFIX}`, found);
        if (before) await writeFile(dest, before); else await rm(dest, { force: true });
        if (besideNew) await rm(besideDest, { recursive: true, force: true });
      };
    } catch {
      return null;
    }
  }

  private folderOf(kind: AccountKind, accountId: string | null): string | null {
    const a = accountId ? this.d.store.get(accountId) : null;
    if (a && a.kind === kind && a.configDir) return a.configDir;
    return this.d.defaults?.[kind] ?? null;
  }

  private startSignIn(row: AccountRow): Promise<AgentSignIn> {
    return this.d.signIn.start(row.kind, {
      id: row.id,
      dirEnv: row.configDir ? { [ACCOUNT_DIR_ENV[row.kind]]: row.configDir } : {},
      signedIn: async () => (await this.ask(row, true)).signedIn,
    });
  }

  /** Ask the CLI about one account, once at a time, and keep what it said about who is signed in. */
  private ask(row: AccountRow, fresh = false): Promise<AccountProbe> {
    const pending = this.asking.get(row.id);
    if (pending && !fresh) return pending;
    const asked = this.d.probe(row.kind, row.configDir).then((p) => {
      const before = this.seen.get(row.id);
      this.seen.set(row.id, { ...p, at: this.now() });
      const who = p.signedIn ? { email: p.email ?? row.email, plan: p.plan ?? row.plan } : null;
      if (who && (who.email !== row.email || who.plan !== row.plan) && this.d.store.get(row.id)) this.d.store.noteIdentity(row.id, who);
      if (before?.signedIn !== p.signedIn || who) this.changed();
      return p;
    }).finally(() => { if (this.asking.get(row.id) === asked) this.asking.delete(row.id); });
    this.asking.set(row.id, asked);
    return asked;
  }

  private view(r: AccountRow): Account {
    const s = this.seen.get(r.id);
    return { id: r.id, kind: r.kind, label: r.label, configDir: r.configDir, signedIn: s?.signedIn ?? null, email: r.email, plan: r.plan, createdAt: r.createdAt };
  }

  private changed(): void {
    this.d.rpc.broadcast("accounts.changed", {});
  }
}

/** Appended to a Claude record a move left behind, so the CLI, which looks for `<id>.jsonl`, no
 *  longer finds it. */
const CLAUDE_MOVED_SUFFIX = ".moved";

/** The longest project name Claude uses as it is; a longer one it cuts and suffixes with a hash. */
const CLAUDE_PROJECT_NAME_MAX = 200;

/** The path the CLI names a project after: the cwd as the OS reports it, symlinks resolved. */
function realOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Whether `p` is somewhere under `root`. */
function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/** `<folder>/projects/*\/<id>.jsonl`, the Claude transcript a resume reads: `prefer`'s, the project
 *  the CLI itself looks in first, and otherwise the one written last. */
async function claudeRecord(folder: string, id: string, prefer?: string): Promise<string | null> {
  const projects = join(folder, "projects");
  const found = (await readdir(projects).catch(() => [] as string[]))
    .map((d) => join(projects, d, `${id}.jsonl`))
    .filter((f) => existsSync(f));
  const preferred = prefer === undefined ? null : join(projects, prefer, `${id}.jsonl`);
  if (preferred && found.includes(preferred)) return preferred;
  let newest: { path: string; at: number } | null = null;
  for (const path of found) {
    const at = (await stat(path)).mtimeMs;
    if (!newest || at > newest.at) newest = { path, at };
  }
  return newest?.path ?? null;
}

/** `<home>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, the Codex rollout a thread resumes from. */
async function codexRollout(home: string, id: string): Promise<string | null> {
  const root = join(home, "sessions");
  const list = (p: string) => readdir(p).catch(() => [] as string[]);
  for (const y of (await list(root)).sort().reverse()) {
    for (const m of (await list(join(root, y))).sort().reverse()) {
      for (const day of (await list(join(root, y, m))).sort().reverse()) {
        const f = (await list(join(root, y, m, day))).find((n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`));
        if (f) return join(root, y, m, day, f);
      }
    }
  }
  return null;
}
