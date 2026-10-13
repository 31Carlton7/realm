import {
  PolicyCapsSchema, PolicyCheckSchema, PolicyDecisionSchema, PolicyScopeSchema, newId,
  type PolicyCaps, type PolicyCheck, type PolicyDecision, type PolicyScope, type TeamPolicyInput,
} from "@realm/contracts";
import { z } from "zod";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

type Raw = {
  id: string; space_id: string; scope: string; scope_key: string; decision: string; caps_json: string; checks_json: string;
  set_by: string; seal: string | null; created_at: number; updated_at: number;
};

/** A row as stored, before main has said anything about its seal. */
export type StoredPolicy = {
  id: string; spaceId: string; scope: PolicyScope; scopeKey: string; decision: PolicyDecision; caps: PolicyCaps; checks: PolicyCheck[];
  setBy: "template" | "user" | "migration"; seal: string | null; createdAt: number; updatedAt: number;
};

const parse = <T>(schema: z.ZodType<T>, text: string): T | null => {
  try { const r = schema.safeParse(JSON.parse(text)); return r.success ? r.data : null; } catch { return null; }
};

/**
 * A row this build cannot read whole — a scope or decision it does not know, caps or checks that do not
 * parse — is skipped rather than guessed at. Skipping only ever tightens: the call falls back to the
 * rows around it and the floor, and a hand-edited row cannot loosen anything by being malformed.
 */
function toPolicy(r: Raw): StoredPolicy | null {
  const scope = PolicyScopeSchema.safeParse(r.scope);
  const decision = PolicyDecisionSchema.safeParse(r.decision);
  const caps = parse(PolicyCapsSchema, r.caps_json);
  const checks = parse(z.array(PolicyCheckSchema), r.checks_json);
  if (!scope.success || !decision.success || !caps || !checks) return null;
  const setBy = r.set_by === "template" || r.set_by === "migration" ? r.set_by : "user";
  return { id: r.id, spaceId: r.space_id, scope: scope.data, scopeKey: r.scope_key, decision: decision.data, caps, checks, setBy, seal: r.seal, createdAt: r.created_at, updatedAt: r.updated_at };
}

/**
 * `team_policies`, rows only. The ONE place in realm-server that writes the table: `reach.test.ts`
 * holds every other file to reading it. Which write is allowed — tightening is open, loosening takes a
 * sealed press — is `PoliciesService`'s; this store writes what it is given.
 */
export class PolicyStore {
  constructor(private db: Db, private clock: () => number = now) {}

  forSpace(spaceId: string): StoredPolicy[] {
    return (this.db.prepare("SELECT * FROM team_policies WHERE space_id = ? ORDER BY scope, scope_key").all(spaceId) as Raw[])
      .map(toPolicy).filter((r): r is StoredPolicy => r !== null);
  }

  at(spaceId: string, scope: PolicyScope, scopeKey: string): StoredPolicy | null {
    const r = this.db.prepare("SELECT * FROM team_policies WHERE space_id = ? AND scope = ? AND scope_key = ?").get(spaceId, scope, scopeKey) as Raw | undefined;
    return r ? toPolicy(r) : null;
  }

  /** Write one row as the person set it. The id and the made-at of a row already there are kept. */
  put(row: TeamPolicyInput, seal: string | null): StoredPolicy {
    const t = this.clock();
    this.db.prepare(`INSERT INTO team_policies (id, space_id, scope, scope_key, decision, caps_json, checks_json, set_by, seal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)
      ON CONFLICT(space_id, scope, scope_key) DO UPDATE SET decision = excluded.decision, caps_json = excluded.caps_json,
        checks_json = excluded.checks_json, set_by = 'user', seal = excluded.seal, updated_at = excluded.updated_at`)
      .run(newId(), row.spaceId, row.scope, row.scopeKey, row.decision, JSON.stringify(row.caps), JSON.stringify(row.checks), seal, t, t);
    return this.at(row.spaceId, row.scope, row.scopeKey)!;
  }

  /** No-click calls a row let through, for its caps: how many since `since` — of this row and verb, or
   *  of this verb across the team. Read off the team's activity, where the gate writes one
   *  `policy_auto` line per call. */
  autoCalls(spaceId: string, since: number, o: { rowId?: string; verb: string }): { count: number } {
    const row = o.rowId !== undefined ? " AND json_extract(detail_json, '$.rowId') = ?" : "";
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM team_activity WHERE space_id = ? AND verb = 'policy_auto' AND ts >= ?
      AND json_extract(detail_json, '$.verb') = ?${row}`).get(...[spaceId, since, o.verb, ...(o.rowId !== undefined ? [o.rowId] : [])]) as { n: number };
    return { count: r.n };
  }

  /** The last no-click call of this row and verb, at any time — what a gap is measured from. */
  lastAuto(spaceId: string, rowId: string, verb: string): number | null {
    const r = this.db.prepare(`SELECT MAX(ts) AS last FROM team_activity WHERE space_id = ? AND verb = 'policy_auto'
      AND json_extract(detail_json, '$.rowId') = ? AND json_extract(detail_json, '$.verb') = ?`).get(spaceId, rowId, verb) as { last: number | null };
    return r.last;
  }
}
