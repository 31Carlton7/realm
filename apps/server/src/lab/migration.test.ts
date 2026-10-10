import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { migrations } from "../db/migrations";

/**
 * v48 (the lab's devices) met by a realm.db as a v45 install has it: a profile, a team space with a
 * role, a queued run of it, an activity line and a setting. The schema is written out BY HAND as v45
 * shipped it, not replayed from `migrations` — a fixture replayed from the list agrees with any edit
 * of the list, which is the one thing a migration test exists to catch (db/database.test.ts says the
 * same). Only the tables the rows need are here, and the two the sessions' activity migration (v49)
 * reads on the way to the end of the chain; v48 reads none of the others. Opened, the upgrade
 * must add the table, leave every row it found alone, and be safe to meet twice.
 */

const V45 = 45;
/** Found by its own text, so the fixture survives a renumbering at merge time. */
const LAB_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS lab_devices"));
const P = "01ARZ3NDEKTSV4RRFFQ69G5PA1";
const S = "01ARZ3NDEKTSV4RRFFQ69G5SA1";
const R = "01ARZ3NDEKTSV4RRFFQ69G5RR1";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5RU1";
const A = "01ARZ3NDEKTSV4RRFFQ69G5AC1";

/** The v45 shapes of the tables below, as `PRAGMA table_info` read them off a v45 database. */
const V45_SCHEMA = `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
    sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    browser_partition TEXT NOT NULL DEFAULT '');
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL, icon TEXT NOT NULL, sort_order INTEGER NOT NULL, folder_path TEXT NOT NULL,
    layout_json TEXT, active_item_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    color TEXT NOT NULL DEFAULT '#7c6cff', groups_json TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL, goal TEXT NOT NULL, agent_kind TEXT NOT NULL, environment_id TEXT,
    constraints_json TEXT, dedupe_key TEXT, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1, session_id TEXT, deadline_at INTEGER, result_text TEXT,
    error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER,
    updated_at INTEGER NOT NULL, schedule_id TEXT, role_id TEXT, woke_on TEXT, cost_usd REAL);
  CREATE TABLE team_roles (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, brief TEXT NOT NULL, realmite_json TEXT NOT NULL, template TEXT,
    agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
    skills_json TEXT NOT NULL DEFAULT '[]', wake_on_review INTEGER NOT NULL DEFAULT 1,
    week_budget_usd REAL, run_cap_usd REAL NOT NULL DEFAULT 3, run_cap_ms INTEGER NOT NULL DEFAULT 1200000,
    max_concurrent INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE team_activity (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, actor TEXT NOT NULL, run_id TEXT, session_id TEXT, verb TEXT NOT NULL,
    object TEXT, detail_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT,
    agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_item_id TEXT, environment_id TEXT NOT NULL,
    seen_seq INTEGER NOT NULL DEFAULT 0, dispatched_by_kind TEXT, dispatched_by_session_id TEXT, fast_mode INTEGER NOT NULL DEFAULT 0,
    provider_cursor TEXT, rewind_fork_json TEXT, rewind_refusal TEXT);
  CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
  -- Review's tables (v44) as far as the chain reads them on its way to the end: record types (v51)
  -- classes a team by its reviews' kinds and records, and generic deliverables (v52) alters the items.
  CREATE TABLE team_reviews (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, record_path TEXT);
  CREATE TABLE team_review_items (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, target_json TEXT);
`;

function writeV45Fixture(dir: string): string {
  const path = join(dir, "realm.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  // Pin WHAT v45 is, so a renumbering cannot leave this fixture standing in for the wrong version.
  expect(migrations[V45 - 1]).toContain("CREATE TABLE IF NOT EXISTS team_activity");
  db.exec(V45_SCHEMA);
  for (let v = 1; v <= V45; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1000);
  const t = 1000;
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (?, 'Work', 'x', '#000', 0, ?, ?)").run(P, t, t);
  db.prepare(`INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at)
    VALUES (?, ?, 'Versed', 'folder', 0, ?, ?, ?)`).run(S, P, join(dir, "versed"), t, t);
  db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at)
    VALUES (?, ?, 'Creator Manager', 'Keep the records.', '{}', 'claude', ?, ?)`).run(R, S, t, t);
  db.prepare(`INSERT INTO runs (id, space_id, title, goal, agent_kind, state, created_at, updated_at, role_id, woke_on)
    VALUES (?, ?, 'Weekly records', 'Keep the records.', 'claude', 'queued', ?, ?, ?, 'schedule')`).run(RUN, S, t, t, R);
  db.prepare("INSERT INTO team_activity (id, space_id, ts, actor, run_id, verb, object) VALUES (?, ?, ?, 'realm', ?, 'woke', 'Creator Manager')").run(A, S, t, RUN);
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('team.slots', '3')").run();
  db.close();
  return path;
}

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("v48: lab devices over a v45 database", () => {
  it("is v48, after the vault's v46 and the handoffs' v47", () => {
    expect(LAB_AT).toBe(47);
    expect(migrations[46]).toContain("CREATE TABLE IF NOT EXISTS team_handoffs");
    expect(migrations[45]).toContain("CREATE TABLE IF NOT EXISTS vault_grants");
  });

  it("adds lab_devices and leaves every row it found alone", () => {
    const path = writeV45Fixture(tempDir("lab-mig-"));
    const db = openDatabase(path);
    try {
      expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
      expect(tables(db)).toContain("lab_devices");
      const cols = (db.prepare("PRAGMA table_info(lab_devices)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(["id", "kind", "udid", "name", "space_id", "accounts_json", "last_seen_at", "created_at", "updated_at"]);
      expect(db.prepare("SELECT name FROM team_roles").all()).toEqual([{ name: "Creator Manager" }]);
      expect(db.prepare("SELECT state, role_id FROM runs").all()).toEqual([{ state: "queued", role_id: R }]);
      expect(db.prepare("SELECT verb FROM team_activity").all()).toEqual([{ verb: "woke" }]);
      expect(db.prepare("SELECT value_json FROM settings WHERE key = 'team.slots'").get()).toEqual({ value_json: "3" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM lab_devices").get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it("is idempotent: met again, it changes nothing and throws nothing", () => {
    const path = writeV45Fixture(tempDir("lab-mig-"));
    const db = openDatabase(path);
    try {
      db.prepare("INSERT INTO lab_devices (id, kind, udid, name, space_id, created_at, updated_at) VALUES ('d1', 'iphone', 'U1', 'Lab phone 1', ?, 1, 1)").run(S);
      expect(() => db.exec(migrations[LAB_AT]!)).not.toThrow();
      expect(db.prepare("SELECT id, udid FROM lab_devices").all()).toEqual([{ id: "d1", udid: "U1" }]);
    } finally { db.close(); }
    // And a second open runs no migration at all.
    const again = openDatabase(path);
    try {
      expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    } finally { again.close(); }
  });

  it("holds one row per udid, and lets a deleted team's phone stay with no team", () => {
    const db = openDatabase(writeV45Fixture(tempDir("lab-mig-")));
    try {
      const add = db.prepare("INSERT INTO lab_devices (id, kind, udid, name, space_id, created_at, updated_at) VALUES (?, 'iphone', ?, 'Phone', ?, 1, 1)");
      add.run("d1", "U1", S);
      expect(() => add.run("d2", "U1", null)).toThrow(/UNIQUE/);
      // Two hand-written rows with no udid yet are both fine.
      add.run("d3", null, null);
      add.run("d4", null, null);
      db.prepare("DELETE FROM spaces WHERE id = ?").run(S);
      expect(db.prepare("SELECT id, space_id FROM lab_devices WHERE id = 'd1'").get()).toEqual({ id: "d1", space_id: null });
    } finally { db.close(); }
  });
});
