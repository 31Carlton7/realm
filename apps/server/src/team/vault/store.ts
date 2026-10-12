import type { VaultGrant, VaultSecretKind, VaultUse } from "@realm/contracts";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

type RawGrant = {
  secret_id: string; space_id: string; role_id: string; kind: VaultSecretKind; name: string;
  hosts_json: string; purpose: string | null; created_at: number;
};

const toGrant = (r: RawGrant): VaultGrant => {
  let hosts: string[] = [];
  try { const v = JSON.parse(r.hosts_json) as unknown; if (Array.isArray(v)) hosts = v.filter((h): h is string => typeof h === "string"); } catch { /* none */ }
  return { secretId: r.secret_id, spaceId: r.space_id, roleId: r.role_id, kind: r.kind, name: r.name, hosts, purpose: r.purpose, createdAt: r.created_at };
};

type RawUse = { id: string; ts: number; actor: string; run_id: string | null; session_id: string | null; verb: string; object: string | null; detail_json: string };

/** The verbs a use of a secret is written under in `team_activity`. */
export const USE_VERBS = ["used_secret", "refused_secret"] as const;

/**
 * The vault's rows in realm.db: grants, and its uses read back off the team's activity log. No secret
 * material is here, or could be — a grant is ids, a name and hosts. Every rule about which grant may be
 * made is `VaultService`'s.
 */
export class VaultStore {
  constructor(private db: Db, private clock: () => number = now) {}

  grants(spaceId: string): VaultGrant[] {
    return (this.db.prepare("SELECT * FROM vault_grants WHERE space_id = ? ORDER BY created_at, secret_id").all(spaceId) as RawGrant[]).map(toGrant);
  }

  grantsForRole(roleId: string): VaultGrant[] {
    return (this.db.prepare("SELECT * FROM vault_grants WHERE role_id = ? ORDER BY created_at, secret_id").all(roleId) as RawGrant[]).map(toGrant);
  }

  grant(secretId: string, roleId: string): VaultGrant | null {
    const r = this.db.prepare("SELECT * FROM vault_grants WHERE secret_id = ? AND role_id = ?").get(secretId, roleId) as RawGrant | undefined;
    return r ? toGrant(r) : null;
  }

  /**
   * Make a grant, or change one's hosts and purpose. A changed grant keeps its `created_at`: it is the
   * same grant, and its allow (sealed against that time) still names only the hosts it was sealed
   * with, so narrowing or widening the grant here never widens what goes through without asking.
   */
  put(g: Omit<VaultGrant, "createdAt">): VaultGrant {
    this.db.prepare(`INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, hosts_json, purpose, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(secret_id, role_id) DO UPDATE SET hosts_json = excluded.hosts_json, purpose = excluded.purpose, name = excluded.name`)
      .run(g.secretId, g.spaceId, g.roleId, g.kind, g.name, JSON.stringify(g.hosts), g.purpose, this.clock());
    return this.grant(g.secretId, g.roleId)!;
  }

  revoke(secretId: string, roleId: string): boolean {
    return Number(this.db.prepare("DELETE FROM vault_grants WHERE secret_id = ? AND role_id = ?").run(secretId, roleId).changes) > 0;
  }

  /** The team's uses of its secrets, newest first. */
  uses(spaceId: string, limit: number): VaultUse[] {
    const rows = this.db.prepare(`SELECT id, ts, actor, run_id, session_id, verb, object, detail_json FROM team_activity
      WHERE space_id = ? AND verb IN ('used_secret', 'refused_secret') ORDER BY ts DESC, rowid DESC LIMIT ?`).all(spaceId, limit) as RawUse[];
    return rows.map((r) => {
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(r.detail_json) as Record<string, unknown>; } catch { /* empty */ }
      const s = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
      const refused = r.verb === "refused_secret";
      return {
        id: r.id, ts: r.ts, actor: r.actor,
        roleId: r.actor.startsWith("role:") ? r.actor.slice(5) : null,
        sessionId: r.session_id, runId: r.run_id,
        outcome: refused ? "refused" : s("kind") === "signin" ? "filled" : "used",
        secretId: s("secretId"), secretName: r.object ?? "",
        kind: s("kind") === "signin" ? "signin" : "key",
        where: refused ? s("reason") ?? "refused" : s("where") ?? "",
        how: s("how") === "unattended" ? "unattended" : s("how") === "card" ? "card" : null,
        status: typeof d.status === "number" ? d.status : null,
      } satisfies VaultUse;
    });
  }
}
