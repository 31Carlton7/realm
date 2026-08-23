# Codex CLI `app-server` protocol — reference for the Realm adapter

Verified against `codex-cli 0.146.0` on macOS, 2026-08-22.

Everything marked **verified** was captured from a live `codex app-server` process. Everything
marked **unverified** was read from the generated TypeScript bindings (`codex app-server
generate-ts`) but not exercised. See `examples/codex-smoke.mjs` for a runnable driver.

> **Caveat on the live runs.** The machine's ChatGPT refresh token was revoked at capture time, so
> `thread/start` against the user's real `CODEX_HOME` failed with
> `{"code":-32600,"data":{"reason":"cloudConfigBundle","action":"relogin"}}`. The session/streaming
> captures below were therefore taken with an isolated `CODEX_HOME` whose `config.toml` points at a
> local mock OpenAI Responses endpoint. The app-server side of the protocol (framing, methods,
> notifications, approvals) is real; only the model backend was mocked.
>
> **Update 2026-08-22 — the real backend now works.** After re-auth, `codex-smoke.mjs` completes a
> full turn against the user's actual `CODEX_HOME`: `thread/start` → `turn/start` → `userMessage` /
> `agentMessage` items → `thread/tokenUsage/updated` (`in=20199 cached=11008 out=7 total=20206`,
> ctx 258400) → `turn/completed` → `status: idle`, with `thread/resume` reporting 1 turn on disk.
> Turn latency ~4.6 s. The §-by-§ shapes below are unchanged by this; treat the mock caveat as
> applying only to *model-generated content*, not to the protocol.
>
> One environment note surfaced by the live run: several MCP servers in the user's `~/.codex`
> config fail at startup — `Figma Desktop` (invalid name, must match `^[a-zA-Z0-9_-]+$`),
> `notion` (HTTP 401, needs sign-in), and `paper` (connection refused on `127.0.0.1:29979`).
> Codex reports each as an `mcp <name>: failed` line and continues. Realm's adapter should
> surface these as non-fatal warnings rather than failing the session.

---

## 1. Transport and framing

- **Spawn**: `codex app-server` (no args). `--listen` defaults to `stdio://`.
- **Framing**: **newline-delimited JSON**. One JSON object per line on stdin and stdout. There are
  **no** `Content-Length` headers. (verified)
- **stderr** carries human tracing/log lines — never JSON-RPC. Drain it or you can deadlock. (verified)
- Requests you send must include `"jsonrpc":"2.0"`. **Responses from the server omit `jsonrpc`** —
  they are bare `{"id":N,"result":…}` / `{"id":N,"error":…}`. Do not validate on that field. (verified)
- Every server **notification** carries an extra top-level `emittedAtMs` alongside `method`/`params`. (verified)
- Errors use `{"error":{"code":-32600,"message":…,"data"?:…}}`. Unknown method and bad param types
  both produce `-32600` (not `-32601`/`-32602`). (verified)
- **Two independent id spaces.** Server→client requests are numbered by the server starting at `0`
  and will collide with your own client request ids. Key pending client requests separately from
  inbound server request ids. (verified — first approval arrived as `id: 0` while client ids were at 6)

---

## 2. Happy path (real captured traffic, trimmed)

### 2.1 `initialize` → `initialized`

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
     "clientInfo":{"name":"realm-smoke","title":"Realm Smoke","version":"0.0.1"},
     "capabilities":{"experimentalApi":true,"requestAttestation":false}}}

← {"id":1,"result":{
     "userAgent":"realm-smoke/0.146.0 (Mac OS 26.4.0; arm64) unknown (realm-smoke; 0.0.1)",
     "codexHome":"/Users/carltonaikins/.codex","platformFamily":"unix","platformOs":"macos"}}

→ {"jsonrpc":"2.0","method":"initialized"}          // notification, no id, no params
```

`InitializeCapabilities`: `{ experimentalApi: boolean, requestAttestation: boolean,
mcpServerOpenaiFormElicitation?: boolean, optOutNotificationMethods?: string[] | null }`.
`capabilities` may be `null`. **Set `experimentalApi: true`** — most of the `v2` surface (including
`thread/*` and `turn/*`) is gated behind it. `optOutNotificationMethods` is a useful firehose valve
(e.g. drop `rawResponse/completed`). (verified: `experimentalApi:true` path; opt-out list unverified)

Shortly after `initialize` the server pushes unsolicited `configWarning` and
`remoteControl/status/changed`. Handle notifications before your first request resolves. (verified)

### 2.2 `thread/start`

```json
→ {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{
     "cwd":"/abs/path","model":"gpt-5.2","approvalPolicy":"on-request","sandbox":"workspace-write"}}

← {"id":2,"result":{
     "thread":{"id":"01a02bb7-76aa-75c2-b032-1454db0f848e","sessionId":"01a02bb7-…","status":{"type":"idle"},
               "path":"…/sessions/2026/08/22/rollout-…jsonl","cwd":"/abs/path","cliVersion":"0.146.0",
               "source":"vscode","modelProvider":"mock","turns":[]},
     "model":"gpt-5.2","modelProvider":"mock","cwd":"/abs/path",
     "runtimeWorkspaceRoots":["/abs/path"],"instructionSources":[],
     "approvalPolicy":"on-request","approvalsReviewer":"user",
     "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,
                "excludeTmpdirEnvVar":false,"excludeSlashTmp":false},
     "reasoningEffort":null,"multiAgentMode":"explicitRequestOnly"}}

← {"method":"thread/started","params":{"thread":{…}},"emittedAtMs":1787439873063}
```

`result.thread.id` is **the** thread id used by every later request and notification. The
`thread/started` notification is redundant with the response and may arrive *after* it. (verified)

`thread/start` **auto-subscribes** this connection to the thread's notifications; there is no
separate subscribe call. `thread/unsubscribe {threadId}` opts back out. (verified for auto-subscribe;
unsubscribe unverified)

### 2.3 `turn/start`

```json
→ {"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
     "threadId":"01a02bb7-76aa-…",
     "input":[{"type":"text","text":"Run `echo hi` then reply DONE.","text_elements":[]}]}}

← {"id":3,"result":{"turn":{"id":"01a02bb7-76fb-70d2-9016-a31ff217cb4c","items":[],
     "itemsView":"notLoaded","status":"inProgress","error":null,
     "startedAt":null,"completedAt":null,"durationMs":null}}}
```

`text_elements: []` is **required** on `{"type":"text"}` input (it is a non-optional array in
`UserInput`). Other input variants: `image {url,detail?}`, `localImage {path,detail?}`,
`audio {url}`, `localAudio {path}`, `skill {name,path}`, `mention {name,path}`. (verified for `text`)

### 2.4 The stream

```json
← thread/status/changed  {"threadId":"…","status":{"type":"active","activeFlags":[]}}
← turn/started           {"threadId":"…","turn":{"id":"01a02bb7-76fb-…","status":"inProgress",…}}
← item/started           {"item":{"type":"userMessage","id":"01a02bb7-774b-…","clientId":null,
                          "content":[{"type":"text","text":"…","text_elements":[]}]},
                          "threadId":"…","turnId":"…","startedAtMs":1787439839051}
← item/completed         {"item":{"type":"userMessage",…},…,"completedAtMs":1787439839051}
← item/started           {"item":{"type":"reasoning","id":"rs_1_1","summary":[],"content":[]},…}
← item/reasoning/summaryPartAdded  {"threadId":"…","turnId":"…","itemId":"rs_1_1","summaryIndex":0}
← item/reasoning/summaryTextDelta  {…,"itemId":"rs_1_1","delta":"Checking ","summaryIndex":0}
← item/completed         {"item":{"type":"reasoning","id":"rs_1_1",
                          "summary":["Checking the request."],"content":[]},…}
← item/started           {"item":{"type":"agentMessage","id":"msg_1","text":"","phase":null,
                          "memoryCitation":null},…}
← item/agentMessage/delta {"threadId":"…","turnId":"…","itemId":"msg_1","delta":"Running "}
← item/completed         {"item":{"type":"agentMessage","id":"msg_1","text":"Running the command.",…}}
← thread/tokenUsage/updated {"threadId":"…","turnId":"…","tokenUsage":{
     "total":{"totalTokens":154,"inputTokens":120,"cachedInputTokens":20,"cacheWriteInputTokens":0,
              "outputTokens":34,"reasoningOutputTokens":12},
     "last":{…},"modelContextWindow":258400}}
← account/rateLimits/updated {"rateLimits":{"limitId":"codex","primary":null,…}}
← thread/status/changed  {"threadId":"…","status":{"type":"idle"}}
← turn/completed         {"threadId":"…","turn":{"id":"01a02bb7-76fb-…","itemsView":"summary",
                          "items":[{"type":"agentMessage","id":"msg_final","text":"DONE",…}],
                          "status":"completed","error":null,"durationMs":110}}
```

Ordering guarantees observed (verified): `turn/started` → `item/started(userMessage)` →
… item lifecycles … → `thread/tokenUsage/updated` (once per model round-trip, not once per turn) →
`thread/status/changed{idle}` → `turn/completed`. Deltas for an item always fall between that item's
`item/started` and `item/completed`.

**A multi-round-trip turn emits `thread/tokenUsage/updated` several times.** `tokenUsage.total` is
thread-cumulative, `tokenUsage.last` is the most recent request. Use `total` for a running display,
not a sum of `last`. (verified)

### 2.5 Command execution + approval (real capture)

```json
← item/started {"item":{"type":"commandExecution","id":"call_1","pluginId":null,"scriptPath":null,
    "command":"/bin/zsh -lc 'echo hello-from-codex && sleep 1 && echo second-line'",
    "cwd":"/abs/path","processId":null,"source":"agent","status":"inProgress",
    "commandActions":[{"type":"unknown","command":"echo hello-from-codex && …"}],
    "aggregatedOutput":null,"exitCode":null,"durationMs":null},
    "threadId":"…","turnId":"…","startedAtMs":1787439873111}

← {"method":"item/commandExecution/requestApproval","id":0,"params":{      // SERVER → CLIENT REQUEST
    "threadId":"…","turnId":"…","itemId":"call_1","startedAtMs":1787439873109,
    "environmentId":"local","reason":"Realm smoke test",
    "command":"/bin/zsh -lc 'echo hello-from-codex && …'","cwd":"/abs/path",
    "commandActions":[{"type":"unknown","command":"…"}],
    "proposedExecpolicyAmendment":["echo","hello-from-codex"],
    "availableDecisions":["accept",
      {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo","hello-from-codex"]}},
      "cancel"]}}

→ {"jsonrpc":"2.0","id":0,"result":{"decision":"accept"}}                  // CLIENT RESPONSE

← serverRequest/resolved  {"threadId":"…","requestId":0}
← item/commandExecution/outputDelta {"threadId":"…","turnId":"…","itemId":"call_1",
                                     "delta":"second-line\n"}
← item/completed {"item":{"type":"commandExecution","id":"call_1","processId":"12654",
    "source":"unifiedExecStartup","status":"completed","aggregatedOutput":"second-line\n",
    "exitCode":0,"durationMs":874},…,"completedAtMs":1787439874147}
```

### 2.6 File change

```json
← item/started   {"item":{"type":"fileChange","id":"call_2","status":"inProgress",
    "changes":[{"path":"/abs/path/smoke.txt","kind":{"type":"add"},"diff":"hello patch\n"}]},…}
← item/completed {"item":{"type":"fileChange","id":"call_2","status":"completed","changes":[…]},…}
```

With `sandbox: "workspace-write"` and a target inside `cwd`, **no approval request is emitted** —
the patch applies silently. Approvals only fire outside the writable roots or under
`approvalPolicy: "untrusted"`. (verified)

---

## 3. Notification reference

Thread-scoped notifications all carry `threadId`; turn-scoped ones add `turnId`; item-scoped ones add
`itemId`. All carry top-level `emittedAtMs`.

| Method | Meaning | Payload fields |
| --- | --- | --- |
| `thread/started` | Thread created/loaded | `thread: Thread` |
| `thread/status/changed` | Idle ↔ active | `threadId`, `status: {type:"notLoaded"\|"idle"\|"systemError"} \| {type:"active",activeFlags[]}` |
| `thread/tokenUsage/updated` | Token accounting | `threadId`, `turnId`, `tokenUsage:{total,last,modelContextWindow}` — each of `total`/`last` = `{totalTokens,inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens}` |
| `thread/compacted`, `thread/closed`, `thread/archived`, `thread/deleted` | Lifecycle | `threadId` *(unverified)* |
| `turn/started` | Turn began | `threadId`, `turn: Turn` |
| `turn/completed` | Turn ended (any outcome) | `threadId`, `turn: Turn` — `turn.status ∈ completed \| interrupted \| failed \| inProgress`, `turn.error: TurnError\|null`, `turn.items` holds only the summary items (`itemsView:"summary"`) |
| `turn/diff/updated` | Aggregated unified diff for the turn | `threadId`, `turnId`, `diff: string` *(unverified)* |
| `turn/plan/updated` | TODO plan changed | `threadId`, `turnId`, `explanation`, `plan: TurnPlanStep[]` *(unverified)* |
| `item/started` | Any item begins | `item: ThreadItem`, `threadId`, `turnId`, `startedAtMs` |
| `item/completed` | Any item ends (final payload) | `item: ThreadItem`, `threadId`, `turnId`, `completedAtMs` |
| `item/agentMessage/delta` | Assistant text delta | `threadId`, `turnId`, `itemId`, `delta` |
| `item/reasoning/summaryTextDelta` | Reasoning summary delta | + `summaryIndex` |
| `item/reasoning/summaryPartAdded` | New summary block | `threadId`, `turnId`, `itemId`, `summaryIndex` |
| `item/reasoning/textDelta` | Raw reasoning delta | + `contentIndex` *(unverified — needs a model that streams raw CoT)* |
| `item/plan/delta` | Plan text delta | *(unverified)* |
| `item/commandExecution/outputDelta` | Live stdout/stderr | `threadId`, `turnId`, `itemId`, `delta` |
| `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta` | PTY / patch-apply output | *(unverified)* |
| `item/fileChange/patchUpdated` | Patch revised mid-flight | `threadId`, `turnId`, `itemId`, `changes: FileUpdateChange[]` *(unverified)* |
| `item/mcpToolCall/progress` | MCP progress text | `threadId`, `turnId`, `itemId`, `message` *(unverified)* |
| `serverRequest/resolved` | A server→client request is no longer pending (answered, or auto-resolved/cancelled) | `threadId`, `requestId` |
| `error` | Turn-level error | `error: TurnError {message, codexErrorInfo, additionalDetails}`, `willRetry: boolean`, `threadId`, `turnId` |
| `warning` / `guardianWarning` / `configWarning` / `deprecationNotice` | Advisory | `message`, `threadId?`, `summary`/`details` for `configWarning` |
| `mcpServer/startupStatus/updated` | MCP server lifecycle | `threadId\|null`, `name`, `status`, `error`, `failureReason` |
| `account/rateLimits/updated` | Rate limit snapshot | `rateLimits{limitId,primary,secondary,credits,planType,…}` |
| `rawResponse/completed`, `rawResponseItem/completed` | Raw upstream Responses payloads | very noisy; opt out |

`ThreadItem` discriminators (`item.type`): `userMessage`, `agentMessage`, `reasoning`, `plan`,
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`,
`subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`, `hookPrompt`,
`enteredReviewMode`, `exitedReviewMode`, `contextCompaction`.

Key item shapes:

- `agentMessage`: `{id, text, phase, memoryCitation}`
- `reasoning`: `{id, summary: string[], content: string[]}`
- `commandExecution`: `{id, command, cwd, processId, source, status: inProgress|completed|failed|declined, commandActions[], aggregatedOutput, exitCode, durationMs}`
- `fileChange`: `{id, changes: [{path, kind:{type:"add"|"update"|"delete"}, diff}], status: inProgress|completed|failed|declined}`
- `mcpToolCall`: `{id, server, tool, arguments, status, result, error, durationMs}`

---

## 4. Approvals (server → client **requests**, not notifications)

These arrive as JSON-RPC **requests with an `id`** and **must be answered** or the turn hangs.

| Request method | Params | Response |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `{threadId, turnId, itemId, startedAtMs, approvalId?, environmentId, reason?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?, availableDecisions}` | `{decision: CommandExecutionApprovalDecision}` |
| `item/fileChange/requestApproval` | `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}` | `{decision: FileChangeApprovalDecision}` *(unverified — not triggered in capture)* |
| `item/permissions/requestApproval` | `{threadId, turnId, itemId, environmentId, startedAtMs, cwd, reason, permissions}` | `{permissions: GrantedPermissionProfile, scope: PermissionGrantScope, strictAutoReview?}` *(unverified)* |
| `item/tool/requestUserInput` | `{threadId, turnId, itemId, questions[], autoResolutionMs}` | *(unverified)* |
| `mcpServer/elicitation/request` | MCP elicitation passthrough | *(unverified)* |
| `account/chatgptAuthTokens/refresh`, `attestation/generate` | only if you opt in via capabilities | *(unverified)* |

```ts
type CommandExecutionApprovalDecision =
  | "accept" | "acceptForSession" | "decline" | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } };

type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
```

**Live wire field not in the generated bindings:** the captured params included
`availableDecisions: [...]` — the exact decision variants the server will accept for *this* request.
Prefer rendering buttons from it over hard-coding the enum. Treat the bindings as a lower bound on
what the wire carries. (verified)

### Legacy (v1) approvals — do not implement

`execCommandApproval` (`ExecCommandApprovalParams` → `{decision: ReviewDecision}`) and
`applyPatchApproval` (`ApplyPatchApprovalParams` → `{decision: ReviewDecision}`) still exist in
`ServerRequest`. They use `conversationId`/`callId` and the snake_case `ReviewDecision` enum
(`"approved" | "approved_for_session" | {"denied":{rejection}} | "timed_out" | "abort" | …`). They are
the pre-`v2` surface. Realm should implement the `item/*` forms and reply to a legacy one only as a
defensive fallback.

---

## 5. Config knobs Realm should pass

All on `thread/start` (and overridable per-turn on `turn/start`):

| Param | Type | Notes |
| --- | --- | --- |
| `cwd` | `string` (absolute) | verified |
| `model` | `string` | e.g. `gpt-5.2`, `gpt-5.6-sol`. Enumerate with `model/list {}` → `{data:[{id, model, displayName, supportedReasoningEfforts[], defaultReasoningEffort, inputModalities[], isDefault}], nextCursor}` (verified) |
| `modelProvider` | `string` | key into `model_providers` (verified) |
| `approvalPolicy` | `"untrusted" \| "on-request" \| "never" \| {granular:{…}}` | verified for `on-request` |
| `sandbox` | `"read-only" \| "workspace-write" \| "danger-full-access"` | **`thread/start` takes the `SandboxMode` string**; the response echoes a structured `SandboxPolicy` object. `turn/start` instead takes `sandboxPolicy` as the structured object. Easy to get wrong. (verified) |
| `config` | `{ [dottedKey]: JsonValue }` | arbitrary `config.toml` overrides for this thread only |
| `baseInstructions` / `developerInstructions` | `string` | unverified |
| `ephemeral` | `boolean` | skip writing a rollout file — unverified |
| `sessionStartSource` | `"startup" \| "clear"` | **only these two values**; anything else is rejected (verified) |
| `personality`, `serviceTier`, `threadSource`, `approvalsReviewer` | | unverified |

Per-turn only on `turn/start`: `effort` (`ReasoningEffort`), `summary` (`ReasoningSummary`),
`outputSchema` (JSON Schema constraining the final assistant message), `clientUserMessageId`
(echoed back as `item.clientId` on the `userMessage` item — use it to correlate optimistic UI).

### Attaching an MCP server (verified end to end)

Pass it through `config` at `thread/start`; no restart, no user `config.toml` edit:

```json
→ {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{
     "cwd":"/abs/path",
     "config":{"mcp_servers":{"realm":{"command":"/usr/local/bin/node","args":["/abs/realm-mcp.mjs"]}}}}}

← {"method":"mcpServer/startupStatus/updated","params":{"threadId":"…","name":"realm",
    "status":"starting","error":null,"failureReason":null}}
← {"method":"mcpServer/startupStatus/updated","params":{"threadId":"…","name":"realm",
    "status":"ready","error":null,"failureReason":null}}

→ {"jsonrpc":"2.0","id":3,"method":"mcpServerStatus/list","params":{"threadId":"…"}}
← {"id":3,"result":{"data":[{"name":"realm",
     "serverInfo":{"name":"realm-tiny","version":"0.0.1"},
     "tools":{"realm_ping":{"name":"realm_ping","description":"ping","inputSchema":{…}}},
     "resources":[],"resourceTemplates":[],"authStatus":"unsupported"}],"nextCursor":null}}
```

Per-server fields: `command`, `args`, `env`, `cwd`, `url`, `bearer_token_env_var`, `http_headers`.

---

## 6. Auth / installed probe

Two layers, and **they disagree** — check both.

```bash
codex --version        # → "codex-cli 0.146.0"   (installed?)
codex login status     # → "Logged in using ChatGPT" (exit 0) | not-logged-in (nonzero)
```

Over the protocol, after `initialize`:

```json
→ {"jsonrpc":"2.0","id":2,"method":"getAuthStatus","params":{"includeToken":false,"refreshToken":false}}
← {"id":2,"result":{"authMethod":"chatgpt","authToken":null,"requiresOpenaiAuth":true}}
```

`authMethod: AuthMode | null` = `apikey | chatgpt | chatgptAuthTokens | headers | agentIdentity |
personalAccessToken | bedrockApiKey`. `null` ⇒ not logged in. (verified)

**Gotcha (verified the hard way):** both `codex login status` and `getAuthStatus` reported a healthy
ChatGPT login on a machine whose refresh token had been *revoked server-side*. The failure only
surfaced at `thread/start`:

```json
← {"id":2,"error":{"code":-32600,
    "data":{"reason":"cloudConfigBundle","errorCode":"Auth","statusCode":401,"action":"relogin",
            "detail":"Your access token could not be refreshed because your refresh token was revoked…"},
    "message":"failed to load configuration: …"}}
```

Recommended Realm probe: `initialize` → `getAuthStatus` for a fast negative, and treat
`error.data.action === "relogin"` on any request as "signed out, prompt re-login". `refreshToken:
true` on `getAuthStatus` would force the refresh during the probe and surface it earlier
*(unverified)*. Passing `includeToken: true` returns the bearer token — do not log it.

Login can also be driven in-protocol via `account/login/start` / `account/login/cancel` /
`account/logout`, with an `account/login/completed` notification *(unverified)*.

---

## 7. Session control

| Call | Params | Result | Notes |
| --- | --- | --- | --- |
| `thread/resume` | `{threadId, …same overrides as thread/start}` | `{thread:{…,turns:[…]}, model, cwd, approvalPolicy, sandbox, …}` | `thread.turns` is populated **only** on `thread/resume`/`fork`/`rollback`/`read`; it is `[]` everywhere else. Resuming a *running* thread rejoins it. (verified) |
| `turn/steer` | `{threadId, expectedTurnId, input[], clientUserMessageId?}` | `{turnId}` | `expectedTurnId` is a required precondition; a stale one fails with `{"code":-32600,"message":"no active turn to steer"}` (verified) |
| `turn/interrupt` | `{threadId, turnId}` | `{}` | verified |
| `thread/unsubscribe` | `{threadId}` | | stop receiving this thread's notifications *(unverified)* |
| `thread/list`, `thread/read`, `thread/fork`, `thread/archive`, `thread/rollback`, `thread/compact/start` | | | *(unverified)* |

**Interrupt semantics (verified).** `turn/interrupt` returns `{}` immediately. The stream then emits
`thread/status/changed{idle}` followed by `turn/completed` with `turn.status: "interrupted"` and
`turn.items: []`. Any in-flight `item/*` simply stops — you will **not** get an `item/completed` for
the item that was streaming. Close out partial items yourself on `turn/completed`.

---

## 8. Gotchas

1. **`v2/` in the bindings is not a wire prefix.** The generated files live under `v2/` and the docs
   talk about "v2 methods", but the on-the-wire method names are plain: `thread/start`, `turn/start`,
   `item/agentMessage/delta`. Nothing is literally namespaced `v2/…`. (verified)
2. **Two id spaces.** Server request ids start at `0` and overlap yours. (verified — §1)
3. **Generated bindings lag the wire.** `availableDecisions` on the approval request exists live but
   is absent from `CommandExecutionRequestApprovalParams.ts`. Parse permissively; never use an exact
   schema validator on inbound payloads. (verified)
4. **One process, many threads.** A single `codex app-server` multiplexes any number of threads
   concurrently; every notification is tagged with `threadId`. Realm should run **one** process and
   fan out by `threadId`, not one process per session. (verified — two live threads on one process)
5. **`sandbox` (string) on `thread/start` vs `sandboxPolicy` (object) on `turn/start`.** Different
   names, different types. (verified)
6. **`text_elements` is mandatory** on text input. Omitting it is a deserialize error. (verified)
7. **`sessionStartSource` accepts only `"startup"` or `"clear"`.** Passing a client name like
   `"vscode"` is rejected. Note the thread's `source` field defaulted to `"vscode"` in our capture —
   it is not derived from `clientInfo.name`. (verified)
8. **stderr is chatty and non-JSON.** Auth-refresh failures spew dozens of lines per second. Pipe it
   somewhere bounded. (verified)
9. **Backpressure.** `item/commandExecution/outputDelta` can be very high-rate. Coalesce before
   crossing the Electron IPC boundary.
10. **Config load happens per `thread/start`**, not at process start — a healthy `initialize` says
    nothing about whether a thread can start. (verified)
11. **Token usage fires per model round-trip**, so a tool-using turn emits it several times. Use
    `tokenUsage.total`. (verified)
12. The default shell tool is **`exec_command`** (PTY-based unified exec), not `shell`. Command
    strings arrive already wrapped: `/bin/zsh -lc '…'`. (verified)

---

## 9. Mapping to Realm `SessionEvent`

Realm's normalized union is `user_message | assistant_text | assistant_delta | thinking | tool_call |
tool_result | permission_request | permission_response | status | error | usage | init`
(`packages/contracts/src/session-events.ts`). Exact field names of each variant are **unverified** —
the repo file was unreadable from this sandbox — so treat the right column as shape guidance.

| Codex signal | Realm event | Suggested payload |
| --- | --- | --- |
| `initialize` response + `thread/start` response | `init` | `sessionId = thread.id`, `model`, `cwd`, `approvalPolicy`, `sandbox`, `codexHome`, `cliVersion` |
| `item/started` where `item.type === "userMessage"` | `user_message` | `text` from `content[].text`, `id = item.id`, correlate via `item.clientId` |
| `item/agentMessage/delta` | `assistant_delta` | `{itemId, delta}` — key the accumulator on `itemId` |
| `item/completed` where `item.type === "agentMessage"` | `assistant_text` | `{itemId, text}` — authoritative final text; replace the accumulated deltas rather than appending |
| `item/reasoning/summaryTextDelta` / `summaryPartAdded` / `textDelta` | `thinking` | `{itemId, delta, summaryIndex \| contentIndex}`; `item/completed(reasoning)` gives the final `summary[]`/`content[]` |
| `item/started` for `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` | `tool_call` | `{id: item.id, name: type-derived, input: command \| changes \| arguments}` |
| `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress` | `tool_result` (partial) or a dedicated streaming channel | `{id: itemId, chunk: delta}` |
| `item/completed` for the same item types | `tool_result` (final) | `{id, status, exitCode, aggregatedOutput \| changes \| result, durationMs, isError: status !== "completed"}` |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | `permission_request` | `{requestId: jsonrpcId, itemId, kind, command \| grantRoot \| permissions, reason, options: availableDecisions}` — **must** round-trip the JSON-RPC `id` |
| Realm's answer + `serverRequest/resolved` | `permission_response` | `{requestId, decision}`; emit on `serverRequest/resolved` too, so externally/auto-resolved requests clear the UI |
| `thread/status/changed`, `turn/started`, `turn/completed` | `status` | `idle \| active \| completed \| interrupted \| failed`, plus `turn.durationMs` |
| `thread/tokenUsage/updated` | `usage` | `{input, cachedInput, output, reasoningOutput, total}` from `tokenUsage.total`; `contextWindow = modelContextWindow` |
| `error` notification; `turn/completed` with `status:"failed"`; JSON-RPC `error` responses | `error` | `{message, retrying: willRetry, code: error.code, action: error.data?.action}` |
| `warning`, `configWarning`, `deprecationNotice`, `mcpServer/startupStatus/updated` | `status` (advisory) or drop | |
| `rawResponse/*`, `fuzzyFileSearch/*`, `thread/realtime/*`, `fs/changed` | drop | consider `optOutNotificationMethods` |

Implementation notes:

- Key streaming state on `(threadId, turnId, itemId)`. `itemId` alone is not unique across threads.
- On `turn/completed`, force-close every still-open item for that `turnId` — interrupts skip
  `item/completed`.
- Answer every server request, including ones you do not understand: reply with a JSON-RPC error
  (`-32601`) rather than dropping it, or the turn stalls.

---

## 10. Reproducing

`docs/dev/examples/codex-smoke.mjs` — self-contained, `node codex-smoke.mjs`, kills its child on
exit. Flags: `--cwd`, `--model`, `--prompt`, `--approval`, `--sandbox`, `--interrupt-after <ms>`,
`--probe-only`, `--raw`, `--timeout`.

To reproduce the streaming captures without a live account, point an isolated `CODEX_HOME` at a local
mock Responses endpoint:

```toml
# $CODEX_HOME/config.toml
model = "mock-model"
model_provider = "mock"

[model_providers.mock]
name = "Mock"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
requires_openai_auth = false
```

Then serve SSE `response.created` / `response.output_item.added` / `response.output_text.delta` /
`response.reasoning_summary_text.delta` / `response.output_item.done` / `response.completed`, with
`function_call` items named `exec_command` and `custom_tool_call` items named `apply_patch`.
Regenerate the type bindings any time the CLI updates: `codex app-server generate-ts --out <dir>`.
