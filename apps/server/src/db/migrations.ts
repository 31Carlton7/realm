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
  // v9 — MCP gateway (Plan 9). oauth_json holds the whole OAuth state for a remote server (client
  // registration, tokens, expiry) — plaintext, same posture and same honesty note as secrets_json.
  // tools_json caches the last successful tools/list so settings can render a server's tools without a
  // live connection. mcp_call_log is Realm's view of proxied calls (Activity); the transcript keeps the
  // agent's own view, so nothing here mirrors into session_events. server_id survives as NULL after a
  // server row is deleted — the log outlives the config that produced it, which is the point of a log.
  `
  ALTER TABLE mcp_servers ADD COLUMN oauth_json TEXT NOT NULL DEFAULT '';
  ALTER TABLE mcp_servers ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE mcp_call_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES mcp_servers(id) ON DELETE SET NULL,
    server_name TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    ok INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ts INTEGER NOT NULL);
  CREATE INDEX mcp_call_log_session ON mcp_call_log(session_id, ts DESC);
  CREATE INDEX mcp_call_log_ts ON mcp_call_log(ts DESC);
  `,
  // v10 — browser panes (Plan 11 W1). The persisted half of a browser item: last committed url + page
  // title, so the pane survives a restart pointing where it pointed. The live WebContentsView belongs
  // to Electron main and has no row here. `url = ''` means never navigated.
  `
  CREATE TABLE browsers (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    url TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX browsers_space ON browsers(space_id);
  `,
  // v11 — defining scope for MCP servers (Plan 12 W2). Every row is defined at 'space' or 'profile'
  // level. Existing rows all become scope 'space' with scope_space_id NULL — the "pre-scoping row"
  // (`LEGACY_SPACE_SCOPE`): listed in every space, governed by the per-space enabled-set in `settings`
  // exactly as before, so NO space's effective set moves on upgrade. No backfill guesses a row into a
  // space: a row enabled in two spaces has no single defining space, and inventing one would change
  // somebody's set. Profile-scoped rows are inherited (default ON) by every space of scope_profile_id,
  // minus per-space disable overrides (`mcp.profileDisabled:<spaceId>` in settings).
  //
  // Plain TEXT, no foreign keys — the same posture as every per-space settings key (`mcp.enabled:` et
  // al. reference space ids with nothing enforcing them): scope liveness is the SERVICE's question, and
  // `McpService.appliesTo` answers it in the one place the effective set is computed. A defining space
  // that no longer exists degrades the row to a pre-scoping one (visible everywhere, opt-in per space —
  // safe under MCP's default-off polarity, and the row stays reachable in panels instead of being
  // orphaned); a defining profile that no longer exists parks the row (applies nowhere) — profile
  // deletion cascades the profile's spaces away, so there is nowhere it could honestly apply, and W4's
  // cross-scope Connections page is the recovery surface.
  `
  ALTER TABLE mcp_servers ADD COLUMN scope TEXT NOT NULL DEFAULT 'space';
  ALTER TABLE mcp_servers ADD COLUMN scope_space_id TEXT;
  ALTER TABLE mcp_servers ADD COLUMN scope_profile_id TEXT;
  `,
  // v12 — the notifications feed (Plan 12 W5): a durable row per thing that waited on the user, so the
  // feed survives restart. `read_at` is about the USER (they saw the row); `acted_at` is about the
  // WORLD (the underlying condition resolved — permission answered, MCP server recovered). The two are
  // independent on purpose: a permission can be answered before anyone reads the row, and read before
  // anyone answers.
  //
  // Plain TEXT references, no foreign keys — deliberately. A notification is a LOG: "session X asked
  // for permission" stays true (and stays worth showing) after session X is deleted, exactly the
  // posture mcp_call_log takes with its ON DELETE SET NULL. `ref_id` is the category's own reference
  // (a permission requestId — possibly a broker's `bperm_…`, so not necessarily a ULID — an MCP server
  // id, an agent kind, an environment id) and, with `category`, the service's dedup key.
  `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    space_id TEXT,
    session_id TEXT,
    ref_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    acted_at INTEGER);
  CREATE INDEX notifications_feed ON notifications(created_at DESC, id DESC);
  CREATE INDEX notifications_unread ON notifications(read_at) WHERE read_at IS NULL;
  CREATE INDEX notifications_dedup ON notifications(category, ref_id);
  `,
  // v13 — the durable ship log (Plan 14 W1). One row per `workspace.ship` that changed something
  // durable (a commit was made, or a push reached the remote), written by GitWriteService.ship at the
  // moment the legs settle. `push_state` records the push leg's ACTUAL outcome — a commit whose push
  // was rejected logs `rejected`; a commit-only ship logs `skipped`.
  //
  // Plain TEXT references, no foreign keys — the notifications posture: a ship row is a LOG, and
  // "branch X was shipped from worktree Y" stays true (and stays worth showing on the History tab)
  // after that worktree is removed or its space deleted.
  //
  // NOTE (merge coordination): Plan 13 W1 also appends a v13 migration in its own worktree. Whichever
  // branch merges second renumbers by moving this block after the other's — the SQL is self-contained,
  // so the fix is a one-line reordering of this array.
  `
  CREATE TABLE ships (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    branch TEXT,
    sha TEXT NOT NULL,
    subject TEXT NOT NULL,
    pr_url TEXT,
    push_state TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  -- Every listing is "this space, newest first"; id DESC is the same-millisecond tiebreak the
  -- notifications feed uses, so keyset pagination can never skip or repeat a row.
  CREATE INDEX ships_space ON ships(space_id, created_at DESC, id DESC);
  `,
  // v14 — dispatch origin (Plan 13 W1; renumbered past Plan 14's v13 ships table at merge): who caused a session to exist, when something other than the
  // user's own click created it. `dispatched_by_kind` is a DispatchKindSchema value ('agent_run' /
  // 'browser_agent_run' / 'user-dispatch', the last reserved for W2's composer gesture);
  // `dispatched_by_session_id` is the delegating session, plain TEXT with no foreign key on purpose —
  // the same log posture notifications takes: "session X dispatched this" stays true (and stays worth
  // showing in W2's Tasks lens) after session X is deleted. Both NULL for every existing row and for
  // every session the user creates directly; nothing is backfilled, because absence IS the fact.
  `
  ALTER TABLE sessions ADD COLUMN dispatched_by_kind TEXT;
  ALTER TABLE sessions ADD COLUMN dispatched_by_session_id TEXT;
  `,
  // v15 — the global search index (Plan 16 W1). FTS5, verified compiled into node:sqlite (unicode61
  // and trigram tokenizers both present; this uses unicode61 with full diacritic folding). A plain
  // contentful FTS5 table rather than external-content or contentless: the sources are heterogeneous
  // (events keyed by integer seq, items by ULID), contentless tables cannot honestly DELETE without
  // SQLite ≥3.43's contentless_delete, and the duplicated text is transcript-sized — cheap next to
  // the payload_json that already stores it. `kind`/`ref`/`seq` are UNINDEXED metadata: kind is
  // 'session' (ref = session id, seq = the event) or 'item' (ref = item id).
  //
  // What is NOT here, deliberately: no space_id and no profile_id. Scoping is a QUERY-TIME join
  // through the live sessions/items→spaces tables (SearchService), because a space can be moved to
  // another profile (spaces.update) and a profile id baked into the index would keep answering for
  // the profile it used to be in. Skills and memory docs are not indexed at all — they are
  // user-editable files (the library folder, `~/Realm/memory/*.md` whose paths the UI shows), so
  // they are read live at query time; an index over files Realm does not own every write to would
  // go stale the first time the user edits one in a text editor.
  //
  // Backfill: item titles inline (one small scan). Session events are backfilled CHUNKED ON BOOT
  // (SearchService.runBackfill), resumable across restarts — a large history must not hold the
  // migration transaction open for its whole scan. The settings row written here is the cursor:
  // `target` is MAX(seq) at migration time, frozen so the boot-time backfill and write-time indexing
  // (which starts with this same release, in SessionEventsStore.append) can never double-index a row.
  `
  CREATE VIRTUAL TABLE search_index USING fts5(
    text, kind UNINDEXED, ref UNINDEXED, seq UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO search_index (text, kind, ref, seq) SELECT title, 'item', id, NULL FROM items;
  INSERT INTO settings (key, value_json)
    VALUES ('search.backfill', json_object('done', 0, 'target', COALESCE((SELECT MAX(seq) FROM session_events), 0)));
  `,
  // v16 — the icon asset library behind the space icon picker's "Generated"/"Uploaded" sections: one
  // row per AI-generated or uploaded icon, saved per PROFILE (never per-space) so the same generation
  // or upload is reusable by every space under it — the same posture the default icon list already
  // has (one shared set, not copied per space). `Space.icon` keeps its existing `z.string()` shape;
  // a row here is addressed as `"asset:" + id` (`parseSpaceIcon`, packages/contracts/src/presets.ts).
  //
  // `data_text` is a base64 data URL for an uploaded raster image, or raw SVG markup for a generated
  // icon (`mime` disambiguates) — plain TEXT alongside the row, the same posture `layout_json` /
  // `tools_json` / `oauth_json` already take for small JSON/text blobs, so no file-serving IPC or
  // on-disk asset directory is needed: the RPC layer returns the data inline.
  `
  CREATE TABLE icon_assets (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, mime TEXT NOT NULL, data_text TEXT NOT NULL, prompt TEXT,
    created_at INTEGER NOT NULL);
  CREATE INDEX icon_assets_profile ON icon_assets(profile_id, created_at DESC);
  `,
  // v17 — pane groups: a space holds several named split arrangements instead of exactly one, with one
  // of them active (packages/contracts/src/groups.ts).
  //
  // No backfill, deliberately. `groups_json` stays NULL for every existing space and the read path
  // (SpacesStore.toSpace) derives a single "Main" group from the `layout_json` that is already there —
  // so a space nobody has touched since upgrading keeps its exact arrangement, and the first write of a
  // group set is what populates the column. A SQL backfill would have had to mint ULIDs and re-encode
  // every layout blob to gain nothing the read path does not already do.
  //
  // `layout_json` is NOT dropped and does not become dead: it keeps holding the ACTIVE group's layout
  // (setGroups writes both), which is what lets `spaces.setLayout` stay a working layout-only write and
  // what an older build would still find if this database were opened by one.
  `ALTER TABLE spaces ADD COLUMN groups_json TEXT;`,
  // v18 — archiving: a sidebar row can be put away without being deleted. The exact shape `pinned`
  // already has (INTEGER NOT NULL DEFAULT 0 on `items`), for the exact opposite gesture, so the flag
  // rides the one query every listing already goes through (`ItemsStore.list`).
  //
  // No backfill and no index. DEFAULT 0 means every existing row is live, which is the only honest
  // reading of a database written before archiving existed; and the filter is always paired with the
  // `space_id` predicate `items_space` already covers, over a per-space row count in the dozens.
  `ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
  // v19 — document workspaces (Plan 17 W1): the persisted half of a `documents` pane, which is its
  // TAB STRIP and nothing else. Document content is not here and never will be — documents are plain
  // files in the checkout, which is the decision that lets an agent edit them with its ordinary
  // Write/Edit tools and lets git, the diff pane and checkpoints see the changes for free.
  //
  // `environment_id` (not space_id alone) is what the pane is rooted at, following `diff`'s precedent:
  // a document workspace is a view of a CHECKOUT, so sessions sharing an environment share documents.
  // ON DELETE CASCADE from environments matters — removing a worktree must not leave a workspace row
  // pointing at a directory that no longer exists.
  //
  // `open_paths_json` is a JSON array of paths RELATIVE to the environment root; `active_path` is one
  // of them or NULL. Relative because a worktree that moves keeps its tabs, and because a relative
  // path is the only shape the RPC layer can range-check for containment.
  `
  CREATE TABLE document_workspaces (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    open_paths_json TEXT NOT NULL DEFAULT '[]', active_path TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX document_workspaces_env ON document_workspaces(environment_id);
  `,
  // v20 — durable runs: a goal that owns a session across attempts and survives restarts
  // (packages/contracts/src/runs.ts). The supervisor `DelegationEngine` deliberately is not — its
  // registry is in memory because a blocked MCP tool call cannot outlive the process. A run has
  // nobody blocked on it, so it is a row.
  //
  // `session_id` carries NO foreign key, on purpose: the same log posture v14's
  // `dispatched_by_session_id` and the notifications feed already take — "run X produced session Y"
  // stays a true and useful statement after Y is deleted, and an ON DELETE SET NULL here would erase
  // the one pointer from a finished run to the transcript that IS its work.
  //
  // `environment_id` DOES carry one (no ON DELETE clause, i.e. RESTRICT): an environment is a
  // directory on disk, and a run still pointing at one is a reason not to silently drop the row.
  //
  // `runs_dedupe` is the load-bearing line. Scoped to the three LIVE states (RUN_LIVE_STATES —
  // runs.test.ts pins that the two lists agree), so a trigger that fires every fifteen minutes can
  // call `runs.create` naively: at most one live run exists per key, enforced by the database rather
  // than by whoever writes next (v5's `environments_one_primary` posture). Terminal runs fall out of
  // the index, which is what lets tomorrow's run of the same recurring thing exist at all.
  //
  // No `lease_until` column, deliberately. A lease earns its keep with a second writer or a wedged
  // service loop; realm-server is one process, so at boot EVERY `running` row is by definition
  // unsupervised and `RunService.recoverOnBoot` reconciles it against the session's real status.
  // Migrations are append-only: a lease is one ALTER away the day a second writer exists.
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL, goal TEXT NOT NULL, agent_kind TEXT NOT NULL,
    environment_id TEXT REFERENCES environments(id),
    constraints_json TEXT, dedupe_key TEXT,
    state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
    session_id TEXT, deadline_at INTEGER, result_text TEXT, error TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL);
  -- Every listing is "this space, newest first"; id DESC is the same-millisecond tiebreak the
  -- notifications and ships feeds use, so keyset pagination can never skip or repeat a row.
  CREATE INDEX runs_space ON runs(space_id, created_at DESC, id DESC);
  -- At most one LIVE run per key per space. See the comment above — this is the whole point.
  CREATE UNIQUE INDEX runs_dedupe ON runs(space_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running', 'blocked');
  -- Boot recovery's one scan, and the only query that reads across spaces.
  CREATE INDEX runs_live ON runs(state) WHERE state IN ('queued', 'running', 'blocked');

  CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    n INTEGER NOT NULL, session_id TEXT, outcome TEXT NOT NULL, detail TEXT,
    started_at INTEGER NOT NULL, settled_at INTEGER);
  CREATE UNIQUE INDEX run_attempts_run_n ON run_attempts(run_id, n);
  `,
];
