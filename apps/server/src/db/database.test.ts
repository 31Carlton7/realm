import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { migrations } from "./migrations";

/**
 * Checking a migration against a REAL home directory: never copy `realm.db` on its own. `openDatabase`
 * runs in WAL mode, so everything committed since the last checkpoint lives in the `-wal` sidecar and a
 * bare file copy silently hands you a stale point-in-time database — an older schema_version and missing
 * rows, with no error to warn you. Take the snapshot with SQLite's own
 *
 *     sqlite3 ~/Realm/realm.db "VACUUM INTO '/somewhere/scratch/snapshot.db'"
 *
 * which is safe against the live writer and folds the WAL in, then migrate a copy of THAT. (Copying all
 * three of `.db`, `-wal`, `-shm` also works; the backup API is the third option.) No fixture below does
 * any of this — they each build their database in a scratch dir from the literal schema — but a one-off
 * real-data check is exactly where the trap is waiting.
 *
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

/**
 * The v4 schema as it SHIPPED — the same hand-written literal discipline as V3_SCHEMA above, and for the
 * same reason: a fixture built by replaying `migrations` agrees with any mutation of `migrations`,
 * including folding v5's work into an earlier entry. This one is what stands between a real user's home
 * directory and the v5 environment split.
 */
const V4_SCHEMA = `
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
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  terminal_item_id TEXT REFERENCES items(id) ON DELETE SET NULL);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
`;

/**
 * A lived-in v4 home: two spaces; two sessions sharing the first space's folder; one session running in
 * a project root inside that space — TWO of them, so that a shared checkout which is *not* a space
 * folder is covered as well; one session in the second space; a third space nobody ever used; and a
 * session that owns a terminal. Every one of those shapes has to come out of v5 unchanged.
 */
function v4Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V4_SCHEMA);
  for (const v of [1, 2, 3, 4]) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)").run("p1", "Work", "user", "#000000", 0, 1, 1);
  const space = db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at, color) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, '#7c6cff')");
  space.run("sp1", "p1", "Versed", "folder", 0, "/tmp/versed", 10, 10);
  space.run("sp2", "p1", "Other", "folder", 1, "/tmp/other", 20, 20);
  space.run("sp3", "p1", "Empty", "folder", 2, "/tmp/empty", 30, 30);
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)").run("pr1", "sp1", "Sub", "/tmp/versed/sub", "main", 11, 11);
  db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("it-term", "sp1", "terminal", "versed", 0, 0, "tm1", 12, 12);
  db.prepare("INSERT INTO terminals VALUES (?, ?, ?, ?, ?, ?)").run("tm1", "sp1", "/tmp/versed", "/bin/zsh", 12, 12);
  const session = db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, cwd,
    status, provider_session_id, title, last_event_seq, created_at, updated_at, terminal_item_id)
    VALUES (?, ?, ?, 'claude', NULL, NULL, 'default', ?, 'idle', NULL, ?, ?, ?, ?, ?)`);
  session.run("se1", "sp1", null, "/tmp/versed", "First", 3, 100, 100, "it-term");
  session.run("se2", "sp1", null, "/tmp/versed", "Second", 0, 101, 101, null);
  session.run("se3", "sp1", "pr1", "/tmp/versed/sub", "In the project", 7, 102, 102, null);
  session.run("se5", "sp1", "pr1", "/tmp/versed/sub", "Also in the project", 2, 104, 104, null);
  session.run("se4", "sp2", null, "/tmp/other", "Elsewhere", 1, 103, 103, null);
  db.close();
}

type EnvRow = { id: string; space_id: string; path: string; branch: string | null; kind: string; port_block_start: number | null };
type SessRow = { id: string; cwd: string; environment_id: string; title: string; last_event_seq: number; terminal_item_id: string | null };
/** Sessions joined to their environment — i.e. what SessionsStore reads, expressed independently of it. */
const readSessions = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries((db.prepare("SELECT s.id, s.environment_id, s.title, s.last_event_seq, s.terminal_item_id, e.path AS cwd FROM sessions s LEFT JOIN environments e ON e.id = s.environment_id").all() as SessRow[]).map((r) => [r.id, r]));

describe("migration v5 — environments", () => {
  const migrated = () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    v4Fixture(p);
    return { p, db: openDatabase(p) };
  };

  it("is appended, not folded into v4: a v4 home still gains the environments table", () => {
    const { db } = migrated();
    // If v5's statements had been merged into migrations[3], a database already stamped v4 would never
    // see them — the loop starts at MAX(version). This is the only assertion that catches that.
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(4);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("environments");
    db.close();
  });

  it("every existing session adopts an environment, and lands in exactly the directory it was already in", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE environment_id IS NULL").get() as { n: number }).n).toBe(0);
    const s = readSessions(db);
    expect(s.se1!.cwd).toBe("/tmp/versed");
    expect(s.se2!.cwd).toBe("/tmp/versed");
    expect(s.se3!.cwd).toBe("/tmp/versed/sub"); // the project-root session keeps ITS directory, not the space's
    expect(s.se5!.cwd).toBe("/tmp/versed/sub");
    expect(s.se4!.cwd).toBe("/tmp/other");
    db.close();
  });

  it("sessions that shared a directory share one environment; a different directory gets its own", () => {
    const { db } = migrated();
    const s = readSessions(db);
    expect(s.se1!.environment_id).toBe(s.se2!.environment_id);
    expect(s.se3!.environment_id).not.toBe(s.se1!.environment_id);
    // Two sessions sharing a checkout that is NOT a space folder must still land on one environment —
    // the only case in which the backfill's de-duplication does any work.
    expect(s.se5!.environment_id).toBe(s.se3!.environment_id);
    expect(s.se4!.environment_id).not.toBe(s.se1!.environment_id);
    db.close();
  });

  it("gives every space exactly one primary environment, at its own folder — used or not", () => {
    const { db } = migrated();
    const envs = db.prepare("SELECT * FROM environments ORDER BY path").all() as EnvRow[];
    const primaries = envs.filter((e) => e.kind === "primary");
    expect(primaries.map((e) => [e.space_id, e.path])).toEqual([["sp3", "/tmp/empty"], ["sp2", "/tmp/other"], ["sp1", "/tmp/versed"]]);
    // The project root is a checkout Realm did not create — never a worktree, so W2 can never remove it.
    expect(envs.filter((e) => e.kind !== "primary")).toEqual([expect.objectContaining({ space_id: "sp1", path: "/tmp/versed/sub", kind: "checkout" })]);
    expect(envs.every((e) => e.branch === null && e.port_block_start === null)).toBe(true);
    db.close();
  });

  it("a second primary in one space is impossible even by direct INSERT", () => {
    const { db } = migrated();
    expect(() => db.prepare("INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at) VALUES ('X','sp1','/tmp/elsewhere',NULL,'primary',NULL,1,1)").run())
      .toThrow(/UNIQUE/);
    // …and neither is a second environment for one directory, which is what keeps sessions sharing.
    expect(() => db.prepare("INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at) VALUES ('Y','sp1','/tmp/versed',NULL,'worktree',NULL,1,1)").run())
      .toThrow(/UNIQUE/);
    db.close();
  });

  it("leaves everything else about a session alone, and drops the cwd column", () => {
    const { db } = migrated();
    const s = readSessions(db);
    expect(s.se1).toMatchObject({ title: "First", last_event_seq: 3, terminal_item_id: "it-term" });
    expect(s.se3).toMatchObject({ title: "In the project", last_event_seq: 7 });
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("environment_id");
    expect(cols).not.toContain("cwd"); // authority moved; a stale copy could only ever disagree
    db.close();
  });

  it("refuses to write a session with no environment", () => {
    const { db } = migrated();
    expect(() => db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, permission_mode, status, title, last_event_seq, created_at, updated_at, environment_id)
      VALUES ('nope','sp1',NULL,'claude','default','idle','t',0,1,1,NULL)`).run()).toThrow(/environment_id is required/);
    const env = (db.prepare("SELECT id FROM environments WHERE space_id='sp1' AND kind='primary'").get() as { id: string }).id;
    db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, permission_mode, status, title, last_event_seq, created_at, updated_at, environment_id)
      VALUES ('yes','sp1',NULL,'claude','default','idle','t',0,1,1,?)`).run(env);
    expect(() => db.prepare("UPDATE sessions SET environment_id = NULL WHERE id = 'yes'").run()).toThrow(/environment_id is required/);
    db.close();
  });

  it("backfilled ids are distinct and pass IdSchema, so environments survive contract validation", async () => {
    const { db } = migrated();
    const { IdSchema } = await import("@realm/contracts");
    const ids = (db.prepare("SELECT id FROM environments").all() as { id: string }[]).map((e) => e.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4); // randomblob really is re-evaluated per row
    for (const id of ids) expect(IdSchema.safeParse(id).success).toBe(true);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs it nor duplicates an environment", () => {
    const { p, db } = migrated();
    const before = db.prepare("SELECT id, space_id, path, kind FROM environments ORDER BY id").all();
    const sessionsBefore = readSessions(db);
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT id, space_id, path, kind FROM environments ORDER BY id").all()).toEqual(before);
    expect(readSessions(again)).toEqual(sessionsBefore);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });

  it("an environment cannot be deleted out from under a live session, but the space can still go", () => {
    const { db } = migrated();
    const env = (db.prepare("SELECT id FROM environments WHERE space_id='sp1' AND kind='primary'").get() as { id: string }).id;
    expect(() => db.prepare("DELETE FROM environments WHERE id = ?").run(env)).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM spaces WHERE id = 'sp1'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM environments WHERE space_id='sp1'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE space_id='sp1'").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("migration v6 — port blocks", () => {
  const migrated = () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    v4Fixture(p);
    return { p, db: openDatabase(p) };
  };

  it("is appended, not folded into v5: a v4 home reaches v6 and gains the uniqueness guarantee", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(5);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain("environments_port_block");
    db.close();
  });

  it("refuses two environments the same block, and is indifferent to how many have none", () => {
    const { db } = migrated();
    const [a, b, c] = (db.prepare("SELECT id FROM environments ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    // Every migrated row starts NULL, and several NULLs are not a conflict — SQLite treats NULLs as
    // distinct in a unique index, so this holds with or without the index's WHERE clause.
    expect((db.prepare("SELECT COUNT(*) AS n FROM environments WHERE port_block_start IS NULL").get() as { n: number }).n).toBeGreaterThan(1);
    db.prepare("UPDATE environments SET port_block_start = 41000 WHERE id = ?").run(a!);
    expect(() => db.prepare("UPDATE environments SET port_block_start = 41000 WHERE id = ?").run(b!)).toThrow(/UNIQUE/i);
    db.prepare("UPDATE environments SET port_block_start = 41010 WHERE id = ?").run(c!);
    expect((db.prepare("SELECT COUNT(*) AS n FROM environments WHERE port_block_start IS NOT NULL").get() as { n: number }).n).toBe(2);
    db.close();
  });
});

/**
 * The v8 `mcp_servers` shape as it SHIPPED (Plan 8 W2) — hand-written for the same reason V3_SCHEMA and
 * V4_SCHEMA are: it must not move when `migrations` does. `mcp_servers` has no foreign keys to any other
 * table, so unlike the v4/v5 fixtures above this one does not need profiles/spaces/sessions alongside it
 * — a bare `schema_version` stamped at 8 plus the table itself is a complete, honest v8 home for the one
 * table v9 touches.
 */
const V8_MCP_SERVERS = `
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  secrets_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

/** A v8 home with one MCP server already defined, in the pre-v9 row shape (no oauth_json/tools_json). */
function v8McpFixture(path: string): { serverId: string } {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V8_MCP_SERVERS);
  // The fixture is deliberately minimal — only the tables LATER migrations touch. v14 ALTERs
  // sessions, so a stub of it must exist for the v9..v14 replay to run; its real v3 shape is
  // exercised by the v4/v5 fixtures above.
  db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("srv1", "airtable", "stdio", "/usr/bin/node", '["/abs/s.mjs"]', "", '{"AIRTABLE_API_KEY":"pat-x"}', 1, 1);
  db.close();
  return { serverId: "srv1" };
}

describe("migration v9 — MCP gateway", () => {
  const migrated = () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    const { serverId } = v8McpFixture(p);
    return { p, db: openDatabase(p), serverId };
  };

  it("is appended, not folded into v8: a v8 home reaches v9 and gains the call log", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(8);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("mcp_call_log");
    db.close();
  });

  it("adds oauth_json and tools_json to mcp_servers with their defaults, leaving an existing row otherwise untouched", () => {
    const { db, serverId } = migrated();
    const cols = (db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["oauth_json", "tools_json"]));
    const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(serverId) as { name: string; oauth_json: string; tools_json: string; secrets_json: string };
    expect(row).toMatchObject({ name: "airtable", oauth_json: "", tools_json: "[]" });
    // The pre-v9 secret is exactly where it was — the migration adds columns, it does not touch data.
    expect(row.secrets_json).toBe('{"AIRTABLE_API_KEY":"pat-x"}');
    db.close();
  });

  it("mcp_call_log starts empty, with the indexes a session/ts listing needs", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_call_log").get() as { n: number }).n).toBe(0);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(["mcp_call_log_session", "mcp_call_log_ts"]));
    db.close();
  });

  // `mcp_call_log.session_id` is NOT NULL and FK-checked, so this needs an actual session — reusing
  // the v4 fixture (which openDatabase migrates all the way to v9, mcp_servers included) rather than
  // building a second parallel chain of profiles/spaces/environments just for one row.
  it("server_id survives as NULL once the server row it names is deleted — the log outlives the config", () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    v4Fixture(p);
    const db = openDatabase(p);
    db.prepare("INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, created_at, updated_at) VALUES ('srv1','airtable','stdio','/usr/bin/node','[]','','{}',1,1)").run();
    db.prepare(`INSERT INTO mcp_call_log (id, session_id, server_id, server_name, tool, args_json, result_summary, ok, duration_ms, ts)
      VALUES ('c1', 'se1', 'srv1', 'airtable', 'search', '{}', 'ok', 1, 5, 100)`).run();
    db.prepare("DELETE FROM mcp_servers WHERE id = 'srv1'").run();
    expect((db.prepare("SELECT server_id FROM mcp_call_log WHERE id = 'c1'").get() as { server_id: string | null }).server_id).toBeNull();
    db.close();
  });

  it("re-running the v9 migration is impossible: a second open is a no-op and the row survives", () => {
    const { p } = migrated();
    expect(() => openDatabase(p).close()).not.toThrow();
    const db = openDatabase(p);
    expect((db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_servers").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("migration v14 — dispatch origin (Plan 13 W1; renumbered past Plan 14's v13 ships table)", () => {
  // The v4 fixture holds a REAL populated session ('se1'), migrated all the way forward — exactly
  // the row an upgrade must leave alone.
  it("adds dispatched_by_kind/dispatched_by_session_id, NULL for every existing session — nothing backfilled", () => {
    const p = join(mkdtempSync(join(tmpdir(), "realm-db-")), "realm.db");
    v4Fixture(p);
    const db = openDatabase(p);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["dispatched_by_kind", "dispatched_by_session_id"]));
    const row = db.prepare("SELECT dispatched_by_kind, dispatched_by_session_id FROM sessions WHERE id = 'se1'").get() as { dispatched_by_kind: string | null; dispatched_by_session_id: string | null };
    expect(row.dispatched_by_kind).toBeNull();
    expect(row.dispatched_by_session_id).toBeNull();
    db.close();
  });
});
