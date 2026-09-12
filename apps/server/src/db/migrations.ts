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
  // v21 — the Settings → Usage tab's one index. `session_events` is the biggest table Realm has (every
  // message, thought and tool round of every transcript), and the usage page's questions are all "the
  // `usage` rows in this time window" — a predicate the existing `(session_id, seq)` index cannot
  // serve at all, so each answer was a full scan of every transcript ever written.
  //
  // PARTIAL, on the `type` predicate: a session writes one `usage` row per turn against a `tool_call`
  // and a `tool_result` per tool and an `assistant_text` per message, so the index covers a small
  // fraction of the table and its write cost on the append path stays negligible. A plain `(type, ts)`
  // index would carry an entry for every tool result ever stored to earn the same lookups.
  //
  // `session_id` rides along as a second column so the per-session grouping the aggregator needs is
  // covered by the index rather than by a row fetch per event.
  //
  // Index-only, no schema change: nothing to backfill, nothing that can fail on an existing home, and
  // the migration is a no-op for correctness — every query it speeds up returns the same rows without it.
  `CREATE INDEX session_events_usage ON session_events(ts, session_id) WHERE type = 'usage';`,
  // v22 — the activity calendar's index, on exactly the v21 pattern and for the same reason. The
  // calendar asks one question ("the `user_message` rows in the last year, by local day") which the
  // `(session_id, seq)` index cannot serve, so without this it is a full scan of every transcript
  // ever written — the same scan v21 exists to have removed.
  //
  // PARTIAL again: a `user_message` row is written once per SEND, which is the rarest event type in
  // the table by a wide margin (a single turn writes dozens of tool and text rows against it), so
  // this index covers a smaller fraction of the table than v21's does and its cost on the append
  // path is smaller still. `session_id` rides along so the distinct-session count per day is
  // answered from the index rather than a row fetch per event.
  //
  // Index-only, no schema change: nothing to backfill, nothing that can fail on an existing home,
  // and every query it speeds up returns the same rows without it.
  `CREATE INDEX session_events_messages ON session_events(ts, session_id) WHERE type = 'user_message';`,
  // v23 — scheduled tasks. A schedule OWNS no execution: it creates runs, and `runs` already answers
  // every question about attempts, restarts and the human gate. So this table holds only the WHEN,
  // plus the log of what the last firing did.
  //
  // `next_run_at` is stored rather than derived at read time, and that is the concurrency design: the
  // runner claims a schedule by writing the next occurrence into this column in the same statement
  // that reads it as due, so two ticks landing together cannot both fire it. Deriving it from the
  // expression on every read would make the claim impossible to express as one write.
  //
  // ON DELETE CASCADE from spaces, like every other space-scoped table: deleting a space must not
  // leave a timer pointing into it. `last_run_id` deliberately has NO foreign key — "this schedule
  // produced run X" stays a true and useful statement after X is deleted, the same log posture
  // `sessions.dispatched_by_session_id` and the notifications feed already take.
  `
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
  -- The runner's ONE query, across every space: the due ones. Partial on the enabled flag so a home
  -- full of paused schedules costs the tick nothing.
  CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled = 1;
  `,
  // v24 — fast mode, per session. A plain nullable column with a 0 default, so every existing
  // session comes back with it off, which is what a session that never asked for it means.
  //
  // A REQUEST is what is stored, deliberately: whether the harness served it is a fact about a turn,
  // not about the session, and it rides the `usage` event instead. Storing the outcome here would
  // give the switch two sources of truth that disagree the moment a rate limit lands.
  `ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;`,
  // v25 — the Library's file index: one row per file a session wrote or was given.
  //
  // A derived table, not a source of truth. Every row in it can be rebuilt from `session_events` by
  // `artifactsFromEvent`, and it exists only because the question the Library asks — "every file
  // across every session, newest first" — is one `session_events` cannot answer without reading and
  // JSON-parsing every tool call ever made. The per-session summary does exactly that fold in the
  // renderer, which is affordable for one transcript and is not for two hundred.
  //
  // Why not a partial index on `session_events` instead, the v21/v22 trick? Because the predicate is
  // not on a column: "a tool_call whose payload names a Write" lives inside `payload_json`, and an
  // index on `type = 'tool_call'` alone would cover the single most common row in the table to
  // filter almost all of it back out in JS. Materialising is what makes the read a range scan.
  //
  // `id` is `<session>:<seq>:<path>`, deterministic, so re-indexing an event is an upsert rather
  // than a duplicate — which is what lets the append-time writer and the backfill overlap safely on
  // the events either side of the cursor without either knowing about the other.
  //
  // No `space_id`, deliberately. It is one join away through `sessions`, and a copy here would be a
  // second fact to keep in step for the sake of a column that never changes the answer.
  //
  // The cursor row mirrors v15's `search.backfill` exactly, `target` frozen at migration time:
  // events past it are indexed at write time, so the two writers cannot double-count and the
  // backfill can stop and resume across boots.
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    ts INTEGER NOT NULL);
  -- The browser's ONE query: newest first, keyset-paged. The id rides along as the tiebreaker so two
  -- files written in the same millisecond cannot make a page repeat or skip a row.
  -- (No backticks in here: this block is a JS template literal, and one would end it early.)
  CREATE INDEX artifacts_recent ON artifacts(ts DESC, id DESC);
  CREATE INDEX artifacts_session ON artifacts(session_id);
  INSERT OR IGNORE INTO settings (key, value_json)
    VALUES ('artifacts.backfill', json_object('done', 0, 'target', COALESCE((SELECT MAX(seq) FROM session_events), 0)));
  `,
  // v26 — machines (Plan 25 W3): a screen somewhere else, shown and driven in a pane.
  //
  // Modelled on `browsers` down to the index, because it is that table's sibling: a live surface with
  // a durable row, one per space, whose id is an item's `ref_id`.
  //
  // NO STATUS COLUMN, and that is a decision rather than an omission. Status is a fact about a
  // process or a socket, and neither survives a restart — a column would have to be rewritten to
  // 'off' at every boot, and would be a lie for the entire window in which a machine was killed
  // while the server was down. `terminals` has none for the same reason.
  //
  // `ws_port` is PER-RUN, cleared on stop and by `restoreAll`, under a UNIQUE index that SQLite's
  // treatment of NULLs makes partial for free (distinct NULLs do not collide). So any number of
  // stopped machines coexist, and the no-overlap invariant lives in the schema rather than in the
  // allocator's care. Deliberately the opposite of `environments.port_block_start`, which is
  // permanent because a dev server left running should keep the port it was reached at.
  //
  // `endpoint_json` rather than host/port columns: `qemu` and `mac` have no address at all, and two
  // columns that are NULL for half the sources are two columns that mean nothing on half the rows.
  //
  // `password_sealed` holds the sealed box, never a plaintext, and `machineSecretBox` is what opens
  // it. A row whose key is gone is a row whose machine needs the password typed again — which is
  // recoverable, and is why this is a column rather than a reason to refuse to store the row.
  `
  CREATE TABLE machines (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, source TEXT NOT NULL, endpoint_json TEXT,
    password_sealed TEXT, ws_port INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX machines_space ON machines(space_id);
  CREATE UNIQUE INDEX machines_ws_port ON machines(ws_port) WHERE ws_port IS NOT NULL;
  `,
  // v27 — headers for the outbound upgrade request (Plan 25 W3, cloud sandboxes).
  //
  // A separate column from `password_sealed` and not a field inside `endpoint_json`, for two
  // different reasons. It is a SECRET — Namespace's `x-nsc-ingress-auth` is a bearer token — so it
  // cannot sit in the plaintext endpoint blob beside the host. And it is not the RFB password:
  // one authenticates to the PROXY in front of the machine and the other to the machine itself, and
  // a sandbox behind an authenticating ingress needs both at once.
  //
  // Nullable with no default and no backfill: every existing row has no headers, which is what
  // NULL means here and is also true.
  `ALTER TABLE machines ADD COLUMN headers_sealed TEXT;`,
  // v28 — simulators: an Apple Simulator, shown and driven in a pane.
  //
  // `machines`' small sibling, and small for a reason that is about the thing rather than about
  // effort. A machine can be anywhere, so its row carries an address, a transport and two sealed
  // secrets; a simulator is always on this Mac, always reached over loopback, and the only durable
  // fact about one is WHICH device the pane is pointed at.
  //
  // No status column, for `machines`' reason: a status is a fact about a process, and the streaming
  // daemon does not survive a restart. No port column either — serve-sim picks its own and publishes
  // it, so a number stored here would be a guess about somebody else's allocator.
  //
  // `udid` is nullable because the pane exists before the device is chosen: the session bar's button
  // makes a row with no device, and the picker inside the pane is what fills it in. That is the same
  // shape as a `machines` row with no endpoint yet.
  `
  CREATE TABLE simulators (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, udid TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX simulators_space ON simulators(space_id);
  `,
  // v29 — goal mode: an objective a session keeps working on across turns.
  //
  // One goal per session, which is why `session_id` IS the primary key rather than a column beside
  // one. A second objective on the same thread would be two agents with one transcript, and the
  // thing that makes goal mode safe — a single ceiling and a single "are we there yet" — has nothing
  // to be about once there are two of them. Replacing a goal is an UPSERT here, deliberately: the
  // old objective is finished with, and a history of abandoned objectives is a thing nobody asked
  // for.
  //
  // `status` IS a column, which is the opposite of the call `machines` and `simulators` make one
  // migration up. Their status is a fact about a process and no process survives a restart; this one
  // is a fact about what the USER asked for, and forgetting it on relaunch would silently drop work
  // somebody is waiting on. What Realm does NOT do is resume it by itself at boot — see the
  // service's `parkOnBoot`, which turns an active goal into a paused one, because starting turns at
  // launch is a surprise nobody consented to.
  //
  // `tokens_used` and `turns` are counters rather than a join over the event log. The log is where
  // the truth about a turn lives, but a budget has to be checked on every settle and a scan of a
  // session's events on each one is a cost that grows with the transcript.
  `
  CREATE TABLE session_goals (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    objective TEXT NOT NULL, status TEXT NOT NULL,
    token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
    note TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX session_goals_status ON session_goals(status);
  `,
  // v30 — terminal scrollback: what a shell printed, kept across a restart.
  //
  // A separate table and not a column on `terminals`, for two reasons that are both about the hot
  // path. `TerminalsStore` reads `SELECT *`, and `restoreAll` reads EVERY row at boot — putting a
  // 128KB blob on that row would make every one of those reads carry the scrollback of every
  // terminal, to answer questions that never mention it.
  //
  // The cascade is the whole cleanup story, and it has one consequence worth writing down rather
  // than discovering: `onExit` deletes the terminals row, so a shell that exited BEFORE the restart
  // takes its scrollback with it and restores exactly as it does today — as a pane that is not
  // running. Only a terminal that was still alive when Realm went away has anything to replay.
  //
  // `cols` and `rows` are the size the output was PRINTED at, not the size to restore to. A replayed
  // 120-column screen above a freshly spawned 80-column shell is a ragged seam nobody would attribute
  // to the pty's default, so `restoreAll` spawns at these instead of the hardcoded 80×24 it used.
  `
  CREATE TABLE terminal_history (
    terminal_id TEXT PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
    data TEXT NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
    captured_at INTEGER NOT NULL);
  `,
  // v31 — `sessions.seen_seq`: how far this user has actually READ a session's transcript.
  //
  // Distinct from `last_event_seq`, which is how far the session has been WRITTEN. The gap between
  // the two is the only thing that can answer "what is new since I was last here", and with a daemon
  // that runs while the app is closed that gap is no longer a rare few seconds — it is days.
  //
  // A column on `sessions` and not a table, unlike `terminal_history` one migration up, because the
  // shapes are opposite: this is one small integer read on every listing, and that blob was 128KB
  // read by nothing that asked for it.
  //
  // Defaulted to 0 rather than backfilled to `last_event_seq`. 0 means "never opened", which for an
  // existing session is a claim about the future and not about the past: the first open stamps it,
  // and until then the rules that read it (the sidebar dot, the "new since you were here" line)
  // simply have nothing to draw. Backfilling would assert that every session in the database has
  // been read to the end, which is the one thing nobody can know.
  `ALTER TABLE sessions ADD COLUMN seen_seq INTEGER NOT NULL DEFAULT 0;`,
  // v32 — `simulators.platform`: which toolchain reaches this device, `ios` or `android`.
  //
  // Defaulted to `ios` rather than backfilled, and the default is the whole point: every row written
  // before Android existed IS an iOS row, so the default is a statement of fact about the past
  // rather than a guess about it. Nothing has to be rewritten and nothing can be got wrong.
  //
  // A column and not a lookup off `udid`'s shape. An Apple UDID and an AVD name are distinguishable
  // today — one is a formatted GUID — and that is exactly the kind of inference that breaks silently
  // the first time a vendor changes a format, on rows nobody is looking at.
  `ALTER TABLE simulators ADD COLUMN platform TEXT NOT NULL DEFAULT 'ios';`,
  // v33 — conversation rewind: where BOTH transcripts stood when a checkpoint was taken, and the fork
  // a restore leaves armed for the session's next start.
  //
  // Five nullable columns, no defaults and no backfill, and the absence of a backfill is the whole
  // point rather than laziness. A cursor invented for a row written before these columns existed would
  // be a fabricated claim about where a provider conversation stood — precisely the claim this feature
  // exists not to make. NULL reads as "not known", every read path treats it as "restore the files
  // only", and `CheckpointSchema`'s matching `.default(null)` means a row written by the older build
  // parses rather than failing on the first read after an upgrade.
  //
  // On `checkpoints`:
  //  - `session_seq`     — Realm's own transcript position at capture: the newest stored event's seq.
  //  - `provider_cursor` — opaque, adapter-defined, and written at the END of the turn this checkpoint
  //                        fronted rather than at capture. It needs two uuids that are known at two
  //                        different moments (the kept turn's last chain entry, and the discarded
  //                        turn's prompt), so a row carries the complete pair or it carries nothing.
  //                        Nulled again if the provider ever refuses that exact fork.
  //
  // On `sessions`:
  //  - `provider_cursor`   — where the provider's chain stood after the last settled turn. This is the
  //                          value the NEXT turn's checkpoint copies as its fork point.
  //  - `rewind_fork_json`  — a restore's armed fork target, read by the next `ensureLive`. A column and
  //                          not memory: a restore is refused while any handle in the checkout is live,
  //                          so the arm is by construction consumed by a LATER process, and an in-memory
  //                          one would be silently dropped by the first restart between the two.
  //  - `rewind_refusal`    — the provider's refusal, kept verbatim. Evidence, not control flow: the
  //                          fork column is cleared on a refusal and the checkpoint's cursor with it, so
  //                          nothing can re-send a request the CLI has already answered deterministically.
  //
  // `ALTER TABLE ... ADD COLUMN` and not a table rebuild: these are five nullable columns on two tables
  // with live foreign keys pointing at them, and a rebuild needs `foreign_keys` OFF, which is a no-op
  // inside this migration's transaction (the same trap v5 documents).
  `
  ALTER TABLE checkpoints ADD COLUMN session_seq INTEGER;
  ALTER TABLE checkpoints ADD COLUMN provider_cursor TEXT;
  ALTER TABLE sessions ADD COLUMN provider_cursor TEXT;
  ALTER TABLE sessions ADD COLUMN rewind_fork_json TEXT;
  ALTER TABLE sessions ADD COLUMN rewind_refusal TEXT;
  `,
];
