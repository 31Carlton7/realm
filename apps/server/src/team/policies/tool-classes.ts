import { RISK_CLASSES, type RiskClass, type ToolClassOverride } from "@realm/contracts";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

type Raw = { connector: string; tool: string; class: string; verb: string | null; seal: string | null };

/** One override as stored, before main has said whether its seal checks out. */
export type StoredToolClass = { connector: string; tool: string; class: RiskClass; verb: string | null; seal: string | null };

/**
 * A person's word on what a connector's tools do (`tool_classes`), per profile. Written only from the
 * Policies page's "What does this do?" through `PoliciesService.setToolClass` — no agent-callable path
 * reaches it, and `reach.test.ts` holds every reference to the table to this file and the migration.
 *
 * A raise holds as written. A lowering holds only with main's seal on it, which `PoliciesService`
 * checks; without one the class Realm derived stands.
 */
export class ToolClassesStore {
  constructor(private db: Db, private clock: () => number = now) {}

  /** The profile's overrides as stored. A row naming a class this build does not know is skipped
   *  rather than guessed at. */
  rows(profileId: string): StoredToolClass[] {
    return (this.db.prepare("SELECT connector, tool, class, verb, seal FROM tool_classes WHERE profile_id = ?").all(profileId) as Raw[])
      .filter((r) => (RISK_CLASSES as readonly string[]).includes(r.class))
      .map((r) => ({ connector: r.connector, tool: r.tool, class: r.class as RiskClass, verb: r.verb, seal: r.seal }));
  }

  /** The profile's overrides keyed `connector\ttool` (`*` for a whole connector), each saying whether its
   *  seal checked out — `sealed` from the caller, which asked main. */
  forProfile(profileId: string, sealed: (r: StoredToolClass) => boolean = () => false): Map<string, ToolClassOverride> {
    const out = new Map<string, ToolClassOverride>();
    for (const r of this.rows(profileId)) out.set(`${r.connector}\t${r.tool}`, { class: r.class, verb: r.verb, sealed: r.seal !== null && sealed(r) });
    return out;
  }

  put(profileId: string, connector: string, tool: string, cls: RiskClass, seal: string | null): void {
    this.db.prepare(`INSERT INTO tool_classes (profile_id, connector, tool, class, verb, seal, set_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(profile_id, connector, tool) DO UPDATE SET class = excluded.class, seal = excluded.seal, set_at = excluded.set_at`)
      .run(profileId, connector, tool, cls, seal, this.clock());
  }
}

/** The override for one tool: its own row, else its connector's `*` row. */
export function overrideFor(overrides: ReadonlyMap<string, ToolClassOverride>, connector: string, tool: string): ToolClassOverride | null {
  return overrides.get(`${connector}\t${tool}`) ?? overrides.get(`${connector}\t*`) ?? null;
}
