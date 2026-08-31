export const migrations: string[] = [
  // v1
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
    sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL, icon TEXT NOT NULL, sort_order INTEGER NOT NULL, folder_path TEXT NOT NULL,
    layout_json TEXT, active_item_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX spaces_profile ON spaces(profile_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, root_path TEXT NOT NULL, default_branch TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX projects_space ON projects(space_id);
  CREATE TABLE items (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    ref_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX items_space ON items(space_id);
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    cwd TEXT NOT NULL, shell TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `,
  // v2
  `ALTER TABLE spaces ADD COLUMN color TEXT NOT NULL DEFAULT '#7c6cff';`,
  // v3
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, project_id TEXT,
    agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', cwd TEXT NOT NULL,
    status TEXT NOT NULL, provider_session_id TEXT, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX sessions_space ON sessions(space_id);
  CREATE TABLE session_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE INDEX session_events_session ON session_events(session_id, seq);
  `,
  // v4 — a session owns an optional terminal (W4). The column points at the terminal's *item*, which is
  // what the sidebar filters on (items.ts) and what the client never sees. ON DELETE SET NULL so closing
  // the terminal (which deletes its item) clears the pointer without a second write; NULL for every
  // existing session, so nobody gains a pty by migrating.
  `ALTER TABLE sessions ADD COLUMN terminal_item_id TEXT REFERENCES items(id) ON DELETE SET NULL;`,
  // v5 — Environment as a first-class record (Plan 7 W1). A session no longer stores where it runs;
  // it points at an environment, and `cwd` is read back off that row. Several sessions may share one.
  //
  // `hex(randomblob(13))` is 26 uppercase hex chars, which is a strict subset of Crockford base32 (no
  // I/L/O/U appear in 0-9A-F), so backfilled ids satisfy IdSchema without a ULID generator in SQL.
  // Nothing orders environments by id — `created_at` carries the time.
  //
  // The backfill must be invisible: every space gets a primary environment at its own folder, every
  // *other* cwd a session was already running in (a project root) gets a `checkout` environment, and
  // each session adopts the one matching the cwd it had. `checkout` exists so W2's worktree removal can
  // never reach a directory Realm did not create.
  `
  CREATE TABLE environments (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL, branch TEXT, kind TEXT NOT NULL, port_block_start INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  -- One environment per checkout per space: two sessions that shared a cwd cannot end up on two rows.
  CREATE UNIQUE INDEX environments_space_path ON environments(space_id, path);
  -- At most one primary per space, enforced by the database rather than by whoever writes next.
  CREATE UNIQUE INDEX environments_one_primary ON environments(space_id) WHERE kind = 'primary';
  ALTER TABLE sessions ADD COLUMN environment_id TEXT REFERENCES environments(id);

  INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at)
    SELECT hex(randomblob(13)), s.id, s.folder_path, NULL, 'primary', NULL, s.created_at, s.updated_at FROM spaces s;
  INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at)
    SELECT hex(randomblob(13)), d.space_id, d.cwd, NULL, 'checkout', NULL, d.created_at, d.created_at
      FROM (SELECT space_id, cwd, MIN(created_at) AS created_at FROM sessions GROUP BY space_id, cwd) d
      WHERE NOT EXISTS (SELECT 1 FROM environments e WHERE e.space_id = d.space_id AND e.path = d.cwd);
  UPDATE sessions SET environment_id =
    (SELECT e.id FROM environments e WHERE e.space_id = sessions.space_id AND e.path = sessions.cwd);

  ALTER TABLE sessions DROP COLUMN cwd;

  -- environment_id cannot be declared NOT NULL after the fact without rebuilding the table, and a
  -- rebuild needs foreign_keys OFF, which is a no-op inside the migration's transaction. Triggers get
  -- the same guarantee: a session with no environment has no cwd, and must not be writable.
  CREATE TRIGGER sessions_environment_required_insert BEFORE INSERT ON sessions
    WHEN NEW.environment_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'sessions.environment_id is required'); END;
  CREATE TRIGGER sessions_environment_required_update BEFORE UPDATE OF environment_id ON sessions
    WHEN NEW.environment_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'sessions.environment_id is required'); END;
  `,
  // v6 — port blocks (Plan 7 W2). Two environments handed the same base port would mean two agents
  // racing for the same `pnpm dev`, which is the exact problem the block exists to solve, so the
  // invariant lives in the schema rather than in the allocator's care: a second environment claiming
  // a taken start fails its UPDATE instead of duplicating it.
  //
  // The WHERE clause only keeps the index off the rows that have no block — which is most of them,
  // since "no block yet" is the normal state until something spawns. It is NOT what permits several
  // blockless rows: SQLite treats NULLs as distinct in any unique index, partial or not.
  `CREATE UNIQUE INDEX environments_port_block ON environments(port_block_start) WHERE port_block_start IS NOT NULL;`,
  // v7 — checkpoints (Plan 7 W4). The row is an INDEX over a git ref; the ref is what keeps the objects
  // alive. Neither is authoritative alone, so the two are always written and deleted together.
  //
  // `ON DELETE CASCADE` on environment_id and `ON DELETE SET NULL` on session_id encode the difference
  // between them: a checkpoint belongs to a checkout, and merely mentions the session whose turn made
  // it. Deleting a session must not throw away the ability to undo what it did; deleting the
  // environment must, because there is no longer a working tree to restore into. The rows going is not
  // enough on its own — `CheckpointService.forgetEnvironment` deletes the refs first, or the objects
  // stay pinned in the repository forever with nothing pointing at them.
  //
  // The trees are stored because restore needs them and re-deriving them from the commit is one more
  // git call on a destructive path. `worktree_tree` is the commit's own tree; `index_tree` is its
  // second parent's, which is the only reason that parent exists.
  `
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
  -- Every listing and every retention sweep is "this environment, newest first".
  CREATE INDEX checkpoints_environment ON checkpoints(environment_id, created_at DESC);
  CREATE INDEX checkpoints_session ON checkpoints(session_id, created_at DESC);
  `,
  // v8 — MCP server definitions (Plan 8 W2). Global rows; which spaces use them is per-space state in
  // `settings` (`mcp.enabled:<spaceId>`), the same split W1 used for skills.
  //
  // `name` is UNIQUE because it is the key every agent addresses the server by — a record key for
  // Claude, a `[mcp_servers.NAME]` table for Codex, a `name` field for ACP. Two rows sharing a name
  // would be one server on the wire, with whichever Realm serialized last silently winning.
  //
  // `secrets_json` is named for exactly what it is: the stdio `env` map or the http/sse header map,
  // **in plain text**. Realm has no secret store, and this column is the whole of the honesty about
  // that — see MCP_SECRET_STORAGE_NOTE, which every surface that takes a key must show. It is one
  // column rather than two because a server has one kind or the other, never both.
  `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT '',
    args_json TEXT NOT NULL DEFAULT '[]',
    url TEXT NOT NULL DEFAULT '',
    secrets_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `,
];
