import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { migrations } from "./migrations";

/**
 * The v3 schema as it SHIPPED, written out by hand rather than replayed from `migrations` — this is a
 * fixture standing in for a real user's home directory, and it must not move when the migration list
 * does. (Deriving it from `migrations[0..2]` would make it agree with any in-place edit of an already
 * released migration, which is exactly the mistake it exists to catch.)
 */
const V3_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, icon TEXT NOT NULL, sort_order INTEGER NOT NULL, folder_path TEXT NOT NULL,
  layout_json TEXT, active_item_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c6cff');
CREATE TABLE projects (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, root_path TEXT NOT NULL, default_branch TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE items (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  ref_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE terminals (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL, shell TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, project_id TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', cwd TEXT NOT NULL,
  status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
`;

/** A v3 home directory with a profile, a space and a session already in it. */
function v3Fixture(path: string): { spaceId: string; sessionId: string } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V3_SCHEMA);
  for (const v of [1, 2, 3]) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)").run("p1", "Work", "user", "#000000", 0, 1, 1);
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at, color) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)")
    .run("sp1", "p1", "Versed", "folder", 0, "/tmp/versed", 1, 1, "#7c6cff");
  db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, cwd, status, provider_session_id, title, last_event_seq, created_at, updated_at)
    VALUES (?, ?, NULL, 'claude', NULL, NULL, 'default', '/tmp/versed', 'idle', NULL, 'Old session', 3, 1, 1)`).run("se1", "sp1");
  db.close();
  return { spaceId: "sp1", sessionId: "se1" };
}

describe("database", () => {
  it("creates schema and records version", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const db = openDatabase(join(dir, "realm.db"));
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["profiles", "spaces", "projects", "items", "terminals", "settings"]) expect(names).toContain(t);
    db.close();
  });
  it("is idempotent on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const p = join(dir, "realm.db");
    openDatabase(p).close();
    expect(() => openDatabase(p).close()).not.toThrow();
  });

  it("migrates a populated v3 database to v4, adding sessions.terminal_item_id (NULL) without touching its rows", () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    const { sessionId } = v3Fixture(p);

    const db = openDatabase(p);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("terminal_item_id");
    // The user's session is still there, unchanged, and owns no terminal — migrating never spawns a pty.
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as { title: string; last_event_seq: number; terminal_item_id: string | null };
    expect(row).toMatchObject({ title: "Old session", last_event_seq: 3, terminal_item_id: null });
    db.close();
  });

  it("re-running the v4 migration is impossible: a second open is a no-op and the data survives", () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    v3Fixture(p);
    openDatabase(p).close();
    // Second open: schema_version already says 4, so no ALTER re-runs (it would throw "duplicate column").
    expect(() => openDatabase(p).close()).not.toThrow();
    const db = openDatabase(p);
    expect((db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
