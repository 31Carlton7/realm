# ACP (Agent Client Protocol) — implementer reference for Realm

Target: one generic ACP adapter in Realm covering Gemini CLI and Cursor, alongside the
existing Claude adapter.

**Verified against** `@zed-industries/agent-client-protocol@0.4.5` (npm `latest` as of
2026-08-22) — its `dist/*.d.ts`, `typescript/schema.ts`, `schema/schema.json` — plus live
stdio captures against `cursor-agent acp` (2026.07.25-e42b078), `gemini --acp` (0.56.0),
and a reference agent built on the SDK's own `AgentSideConnection`. Every JSON block below
is a **real captured frame**, trimmed; anything not observed on the wire or in the shipped
types is marked **unverified**.

---

## 1. Transport and framing

- **stdio, newline-delimited JSON-RPC 2.0.** One complete JSON object per `\n`-terminated
  line. **No `Content-Length` headers** — not LSP framing, not MCP framing.
- Fully bidirectional over the same pipe. Request-id spaces are **independent per
  direction** — in a live capture our `id:1` and the agent's `id:0` coexisted without
  collision. Never key a single map on `id` alone; key on direction.
- `stderr` is free-form agent logging. Never parse it; do drain it (a full pipe buffer
  deadlocks the child).

### Constructing `ClientSideConnection` in Node — the part that bites

`ndJsonStream(output, input)` takes **Web Streams**, and the argument order is
*(writable, readable)*. For a client driving a child process, `output` is the child's
**stdin** and `input` is the child's **stdout**. Backwards ⇒ silent hang, zero diagnostics.

```ts
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";

const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
const toAgent   = Writable.toWeb(child.stdin!);                               // we write here
const fromAgent = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>; // we read here

const conn = new acp.ClientSideConnection(
  (_agent) => realmClientHandler,          // our Client impl (agent → us)
  acp.ndJsonStream(toAgent, fromAgent),    // (writable, readable)
);
```

`Readable.toWeb`/`Writable.toWeb` are stable in Node 22. This must run in Electron's **main
process** — `node:stream/web` is unavailable in a sandboxed renderer. The package is
**ESM-only** (`"type":"module"`), so a CJS main process needs `await import()` or a bundler.

---

## 2. Handshake

Method names are exported as `AGENT_METHODS` / `CLIENT_METHODS`:

| Direction | Methods |
|---|---|
| Client → Agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel` (notification), `session/set_mode`, `session/set_model` (unstable) |
| Agent → Client | `session/update` (notification), `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` |

`PROTOCOL_VERSION = 1`. Negotiation: the client sends the latest version it supports; the
agent returns that same version if supported, otherwise the latest **it** supports. If the
client can't speak the returned version it must close the connection and tell the user.

### 2.1 `initialize`
```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":1,
    "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false}}}
```

Cursor's real reply:

```json
← {"jsonrpc":"2.0","id":1,"result":{
    "protocolVersion":1,
    "agentCapabilities":{"loadSession":true,
      "mcpCapabilities":{"http":true,"sse":true},
      "promptCapabilities":{"audio":false,"embeddedContext":false,"image":true},
      "sessionCapabilities":{"list":{}}},
    "authMethods":[{"id":"cursor_login","name":"Cursor Login",
      "description":"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}}
```

Gemini's reply has the same shape plus a non-0.4.5 `agentInfo`
(`{"name":"gemini-cli","title":"Gemini CLI","version":"0.56.0"}`); Cursor adds a non-0.4.5
`agentCapabilities.sessionCapabilities`. Treat unknown extras as ignorable — do not
validate strictly. Per-agent values are tabulated in §7.

Types (0.4.5):

```ts
interface InitializeRequest  { protocolVersion: number; clientCapabilities?: ClientCapabilities; _meta?: {...} }
interface ClientCapabilities { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean }
interface InitializeResponse { protocolVersion: number; agentCapabilities?: AgentCapabilities; authMethods?: AuthMethod[] }
interface AgentCapabilities  { loadSession?: boolean; mcpCapabilities?: McpCapabilities; promptCapabilities?: PromptCapabilities }
interface AuthMethod         { id: string; name: string; description?: string | null }
```

> The docs site (agentclientprotocol.com) already documents `auth.terminal`,
> `elicitation`, and `session.configOptions` on `ClientCapabilities`. **None of those are
> in npm 0.4.5.** Code against the shipped types; treat doc-only fields as unverified.

### 2.2 `authenticate`

Only needed when the agent rejects `session/new`. `params: { methodId: string }` — the `id`
of one of the advertised `authMethods`. Response is `{}` / void. **`auth_required` is
JSON-RPC code `-32000`** (`RequestError.authRequired`; `-32002` is `resource_not_found`).
Real Gemini rejection:
```json
→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/…/work","mcpServers":[]}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Gemini API key is missing or not configured."}}
```

**Realm should not call `authenticate` automatically.** Live-verified: Gemini's
`oauth-personal` blocks the JSON-RPC call while it opens a system browser and never returns
within a normal timeout. Surface `authMethods` as a card and let the user run the CLI's own
login (`cursor-agent login`, `gemini` interactive) out of band, then reconnect. Reserve
programmatic `authenticate` for non-interactive (API-key style) ids. **Unverified:**
whether any agent's `authenticate` is safely non-blocking.

### 2.3 `session/new` and `session/load`
```ts
interface NewSessionRequest  { cwd: string; mcpServers: McpServer[] }               // cwd MUST be absolute
interface NewSessionResponse { sessionId: string; modes?: SessionModeState | null; models?: SessionModelState | null }
interface LoadSessionRequest { sessionId: string; cwd: string; mcpServers: McpServer[] }
interface LoadSessionResponse{ modes?: SessionModeState | null; models?: SessionModelState | null }
```

`mcpServers` is **required, not optional** — send `[]`. Members are a union of
`{type:"http"|"sse", name, url, headers}` and `Stdio = {name, command, args, env}` where
`env: {name,value}[]` is an array of pairs, *not* a record.

`session/load` is gated on `agentCapabilities.loadSession`; both Cursor and Gemini advertise
`true` (verified live). The agent replays the entire prior conversation as `session/update`
notifications **before** returning, so Realm must use that burst to rehydrate the
transcript, not append it as new turns.

```json
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_ref_0001",
    "modes":{"currentModeId":"default",
      "availableModes":[{"id":"default","name":"Always Ask"},{"id":"yolo","name":"Accept Edits"}]}}}
```

---

## 3. Turn flow

Numbered happy path, all frames captured live:

1. `initialize` → capabilities + `authMethods` (§2.1).
2. `session/new` → `sessionId` (+ optional `modes`/`models`). On `-32000`, go to §2.2.
3. `session/prompt` — one request that stays pending for the whole turn:
   `→ {"id":3,"method":"session/prompt","params":{"sessionId":"sess_ref_0001","prompt":[{"type":"text","text":"read NOTES.txt"}]}}`

`prompt: ContentBlock[]`, where `ContentBlock` is the MCP-compatible union:
`{type:"text",text}` · `{type:"image",data,mimeType,uri?}` · `{type:"audio",data,mimeType}`
· `{type:"resource_link",uri,name,mimeType?,title?,description?,size?}` ·
`{type:"resource",resource}`. Only send `image`/`audio`/`resource` if
`agentCapabilities.promptCapabilities` allows it — **Cursor reports
`embeddedContext:false`**, so `@file` mentions must be `resource_link`, not inlined
`resource`.

4. Agent streams `session/update` notifications (§3.1) and may call back into us (§5).
5. Agent resolves the original request:
   `← {"id":3,"result":{"stopReason":"end_turn"}}`

`stopReason`: `end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`.

### 3.1 `session/update` variants

Envelope is always
`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"<variant>", …}}}`.

| `sessionUpdate` | Meaning | Payload fields |
|---|---|---|
| `user_message_chunk` | Echo of user input; in practice only during `session/load` replay | `content: ContentBlock` |
| `agent_message_chunk` | Streamed assistant text | `content: ContentBlock` |
| `agent_thought_chunk` | Streamed reasoning / thinking | `content: ContentBlock` |
| `tool_call` | A tool call is **created** | `toolCallId` (req), `title` (req), `kind?`, `status?`, `content?: ToolCallContent[]`, `locations?`, `rawInput?`, `rawOutput?` |
| `tool_call_update` | Mutation of an existing call; **fields are a sparse patch** | `toolCallId` (req); all others optional **and nullable**: `title?`, `kind?`, `status?`, `content?`, `locations?`, `rawInput?`, `rawOutput?` |
| `plan` | Full replacement of the todo/plan list | `entries: {content, priority:"high"\|"medium"\|"low", status:"pending"\|"in_progress"\|"completed"}[]` |
| `available_commands_update` | Slash commands the agent offers | `availableCommands: {name, description, input?}[]` |
| `current_mode_update` | Agent changed mode autonomously | `currentModeId: string` |

- `ToolCallStatus`: `pending` | `in_progress` | `completed` | `failed`.
- `ToolKind`: `read` | `edit` | `delete` | `move` | `search` | `execute` | `think` |
  `fetch` | `switch_mode` | `other`.
- `ToolCallContent`: `{type:"content", content: ContentBlock}` ·
  `{type:"diff", path, oldText: string|null, newText}` · `{type:"terminal", terminalId}`.
- `ToolCallLocation`: `{path: string, line?: number|null}` — drives "follow along" in the
  editor.
- `plan` is **not** incremental: replace the whole list each time.
- `tool_call_update` is a patch — merge into the existing call keyed by `toolCallId`;
  never treat a missing field as a clear. `null` explicitly clears.

Captured sequence (reference agent, trimmed to `params.update`):

```json
{"sessionUpdate":"plan","entries":[{"content":"Read NOTES.txt","priority":"high","status":"in_progress"},{"content":"Summarize","priority":"medium","status":"pending"}]}
{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"I should read the file."}}
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reading "}}
{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Read NOTES.txt","kind":"read","status":"pending","locations":[{"path":"/tmp/NOTES.txt","line":1}],"rawInput":{"path":"/tmp/NOTES.txt"}}
{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"in_progress"}
{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hello from realm smoke\n"}}],"rawOutput":{"bytes":23}}
{"sessionUpdate":"tool_call","toolCallId":"call_2","title":"Edit NOTES.txt","kind":"edit","status":"completed","content":[{"type":"diff","path":"/tmp/NOTES.txt","oldText":"a\n","newText":"b\n"}]}
```

There is **no token-usage variant in ACP 0.4.5.** Agents may smuggle counts through
`_meta` — per-agent and unverified.

---

## 4. Permissions

Agent → client **request** (captured live):

```json
← {"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{
    "sessionId":"sess_ref_0001",
    "toolCall":{"toolCallId":"call_1","title":"Read NOTES.txt","kind":"read"},
    "options":[
      {"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
      {"optionId":"allow-always","name":"Always allow reads","kind":"allow_always"},
      {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
```

```ts
interface RequestPermissionRequest { sessionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
interface PermissionOption {
  optionId: string;
  name: string;                                    // human label — render verbatim
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}
```

`toolCall` is a **`ToolCallUpdate`** — a sparse patch where only `toolCallId` is
guaranteed. Realm must merge it against the `tool_call` it already recorded to render a
useful card; never assume `title`/`kind`/`rawInput` are present.

Client → agent **response** — exactly two shapes, both **successful results**, never
JSON-RPC errors:

```json
→ {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
→ {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"cancelled"}}}
```

`cancelled` is reserved for "the turn was cancelled while this prompt was open" — a user
pressing *Deny* is `{"outcome":"selected","optionId":"<a reject_* option>"}`.

`optionId` values are agent-defined strings. Do **not** hardcode them; drive Realm's
buttons off `options[].kind` for styling and keyboard defaults, and echo back `optionId`.
`allow_always`/`reject_always` are hints about what the *agent* will remember — ACP has no
persistence API, so Realm's own sticky rules must be client-side auto-answers.

---

## 5. Client-side methods the agent calls on us

| Method | Gate | Mandatory? |
|---|---|---|
| `session/update` | none | **Yes** — always implement (notification, no reply) |
| `session/request_permission` | none | **Yes** — always implement |
| `fs/read_text_file` | `clientCapabilities.fs.readTextFile` | Only if declared |
| `fs/write_text_file` | `clientCapabilities.fs.writeTextFile` | Only if declared |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | `clientCapabilities.terminal === true` | Only if declared — **all five together** |

In the SDK's `Client` interface, `sessionUpdate` and `requestPermission` are required
members; every `fs/*` and `terminal/*` member is optional. Paths are always absolute.

```ts
// fs/read_text_file
{ sessionId, path, line?: number|null, limit?: number|null } -> { content: string }
// fs/write_text_file
{ sessionId, path, content: string }                         -> {}
```

Captured live after an `allow-once`:
`← {"id":1,"method":"fs/read_text_file","params":{"sessionId":"sess_ref_0001","path":"/…/NOTES.txt"}}`
→ `{"id":1,"result":{"content":"hello from realm smoke\n"}}`.

### Recommended minimum for Realm — `{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false}`

- **Declare both `fs` flags.** Two small handlers, and they buy Realm its value-add: reads
  see unsaved buffer state, writes land as reviewable diffs instead of silent disk
  mutations. Declaring `false` doesn't disable the capability — the agent just does its own
  direct disk I/O, invisibly.
- **Declare `terminal: false` initially.** That surface is five methods plus PTY lifecycle,
  output byte caps, and kill/release bookkeeping. Agents fall back to their own shell
  execution, which still surfaces as `tool_call` with `kind:"execute"`. Cost: render
  `ToolCallContent {type:"terminal"}` as a placeholder until terminals ship.
- Always implement a **catch-all returning `-32601`** for undeclared and unknown methods.
  Agents probe, and an unanswered request stalls the turn permanently.

---

## 6. Cancellation

`session/cancel` is a **notification** (no `id`, no reply): `{ sessionId }`. Contract:

- Client SHOULD preemptively mark the turn's unfinished tool calls as cancelled.
- Client **MUST** answer every in-flight `session/request_permission` with
  `{"outcome":{"outcome":"cancelled"}}`.
- Agent SHOULD abort model requests and tool invocations promptly, **MAY** keep sending
  `session/update` afterwards but MUST flush them *before* replying, and **MUST** still
  resolve the original `session/prompt` with `{"stopReason":"cancelled"}`.

So Realm must keep the `session/prompt` promise alive after cancelling and keep applying
updates until it settles. Don't tear the connection down on cancel — that loses final state
and orphans the child. **Unverified:** whether Cursor and Gemini honour the `cancelled`
stop reason in practice (blocked on login, §7).

---

## 7. Per-agent specifics

| | Gemini CLI | Cursor |
|---|---|---|
| Launch | `gemini --acp` | `cursor-agent acp` |
| Legacy flag | `gemini --experimental-acp` (deprecated alias, still accepted) | — |
| Version verified | 0.56.0 | 2026.07.25-e42b078 |
| `loadSession` | `true` | `true` |
| `promptCapabilities` | `image:true, audio:true, embeddedContext:true` | `image:true, audio:false, **embeddedContext:false**` |
| `mcpCapabilities` | `http:true, sse:true` | `http:true, sse:true` |
| `authMethods` | `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway` | `cursor_login` |
| Auth failure shape | JSON-RPC `-32000` on `session/new`: `{"code":-32000,"message":"Gemini API key is missing or not configured."}` | JSON-RPC `-32603` on `session/new`: `{"code":-32603,"message":"Internal error","data":{"message":"Failed to initialize session services"}}`; `authenticate` → `-32603` `{"details":"[unauthenticated] Error"}` |
| Extra fields | `agentInfo:{name,title,version}` on `initialize` (not in 0.4.5 types) | `agentCapabilities.sessionCapabilities:{list:{}}` (not in 0.4.5 types) |

**Login state on this machine (updated 2026-08-22, after re-auth):**

- **Cursor — WORKING, live-verified end to end.** `cursor-agent acp` completes a full turn:
  `session/new` → `session/prompt` → `agent_thought_chunk` + `agent_message_chunk` →
  `stopReason:"end_turn"`, followed by a successful `session/load` replay. This is the
  reference agent to develop the Realm ACP adapter against.
- **Gemini CLI — upgraded to 0.56.0, but the personal tier is discontinued.** `gemini --acp`
  now exists and `initialize` succeeds, but `session/new` returns:
  `{"code":-32000,"message":"This client is no longer supported for Gemini Code Assist for
  individuals. To continue using Gemini, please migrate to the Antigravity suite of
  products: https://antigravity.google"}`.
  This is a **product shutdown of the `oauth-personal` auth method, not a stale token** —
  re-logging in with a Google account cannot fix it. To use Gemini over ACP, authenticate
  via `gemini-api-key` (AI Studio key) or `vertex-ai` instead. Note the older global 0.1.9
  build had no ACP support at all and was shadowing the new one; it lived under a different
  nvm Node prefix (v22.11.0 vs the active v22.23.2), so `npm i -g` alone did not replace it.

§3.1/§4/§5 captures come from a reference agent built on the SDK's own
`AgentSideConnection` — byte-identical serialization to any compliant agent. Cursor's live
run confirms the overall turn sequencing; **per-variant field-level sequencing for
`tool_call`/`tool_call_update` remains unverified against a real agent** (the smoke prompt
did not trigger tool use).

**Live from Cursor, not present in the 0.4.5 types** — a `session_info_update` variant
carrying modes and models, both of which Realm should surface in its existing pickers:

- modes: `currentModeId:"agent"`, available `agent` / `plan` (read-only) / `ask` (no edits
  or command execution). These map cleanly onto Realm's permission-mode selector.
- models: `currentModelId:"composer-2.5[fast=true]"` plus ~35 entries including
  `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`, `grok-4.6[…]`,
  `gpt-5.6-sol[…]`, `gemini-3.1-pro[]`. Note the model id **encodes its options in
  brackets** — treat the whole string as an opaque id, do not parse or reconstruct it.

Other variants observed live: `available_commands_update`, `user_message_chunk`.

Cursor quirks: `~/.cursor/acp-sessions/<uuid>/` already holds ~900 entries, so `loadSession`
is backed by real on-disk history; `~/.cursor/acp-config.json` is empty (`{}`). Cursor
returns a generic `-32603 Internal error` for *any* session-startup failure, so Realm cannot
distinguish "not logged in" from "bad cwd" by code alone — surface `error.data` verbatim.

---

## 8. Mapping to Realm `SessionEvent`

`packages/contracts/src/session-events.ts` was not readable in this environment, so the
variant names below come from the task brief and **field names are indicative — reconcile
against the real type**.

| Realm `SessionEvent` | ACP source | Notes |
|---|---|---|
| `init` | `initialize` result + `session/new` result | Carry `sessionId`, `agentCapabilities`, `authMethods`, `modes`, `models`. Emit once per connection. |
| `user_message` | Realm's own send of `session/prompt`; also `session/update` `user_message_chunk` during `session/load` | On replay, tag as historical so the transcript isn't duplicated. |
| `assistant_delta` | `agent_message_chunk` | `content.type === "text"` → append `content.text`. Non-text blocks (`image`, `resource_link`) should become their own `assistant_text` rather than a delta. |
| `assistant_text` | Coalesced `agent_message_chunk` run | Flush the delta buffer on any non-`agent_message_chunk` update or on `session/prompt` resolution. |
| `thinking` | `agent_thought_chunk` | Same chunking rules as `assistant_delta`. Realm must be able to interleave — agents alternate thought and message chunks freely. |
| `tool_call` | `tool_call` | `toolCallId` → id, `title`, `kind`, `status`, `rawInput` → args, `locations` → file affordances. |
| `tool_result` | `tool_call_update` with `status` in `completed`/`failed` | Merge the sparse patch first. `content[]` carries the payload: `{type:"content"}` → text/image, `{type:"diff"}` → diff view, `{type:"terminal"}` → no-op while `terminal:false`. `rawOutput` → structured result. Intermediate `in_progress` patches should update the existing card, **not** emit a new `tool_result`. |
| `permission_request` | `session/request_permission` | Map `options[]` 1:1 to card buttons; keep `optionId` opaque; use `kind` for styling and default focus. Stash the JSON-RPC `id` — the response must go back on it. |
| `permission_response` | Our reply to `session/request_permission` | `{outcome:"selected", optionId}` on user choice; `{outcome:"cancelled"}` when the turn is cancelled with the prompt open. |
| `status` | `session/prompt` lifecycle, `plan`, `available_commands_update`, `current_mode_update` | Suggested `status` payloads: `running` on prompt send; `idle` with the `stopReason` on resolution; plan entries; command list; mode id. |
| `error` | JSON-RPC error responses, child spawn failure, child exit mid-turn, malformed ndjson | Preserve `code` **and** `data` — `-32000` should route to Realm's auth/login card, everything else to a generic error card. |
| `usage` | **No ACP source.** | ACP 0.4.5 has no token-usage message. Either don't emit `usage` for ACP-backed sessions, or scrape `_meta` per agent (**unverified, agent-specific, will break**). |

Additional adapter notes:

- `stopReason` has no dedicated Realm event; fold it into the terminal `status`. `refusal`
  and `max_tokens` are user-visible outcomes deserving distinct copy.
- Gate `session/load` emission behind a `replaying` flag so Realm rebuilds the transcript
  rather than appending to it.
- Buffer `assistant_delta` on a ~16–33 ms timer. Agents emit very small chunks; one IPC
  message per chunk will saturate Electron's bridge.

---

## 9. Smoke test

`docs/dev/examples/acp-smoke.mjs` — zero-dependency, self-contained, kills its child on
every exit path. Takes the agent command as argv:

```bash
node docs/dev/examples/acp-smoke.mjs cursor-agent acp
node docs/dev/examples/acp-smoke.mjs gemini --acp -- "Reply with exactly: ACP OK"
ACP_CWD=/path/to/repo ACP_TIMEOUT_MS=60000 node docs/dev/examples/acp-smoke.mjs cursor-agent acp
```

Logs every frame both directions, auto-answers permission prompts with the first
`reject_once` option, serves `fs/read_text_file`, refuses `fs/write_text_file`, and
exercises `session/load` when advertised. Verified **PASS** end-to-end against both the
reference agent and the real `cursor-agent acp`. Against `gemini --acp` it reaches a clean
`initialize` and then stops at the `-32000` personal-tier shutdown described in §7.
