# MCP gateway — Design Spec

**Date:** 2026-08-31
**Status:** Approved (brainstorm complete)
**Supersedes:** v1 spec §7 "Gateway" (the per-session `realm-mcp` stdio binary and `packages/mcp`), and Plan 8 W2's direct passthrough of server configs to adapters.
**Builds on:** `docs/superpowers/specs/2026-08-28-capability-research.md` §3/§7 (verdict: build the gateway, include remote HTTP + OAuth in the first cut), Plan 8 W2 (`apps/server/src/mcp/service.ts`, `packages/contracts/src/mcp.ts`).

## 1. Goals

All four, confirmed with the user:

1. **OAuth remote servers** — `https://mcp.vercel.com` and `https://mcp.linear.app/mcp` work day one; Realm runs the OAuth dance and refresh, not the agent CLIs.
2. **Observability** — every proxied tool call logged with session attribution and surfaced in an Activity view.
3. **Mount point for Realm tools** — the future `browser.*` / `artifact.*` / `context.*` tools register as an in-process provider on this same hub instead of needing their own delivery path.
4. **Credential isolation** — API keys, headers, and OAuth tokens stay in realm-server and are injected upstream; agents never receive them.

UI scope is **full** (user's call): server settings incl. OAuth connect, per-tool toggles, and the Activity view ship with the engine, accepting a rebase against the in-flight ara-refresh reskin.

## 2. Architecture — in-server gateway over Streamable HTTP

No new process and no `packages/mcp`. realm-server hosts the gateway in `apps/server/src/mcp/`, beside the W2 service it extends.

```
agent CLI ──http──▶ gateway listener (127.0.0.1:<port>, Bearer <session token>)
                      │  token → session → space → enabled servers → allowedTools
                      │  namespacing: <serverName>__<toolName>
                      ▼
                    hub — one upstream MCP client per server row (lazy, shared,
                      circuit-broken), stdio | http | sse via @modelcontextprotocol/sdk
                      │  headers/env + OAuth tokens injected here
                      ▼
                    third-party servers        (later: in-process Realm providers)
```

- At startup realm-server binds a **second loopback HTTP listener** (port from the existing `PortAllocator`) speaking Streamable HTTP MCP.
- Each session gets a **random bearer token** minted at start. Adapters receive **exactly one** MCP server:
  `{ name: "realm", transport: "http", url: "http://127.0.0.1:<port>/mcp", headers: { Authorization: "Bearer <token>" } }`.
  The token travels in a header, not the URL, so it stays out of argv and request logs. All three live adapters carry http headers (verified: Claude SDK `McpHttpServerConfig`, Codex `http_headers`, ACP http config — `packages/contracts/src/mcp.ts` §`AGENT_MCP_TRANSPORTS`).
- **`McpService.configFor` and the passthrough path are deleted.** `sessions/service.ts:307` hands adapters the single realm endpoint instead. Third-party configs, env values, and headers never reach an agent again.
- Consequence: the per-agent transport asymmetry vanishes on the agent side — the gateway speaks SSE upstream on every agent's behalf. `AGENT_MCP_TRANSPORTS` / `mcpSupportNote` reduce to "fake has no MCP"; the Codex-SSE warning machinery goes away for proxied servers.
- Sessions already die with realm-server, so gateway-dies-with-server adds no new failure mode.

## 3. Components

### Hub (`apps/server/src/mcp/hub.ts`)
- One upstream MCP client per **server row**, shared across all sessions and spaces (single-user app; per-profile credential scoping is preserved because credentials live on the row).
- **Lazy**: connects on first tool list or call. Disconnect on server row delete/update.
- **Tool list cache** persisted to the DB on every successful `tools/list`, so settings UI can render a server's tools without a live connection; refreshed on connect and on `notifications/tools/list_changed`.
- **Circuit breaker**: 3 consecutive failures opens the circuit (spec §8); a structured error is returned until a manual retry from settings or a server row edit.

### Gateway (`apps/server/src/mcp/gateway.ts`)
- Validates bearer token → sessionId → spaceId. Unknown/expired token → 401.
- `tools/list`: union of the space's **enabled** servers' cached tools, filtered by per-space `allowedTools`, re-exported as `<serverName>__<toolName>`. Server names are unique and TOML-safe already (`McpServerNameSchema`); collision with a Realm-native tool name is impossible by the same charset (`__` separator is reserved).
- `tools/call`: resolves the namespace prefix, re-checks enablement + allowedTools at call time (policy edits apply to running sessions), forwards to the hub, times the call, writes the log row.
- Emits MCP `notifications/tools/list_changed` to connected sessions when enablement, allowedTools, or an upstream tool list changes.

### OAuth (`apps/server/src/mcp/oauth.ts`)
- MCP authorization spec: OAuth 2.1 + PKCE, discovery via RFC 9728 protected-resource metadata → authorization-server metadata, **dynamic client registration** where offered.
- Flow: settings UI calls `mcp.oauth.start` → server prepares PKCE state and returns the authorization URL → renderer opens it in the system browser → redirect lands on `http://127.0.0.1:<gatewayPort>/oauth/callback` → server exchanges the code, stores access + refresh tokens, and pushes an `mcp.oauth.status` event.
- Tokens are injected as `Authorization` headers on upstream calls. One silent refresh on 401; if that fails the server row enters a `reconnect needed` status the UI badges.
- **Storage posture**: same as W2 — plaintext in `realm.db`, stated by `MCP_SECRET_STORAGE_NOTE` on every surface that touches it. Electron `safeStorage` is a named follow-up, not this build.

### Data
- New table **`McpCallLog`**: `id, sessionId, serverId, serverName, tool, argsJson, resultSummary, ok, durationMs, ts`. `resultSummary` is a truncated first-text-content excerpt, not the full payload.
- OAuth token storage on the server row (`secrets` sibling: `oauthJson` — client id, tokens, expiry, resource metadata URL).
- Per-space `allowedTools` in settings, beside the existing `mcp.enabled:<spaceId>` key: absent = all tools allowed (default-open *within* an explicitly enabled server; enablement itself stays default-off per W2's rationale).
- `McpServer` contract gains `authKind: "none" | "secrets" | "oauth"` (derived), `oauthStatus: "unconfigured" | "connected" | "reconnect_needed"`, and `tools: { name, description }[]` from the cache.

### RPC surface (contracts + `rpc/methods.ts`)
`mcp.tools.list(serverId)` · `mcp.setAllowedTools(spaceId, serverId, tools[] | null)` · `mcp.calls.list({ sessionId?, serverId?, limit, before })` · `mcp.oauth.start(serverId)` · `mcp.oauth.disconnect(serverId)` · `mcp.retry(serverId)` (closes the circuit) — plus events `mcp.call` (live log row) and `mcp.serverStatus`.

## 4. Transcript vs Activity — deviation from v1 spec §7

The v1 spec wanted every proxied call mirrored into `SessionEvent` `tool_call`/`tool_result`. Agents already emit their own tool events for MCP tools, so mirroring would double every call in the transcript. **Gateway calls go to `McpCallLog` only.** The transcript keeps the agent's view; Activity shows Realm's view; the two join on sessionId.

## 5. UI

Follows `docs/superpowers/specs/2026-08-27-design-language.md`; the space-settings sheet is the pattern. Expect a rebase against `feat/ara-refresh` at merge time — build against current main, restyle in the rebase if the reskin moved tokens.

- **Server editor**: existing fields + auth section — API-key headers (existing) or a **Connect** button for OAuth with live status (connected / reconnect needed / error), always showing `MCP_SECRET_STORAGE_NOTE`.
- **Per-space enablement** grows a per-tool checkbox list under each enabled server (from the tool cache; "all tools" is the default state, matching `allowedTools` absent).
- **Activity view**: reverse-chron call list — time, session, `server__tool`, duration, ok/error — filterable by session and server, live-updating from `mcp.call` events. Empty states and error copy per the design language's honesty idiom (a server whose circuit is open says so here too).

## 6. Error handling

| Failure | Behavior |
|---|---|
| Unknown/expired session token | 401; agent surfaces its own connection error. |
| Tool blocked by space policy | Structured tool error naming the space and the toggle that blocks it. |
| Upstream call fails | Error result to the agent, log row with `ok=false`, toast in UI; other servers unaffected. |
| 3 consecutive upstream failures | Circuit opens; calls fail fast with a "server unavailable, retry from settings" error until `mcp.retry` or a row edit. |
| OAuth token expired | One silent refresh; on failure, row → `reconnect_needed`, calls fail with a reconnect message, UI badges it. |
| Server row deleted mid-session | Its tools vanish from `tools/list` (list_changed notification); in-flight calls complete or error. |
| Gateway listener port lost | Fatal at startup only (PortAllocator); no runtime rebind. |

## 7. Testing

- **Gateway end-to-end**: in-process MCP client (SDK) → gateway → stub upstream fixture server (stdio and http variants) — list, call, namespacing, allowedTools enforcement, call-time policy re-check, 401s.
- **Hub**: lazy connect, sharing across two sessions, tool-cache persistence, circuit breaker open/close.
- **OAuth**: full flow against a stub authorization server (discovery → DCR → PKCE exchange → refresh → refresh-failure status).
- **Session wiring**: session start hands each adapter exactly one `realm` http server with a Bearer header; W2 `configFor` tests removed with the code.
- **Migrations**: `McpCallLog` + `oauthJson` up-migration on a W2-era DB.
- Gates per Plan 8: `SHELL=/bin/bash pnpm vitest run`, `pnpm -r typecheck`, `pnpm -r build`.

## 8. Explicitly not built

`packages/mcp` as a workspace package. A per-session gateway process. SessionEvent mirroring of proxied calls. `safeStorage` encryption (follow-up). Realm-native tool providers (`browser.*` etc.) — the hub's provider seam is designed for them but the first provider arrives with the browser pane. Per-server "direct passthrough" escape hatch — removed deliberately; revisit only if a server misbehaves behind the proxy in practice.
