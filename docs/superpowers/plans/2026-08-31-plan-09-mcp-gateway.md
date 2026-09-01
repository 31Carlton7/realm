# Realm Plan 9 — MCP gateway

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan workstream-by-workstream, in order. Checkboxes
> track workstreams.

**Goal:** Agents connect to one Realm-hosted MCP endpoint instead of directly to third-party servers —
giving Realm call logging, per-tool policy, OAuth for remote servers, and credential isolation.

**Architecture:** realm-server binds a second loopback HTTP listener speaking Streamable HTTP MCP
(`@modelcontextprotocol/sdk`). A per-session bearer token maps the connection to a session and space; the
gateway re-exports enabled upstream tools as `<serverName>__<toolName>` and proxies calls through a hub of
shared, lazily-connected upstream clients. Spec: `docs/superpowers/specs/2026-08-31-mcp-gateway-design.md`.

**Tech stack:** `@modelcontextprotocol/sdk` (server + client + auth), node `http`, better-sqlite3, zod
contracts, React/zustand renderer.

**Spec amendment carried by this plan:** the gateway listener binds **port 0** (OS-assigned, loopback),
not a `PortAllocator` port — the allocator reserves dev-server blocks for environments, which is a
different job. The bound port is read back at startup and used for session tokens and the OAuth redirect.

---

## Ground rules

- Sequential workstreams; each ends green on all three gates:
  `SHELL=/bin/bash pnpm vitest run` · `pnpm -r typecheck` · `pnpm -r build`. Commit per workstream.
- TDD where the seam is testable in-process (all of W2–W6): write the failing test, watch it fail, make it
  pass. UI workstreams follow the existing RTL patterns (`space-settings.test.tsx`).
- Never modify anything under `~/.claude`, `~/.codex`, `~/.cursor`. No user-owned config writes.
- Secrets discipline is inherited from W2 of Plan 8 and now gets *stronger*: with the passthrough gone,
  **no code path outside `hub.ts`/`oauth.ts` may touch `McpServerRow.secrets` or `oauthJson`.** Nothing
  logs, broadcasts, or persists a secret value; `mcp.list` keeps returning key names only.
- Verify SDK API names against the installed `@modelcontextprotocol/sdk` before writing each consumer —
  the shapes below (transport/class names) are from its documented exports, not from this repo.

## File map

| Path | Role |
|---|---|
| `apps/server/src/db/migrations.ts` | v9 migration (call log, oauth + tools columns) |
| `apps/server/src/store/mcp.ts` | row gains `oauthJson`, `tools`; new `McpCallLogStore` |
| `apps/server/src/mcp/hub.ts` (new) | upstream clients: lazy, shared, circuit-broken, tool cache |
| `apps/server/src/mcp/gateway.ts` (new) | HTTP listener, token→session auth, namespacing, policy, logging |
| `apps/server/src/mcp/oauth.ts` (new) | OAuth 2.1 + PKCE + DCR, callback route, token refresh |
| `apps/server/src/mcp/service.ts` | allowedTools; `configFor` **deleted** |
| `apps/server/src/sessions/service.ts:300–317` | passthrough → `gateway.register(sessionId)` |
| `apps/server/src/app.ts` | construct hub/gateway/oauth; close them in `close()` |
| `apps/server/src/rpc/methods.ts` | new `mcp.*` methods |
| `packages/contracts/src/mcp.ts` / `rpc.ts` | tool/call/oauth schemas, methods, events |
| `apps/desktop/src/renderer/src/components/sidebar/McpSection.tsx` (new) | servers UI in SpaceSettingsSheet |
| `apps/desktop/src/renderer/src/components/ActivitySheet.tsx` (new) | call log view |
| `apps/server/src/mcp/fixtures/stub-server.ts` (new) | in-process upstream for tests |

---

### W1 — Schema, store, contracts

- [x] **Migration v9** appended to `migrations` (follow the v8 comment idiom — say *why* in the SQL
  comment):

```sql
-- v9 — MCP gateway (Plan 9). oauth_json holds the whole OAuth state for a remote server (client
-- registration, tokens, expiry) — plaintext, same posture and same honesty note as secrets_json.
-- tools_json caches the last successful tools/list so settings can render a server's tools without a
-- live connection. mcp_call_log is Realm's view of proxied calls (Activity); the transcript keeps the
-- agent's own view, so nothing here mirrors into session_events. server_id survives as NULL after a
-- server row is deleted — the log outlives the config that produced it, which is the point of a log.
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
```

- [x] `store/mcp.ts`: `McpServerRow` gains `oauthJson: string` and `tools: McpToolRow[]`
  (`{ name: string; description: string }`), parsed with the same corruption-degrades-to-empty idiom as
  `parseArgs`. New methods `setTools(id, tools)`, `setOauth(id, json)` — targeted UPDATEs that do not
  touch `updated_at` semantics of user edits (they may share `now()`; the distinction that matters is
  they must not go through `update()`'s name guard). New `McpCallLogStore` in the same file:
  `append(row)`, `list({ sessionId?, serverId?, before?, limit })` newest-first with `before` as a ts
  cursor, default limit 50, max 200.
- [x] `packages/contracts/src/mcp.ts`:

```ts
export const McpToolSchema = z.object({ name: z.string(), description: z.string() });
export const McpOauthStatusSchema = z.enum(["unconfigured", "connected", "reconnect_needed"]);
export const McpServerStatusSchema = z.enum(["idle", "connected", "error", "circuit_open"]);
export const McpCallSchema = z.object({
  id: IdSchema, sessionId: IdSchema, serverId: IdSchema.nullable(), serverName: z.string(),
  tool: z.string(), argsJson: z.string(), resultSummary: z.string(),
  ok: z.boolean(), durationMs: z.number().int(), ts: z.number().int(),
});
```

  `McpServerSchema` gains `authKind: z.enum(["none", "secrets", "oauth"])` (derived: oauth beats
  secrets beats none), `oauthStatus: McpOauthStatusSchema`, `status: McpServerStatusSchema`,
  `tools: z.array(McpToolSchema)`.
- [x] `packages/contracts/src/rpc.ts` — methods:
  `mcp.tools.list { id } → { tools: McpToolSchema[], error: z.string().nullable() }` (triggers a lazy
  connect; a connect failure is a **result**, not a thrown error — the list is still renderable),
  `mcp.setAllowedTools { spaceId, id, tools: z.array(z.string()).nullable() } → ok` (null = all),
  `mcp.calls.list { sessionId?, serverId?, before?, limit? } → { calls: McpCallSchema[] }`,
  `mcp.oauth.start { id } → { authUrl: z.string() }`, `mcp.oauth.disconnect { id } → ok`,
  `mcp.retry { id } → ok`. Events: `"mcp.call": McpCallSchema`,
  `"mcp.serverStatus": z.object({ id: IdSchema, status: McpServerStatusSchema, oauthStatus: McpOauthStatusSchema })`.
- [x] `mcp.list` result rows carry the new fields; `allowedTools` reaches the client as
  `allowedTools: z.array(z.string()).nullable()` on each server (per the spaceId the list was asked for).
- [x] Migration test in `db/database.test.ts` style: open a v8-era DB fixture, migrate, assert columns
  and empty log. Gates. Commit `feat(server): v9 schema + contracts for the MCP gateway`.

> **Amendments after W1 review (binding on later workstreams):**
> 1. **Composite call-log cursor.** A plain `before: ts` cursor drops same-millisecond siblings at page
>    boundaries (the store's own tie-break test proves the case is real). In W3, change
>    `mcp.calls.list` params to `before: z.object({ ts: z.number().int(), id: IdSchema }).optional()`
>    and `McpCallLogStore.list` to filter `(ts < ? OR (ts = ? AND id < ?))` ordered `ts DESC, id DESC`;
>    W7's "Load more" passes the last row's `{ ts, id }`.
> 2. **Corrupted allowlists stay fail-open** (`allowedTools` non-array → null = all). Realm writes these
>    values itself, so corruption is a bug not an attack; failing closed would silently kill tools with
>    no UI explaining why. W3's enforcement comment must state this decision.

### W2 — Hub

- [x] Add `@modelcontextprotocol/sdk` to `apps/server/package.json` (and a `//` comment naming why it is
  a direct dep, matching the file's idiom).
- [x] `apps/server/src/mcp/fixtures/stub-server.ts`: a minimal in-process MCP server factory used by
  every test in W2–W6 — `makeStubServer({ tools, failNext? })` exposing `echo` (returns its args) and
  `boom` (returns an error), connectable over an in-memory transport pair and, for one integration
  test, spawnable as stdio via `tsx`.
- [x] `hub.ts` — `class McpHub`:

```ts
type UpstreamStatus = "idle" | "connected" | "error" | "circuit_open";
class McpHub {
  constructor(d: { servers: McpServersStore; onStatus: (id: string, status: UpstreamStatus) => void;
                   authHeaders: (row: McpServerRow) => Promise<Record<string, string>> }) {}
  async tools(serverId: string): Promise<McpToolRow[]>;          // lazy connect; caches via setTools
  async call(serverId: string, tool: string, args: unknown): Promise<CallToolResult>;
  async retry(serverId: string): Promise<void>;                  // closes the circuit, drops the client
  invalidate(serverId: string): void;                            // row edited/deleted → disconnect
  async close(): Promise<void>;
}
```

  One SDK `Client` per server row, keyed by id, created on first `tools()`/`call()`. Transport from the
  row: `StdioClientTransport` (command/args/env=secrets), `StreamableHTTPClientTransport` (url, headers =
  secrets + `await authHeaders(row)` — the OAuth seam, wired in W5), `SSEClientTransport` likewise.
  Subscribe to `tools/list_changed` → refresh cache → `onStatus` fires so the gateway can notify.
  Circuit breaker: 3 consecutive failures → `circuit_open`, calls fail fast with a structured error
  naming `mcp.retry`; any success resets the count.
- [x] Tests (`hub.test.ts`, TDD): lazy (no connect before first use) · two callers share one client ·
  tool cache persisted · circuit opens after 3 and `retry` closes it · `invalidate` disconnects ·
  connect failure surfaces as error result, not throw. *(Amended after W2 review: this bullet holds at
  the RPC layer only — `McpHub.tools()` THROWS on failure; W3's `mcp.tools.list` handler and the
  gateway's `tools/list` union catch it and shape results. Breaker "failures" are THROWN failures only —
  an `isError: true` tool result is a successful round-trip and never touches the breaker. `close()` is
  terminal: a closed hub is never reused; any restart constructs a fresh McpHub.)*
  Gates. Commit `feat(server): MCP hub — shared lazy upstream clients with circuit breaker`.

### W3 — Gateway listener + session wiring (passthrough removed)

- [x] `gateway.ts` — `class McpGateway`:

```ts
class McpGateway {
  constructor(d: { hub: McpHub; mcp: McpService; sessions: SessionsStore; calls: McpCallLogStore;
                   rpc: RpcServer }) {}
  async listen(): Promise<number>;                         // http.createServer on 127.0.0.1:0
  register(sessionId: string, spaceId: string): McpServerConfig; // mint token → the one realm server entry
  release(sessionId: string): void;                        // token revoked, transport closed
  notifyPolicyChanged(spaceId: string): void;              // → tools/list_changed to affected sessions
  async close(): Promise<void>;
}
```

  - Routes: `POST|GET|DELETE /mcp` (Streamable HTTP, stateful — one `StreamableHTTPServerTransport` +
    SDK `Server` per registered session, created on first authorized request), `GET /oauth/callback`
    (W5). Everything else 404. `Authorization: Bearer <token>` resolved against the register map;
    unknown/revoked → 401. Tokens: 32 bytes from `crypto.randomBytes`, base64url, never logged.
  - `register` returns exactly
    `{ name: "realm", transport: "http", url: "http://127.0.0.1:<port>/mcp", headers: { Authorization: "Bearer <token>" } }`.
  - `tools/list`: for each server enabled in the session's space, `hub.tools()` filtered by
    allowedTools, prefixed `<serverName>__`. A server whose connect fails contributes nothing (its
    status event is the signal — the agent's list must not error because one upstream is down).
  - `tools/call`: split on first `__`; re-check enablement + allowedTools **at call time** (edits reach
    running sessions); forward to hub; time it; append the log row; `rpc.broadcast("mcp.call", row)`.
    Blocked tool → tool error naming the space and the settings toggle. `resultSummary`: first text
    content, truncated to 200 chars.
- [x] `sessions/service.ts`: replace lines 301–307's `configFor` block with
  `const mcpServers = [this.d.gateway.register(id, s.spaceId)];` (comment: the ONLY MCP config an agent
  ever receives; secrets stay server-side). Call `release(id)` where the live handle is dropped
  (`ensureLive`'s pump `finally`, `closeAll`, and session delete). `app.ts`: construct hub + gateway,
  `await gateway.listen()` before `rpc.listen`, close both in `close()`.
- [x] `mcp/service.ts`: **delete `configFor` and `toAdapterConfig`**; add
  `allowedTools(spaceId, serverId)`, `setAllowedTools(...)` on settings key
  `mcp.allowedTools:<spaceId>:<serverId>` (absent = all), and `enabledServerIds(spaceId)` for the
  gateway. `rpc/methods.ts`: wire the six new methods; `mcp.setEnabled`/`setAllowedTools` also call
  `gateway.notifyPolicyChanged(spaceId)`, and `mcp.update`/`mcp.remove` call `hub.invalidate(id)` (a
  deleted or re-pointed server must not keep serving through a stale client) followed by
  `notifyPolicyChanged` for every space that had it enabled.
- [x] Tests: end-to-end with an SDK client dialing the gateway over real HTTP against a stub upstream —
  list is namespaced and policy-filtered · call round-trips and logs · call-time policy re-check ·
  401 on bad/revoked token · one upstream down leaves the other listable · session start test asserts
  the adapter received exactly one `realm` http entry with a Bearer header (extend the existing
  fake-adapter session tests) · W2-era `service.test.ts` passthrough tests deleted with the code.
  Gates. Commit `feat(server): MCP gateway — agents now reach servers only through Realm`.

### W4 — Agent-side simplification

- [x] `packages/contracts/src/mcp.ts`: `AGENT_MCP_TRANSPORTS` collapses to the one true statement —
  every live adapter takes the gateway's http entry; `fake` takes none. `mcpSupportNote` now explains
  the *gateway* ("this space's servers reach <label> through Realm's gateway; calls appear in
  Activity") instead of per-transport gaps; the Codex-SSE warning path and adapters' transport-drop
  logging go away (the gateway speaks SSE upstream on every agent's behalf). Delete what dies; update
  `mcp.test.ts` accordingly.
- [x] Gates. Commit `refactor: transport asymmetry is the gateway's problem now, not the agents'`.

### W5 — OAuth for remote servers

- [x] `oauth.ts` — `class McpOauth` implementing the SDK's `OAuthClientProvider` against
  `McpServersStore` (`oauthJson` holds client registration, tokens, verifier, resource metadata URL):
  `start(serverId) → authUrl` (discovery per RFC 9728 → AS metadata → dynamic client registration where
  offered → PKCE, `state` = signed serverId nonce), `handleCallback(url)` (validates state, exchanges
  code, stores tokens, broadcasts `mcp.serverStatus`), `headers(row)` (valid access token, **one**
  silent refresh on expiry; refresh failure → `reconnect_needed` + status event),
  `disconnect(serverId)` (clears `oauthJson`). Redirect URI:
  `http://127.0.0.1:<gatewayPort>/oauth/callback` — the gateway routes it here; the response page is
  three lines of static HTML saying "connected — return to Realm".
  `mcp.oauth.start` returns the URL; the **renderer** opens it (`window.open` → default browser via the
  existing external-link path in desktop main). Hub's `authHeaders` seam from W2 now calls
  `oauth.headers(row)` for rows with oauth state.
- [x] Tests against a stub authorization server (plain `http` fixture): full flow → tokens stored →
  headers injected · refresh on expiry · refresh failure flips status to `reconnect_needed` · state
  mismatch rejected · disconnect clears state. Nothing asserts against real Vercel/Linear.
- [x] Manual live check (not CI): add `mcp.vercel.com` as an http server, Connect, watch tools land.
  Gates. Commit `feat(server): OAuth 2.1 + PKCE for remote MCP servers, tokens never leave realm-server`.

> **Amendment from W4 review:** an ACP build that does not advertise `mcpCapabilities.http` silently
> drops the gateway entry — its only route to any tool — and today that logs only to realm-server's
> stderr while `mcpSupportNote` promises the gateway works. W6 must surface this honestly: when the
> session's agent is ACP-kind, the settings copy must note that a build without http MCP support gets
> no tools (the adapter's onLog line and `acpMcpServers([http], {}) === []` test pin the behavior).

> **Amendment from W5 review — known friction, accepted for v1:** OAuth refresh happens only at
> connect time (the hub's `authHeaders` seam). A token expiring under a long-lived client produces
> three failing agent calls, then `circuit_open`, then the server is dark until the user clicks
> Retry in settings — which reconnects and silently refreshes. Not transparent; reachable with 1h
> TTLs in a long-running desktop app. A hub-level 401→invalidate-once retry is the post-plan fix.
> W6's circuit-open UI copy should hint at this ("Retry reconnects and refreshes the connection").

### W6 — Settings UI: servers, auth, per-tool policy

- [x] `components/sidebar/McpSection.tsx`, rendered inside `SpaceSettingsSheet` below
  `EnvironmentList`, following its exact idiom (`useApp`, `run()`, `.field`/`.env-row` styling and the
  design-language spec). Contents: server list (name, transport, endpoint, status dot from
  `mcp.serverStatus`); add/edit form (the W2 fields plus auth kind — API-key secrets as today, or a
  **Connect** button for OAuth showing `oauthStatus`, with `MCP_SECRET_STORAGE_NOTE` wherever a secret
  is entered); per-space enable toggle; under an enabled server, its cached tools as checkboxes
  (all-checked = `allowedTools: null`; any uncheck sends the explicit list) with a "Refresh tools"
  action calling `mcp.tools.list` and surfacing its `error` inline; circuit-open shows a Retry button
  (`mcp.retry`). Every state renders honestly — a server with no cached tools says "not connected yet",
  not an empty region.
- [x] Store/live-api: `state/store.ts` gains mcp servers + statuses keyed by the space being edited;
  `state/live-api.ts` subscribes to `mcp.changed` / `mcp.serverStatus` and refetches/patches.
- [x] RTL tests (`mcp-section.test.tsx`, patterned on `space-settings.test.tsx`): add server → appears
  enabled here only · toggle per-tool checkbox → `mcp.setAllowedTools` called with the explicit list ·
  oauth server shows Connect and status transitions on event · secret note visible on the key form.
  Gates. Commit `feat(desktop): MCP servers, auth and per-tool policy in space settings`.

### W7 — Activity view

> **Amendment from W3 review:** blocked-call rows have attribution quirks the renderer must handle —
> a blocked-but-known server logs the parsed `tool` name normally, but an unmatched tool name logs
> `serverName: ""` with `tool` holding the full namespaced string. Render `serverName ? `${serverName}__${tool}` : tool`.
> "Load more" passes the last row's `{ ts, id }` as the composite `before` cursor (W1 amendment).

- [x] `components/ActivitySheet.tsx`: reverse-chron call list (time, session title, `server__tool`,
  duration, ok/error), filter chips by session and by server, live-prepend from `mcp.call` events,
  "Load more" via `before` cursor. Opened from space settings ("Activity") and the command palette
  ("MCP Activity"), through the existing sheet plumbing in `state/store.ts`. Empty state: "No MCP calls
  yet — calls agents make through Realm's gateway appear here." A circuit-open server's failures show
  their structured error text.
- [x] RTL tests: rows render from `mcp.calls.list` · live event prepends · filters narrow.
  Gates. Commit `feat(desktop): Activity — Realm's view of every proxied MCP call`.

### W8 — Docs and closeout

- [x] Spec: amend the PortAllocator line to port-0 (this plan's header note), commit alongside.
  README "Agent sessions" section gains two lines on the gateway (agents see one Realm endpoint;
  Activity shows calls). Cross-link this plan from the spec header.
- [x] Live smoke on the real app (`pnpm dev`): stdio server (e.g. `npx -y @modelcontextprotocol/server-everything`)
  + one OAuth remote; a Claude session lists namespaced tools, a call lands in Activity; kill the
  stdio server mid-session and confirm the structured error + toast, not a dead session.
- [x] Final gates; `git log --oneline` review; PR per repo convention.

## Execution notes

Sequential implementers, mutation-grade tests, commit before mutating. The stub fixtures from W2 are
load-bearing for every later workstream — build them well. Feature-detect nothing here (the SDK is a
pinned dependency, not a moving CLI), but **do** verify SDK export names against the installed version
before each consumer file. If ara-refresh merges mid-plan, rebase W6/W7 onto the new tokens rather than
styling twice.

## Closeout notes

- **Activity's server filter chips are per-space-opened, not global.** The chip set `ActivitySheet`
  offers is seeded from whichever space last had its settings opened, not from every server that has
  ever logged a call — so the global log (opened from the command palette, no space in scope) can still
  render space-scoped chips left over from the last settings visit. Narrow but real; worth a look if
  Activity ever grows a true cross-space filter.
- **Switching an OAuth remote server to stdio is a two-step edit, not one.** `mcp.update` clears
  `oauthJson` the instant the transport changes (the OAuth-drop guard in `service.ts`/`integration.test.ts`
  is deliberate — a stdio server has no business holding remote tokens) but the SAME update call has no
  way to also carry the new `env` keys a stdio server needs, because the form only sends the fields for
  the transport it currently shows. In practice: save once to drop the grant and land on stdio, then
  re-open the row to add env keys. Not a bug, just a two-click flow the settings UI never collapsed.
- **`mcp.list`'s `secretNote` field is dead on the wire.** `McpService.list` still returns
  `secretNote: MCP_SECRET_STORAGE_NOTE` on every result (`packages/contracts/src/rpc.ts`'s `mcp.list`
  schema), and `integration.test.ts` still asserts it is present — but `McpSection.tsx` imports
  `MCP_SECRET_STORAGE_NOTE` directly from `@realm/contracts` rather than reading it off the RPC result.
  The value is right either way (it is the same constant), so nothing is wrong today; it is a candidate
  for removing the field from the wire schema rather than a bug worth a workstream of its own.
- **Per-tool allowlist toggles cost an RPC plus a redundant refetch each.** Every checkbox click in
  `McpSection.tsx` calls `store.setMcpAllowedTools`, which awaits `mcp.setAllowedTools` and only then
  patches the row locally — no optimistic update ahead of the round trip — and the `mcp.changed` broadcast
  that same call triggers fires a full `mcp.list` refetch on top of that local patch (`App.tsx`'s
  `mcp.changed` handler). One RPC plus one list refetch per click, on a server whose tool count is
  realistically single digits. Fine at the scale a per-space server list actually reaches; worth
  revisiting only if a server ever shows up with dozens of tools and toggling feels laggy.
- **Two accepted-friction items already live in their own amendment blocks, not repeated here:** the
  connect-time-only OAuth refresh (W5 amendment, above — a token expiring mid-session takes three failed
  calls and a circuit-open before Retry silently re-authenticates) and the `durationMs: 0` a blocked call
  logs alongside every real one (W3's `blocked()` — indistinguishable from a genuinely instant successful
  call in Activity's duration column without also reading `ok`). Both were reviewed and accepted for v1;
  see their own blocks for the reasoning rather than duplicating it here.
