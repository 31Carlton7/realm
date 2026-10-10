import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "./database";
import { migrations } from "./migrations";
import { ItemsStore } from "../store/items";

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

/**
 * The two tables the activity migration reads — `sessions.created_at`, and `session_events`' session,
 * time and type — added where a stub below left them out. Each of those fixtures runs the chain to its
 * END, and a real home of any version has both tables whole: a stub is missing them only because
 * nothing it was written for read them. Columns a stub already has are left as it wrote them.
 */
function stubActivitySources(db: DatabaseSync): void {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (cols("sessions").length === 0) db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0)");
  else if (!cols("sessions").includes("created_at")) db.exec("ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
  if (cols("session_events").length === 0) {
    db.exec("CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}')");
    return;
  }
  if (!cols("session_events").includes("ts")) db.exec("ALTER TABLE session_events ADD COLUMN ts INTEGER NOT NULL DEFAULT 0");
  if (!cols("session_events").includes("type")) db.exec("ALTER TABLE session_events ADD COLUMN type TEXT NOT NULL DEFAULT ''");
}

describe("database", () => {

  it("migrates a populated v3 database to v4, adding sessions.terminal_item_id (NULL) without touching its rows", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
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
    const p = join(tempDir("realm-db-"), "realm.db");
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
    const p = join(tempDir("realm-db-"), "realm.db");
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
    const p = join(tempDir("realm-db-"), "realm.db");
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
  stubActivitySources(db);
  // The fixture is deliberately minimal — only the tables LATER migrations touch. v14 ALTERs
  // sessions and v15 reads items/session_events and writes settings and v17 alters spaces, so stubs of those must exist
  // for the v9..v21 replay to run; their real v1/v3 shapes are exercised by the v4/v5 fixtures above.
  db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')");
  // session_events carries its real v3 COLUMNS, not just `seq`: v21 indexes (ts, session_id) on a
  // `type` predicate, so a stub with one column cannot reach v21 at all. A real v8 home has had all
  // four of these since v3 — the stub was under-specified, and the first migration to read a column
  // rather than merely require the table is what found it.
  db.exec("CREATE TABLE IF NOT EXISTS session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, layout_json TEXT)");
  // v33 ALTERs `checkpoints`, which a v8 home has had since v7 — the same under-specification the
  // `session_events` stub above ran into, found by the first migration to touch this table.
  db.exec("CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY)");
  // v37 ALTERs `profiles` and orders it, which a v8 home has had since v1 — the same
  // under-specification again, found by the first migration to touch that table. Its real shape.
  db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
    sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("srv1", "airtable", "stdio", "/usr/bin/node", '["/abs/s.mjs"]', "", '{"AIRTABLE_API_KEY":"pat-x"}', 1, 1);
  db.close();
  return { serverId: "srv1" };
}

describe("migration v9 — MCP gateway", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
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

  it("carries the usage and activity indexes onto an existing home, without touching a row", () => {
    // Both are index-only migrations (v21, v22) on the biggest table Realm has, and both are
    // pointless if a home that predates them never gains them — an unindexed `session_events` turns
    // the usage page and the activity calendar back into full scans of every transcript ever
    // written. Asserted on a REPLAYED v8 fixture, not a fresh home, because that is the case where
    // an append-only chain can silently skip a step.
    const { db } = migrated();
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(["session_events_usage", "session_events_messages"]));
    // PARTIAL, both of them: a plain index over the whole table would carry an entry for every tool
    // result ever stored to earn the same lookups.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_events_messages'").get() as { sql: string }).sql;
    expect(sql).toContain("WHERE type = 'user_message'");
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
    const p = join(tempDir("realm-db-"), "realm.db");
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
    const p = join(tempDir("realm-db-"), "realm.db");
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

describe("migration v15 — the search index (Plan 16 W1)", () => {
  // The v4 fixture again: real items and sessions, migrated the whole way forward.
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    // A pre-v15 transcript, inserted raw (no store, so no write-time indexing) before openDatabase
    // replays the chain — exactly what an upgrading home holds.
    const raw = new DatabaseSync(p);
    raw.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES ('se1', 1, 'user_message', ?)")
      .run(JSON.stringify({ text: "an old pangolin question", attachments: [] }));
    raw.close();
    return { p, db: openDatabase(p) };
  };

  it("creates the FTS table and backfills item titles inline", () => {
    const { db } = migrated();
    const rows = db.prepare("SELECT text, ref FROM search_index WHERE kind = 'item'").all() as { text: string; ref: string }[];
    expect(rows).toEqual([{ text: "versed", ref: "it-term" }]);
    db.close();
  });

  it("does NOT backfill events inline — it freezes the resumable cursor for the boot-time backfill instead", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'session'").get() as { n: number }).n).toBe(0);
    const cursor = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'search.backfill'").get() as { value_json: string }).value_json) as { done: number; target: number };
    expect(cursor.done).toBe(0);
    expect(cursor.target).toBeGreaterThan(0); // MAX(seq) of the pre-existing history
    db.close();
  });

  it("a fresh (no-history) home gets a closed cursor: done 0, target 0 — nothing to backfill", () => {
    const db = openDatabase(join(tempDir("realm-db-"), "realm.db"));
    const cursor = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'search.backfill'").get() as { value_json: string }).value_json) as { done: number; target: number };
    expect(cursor).toEqual({ done: 0, target: 0 });
    db.close();
  });
});

describe("migration v17 — pane groups", () => {
  /** A v4 home carrying a real layout on one space and none on another. */
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const pre = new DatabaseSync(p);
    pre.prepare("UPDATE spaces SET layout_json = ? WHERE id = 'sp1'")
      .run(JSON.stringify({ type: "leaf", id: "L1", itemId: "it-term" }));
    pre.close();
    return openDatabase(p);
  };

  it("adds groups_json to spaces, NULL for every existing space — nothing is backfilled", () => {
    const db = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    const cols = (db.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("groups_json");
    const rows = db.prepare("SELECT id, groups_json FROM spaces").all() as { id: string; groups_json: string | null }[];
    expect(rows.every((r) => r.groups_json === null)).toBe(true);
    db.close();
  });

  // The migration's whole contract: it must be INVISIBLE. A space's arrangement is what the read path
  // derives from the layout it already had (SpacesStore.toSpace), so the column staying NULL is not a
  // gap — it is the point.
  it("leaves layout_json exactly as it was, so a space keeps the arrangement it had", () => {
    const db = migrated();
    const row = db.prepare("SELECT layout_json FROM spaces WHERE id = 'sp1'").get() as { layout_json: string };
    expect(JSON.parse(row.layout_json)).toEqual({ type: "leaf", id: "L1", itemId: "it-term" });
    expect((db.prepare("SELECT layout_json FROM spaces WHERE id = 'sp2'").get() as { layout_json: string | null }).layout_json).toBeNull();
    db.close();
  });

  it("is idempotent: reopening the same home does not re-run the ALTER", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const first = openDatabase(p);
    first.prepare("UPDATE spaces SET groups_json = ? WHERE id = 'sp1'").run('{"groups":[]}');
    first.close();
    const again = openDatabase(p);
    expect((again.prepare("SELECT groups_json FROM spaces WHERE id = 'sp1'").get() as { groups_json: string }).groups_json).toBe('{"groups":[]}');
    expect((again.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    again.close();
  });
});

describe("migration v16 — the icon asset library", () => {
  it("adds icon_assets to a pre-v16 (v4-forward) home, scoped to a profile", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const db = openDatabase(p);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    db.prepare("INSERT INTO icon_assets (id, profile_id, kind, mime, data_text, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("ia1", "p1", "generated", "image/svg+xml", "<svg viewBox=\"0 0 48 48\"></svg>", "a pangolin", 1);
    const row = db.prepare("SELECT * FROM icon_assets WHERE id = ?").get("ia1") as { profile_id: string; kind: string; prompt: string | null };
    expect(row).toMatchObject({ profile_id: "p1", kind: "generated", prompt: "a pangolin" });
    db.close();
  });

  it("cascades on profile deletion", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const db = openDatabase(p);
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare("INSERT INTO icon_assets (id, profile_id, kind, mime, data_text, prompt, created_at) VALUES ('ia1', 'p1', 'image', 'image/png', 'ZGF0YQ==', NULL, 1)").run();
    db.prepare("DELETE FROM profiles WHERE id = 'p1'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM icon_assets").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("migration v18 — archiving (a row put away, not deleted)", () => {
  /** The v4 fixture plus one ordinary item, inserted raw at the PRE-v18 nine-column shape — the row
   *  an upgrading home actually holds. `it-term` cannot stand in for it: se1 owns it, so every
   *  listing filters it out for an unrelated reason. */
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const raw = new DatabaseSync(p);
    raw.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("it-old", "sp1", "session", "Old chat", 1, 1, "se2", 13, 13);
    raw.close();
    return openDatabase(p);
  };

  it("adds items.archived, 0 for every row it finds — an upgrade shelves nothing", () => {
    const db = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    const cols = (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("archived");
    expect((db.prepare("SELECT COUNT(*) AS n FROM items WHERE archived <> 0").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("the pre-v18 row reads back through the store as a live, still-pinned item", () => {
    const db = migrated();
    const items = new ItemsStore(db);
    // `pinned` proves the backfill did not rewrite the row it was appending a column to.
    expect(items.list("sp1")).toEqual([expect.objectContaining({ id: "it-old", title: "Old chat", pinned: true, archived: false })]);
    expect(items.listAll().map((i) => i.id)).toEqual(["it-old"]);
    db.close();
  });
});

describe("migration v25 — the Library's file index", () => {
  /**
   * The v4 fixture plus a history of session EVENTS, inserted raw — the state an upgrading home is
   * actually in: files were written months ago and nothing indexed them, because the index did not
   * exist yet.
   */
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const raw = new DatabaseSync(p);
    const ev = raw.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)");
    ev.run("se1", 100, "tool_call", JSON.stringify({ toolUseId: "t1", name: "Write", input: { file_path: "/tmp/versed/report.md" }, parentToolUseId: null }));
    ev.run("se1", 101, "assistant_text", JSON.stringify({ messageId: "m1", text: "wrote it" }));
    ev.run("se2", 102, "user_message", JSON.stringify({ text: "look", attachments: [{ path: "/tmp/versed/shot.png", mime: "image/png" }] }));
    raw.close();
    return openDatabase(p);
  };

  it("adds an EMPTY table and a cursor aimed at the whole existing history", () => {
    /* The migration itself indexes nothing. Walking every event inside a schema migration would put
       an unbounded scan between the user and their first window; the cursor is what defers it to a
       chunked, resumable, interruptible pass after boot. */
    const db = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n).toBe(0);
    const cursor = JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'artifacts.backfill'").get() as { value_json: string }).value_json) as { done: number; target: number };
    expect(cursor.done).toBe(0);
    // Frozen at the last event that existed when the schema moved. Everything past it is indexed at
    // write time, so the two writers cannot both claim the same row.
    expect(cursor.target).toBe((db.prepare("SELECT MAX(seq) AS m FROM session_events").get() as { m: number }).m);
    db.close();
  });

  it("is idempotent: a second open neither re-runs it nor resets a cursor the backfill has advanced", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v4Fixture(p);
    const first = openDatabase(p);
    first.prepare("UPDATE settings SET value_json = ? WHERE key = 'artifacts.backfill'").run(JSON.stringify({ done: 9, target: 9 }));
    first.close();
    // INSERT OR IGNORE, not INSERT: re-running this would otherwise rewind a finished backfill and
    // re-scan the whole history on every launch.
    const again = openDatabase(p);
    expect(JSON.parse((again.prepare("SELECT value_json FROM settings WHERE key = 'artifacts.backfill'").get() as { value_json: string }).value_json))
      .toEqual({ done: 9, target: 9 });
    again.close();
  });

  it("an indexed file goes when its session goes, without a second delete to remember", () => {
    const db = migrated();
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare("INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES ('a1', 'se1', 1, 'output', '/tmp/versed/report.md', 'report.md', 'md', 100)").run();
    db.prepare("DELETE FROM sessions WHERE id = 'se1'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

/**
 * The v32 shapes of the two tables v33 touches, hand-written — the same discipline as V3_SCHEMA,
 * V4_SCHEMA and V8_MCP_SERVERS above, and load-bearing for the same reason: a fixture derived by
 * replaying `migrations[0..31]` would agree with any in-place edit of an already-shipped migration,
 * including folding v33's five columns into an earlier entry, which is precisely the mistake these
 * fixtures exist to catch.
 *
 * `sessions` carries every column it had accumulated by v32 (v3's base, less v5's dropped `cwd`, plus
 * v4's terminal_item_id, v5's environment_id, v14's dispatch pair, v26's fast_mode and v31's seen_seq)
 * in the order the ALTERs appended them, because that IS what a real home's table looks like.
 *
 * `spaces`, `environments` and `items` are STUBS, the V8_MCP_SERVERS compromise: v33 reads no column of
 * any of them, but `sessions`' foreign keys have to point at something for a row to be insertable, and
 * their real shapes are exercised by the v4/v5 fixtures above. `browsers` is one too, for the reason
 * V8's `checkpoints` stub is: v36 ALTERs it, a real v32 home has had it since v10, and the first
 * migration to touch it after this fixture was written is what found it missing. `profiles` is in its
 * real shape for the same reason: v37 ALTERs and orders it, and a v32 home has had it since v1. `runs`
 * and `schedules` are stubs again: v38 ALTERs both (reading `runs.dedupe_key` and indexing its
 * `created_at`), and a v32 home has had them since v20 and v23.
 */
const V32_REWIND_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE environments (id TEXT PRIMARY KEY);
CREATE TABLE items (id TEXT PRIMARY KEY);
CREATE TABLE browsers (id TEXT PRIMARY KEY);
CREATE TABLE runs (id TEXT PRIMARY KEY, dedupe_key TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE schedules (id TEXT PRIMARY KEY);
CREATE TABLE simulators (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, udid TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios');
CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, project_id TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  terminal_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id),
  dispatched_by_kind TEXT, dispatched_by_session_id TEXT,
  fast_mode INTEGER NOT NULL DEFAULT 0, seen_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  worktree_tree TEXT NOT NULL,
  index_tree TEXT NOT NULL,
  head_sha TEXT,
  head_ref TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX checkpoints_environment ON checkpoints(environment_id, created_at DESC);
CREATE INDEX checkpoints_session ON checkpoints(session_id, created_at DESC);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** A v32 home with a Claude session that has already run, and two checkpoints of its turns. */
function v32Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V32_REWIND_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 32; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1')").run();
  db.prepare("INSERT INTO environments (id) VALUES ('env1')").run();
  db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, status,
    provider_session_id, title, last_event_seq, created_at, updated_at, terminal_item_id, environment_id,
    dispatched_by_kind, dispatched_by_session_id, fast_mode, seen_seq)
    VALUES ('se1','sp1',NULL,'claude',NULL,NULL,'default','idle','prov-1','Old session',9,1,1,NULL,'env1',NULL,NULL,0,4)`).run();
  const cp = db.prepare(`INSERT INTO checkpoints (id, environment_id, session_id, kind, label, ref, commit_sha,
    worktree_tree, index_tree, head_sha, head_ref, created_at) VALUES (?, 'env1', 'se1', 'turn', ?, ?, ?, 't1', 't2', 'h1', 'refs/heads/main', ?)`);
  cp.run("cp1", "first turn", "refs/realm/checkpoints/env1/cp1", "c1", 10);
  cp.run("cp2", "second turn", "refs/realm/checkpoints/env1/cp2", "c2", 20);
  // A pane on a simulator, as every v32 row is: what v34 must read back as not a real device.
  db.prepare("INSERT INTO simulators (id, space_id, name, udid, created_at, updated_at, platform) VALUES ('sim1', 'sp1', 'iPhone 17e', 'A7174200', 5, 6, 'ios')").run();
  db.close();
}

describe("migration v33 — conversation rewind", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v32Fixture(p);
    return { p, db: openDatabase(p) };
  };

  it("is appended, not folded into v32: a v32 home reaches the end of the chain and gains all five columns", () => {
    const { db } = migrated();
    // If v33's statements had been merged into an earlier entry, a database already stamped 32 would
    // never see them — the loop starts at MAX(version). This is the assertion that catches that.
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(32);
    const cps = (db.prepare("PRAGMA table_info(checkpoints)").all() as { name: string }[]).map((c) => c.name);
    expect(cps).toEqual(expect.arrayContaining(["session_seq", "provider_cursor"]));
    const sess = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(sess).toEqual(expect.arrayContaining(["provider_cursor", "rewind_fork_json", "rewind_refusal"]));
    db.close();
  });

  it("backfills NOTHING: every existing checkpoint and session comes out with NULL cursors", () => {
    /* The whole point of the migration, and the one mutant worth naming: a backfill that set
       `session_seq` to the session's `last_event_seq` would look harmless and would be a fabricated
       claim — it would assert that a checkpoint taken months ago sat at today's transcript position,
       and a restore would then truncate to the wrong place. NULL means "not known", and not known is
       the truth for every row written before these columns existed. */
    const { db } = migrated();
    const rows = db.prepare("SELECT id, session_seq, provider_cursor FROM checkpoints ORDER BY id").all() as { id: string; session_seq: number | null; provider_cursor: string | null }[];
    expect(rows).toEqual([
      { id: "cp1", session_seq: null, provider_cursor: null },
      { id: "cp2", session_seq: null, provider_cursor: null },
    ]);
    const s = db.prepare("SELECT provider_cursor, rewind_fork_json, rewind_refusal FROM sessions WHERE id = 'se1'").get() as Record<string, unknown>;
    expect(s).toEqual({ provider_cursor: null, rewind_fork_json: null, rewind_refusal: null });
    db.close();
  });

  it("leaves every other column of the rows it altered exactly as it found them", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT label, commit_sha, head_ref, created_at FROM checkpoints WHERE id = 'cp2'").get())
      .toEqual({ label: "second turn", commit_sha: "c2", head_ref: "refs/heads/main", created_at: 20 });
    expect(db.prepare("SELECT title, last_event_seq, seen_seq, provider_session_id FROM sessions WHERE id = 'se1'").get())
      .toEqual({ title: "Old session", last_event_seq: 9, seen_seq: 4, provider_session_id: "prov-1" });
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the ALTERs nor disturbs a cursor written since", () => {
    const { p, db } = migrated();
    // A cursor written by the running app after the upgrade. A re-run of the migration would throw
    // "duplicate column"; a migration rewritten as a backfill would quietly reset this to NULL.
    db.prepare("UPDATE checkpoints SET session_seq = 12, provider_cursor = ? WHERE id = 'cp2'")
      .run('{"session":"prov-1","at":"u-end","dropsTurn":"u-prompt"}');
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT session_seq, provider_cursor FROM checkpoints WHERE id = 'cp2'").get())
      .toEqual({ session_seq: 12, provider_cursor: '{"session":"prov-1","at":"u-end","dropsTurn":"u-prompt"}' });
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

describe("migration v34 — a real device", () => {
  it("is appended, and reads every row written before it as the simulator it was", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v32Fixture(p);
    const db = openDatabase(p);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThanOrEqual(34);
    // Defaulted, not backfilled: the row is exactly as it was, plus a column that says what it always was.
    expect(db.prepare("SELECT name, udid, platform, physical, created_at, updated_at FROM simulators WHERE id = 'sim1'").get())
      .toEqual({ name: "iPhone 17e", udid: "A7174200", platform: "ios", physical: 0, created_at: 5, updated_at: 6 });
    db.close();
  });
});

/**
 * The v34 shapes of what v35 touches, hand-written for the reason every fixture above is: replaying
 * `migrations[0..33]` would agree with an in-place edit of a shipped migration, including folding
 * v35's table into an earlier entry — and a home already stamped 34 would then never get it.
 *
 * `profiles` is its real shape, because the history's foreign key points at it and the cascade is part
 * of what is under test. `spaces` is a stub (nothing here reads a column of it), and `browsers` carries
 * a pane that is already somewhere — which is what a backfill would be tempted to turn into a visit.
 * `runs` and `schedules` are stubs because v38 ALTERs them, and a v34 home has had both since v23.
 */
const V34_HISTORY_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE);
CREATE TABLE browsers (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX browsers_space ON browsers(space_id);
CREATE TABLE runs (id TEXT PRIMARY KEY, dedupe_key TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE schedules (id TEXT PRIMARY KEY);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** A v34 home with two profiles and a browser pane already on a page. */
function v34Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V34_HISTORY_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 34; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  const profile = db.prepare("INSERT INTO profiles VALUES (?, ?, 'user', '#000000', 0, 1, 1)");
  profile.run("p1", "Work");
  profile.run("p2", "Home");
  db.prepare("INSERT INTO spaces (id, profile_id) VALUES ('sp1', 'p1')").run();
  db.prepare("INSERT INTO browsers VALUES ('b1', 'sp1', 'https://example.com/docs', 'Docs', 1, 2)").run();
  db.close();
}

describe("migration v35 — browser history", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v34Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const visit = (db: DatabaseSync, profile: string, url: string, n = 1) =>
    db.prepare("INSERT INTO browser_history (profile_id, url, title, visit_count, last_visit_at) VALUES (?, ?, 'T', ?, 10)").run(profile, url, n);

  it("is appended, not folded into v34: a v34 home reaches the end of the chain and gains the table", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(34);
    const cols = (db.prepare("PRAGMA table_info(browser_history)").all() as { name: string }[]).map((c) => c.name);
    // The columns v35 created, in its order; later migrations append (v36's favicon_digest).
    expect(cols.slice(0, 5)).toEqual(["profile_id", "url", "title", "visit_count", "last_visit_at"]);
    db.close();
  });

  it("backfills NOTHING: a pane that is already on a page is not a visit anyone made", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT COUNT(*) AS n FROM browser_history").get() as { n: number }).n).toBe(0);
    // …and the pane's own row is exactly as it was.
    expect(db.prepare("SELECT url, title, updated_at FROM browsers WHERE id = 'b1'").get()).toEqual({ url: "https://example.com/docs", title: "Docs", updated_at: 2 });
    db.close();
  });

  it("holds one row per page per profile — a second visit has to be an update, not a second row", () => {
    const { db } = migrated();
    visit(db, "p1", "https://example.com/");
    expect(() => visit(db, "p1", "https://example.com/")).toThrow(/UNIQUE|PRIMARY/);
    // The same page in ANOTHER profile is that profile's own row.
    expect(() => visit(db, "p2", "https://example.com/")).not.toThrow();
    db.close();
  });

  it("a profile's history goes with the profile, and only that profile's", () => {
    const { db } = migrated();
    visit(db, "p1", "https://a.example/");
    visit(db, "p2", "https://b.example/");
    db.prepare("DELETE FROM profiles WHERE id = 'p1'").run();
    expect(db.prepare("SELECT profile_id, url FROM browser_history").all()).toEqual([{ profile_id: "p2", url: "https://b.example/" }]);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the CREATE nor loses a visit made since", () => {
    const { p, db } = migrated();
    visit(db, "p1", "https://example.com/", 3);
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT url, visit_count FROM browser_history").all()).toEqual([{ url: "https://example.com/", visit_count: 3 }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

/**
 * The v35 shapes of what v36 touches, hand-written for the reason every fixture above is: replaying
 * `migrations[0..34]` would agree with an in-place edit of a shipped migration — folding v36's columns
 * into v35's CREATE, say — and a home already stamped 35 would then never get them.
 *
 * `profiles` is its real shape, because the favicon table's foreign key points at it and the cascade
 * is under test. `spaces` is a stub. `browsers` and `browser_history` each carry a row already, which
 * is what a backfill would be tempted to invent an icon for. `runs` and `schedules` are stubs because
 * v38 ALTERs them, and a v35 home has had both since v23.
 */
const V35_FAVICON_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE);
CREATE TABLE browsers (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX browsers_space ON browsers(space_id);
CREATE TABLE browser_history (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1, last_visit_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, url));
CREATE INDEX browser_history_recent ON browser_history(profile_id, last_visit_at DESC);
CREATE TABLE runs (id TEXT PRIMARY KEY, dedupe_key TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE schedules (id TEXT PRIMARY KEY);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** A v35 home with two profiles, a pane on a page, and that page in the history. */
function v35Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V35_FAVICON_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 35; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  const profile = db.prepare("INSERT INTO profiles VALUES (?, ?, 'user', '#000000', 0, 1, 1)");
  profile.run("p1", "Work");
  profile.run("p2", "Home");
  db.prepare("INSERT INTO spaces (id, profile_id) VALUES ('sp1', 'p1')").run();
  db.prepare("INSERT INTO browsers VALUES ('b1', 'sp1', 'https://example.com/docs', 'Docs', 1, 2)").run();
  db.prepare("INSERT INTO browser_history VALUES ('p1', 'https://example.com/docs', 'Docs', 3, 40)").run();
  db.close();
}

describe("migration v36 — favicons", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v35Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const keep = (db: DatabaseSync, profile: string, digest: string) =>
    db.prepare("INSERT INTO browser_favicons (profile_id, digest, data) VALUES (?, ?, ?)").run(profile, digest, PNG);

  it("is appended, not folded into v35: a v35 home reaches the end of the chain and gains every column", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(35);
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("browsers")).toContain("favicon");
    expect(cols("browser_history")).toContain("favicon_digest");
    expect(cols("browser_favicons")).toEqual(["profile_id", "digest", "data"]);
    db.close();
  });

  it("backfills NOTHING: a pane and a page nobody fetched an icon for come out with none, and otherwise as they were", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT url, title, favicon, updated_at FROM browsers WHERE id = 'b1'").get())
      .toEqual({ url: "https://example.com/docs", title: "Docs", favicon: "", updated_at: 2 });
    expect(db.prepare("SELECT title, visit_count, last_visit_at, favicon_digest FROM browser_history").get())
      .toEqual({ title: "Docs", visit_count: 3, last_visit_at: 40, favicon_digest: "" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM browser_favicons").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("keeps a picture once per profile, and a profile's pictures go with the profile", () => {
    const { db } = migrated();
    keep(db, "p1", "d1");
    expect(() => keep(db, "p1", "d1")).toThrow(/UNIQUE|PRIMARY/);
    keep(db, "p2", "d1"); // the same picture in ANOTHER profile is that profile's own row
    db.prepare("DELETE FROM profiles WHERE id = 'p1'").run();
    expect(db.prepare("SELECT profile_id FROM browser_favicons").all()).toEqual([{ profile_id: "p2" }]);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the ALTERs nor loses an icon kept since", () => {
    const { p, db } = migrated();
    db.prepare("UPDATE browsers SET favicon = ? WHERE id = 'b1'").run(PNG);
    keep(db, "p1", "d1");
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT favicon FROM browsers WHERE id = 'b1'").get()).toEqual({ favicon: PNG });
    expect(again.prepare("SELECT digest FROM browser_favicons").all()).toEqual([{ digest: "d1" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

/**
 * The v36 shape of what v37 touches, hand-written for the reason every fixture above is. `profiles` is
 * its real v36 shape; `spaces` is a stub that only has to hold a foreign key. The rows are inserted in
 * an order that is NOT the app's order — the profile listed first is the second one written, and two
 * share a sort position — because "first" is the whole question the backfill answers. `runs` and
 * `schedules` are stubs because v38 ALTERs them, and a v36 home has had both since v23.
 */
const V36_PROFILES_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE);
CREATE TABLE runs (id TEXT PRIMARY KEY, dedupe_key TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE schedules (id TEXT PRIMARY KEY);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** A v36 home with three profiles: School (sort 1), Work (sort 0, the app's first), Home (sort 1, younger). */
function v36Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V36_PROFILES_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 36; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  const profile = db.prepare("INSERT INTO profiles VALUES (?, ?, 'user', '#000000', ?, ?, 1)");
  profile.run("pSchool", "School", 1, 5);
  profile.run("pWork", "Work", 0, 9);
  profile.run("pHome", "Home", 1, 7);
  db.prepare("INSERT INTO spaces (id, profile_id) VALUES ('sp1', 'pWork')").run();
  db.close();
}

describe("migration v37 — a browser partition per profile", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v36Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const partitions = (db: DatabaseSync) =>
    Object.fromEntries((db.prepare("SELECT id, browser_partition FROM profiles").all() as { id: string; browser_partition: string }[])
      .map((r) => [r.id, r.browser_partition]));

  it("is appended, not folded into v36: a v36 home reaches the end of the chain and gains the column", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(36);
    const cols = (db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("browser_partition");
    db.close();
  });

  it("gives the shared jar to the profile the app lists FIRST, and every other profile one of its own", () => {
    /* THE mutants: hand `persist:browser` to the first row WRITTEN (School), or to none — either way the
       user opens the profile they always used and every site has signed them out. */
    const { db } = migrated();
    expect(partitions(db)).toEqual({
      pWork: "persist:browser",
      pSchool: "persist:browser-pSchool",
      pHome: "persist:browser-pHome",
    });
    db.close();
  });

  it("changes nothing else about a profile, and keeps its spaces", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT name, icon, color, sort_order, created_at FROM profiles WHERE id = 'pHome'").get())
      .toEqual({ name: "Home", icon: "user", color: "#000000", sort_order: 1, created_at: 7 });
    expect(db.prepare("SELECT profile_id FROM spaces").all()).toEqual([{ profile_id: "pWork" }]);
    db.close();
  });

  it("is idempotent: a reopen after the user reorders profiles moves nobody's cookies", () => {
    const { p, db } = migrated();
    // School moves to the top. The jar stays with Work — it is the user's sign-ins, not a rank.
    db.prepare("UPDATE profiles SET sort_order = -1 WHERE id = 'pSchool'").run();
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(partitions(again).pWork).toBe("persist:browser");
    expect(partitions(again).pSchool).toBe("persist:browser-pSchool");
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });

  it("a home with no profiles yet backfills nothing — the first profile made takes the shared jar", () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    db.exec(V36_PROFILES_SCHEMA);
    stubActivitySources(db);
    for (let v = 1; v <= 36; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
    db.close();
    const fresh = openDatabase(p);
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM profiles").get()).toEqual({ n: 0 });
    fresh.close();
  });
});

/**
 * The v37 shape of what v38 touches, hand-written for the reason every fixture above is: `runs` as
 * v20 created it and `schedules` as v23 did, column for column. `spaces` and `environments` are stubs
 * that only have to hold the foreign keys. The runs are the cases the backfill has to tell apart: two
 * firings of one schedule (a clock one and a Run now — both keyed `schedule:<id>:<moment>`), a run
 * whose key merely starts with the word, one keyed by somebody else, and one with no key at all.
 */
const V37_SCHEDULED_SCHEMA = `
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE environments (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, goal TEXT NOT NULL, agent_kind TEXT NOT NULL,
  environment_id TEXT REFERENCES environments(id),
  constraints_json TEXT, dedupe_key TEXT,
  state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
  session_id TEXT, deadline_at INTEGER, result_text TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL);
CREATE INDEX runs_space ON runs(space_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX runs_dedupe ON runs(space_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running', 'blocked');
CREATE INDEX runs_live ON runs(state) WHERE state IN ('queued', 'running', 'blocked');
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  constraints_json TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_run_id TEXT,
  last_skipped_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX schedules_space ON schedules(space_id, created_at);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled = 1;
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

function v37Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V37_SCHEDULED_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 37; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1')").run();
  db.prepare(`INSERT INTO schedules (id, space_id, title, goal, cron, enabled, constraints_json, next_run_at, last_run_at, last_run_id, last_skipped_at, created_at, updated_at)
    VALUES ('SCH1', 'sp1', 'Morning triage', 'Read the new issues.', '0 9 * * 1-5', 1, '{"agentKind":"fake"}', 500, 400, 'r-clock', NULL, 10, 20)`).run();
  const run = db.prepare(`INSERT INTO runs (id, space_id, title, goal, agent_kind, environment_id, constraints_json, dedupe_key, state, attempt, max_attempts,
    session_id, deadline_at, result_text, error, created_at, started_at, settled_at, updated_at)
    VALUES (?, 'sp1', 'Morning triage', 'Read the new issues.', 'fake', NULL, NULL, ?, 'succeeded', 1, 1, ?, NULL, 'done', NULL, ?, NULL, NULL, ?)`);
  run.run("r-clock", "schedule:SCH1:1790000000000", "sess-a", 100, 100);
  run.run("r-now", "schedule:SCH1:1790000500000", "sess-b", 200, 200);
  run.run("r-word", "schedule:", "sess-c", 300, 300);
  run.run("r-other", "hw-week-3", "sess-d", 400, 400);
  run.run("r-none", null, "sess-e", 500, 500);
  db.close();
}

describe("migration v38 — a scheduled task keeps its runs", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v37Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const scheduleIds = (db: DatabaseSync) =>
    Object.fromEntries((db.prepare("SELECT id, schedule_id FROM runs").all() as { id: string; schedule_id: string | null }[]).map((r) => [r.id, r.schedule_id]));

  it("is appended, not folded into v37: a v37 home reaches the end of the chain and gains every column", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(37);
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("runs")).toContain("schedule_id");
    expect(cols("schedules")).toEqual(expect.arrayContaining(["new_session_per_run", "archive_succeeded"]));
    db.close();
  });

  it("reads each scheduled run's schedule back off the key the scheduler wrote, and invents none", () => {
    /* THE mutants: a backfill that leaves every run unlinked (the page shows tasks that never ran), and
       one that takes anything starting `schedule:` (a key that only has the word gets a schedule id of
       "" or of garbage). */
    const { db } = migrated();
    expect(scheduleIds(db)).toEqual({ "r-clock": "SCH1", "r-now": "SCH1", "r-word": null, "r-other": null, "r-none": null });
    db.close();
  });

  it("gives every existing schedule the only behaviour it ever had: a new session per run, nothing archived", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT new_session_per_run, archive_succeeded FROM schedules WHERE id = 'SCH1'").get())
      .toEqual({ new_session_per_run: 1, archive_succeeded: 0 });
    // …and nothing else about it moved.
    expect(db.prepare("SELECT title, goal, cron, enabled, constraints_json, next_run_at, last_run_at, last_run_id, created_at, updated_at FROM schedules").get())
      .toEqual({ title: "Morning triage", goal: "Read the new issues.", cron: "0 9 * * 1-5", enabled: 1, constraints_json: '{"agentKind":"fake"}',
        next_run_at: 500, last_run_at: 400, last_run_id: "r-clock", created_at: 10, updated_at: 20 });
    db.close();
  });

  it("lists a schedule's runs off an index, not a scan of every run", () => {
    const { db } = migrated();
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM runs WHERE schedule_id = ? ORDER BY created_at DESC, id DESC").all("SCH1") as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("runs_schedule");
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the ALTERs nor re-links a run unlinked since", () => {
    const { p, db } = migrated();
    db.prepare("UPDATE runs SET schedule_id = NULL WHERE id = 'r-now'").run();
    db.prepare("UPDATE schedules SET new_session_per_run = 0 WHERE id = 'SCH1'").run();
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(scheduleIds(again)["r-now"]).toBeNull();
    expect(again.prepare("SELECT new_session_per_run FROM schedules").get()).toEqual({ new_session_per_run: 0 });
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

/**
 * What every real home has had since v20/v23 and the stubs below left out: the team migrations (v43+)
 * ALTER `runs` and `schedules` and hang tables off `spaces`, so a fixture that stops before them has
 * to hold those three, the way V32's `browsers` stub exists for a later key. IF NOT EXISTS, so a
 * fixture that already has one keeps its own.
 */
const TEAM_TABLES_STUB = `
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at INTEGER);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY);
`;

/**
 * The v38 shape of what v39 touches, hand-written for the reason every fixture above is: `sessions`
 * as it stands at v38 matters only as the table `app_views` hangs off, so it is a stub holding the
 * id the foreign key needs — with a session in it, as a real home would have. `session_events` is a
 * stub too, for the reason V32's `browsers` is: a real v38 home has had it since v3, and v41's key to
 * it — which a session's deletion now resolves — is what found it missing.
 */
const V38_SESSIONS_SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
${TEAM_TABLES_STUB}`;

function v38Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V38_SESSIONS_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= 38; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO sessions (id, title) VALUES ('sess1', 'Charts'), ('sess2', 'Other')").run();
  db.close();
}

describe("migration v39 — the views MCP servers draw", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v38Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const insert = (db: DatabaseSync, id: string, sessionId: string) => db.prepare(`INSERT INTO app_views
    (id, session_id, tool_use_id, server_id, server_name, tool, tool_json, resource_uri, input_json, result_json, created_at)
    VALUES (?, ?, 'toolu_1', 'SRV', 'Charts', 'show_chart', '{}', 'ui://charts/bar.html', '{}', '{}', 1)`).run(id, sessionId);

  it("is appended, not folded into v38: a v38 home reaches the end of the chain and gains the table", () => {
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBeGreaterThan(38);
    const cols = (db.prepare("PRAGMA table_info(app_views)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "session_id", "tool_use_id", "server_id", "server_name", "tool", "tool_json", "resource_uri", "input_json", "result_json", "created_at"]);
    db.close();
  });

  it("backfills NOTHING, and leaves the sessions it hangs off exactly as they were", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_views").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, title FROM sessions ORDER BY id").all()).toEqual([{ id: "sess1", title: "Charts" }, { id: "sess2", title: "Other" }]);
    db.close();
  });

  it("goes with its session, and only its own session's views go", () => {
    const { db } = migrated();
    insert(db, "v1", "sess1");
    insert(db, "v2", "sess2");
    db.prepare("DELETE FROM sessions WHERE id = 'sess1'").run();
    expect(db.prepare("SELECT id FROM app_views").all()).toEqual([{ id: "v2" }]);
    expect(() => insert(db, "v3", "no-such-session")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the CREATE nor loses a view kept since", () => {
    const { p, db } = migrated();
    insert(db, "v1", "sess1");
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT id FROM app_views").all()).toEqual([{ id: "v1" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    // The statement itself is safe to meet twice as well — `IF NOT EXISTS`, not a version check alone.
    expect(() => again.exec(migrations[38]!)).not.toThrow();
    again.close();
  });
});

/**
 * The v39 shape of what v40 touches, hand-written for the reason every fixture above is: `profiles` as
 * it stands at v39 — v1's columns and v37's partition, in that order — because `library_files` hangs
 * off it, with two profiles in it as a real home has.
 *
 * The version it is stamped at is found rather than written down: the migration that makes the table
 * is looked for by what it says, so a migration another branch lands before it still leaves this a
 * home stamped one short of it.
 */
const V39_PROFILES_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  browser_partition TEXT NOT NULL DEFAULT '');
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
${TEAM_TABLES_STUB}`;
const LIBRARY_FILES_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS library_files"));

function v39Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V39_PROFILES_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= LIBRARY_FILES_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare(`INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at, browser_partition)
    VALUES ('pWork', 'Work', 'briefcase', '#3b82f6', 0, 1, 1, 'persist:browser'), ('pHome', 'Home', 'house', '#22c55e', 1, 2, 2, 'persist:browser-pHome')`).run();
  db.close();
}

describe("migration v40 — the files a person adds to the Library", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v39Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const insert = (db: DatabaseSync, id: string, profileId: string, ts = 1) => db.prepare(`INSERT INTO library_files
    (id, profile_id, path, name, ext, size, digest, ts) VALUES (?, ?, '/home/library/report.pdf', 'report.pdf', 'pdf', 9, 'd1', ?)`).run(id, profileId, ts);

  it("is appended, not folded into v39: a v39 home reaches the end of the chain and gains the table", () => {
    const { db } = migrated();
    expect(LIBRARY_FILES_AT).toBeGreaterThanOrEqual(39);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    const cols = (db.prepare("PRAGMA table_info(library_files)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "profile_id", "path", "name", "ext", "size", "digest", "ts"]);
    db.close();
  });

  it("backfills NOTHING, and leaves the profiles it hangs off exactly as they were", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_files").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, name, browser_partition FROM profiles ORDER BY sort_order").all())
      .toEqual([{ id: "pWork", name: "Work", browser_partition: "persist:browser" }, { id: "pHome", name: "Home", browser_partition: "persist:browser-pHome" }]);
    db.close();
  });

  it("goes with its profile, only its own profile's files go, and a file names a profile that exists", () => {
    const { db } = migrated();
    insert(db, "f1", "pWork");
    insert(db, "f2", "pHome");
    db.prepare("DELETE FROM profiles WHERE id = 'pHome'").run();
    expect(db.prepare("SELECT id FROM library_files").all()).toEqual([{ id: "f1" }]);
    expect(() => insert(db, "f3", "no-such-profile")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("answers the Library's two questions off indexes: a profile's newest files, and whether these bytes are in", () => {
    const { db } = migrated();
    const plan = (sql: string, ...args: string[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" ");
    const newest = plan("SELECT * FROM library_files WHERE profile_id = ? ORDER BY ts DESC, id DESC LIMIT 60", "pWork");
    expect(newest).toContain("library_files_recent");
    expect(newest).not.toContain("TEMP B-TREE");
    expect(plan("SELECT id FROM library_files WHERE profile_id = ? AND digest = ?", "pWork", "d1")).toMatch(/library_files_(digest|recent)/);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the CREATE nor loses a file kept since", () => {
    const { p, db } = migrated();
    insert(db, "f1", "pWork");
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT id FROM library_files").all()).toEqual([{ id: "f1" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    // The statement itself is safe to meet twice as well — `IF NOT EXISTS`, not a version check alone.
    expect(() => again.exec(migrations[LIBRARY_FILES_AT]!)).not.toThrow();
    expect(again.prepare("SELECT id FROM library_files").all()).toEqual([{ id: "f1" }]);
    again.close();
  });
});

/**
 * The v40 shape of what v41 hangs off, hand-written for every fixture's reason: `session_events`
 * exactly as it has stood since v3 — the table a saved turn names a row of — and `sessions` as a stub
 * holding the id the second key needs, with a log in it, as a real home would have. And v40's own
 * table as v40 made it — `library_files`, on the `profiles` it hangs off, with a file in it — which the
 * migration after it has to leave exactly as it found it.
 *
 * Stamped one short of the migration that makes `saved_turns`, found by what it says, as v40's fixture
 * finds its own: a migration another branch lands first still leaves this a home one short of it.
 */
const V40_EVENTS_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  browser_partition TEXT NOT NULL DEFAULT '');
CREATE TABLE library_files (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  digest TEXT NOT NULL,
  ts INTEGER NOT NULL);
CREATE INDEX library_files_recent ON library_files(profile_id, ts DESC, id DESC);
CREATE INDEX library_files_digest ON library_files(profile_id, digest);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX session_events_session ON session_events(session_id, seq);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
${TEAM_TABLES_STUB}`;
const SAVED_TURNS_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS saved_turns"));

function v40Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V40_EVENTS_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= SAVED_TURNS_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare(`INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at, browser_partition)
    VALUES ('pWork', 'Work', 'briefcase', '#3b82f6', 0, 1, 1, 'persist:browser')`).run();
  db.prepare(`INSERT INTO library_files (id, profile_id, path, name, ext, size, digest, ts)
    VALUES ('f1', 'pWork', '/home/library/pWork/report.pdf', 'report.pdf', 'pdf', 9, 'd1', 5)`).run();
  db.prepare("INSERT INTO sessions (id, title) VALUES ('sess1', 'Org access'), ('sess2', 'Recipes')").run();
  const ev = db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)");
  ev.run("sess1", 10, "user_message", '{"text":"Fix the crash","attachments":[]}'); // seq 1
  ev.run("sess1", 11, "assistant_text", '{"messageId":"m1","text":"Fixed."}'); // seq 2
  ev.run("sess1", 20, "user_message", '{"text":"Add a test","attachments":[]}'); // seq 3
  ev.run("sess2", 30, "user_message", '{"text":"Soup?","attachments":[]}'); // seq 4
  db.close();
}

describe("migration v41 — saved turns", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v40Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const save = (db: DatabaseSync, seq: number, sessionId: string) =>
    db.prepare("INSERT INTO saved_turns (event_seq, session_id, saved_at) VALUES (?, ?, 1)").run(seq, sessionId);

  it("is appended after v40, not folded into it: a v40 home reaches the end of the chain and gains the table", () => {
    const { db } = migrated();
    expect(SAVED_TURNS_AT).toBeGreaterThanOrEqual(40);
    expect(SAVED_TURNS_AT).toBeGreaterThan(LIBRARY_FILES_AT);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    const cols = (db.prepare("PRAGMA table_info(saved_turns)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["event_seq", "session_id", "saved_at"]);
    db.close();
  });

  it("saves nothing on the way in, and leaves the log it names — and v40's files — exactly as they were", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT COUNT(*) AS n FROM saved_turns").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT seq, session_id, type FROM session_events ORDER BY seq").all()).toEqual([
      { seq: 1, session_id: "sess1", type: "user_message" }, { seq: 2, session_id: "sess1", type: "assistant_text" },
      { seq: 3, session_id: "sess1", type: "user_message" }, { seq: 4, session_id: "sess2", type: "user_message" }]);
    expect(db.prepare("SELECT id, profile_id, name, digest FROM library_files").all()).toEqual([{ id: "f1", profile_id: "pWork", name: "report.pdf", digest: "d1" }]);
    db.close();
  });

  it("goes with the event it names — cut from the log, or gone with its session — and names no other", () => {
    /* THE mutant: a table with no key to the event. A rewind that cut the prompt out of the log would
       leave a saved turn pointing at a seq nothing holds — listed as a blank, or as whatever reused it. */
    const { db } = migrated();
    // A session that is not there is refused too: the per-session read a pane mounts with would never find it.
    expect(() => save(db, 3, "nobody")).toThrow(/FOREIGN KEY/);
    save(db, 1, "sess1");
    save(db, 3, "sess1");
    save(db, 4, "sess2");
    db.prepare("DELETE FROM session_events WHERE session_id = 'sess1' AND seq > 1").run();
    expect(db.prepare("SELECT event_seq FROM saved_turns ORDER BY event_seq").all()).toEqual([{ event_seq: 1 }, { event_seq: 4 }]);
    db.prepare("DELETE FROM sessions WHERE id = 'sess2'").run();
    expect(db.prepare("SELECT event_seq FROM saved_turns").all()).toEqual([{ event_seq: 1 }]);
    expect(() => save(db, 999, "sess1")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("is idempotent: reopening twice more neither re-runs the CREATE nor loses a turn saved since", () => {
    const { p, db } = migrated();
    save(db, 1, "sess1");
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT event_seq, session_id FROM saved_turns").all()).toEqual([{ event_seq: 1, session_id: "sess1" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    // The statement itself is safe to meet twice as well — `IF NOT EXISTS`, not a version check alone.
    expect(() => again.exec(migrations[SAVED_TURNS_AT]!)).not.toThrow();
    expect(again.prepare("SELECT event_seq FROM saved_turns").all()).toEqual([{ event_seq: 1 }]);
    again.close();
  });
});

describe("migration v42 — goal mode's provider renamed to realm-goal", () => {
  /* The v3 home stands in for any home from before the rename: `settings` has not changed shape since
     v1, and the switches are rows in it. */
  const migrated = (rows: [string, string][]) => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v3Fixture(p);
    const raw = new DatabaseSync(p);
    for (const [key, value] of rows) raw.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)").run(key, value);
    raw.close();
    return { p, db: openDatabase(p) };
  };
  const read = (db: DatabaseSync, key: string) => (db.prepare("SELECT value_json AS v FROM settings WHERE key = ?").get(key) as { v: string }).v;

  it("keeps a space's goal tools off under the new name, and leaves every other switch alone", () => {
    // THE mutant is no migration: `goal` stays in the list, `realm-goal` is not in it, and a space that
    // switched the goal tools off has them back after an upgrade.
    const { db } = migrated([
      ["mcp.providersDisabled:sp1", '["goal","realm-browser"]'],
      ["mcp.providersDisabled:sp2", '["realm-docs"]'],
      ["mcp.providersEnabled:sp1", '["goal"]'],
      ["theme", '"goal"'],
    ]);
    expect(JSON.parse(read(db, "mcp.providersDisabled:sp1"))).toEqual(["realm-browser", "realm-goal"]);
    expect(read(db, "mcp.providersDisabled:sp2")).toBe('["realm-docs"]');
    // Only the disabled lists name providers that default on; nothing else is the rename's business.
    expect(read(db, "mcp.providersEnabled:sp1")).toBe('["goal"]');
    expect(read(db, "theme")).toBe('"goal"');
    db.close();
  });

  it("is idempotent, and folds a list that already had both names into one", () => {
    const { p, db } = migrated([["mcp.providersDisabled:sp1", '["realm-goal","goal"]']]);
    expect(JSON.parse(read(db, "mcp.providersDisabled:sp1"))).toEqual(["realm-goal"]);
    db.prepare("UPDATE settings SET value_json = ? WHERE key = ?").run('["realm-goal","realm-docs"]', "mcp.providersDisabled:sp1");
    db.close();
    const again = openDatabase(p);
    // A list written by the running app after the upgrade is never rewritten again.
    expect(read(again, "mcp.providersDisabled:sp1")).toBe('["realm-goal","realm-docs"]');
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

/**
 * The v42 shape of what v43–v45 touch, hand-written: `runs` and `schedules` as they stand after v38
 * (the v20/v23 tables plus `schedule_id`, `new_session_per_run`, `archive_succeeded`), and `spaces` as
 * the stub the new tables' foreign keys hang off. One space with a scheduled run and a hand-started
 * one, so the upgrade has rows it must leave belonging to no role.
 */
const V42_TEAMS_SCHEMA = `
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, goal TEXT NOT NULL, agent_kind TEXT NOT NULL, environment_id TEXT,
  constraints_json TEXT, dedupe_key TEXT,
  state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
  session_id TEXT, deadline_at INTEGER, result_text TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL,
  schedule_id TEXT);
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, goal TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  constraints_json TEXT, next_run_at INTEGER, last_run_at INTEGER, last_run_id TEXT, last_skipped_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  new_session_per_run INTEGER NOT NULL DEFAULT 1, archive_succeeded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** Stamped up to the version BEFORE the team tables, found from the migration's own text so the
 *  fixture survives a renumbering at merge time. */
const TEAM_ROLES_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_roles"));

function v42Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V42_TEAMS_SCHEMA);
  stubActivitySources(db);
  for (let v = 1; v <= TEAM_ROLES_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1'), ('sp2')").run();
  db.prepare(`INSERT INTO schedules (id, space_id, title, goal, cron, enabled, constraints_json, next_run_at, last_run_at, last_run_id, last_skipped_at, created_at, updated_at)
    VALUES ('SCH1', 'sp1', 'Morning triage', 'Read the new issues.', '0 9 * * 1-5', 1, NULL, 500, 400, 'r-clock', NULL, 10, 20)`).run();
  const run = db.prepare(`INSERT INTO runs (id, space_id, title, goal, agent_kind, state, attempt, max_attempts, session_id, result_text, created_at, updated_at, schedule_id)
    VALUES (?, 'sp1', 'Morning triage', 'Read the new issues.', 'fake', 'succeeded', 1, 1, ?, 'done', ?, ?, ?)`);
  run.run("r-clock", "sess-a", 100, 100, "SCH1");
  run.run("r-hand", "sess-b", 200, 200, null);
  db.close();
}

describe("migrations v43–v45 — teams: roles, review, activity", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v42Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  it("is appended after v42: a v42 home reaches the end of the chain and gains every table and column", () => {
    expect(TEAM_ROLES_AT).toBeGreaterThanOrEqual(42);
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(cols(db, "team_roles")).toEqual(expect.arrayContaining(["space_id", "name", "brief", "realmite_json", "model", "permission_mode",
      "skills_json", "week_budget_usd", "run_cap_usd", "run_cap_ms", "max_concurrent", "archived"]));
    expect(cols(db, "runs")).toEqual(expect.arrayContaining(["role_id", "woke_on", "cost_usd", "schedule_id"]));
    expect(cols(db, "schedules")).toContain("role_id");
    expect(cols(db, "team_reviews")).toEqual(expect.arrayContaining(["role_id", "run_id", "record_path", "kind", "state", "version"]));
    expect(cols(db, "team_review_items")).toEqual(expect.arrayContaining(["files_json", "body", "target_json", "content_hash", "approved_hash", "act_state"]));
    expect(cols(db, "team_activity")).toEqual(expect.arrayContaining(["actor", "verb", "object", "detail_json", "run_id"]));
    db.close();
  });

  it("gives no existing run or schedule a role, and leaves the rest of each row as it was", () => {
    /* THE mutant: a backfill that tags old work with a role, or sets a cost it never measured. */
    const { db } = migrated();
    expect(db.prepare("SELECT id, role_id, woke_on, cost_usd, schedule_id, result_text FROM runs ORDER BY id").all()).toEqual([
      { id: "r-clock", role_id: null, woke_on: null, cost_usd: null, schedule_id: "SCH1", result_text: "done" },
      { id: "r-hand", role_id: null, woke_on: null, cost_usd: null, schedule_id: null, result_text: "done" },
    ]);
    expect(db.prepare("SELECT role_id, title, cron, next_run_at, last_run_id FROM schedules").get())
      .toEqual({ role_id: null, title: "Morning triage", cron: "0 9 * * 1-5", next_run_at: 500, last_run_id: "r-clock" });
    db.close();
  });

  it("takes the plan's defaults for a role row: $3 and 20 minutes a run, one run at a time, wakes on review", () => {
    const { db } = migrated();
    db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at)
      VALUES ('R1', 'sp1', 'Creator Manager', 'Keep the records.', '{}', 'claude', 1, 1)`).run();
    expect(db.prepare("SELECT run_cap_usd, run_cap_ms, max_concurrent, wake_on_review, permission_mode, skills_json, week_budget_usd, archived FROM team_roles").get())
      .toEqual({ run_cap_usd: 3, run_cap_ms: 1_200_000, max_concurrent: 1, wake_on_review: 1, permission_mode: "default", skills_json: "[]", week_budget_usd: null, archived: 0 });
    db.close();
  });

  it("a team's roles, reviews and activity go with its space, and only that space's", () => {
    const { db } = migrated();
    for (const sp of ["sp1", "sp2"]) {
      db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at) VALUES (?, ?, 'R', 'b', '{}', 'claude', 1, 1)`).run(`R-${sp}`, sp);
      db.prepare(`INSERT INTO team_reviews (id, space_id, kind, title, state, created_at, updated_at) VALUES (?, ?, 'slideshows', 't', 'waiting', 1, 1)`).run(`V-${sp}`, sp);
      db.prepare(`INSERT INTO team_review_items (id, review_id, ord, files_json, content_hash) VALUES (?, ?, 0, '[]', 'h')`).run(`I-${sp}`, `V-${sp}`);
      db.prepare(`INSERT INTO team_activity (id, space_id, ts, actor, verb) VALUES (?, ?, 1, 'user', 'approved')`).run(`A-${sp}`, sp);
    }
    db.prepare("DELETE FROM spaces WHERE id = 'sp1'").run();
    const ids = (t: string) => (db.prepare(`SELECT id FROM ${t} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    expect(ids("team_roles")).toEqual(["R-sp2"]);
    expect(ids("team_reviews")).toEqual(["V-sp2"]);
    expect(ids("team_review_items")).toEqual(["I-sp2"]);
    expect(ids("team_activity")).toEqual(["A-sp2"]);
    db.close();
  });

  it("lists a role's runs off an index, not a scan of every run", () => {
    const { db } = migrated();
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM runs WHERE role_id = ? ORDER BY created_at DESC").all("R1") as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("runs_role");
    db.close();
  });

  it("is idempotent: reopening twice more re-runs nothing and keeps a role written since", () => {
    const { p, db } = migrated();
    db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at) VALUES ('R1', 'sp1', 'Producer', 'b', '{}', 'claude', 1, 1)`).run();
    db.prepare("UPDATE runs SET role_id = 'R1', cost_usd = 0.84 WHERE id = 'r-hand'").run();
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT role_id, cost_usd FROM runs WHERE id = 'r-hand'").get()).toEqual({ role_id: "R1", cost_usd: 0.84 });
    expect(again.prepare("SELECT name FROM team_roles").all()).toEqual([{ name: "Producer" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    // The CREATEs say IF NOT EXISTS, so the reviews and activity statements are safe to replay as written.
    expect(() => again.exec(migrations[TEAM_ROLES_AT + 1]!)).not.toThrow();
    expect(() => again.exec(migrations[TEAM_ROLES_AT + 2]!)).not.toThrow();
    again.close();
  });
});

/**
 * The v45 shape of what v47 touches, hand-written: `team_roles` as v43 made it (with a role in it, as a
 * team made before handoffs would have), and `spaces`, `runs`, `schedules` as the stubs v47's table and
 * the team tables hang off. v46 is the vault's (a parallel branch): the second fixture stamps through
 * v46 with a vault-shaped table of its own and a grant in it, so v47 is proven to need nothing v46 made
 * and to leave what it did make alone.
 */
const V45_TEAM_ROLES_SCHEMA = `
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER, role_id TEXT, woke_on TEXT, cost_usd REAL);
CREATE TABLE schedules (id TEXT PRIMARY KEY, role_id TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE team_roles (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, brief TEXT NOT NULL, realmite_json TEXT NOT NULL, template TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  skills_json TEXT NOT NULL DEFAULT '[]',
  wake_on_review INTEGER NOT NULL DEFAULT 1,
  week_budget_usd REAL, run_cap_usd REAL NOT NULL DEFAULT 3, run_cap_ms INTEGER NOT NULL DEFAULT 1200000,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

/** A vault table as Phase 2's plan sketches it — what a v46 home could hold. Only its survival matters. */
const V46_VAULT_SCHEMA = `
CREATE TABLE vault_grants (
  secret_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (secret_id, role_id));
`;

/** Found by what it says, so the fixtures survive a renumbering at merge. */
const HANDOFFS_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_handoffs"));

function teamRolesFixture(path: string, through: number, extra = ""): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V45_TEAM_ROLES_SCHEMA + extra);
  for (let v = 1; v <= through; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1'), ('sp2')").run();
  db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, wake_on_review, week_budget_usd, created_at, updated_at)
    VALUES ('R1', 'sp1', 'Content Producer', 'Make slides.', '{"seed":"cp"}', 'claude', 0, 25, 10, 20)`).run();
  if (extra) db.prepare("INSERT INTO vault_grants (secret_id, space_id, role_id, created_at) VALUES ('S1', 'sp1', 'R1', 5)").run();
  stubActivitySources(db);
  db.close();
}

describe("migration v47 — team handoffs and mentions", () => {
  const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const fromV45 = () => { const p = join(tempDir("realm-db-"), "realm.db"); teamRolesFixture(p, HANDOFFS_AT - 1); return { p, db: openDatabase(p) }; };
  const fromV46 = () => { const p = join(tempDir("realm-db-"), "realm.db"); teamRolesFixture(p, HANDOFFS_AT, V46_VAULT_SCHEMA); return { p, db: openDatabase(p) }; };

  it("is appended after the vault's v46: a v45 home reaches the end of the chain and gains the table and both columns", () => {
    expect(HANDOFFS_AT).toBeGreaterThanOrEqual(46);
    const { db } = fromV45();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(cols(db, "team_roles")).toEqual(expect.arrayContaining(["handoffs_json", "wake_on_mention"]));
    expect(cols(db, "team_handoffs")).toEqual(expect.arrayContaining(["space_id", "kind", "from_role_id", "from_session_id", "to_role_id",
      "record_path", "note", "files_json", "run_id", "session_id", "outcome", "cost_usd", "created_at", "settled_at"]));
    db.close();
  });

  it("gives a role made before it no edges and leaves it answering mentions, and changes nothing else about it", () => {
    /* THE mutant: a backfill that wires every role to every other, or turns mentions off. */
    const { db } = fromV45();
    expect(db.prepare("SELECT handoffs_json, wake_on_mention, wake_on_review, week_budget_usd, name, brief FROM team_roles").get())
      .toEqual({ handoffs_json: "[]", wake_on_mention: 1, wake_on_review: 0, week_budget_usd: 25, name: "Content Producer", brief: "Make slides." });
    db.close();
  });

  it("needs nothing the vault's v46 made, and leaves its rows as they were", () => {
    const { db } = fromV46();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(cols(db, "team_handoffs")).toContain("to_role_id");
    expect(db.prepare("SELECT secret_id, space_id, role_id FROM vault_grants").all()).toEqual([{ secret_id: "S1", space_id: "sp1", role_id: "R1" }]);
    db.close();
  });

  it("a team's handoffs go with its space, and only that space's", () => {
    const { db } = fromV45();
    for (const sp of ["sp1", "sp2"]) {
      db.prepare("INSERT INTO team_handoffs (id, space_id, kind, to_role_id, note, created_at) VALUES (?, ?, 'handoff', 'R1', 'n', 1)").run(`H-${sp}`, sp);
    }
    db.prepare("DELETE FROM spaces WHERE id = 'sp1'").run();
    expect(db.prepare("SELECT id FROM team_handoffs").all()).toEqual([{ id: "H-sp2" }]);
    db.close();
  });

  it("lists a role's handoffs off an index, not a scan", () => {
    const { db } = fromV45();
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM team_handoffs WHERE to_role_id = ? ORDER BY created_at DESC").all("R1") as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("team_handoffs_to");
    db.close();
  });

  it("is idempotent: reopening twice more re-runs nothing and keeps an edge and a handoff written since", () => {
    const { p, db } = fromV45();
    db.prepare(`UPDATE team_roles SET handoffs_json = '["R2"]' WHERE id = 'R1'`).run();
    db.prepare("INSERT INTO team_handoffs (id, space_id, kind, to_role_id, note, created_at) VALUES ('H1', 'sp1', 'mention', 'R1', 'n', 1)").run();
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT handoffs_json FROM team_roles").get()).toEqual({ handoffs_json: '["R2"]' });
    expect(again.prepare("SELECT id, kind FROM team_handoffs").all()).toEqual([{ id: "H1", kind: "mention" }]);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    again.close();
  });
});

/**
 * `sessions` and `session_events` as they stand before the activity column, hand-written: every
 * column a session row has had since v38 (fast mode, the rewind cursors, dispatch origin, the read
 * mark), and the events table as it has been since v3. Three sessions — one that has talked, one that
 * was only made, and one whose log holds nothing but Realm's own lines.
 */
const V45_SESSIONS_SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_item_id TEXT, environment_id TEXT NOT NULL,
  seen_seq INTEGER NOT NULL DEFAULT 0, dispatched_by_kind TEXT, dispatched_by_session_id TEXT, fast_mode INTEGER NOT NULL DEFAULT 0,
  provider_cursor TEXT, rewind_fork_json TEXT, rewind_refusal TEXT);
CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
`;

/** Stamped up to the version BEFORE the activity column, found from the migration's own text so the
 *  fixture survives a renumbering at merge time. */
const ACTIVITY_AT = migrations.findIndex((m) => m.includes("ADD COLUMN activity_at"));

function v45Fixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V45_SESSIONS_SCHEMA);
  for (let v = 1; v <= ACTIVITY_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  const session = db.prepare(`INSERT INTO sessions (id, space_id, agent_kind, status, title, last_event_seq, created_at, updated_at, environment_id)
    VALUES (?, 'sp1', 'claude', 'idle', ?, 0, ?, ?, 'env1')`);
  // `updated_at` far past every event: the rows were written to after they last talked (a resume, a
  // status, a cursor), which is exactly the time the sidebar must stop ordering by.
  session.run("talked", "Talked", 100, 9_000);
  session.run("made", "Only made", 200, 9_000);
  session.run("quiet", "Realm's lines only", 300, 9_000);
  const ev = db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, '{}')");
  ev.run("talked", 1_000, "user_message");
  ev.run("talked", 1_500, "assistant_text");
  ev.run("talked", 2_000, "status");
  ev.run("talked", 2_500, "summary");
  ev.run("quiet", 4_000, "init");
  ev.run("quiet", 4_100, "status");
  db.close();
}

describe("migration — a session's activity", () => {
  const migrated = () => {
    const p = join(tempDir("realm-db-"), "realm.db");
    v45Fixture(p);
    return { p, db: openDatabase(p) };
  };
  const activity = (db: DatabaseSync) => db.prepare("SELECT id, activity_at FROM sessions ORDER BY id").all();

  it("is appended after the team tables: a home from before it reaches the end of the chain and gains the column", () => {
    expect(ACTIVITY_AT).toBeGreaterThanOrEqual(45);
    const { db } = migrated();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name)).toContain("activity_at");
    db.close();
  });

  it("dates each session by its newest prompt or reply, else its making — never by the last write to its row", () => {
    // THE mutants: a backfill from `updated_at` (every row would say 9000, and the order the user knew
    // would be shuffled by whatever last touched each row), and one that counts any event (`quiet`
    // would rise above `talked` on an init and a status).
    const { db } = migrated();
    expect(activity(db)).toEqual([
      { id: "made", activity_at: 200 },
      { id: "quiet", activity_at: 300 },
      { id: "talked", activity_at: 1_500 },
    ]);
    db.close();
  });

  it("leaves every other column of a session as it found it", () => {
    const { db } = migrated();
    expect(db.prepare("SELECT title, created_at, updated_at, last_event_seq FROM sessions WHERE id = 'talked'").get())
      .toEqual({ title: "Talked", created_at: 100, updated_at: 9_000, last_event_seq: 0 });
    db.close();
  });

  it("is idempotent: reopening re-runs nothing, and a replayed backfill never pulls back a time written since", () => {
    const { p, db } = migrated();
    db.prepare("UPDATE sessions SET activity_at = 7000 WHERE id = 'made'").run();
    db.close();
    expect(() => openDatabase(p).close()).not.toThrow();
    const again = openDatabase(p);
    expect(again.prepare("SELECT activity_at FROM sessions WHERE id = 'made'").get()).toEqual({ activity_at: 7000 });
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    const backfill = migrations[ACTIVITY_AT]!.slice(migrations[ACTIVITY_AT]!.indexOf("UPDATE sessions"));
    again.exec(backfill);
    again.exec(backfill);
    expect(activity(again)).toEqual([
      { id: "made", activity_at: 7000 },
      { id: "quiet", activity_at: 300 },
      { id: "talked", activity_at: 1_500 },
    ]);
    again.close();
  });
});

describe("migrations 46–50, as the five branches that held each other's slots merged", () => {
  it("hold no SELECT 1; placeholder, and run vault, handoffs, lab, sessions' activity, then act tickets", () => {
    expect(migrations.filter((m) => m.trim() === "SELECT 1;")).toEqual([]);
    // The dynamic-Teams migrations follow from v51.
    expect(migrations.length).toBeGreaterThanOrEqual(50);
    expect(migrations[45]).toContain("CREATE TABLE IF NOT EXISTS vault_grants");
    expect(migrations[46]).toContain("CREATE TABLE IF NOT EXISTS team_handoffs");
    expect(migrations[47]).toContain("CREATE TABLE IF NOT EXISTS lab_devices");
    expect(migrations[48]).toContain("ALTER TABLE sessions ADD COLUMN activity_at");
    expect(migrations[49]).toContain("CREATE TABLE IF NOT EXISTS team_act_tickets");
  });
});
