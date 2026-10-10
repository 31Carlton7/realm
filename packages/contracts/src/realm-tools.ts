import { BROWSER_READ_ONLY_TOOLS } from "./browser-agent";

/**
 * Realm's own gateway tools that change nothing, by the name the gateway lists them under
 * (`<provider>__<tool>`) — ONE list, read by both engines' gates. The gateway marks each of these
 * `annotations.readOnlyHint: true`, which is what Codex reads to skip its own approval; the Claude
 * adapter pre-allows the same names through `allowedTools`. So the two engines agree on which of
 * Realm's tools ask first.
 *
 * Each one is here because its handler only reads:
 *   - the `realm-browser` five — see `BROWSER_READ_ONLY_TOOLS`, including why `browser_credentials`
 *     (names and origins, no field for a password) is safe;
 *   - `workspace_state`, `sessions_list`, `session_read`, `space_list` — what is in this space and
 *     profile and what its sessions said, as the sidebar already shows it;
 *   - `settings_get` — the five settings an agent may change (theme and the like), none of them secret;
 *   - `agent_peers` — the other sessions in this space and whether each can be asked;
 *   - `agent_status` — this session's own delegated runs, without collecting them;
 *   - `schedule_list` — the space's schedules;
 *   - `docs_search`, `docs_read` — the text of files in the space's folder;
 *   - `docs_state` — which files the space's Documents panes have open;
 *   - `record_list` — the team's record files, by name;
 *   - `record_types` — the kinds of record the team keeps: folders, fields and sections;
 *   - `review_status` — where this session's submissions to Review stand;
 *   - `memory_index`, `memory_read`, `memory_search` — the memory repo, which refuses a secret's shape
 *     on every write;
 *   - `goal_status` — the session's goal, turns and budget;
 *   - `vault_list` — the vault's secrets by NAME and host; there is no field for a value.
 *
 * NEVER add a tool that changes state, sends something, moves the user's screen or reveals a secret
 * value: a name here runs with no prompt from either engine. Left out on purpose: `docs_open`,
 * `pane_show`, `session_open`, `space_switch` (each changes what is on screen); `docs_list` and
 * `docs_progress` (each creates the space's Documents workspace the first time it runs);
 * `record_read` (logs the read on the team's activity); `team_roles` (re-hashes approved reviews, and
 * sends one back to the person when a file changed under it); `vault_http` (spends a secret).
 */
export const REALM_READ_ONLY_TOOLS: readonly string[] = [
  ...BROWSER_READ_ONLY_TOOLS.map((t) => `realm-browser__${t}`),
  "realm-workspace__workspace_state",
  "realm-workspace__sessions_list",
  "realm-workspace__session_read",
  "realm-workspace__space_list",
  "realm-workspace__settings_get",
  "realm-agent__agent_peers",
  "realm-agent__agent_status",
  "realm-schedule__schedule_list",
  "realm-docs__docs_search",
  "realm-docs__docs_read",
  "realm-docs__docs_state",
  "realm-team__record_list",
  "realm-team__record_types",
  "realm-team__review_status",
  "realm-memory__memory_index",
  "realm-memory__memory_read",
  "realm-memory__memory_search",
  "realm-goal__goal_status",
  "realm-vault__vault_list",
];
