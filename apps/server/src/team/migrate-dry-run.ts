import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database";
import { migrations } from "../db/migrations";
import { TeamStore } from "./store";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";
import { adoptRecordTypes } from "./record-types/adopt";

export type DryRunReport = {
  from: number;
  to: number;
  /** Rows each table gains, tables the migrations made included. Only tables that change are listed. */
  added: Record<string, number>;
  /** Rows a migration took away or rewrote — zero-loss means this is empty. */
  lost: Record<string, number>;
  teams: { spaceId: string; name: string; template: string | null; types: string[] }[];
  /** What the boot reconcile would adopt from the teams' memory repos, read and never written. */
  adoptions: { spaceId: string; folder: string; key: string }[];
};

/**
 * What the dynamic-Teams migrations (v51 on) would do to a real home, without touching it: the
 * database is copied with `VACUUM INTO` — the source opened read-only — and migrated in a scratch
 * folder, then the boot reconcile runs against the copy, reading the teams' memory repos and writing
 * nothing to them (the plan's Risk 4: "a migration on a home nobody has seen").
 */
export function dryRunMigrations(source: string): DryRunReport {
  if (!existsSync(source)) throw new Error(`${source} does not exist`);
  const scratch = mkdtempSync(join(tmpdir(), "realm-dry-run-"));
  try {
    const copy = join(scratch, "realm.db");
    const src = new DatabaseSync(source, { readOnly: true });
    src.prepare("VACUUM INTO ?").run(copy);
    src.close();
    const raw = new DatabaseSync(copy);
    const from = (raw.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as { v: number } | undefined)?.v ?? 0;
    const before = rowsByTable(raw);
    raw.close();
    const db = openDatabase(copy);
    const repoPath = (spaceId: string): string | null => {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`memory.repo:space:${spaceId}`) as { value_json: string } | undefined;
      const path = row ? (JSON.parse(row.value_json) as { path?: unknown } | null)?.path : null;
      return typeof path === "string" && existsSync(join(path, ".git")) ? path : null;
    };
    const team = new TeamStore(db);
    const store = new RecordTypeStore(db);
    const types = new RecordTypeService({ store, repoPath, spaceExists: () => true, log: (spaceId, actor, verb, object, detail) => { team.appendActivity({ spaceId, actor, verb, object, detail }); }, changed: () => {} });
    const adoptions = adoptRecordTypes({ teamSpaceIds: () => team.teamSpaceIds(), repoPath, store, types });
    const after = rowsByTable(db);
    const added: Record<string, number> = {};
    const lost: Record<string, number> = {};
    for (const [t, rows] of after) {
      const was = before.get(t) ?? new Set<string>();
      const gained = [...rows].filter((r) => !was.has(r)).length;
      if (gained > 0) added[t] = gained;
    }
    for (const [t, rows] of before) {
      // Compared on the columns the table had before: a column added by a migration is not a change.
      const cols = Object.keys(JSON.parse([...rows][0] ?? "{}") as object);
      if (cols.length === 0) continue;
      const now = new Set((db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}"`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(r)));
      const gone = [...rows].filter((r) => !now.has(r)).length;
      if (gone > 0) lost[t] = gone;
    }
    const teams = (db.prepare("SELECT m.space_id AS id, s.name AS name, m.template AS template FROM team_meta m LEFT JOIN spaces s ON s.id = m.space_id ORDER BY s.name").all() as { id: string; name: string | null; template: string | null }[])
      .map((m) => ({ spaceId: m.id, name: m.name ?? m.id, template: m.template, types: types.list(m.id).map((t) => `${t.key} (${t.folder}/)`) }));
    db.close();
    return { from, to: migrations.length, added, lost, teams, adoptions };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function rowsByTable(db: DatabaseSync): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name <> 'schema_version' ORDER BY name").all() as { name: string }[];
  for (const { name } of tables) out.set(name, new Set((db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(r))));
  return out;
}

/** The report in a few lines, for a person reading a terminal. */
export function dryRunWords(r: DryRunReport): string {
  const lines = [`Migrations: v${r.from} → v${r.to}${r.from === r.to ? " (nothing to run)" : ""}`];
  lines.push(Object.keys(r.lost).length === 0 ? "Lost or rewritten rows: none" : `LOST OR REWRITTEN ROWS: ${Object.entries(r.lost).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  lines.push(`Added rows: ${Object.entries(r.added).map(([t, n]) => `${t} +${n}`).join(", ") || "none"}`);
  for (const t of r.teams) lines.push(`- ${t.name}: ${t.template ?? "no template"} · ${t.types.join(", ") || "no record types"}`);
  for (const a of r.adoptions) lines.push(`  adopts ${a.folder}/ as ${a.key} in ${r.teams.find((t) => t.spaceId === a.spaceId)?.name ?? a.spaceId}`);
  return lines.join("\n");
}
