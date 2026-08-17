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
];
