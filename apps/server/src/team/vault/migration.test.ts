import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../../db/database";
import { migrations } from "../../db/migrations";

/**
 * v46 — the team vault's grants, against a hand-written v45 home rather than one replayed from
 * `migrations` (a replayed fixture agrees with any mutation of the list it was built from).
 */

/** Found by its own text, so the fixture survives a renumbering at merge time. */
const VAULT_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS vault_grants"));

/** What v46 stands on as v45 left it: the spaces it hangs off, and the team tables beside it. */
const V45_SCHEMA = `
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE team_roles (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, brief TEXT NOT NULL, realmite_json TEXT NOT NULL, template TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
  skills_json TEXT NOT NULL DEFAULT '[]', wake_on_review INTEGER NOT NULL DEFAULT 1,
  week_budget_usd REAL, run_cap_usd REAL NOT NULL DEFAULT 3, run_cap_ms INTEGER NOT NULL DEFAULT 1200000,
  max_concurrent INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE team_activity (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, actor TEXT NOT NULL, run_id TEXT, session_id TEXT, verb TEXT NOT NULL, object TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}');-- What the sessions' activity migration (v49) reads on the way to the end of the chain.
CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
-- Review's tables (v44): the record types' migration (v51) reads its batches by kind and record, and
-- generic deliverables (v52) alters its items, on the way to the end of the chain.
CREATE TABLE team_reviews (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, record_path TEXT);
CREATE TABLE team_review_items (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, target_json TEXT);
`;

function v45Home(): string {
  const p = join(tempDir("realm-vault-db-"), "realm.db");
  const db = new DatabaseSync(p);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V45_SCHEMA);
  for (let v = 1; v <= VAULT_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1'), ('sp2')").run();
  db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at)
    VALUES ('R1', 'sp1', 'Growth Analyst', 'Check the numbers.', '{}', 'claude', 1, 1)`).run();
  db.prepare(`INSERT INTO team_activity (id, space_id, ts, actor, verb, object, detail_json) VALUES ('A1', 'sp1', 7, 'user', 'made_team', NULL, '{}')`).run();
  db.close();
  return p;
}

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("migration v46 — vault grants", () => {
  it("is v46, appended after the team's activity log", () => {
    expect(VAULT_AT).toBe(45);
    expect(migrations[VAULT_AT - 1]).toContain("CREATE TABLE IF NOT EXISTS team_activity");
  });

  it("brings a v45 home to the end of the chain with the grants table, and leaves its rows as they were", () => {
    const db = openDatabase(v45Home());
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(cols(db, "vault_grants")).toEqual(["secret_id", "space_id", "role_id", "kind", "name", "hosts_json", "purpose", "created_at"]);
    // THE MUTANT: a backfill that grants an existing role something, or touches the log.
    expect(db.prepare("SELECT COUNT(*) AS n FROM vault_grants").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, verb FROM team_activity").all()).toEqual([{ id: "A1", verb: "made_team" }]);
    db.close();
  });

  it("holds one grant per secret and role, with no hosts until some are named", () => {
    const db = openDatabase(v45Home());
    const put = db.prepare("INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, created_at) VALUES (?, 'sp1', 'R1', 'key', 'K', 1)");
    put.run("s1");
    expect(() => put.run("s1")).toThrow(/UNIQUE|PRIMARY/);
    expect(db.prepare("SELECT hosts_json, purpose FROM vault_grants").get()).toEqual({ hosts_json: "[]", purpose: null });
    db.close();
  });

  it("goes with its space, and only that space's", () => {
    const db = openDatabase(v45Home());
    db.prepare("INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, created_at) VALUES ('s1', 'sp1', 'R1', 'key', 'K', 1), ('s2', 'sp2', 'R9', 'signin', 'S', 1)").run();
    db.prepare("DELETE FROM spaces WHERE id = 'sp1'").run();
    expect(db.prepare("SELECT secret_id FROM vault_grants").all()).toEqual([{ secret_id: "s2" }]);
    db.close();
  });

  it("is idempotent: reopened, and its SQL met again, nothing re-runs or throws, and a grant written since stays", () => {
    const p = v45Home();
    const db = openDatabase(p);
    db.prepare("INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, created_at) VALUES ('s1', 'sp1', 'R1', 'key', 'K', 1)").run();
    expect(() => db.exec(migrations[VAULT_AT]!)).not.toThrow();
    db.close();
    const again = openDatabase(p);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    expect(again.prepare("SELECT secret_id FROM vault_grants").all()).toEqual([{ secret_id: "s1" }]);
    again.close();
  });

  it("lists a team's grants off an index", () => {
    const db = openDatabase(v45Home());
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM vault_grants WHERE space_id = ? ORDER BY created_at").all("sp1") as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("vault_grants_space");
    db.close();
  });
});
