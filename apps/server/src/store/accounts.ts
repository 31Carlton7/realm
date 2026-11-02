import type { Db } from "../db/database";
import type { AccountKind } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; kind: AccountKind; label: string; config_dir: string | null; email: string | null; plan: string | null; created_at: number };

/** An account as it is stored: everything but whether it is signed in, which is asked fresh. */
export type AccountRow = { id: string; kind: AccountKind; label: string; configDir: string | null; email: string | null; plan: string | null; createdAt: number };

const toRow = (r: Row): AccountRow => ({ id: r.id, kind: r.kind, label: r.label, configDir: r.config_dir, email: r.email, plan: r.plan, createdAt: r.created_at });

/** The `agent_accounts` table: one row per account, the CLI's own folder seeded as each kind's first. */
export class AccountsStore {
  constructor(private db: Db) {}

  list(): AccountRow[] {
    return (this.db.prepare("SELECT * FROM agent_accounts ORDER BY kind, created_at, id").all() as Row[]).map(toRow);
  }

  get(id: string): AccountRow | null {
    const r = this.db.prepare("SELECT * FROM agent_accounts WHERE id = ?").get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  require(id: string): AccountRow {
    const a = this.get(id);
    if (!a) throw new NotFoundError("account", id);
    return a;
  }

  create(a: { id: string; kind: AccountKind; label: string; configDir: string }): AccountRow {
    this.db.prepare("INSERT INTO agent_accounts (id, kind, label, config_dir, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, a.kind, a.label, a.configDir, now());
    return this.require(a.id);
  }

  rename(id: string, label: string): AccountRow {
    this.require(id);
    this.db.prepare("UPDATE agent_accounts SET label = ? WHERE id = ?").run(label, id);
    return this.require(id);
  }

  /** What the CLI said about the login, kept until it says otherwise. */
  noteIdentity(id: string, who: { email: string | null; plan: string | null }): void {
    this.db.prepare("UPDATE agent_accounts SET email = ?, plan = ? WHERE id = ?").run(who.email, who.plan, id);
  }

  /** Its sessions go back to the default account (`ON DELETE SET NULL`). */
  remove(id: string): void {
    this.db.prepare("DELETE FROM agent_accounts WHERE id = ?").run(id);
  }

  /** The sessions running on an account, by id. */
  sessionsOn(id: string): string[] {
    return (this.db.prepare("SELECT id FROM sessions WHERE account_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  }
}
