import { RISK_CLASSES, type RiskClass, type ToolClassOverride } from "@realm/contracts";
import type { Db } from "../../db/database";

type Raw = { connector: string; tool: string; class: string; verb: string | null; seal: string | null };

/**
 * A person's word on what a connector's tools do (`tool_classes`), read for one profile. Nothing in
 * Realm writes these rows yet — the Policies page that will is read-only in this release — and no
 * agent-callable path ever will: `tool-classes.test.ts` holds every reference to the table to this
 * file and the migration.
 *
 * `sealed` is false for every row. Main's stamp is what would confirm a lowering, and nothing checks
 * one yet, so a lowering is shown as not confirmed and the class Realm derived stands.
 */
export class ToolClassesStore {
  constructor(private db: Db) {}

  /** The profile's overrides, keyed `connector\ttool` (`*` for a whole connector). A row naming a
   *  class this build does not know is skipped rather than guessed at. */
  forProfile(profileId: string): Map<string, ToolClassOverride> {
    const rows = this.db.prepare("SELECT connector, tool, class, verb, seal FROM tool_classes WHERE profile_id = ?").all(profileId) as Raw[];
    const out = new Map<string, ToolClassOverride>();
    for (const r of rows) {
      if (!(RISK_CLASSES as readonly string[]).includes(r.class)) continue;
      out.set(`${r.connector}\t${r.tool}`, { class: r.class as RiskClass, verb: r.verb, sealed: false });
    }
    return out;
  }
}

/** The override for one tool: its own row, else its connector's `*` row. */
export function overrideFor(overrides: ReadonlyMap<string, ToolClassOverride>, connector: string, tool: string): ToolClassOverride | null {
  return overrides.get(`${connector}\t${tool}`) ?? overrides.get(`${connector}\t*`) ?? null;
}
