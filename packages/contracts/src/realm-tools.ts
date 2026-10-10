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
 *   - `agent_peers` — the other sessions in this space and whether each can be asked;
 *   - `agent_status` — this session's own delegated runs, without collecting them;
 *   - `schedule_list` — the space's schedules;
 *   - `docs_search` — a text search of the space's folder;
 *   - `goal_status` — the session's goal, turns and budget.
 *
 * NEVER add a tool that changes state, sends something, or reveals a secret value: a name here runs
 * with no prompt from either engine. Left out on purpose: `docs_open` (puts a tab on the user's
 * screen), and `docs_list`/`docs_progress` (each creates the space's Documents workspace the first
 * time it runs).
 */
export const REALM_READ_ONLY_TOOLS: readonly string[] = [
  ...BROWSER_READ_ONLY_TOOLS.map((t) => `realm-browser__${t}`),
  "realm-agent__agent_peers",
  "realm-agent__agent_status",
  "realm-schedule__schedule_list",
  "realm-docs__docs_search",
  "goal__goal_status",
];
