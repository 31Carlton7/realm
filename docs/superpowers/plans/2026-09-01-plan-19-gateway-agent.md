# Realm Plan 19 — Native gateway agent

**Status:** design only. No code in this document has been written into the repo.

**Goal:** a fifth kind of agent that is not a CLI at all — Realm's own agent loop, talking straight to an OpenAI-compatible AI gateway (OpenRouter, Vercel AI Gateway, or any URL the user adds), with full tool calling, file and terminal access, MCP through Realm's existing gateway, and Realm's permission modes. A full peer to a Claude session, not a chat toy.

**Why this is different from every adapter Realm has:** the other four adapters *negotiate* with a process that owns the agent loop. This one *is* the agent loop. That inverts three things at once — Realm executes every tool (so permission modes become real rather than best-effort), Realm owns the message array (so conversation rewind becomes possible for the first time), and there is no child process (so the API key never leaves `realm-server`). Most of the design below falls out of those three facts.

---

## 1. Wire-format research

### 1.1 OpenRouter

| Question | Answer | Source |
|---|---|---|
| Base URL | `https://openrouter.ai/api/v1/` | [API overview](https://openrouter.ai/docs/api-reference/overview) |
| Auth | `Authorization: Bearer <OPENROUTER_API_KEY>` | ibid. |
| Chat | `POST /api/v1/chat/completions` — "request and response schemas are very similar to the OpenAI Chat API, with a few small differences" | ibid. |
| Streaming | `stream: true`, SSE. **May emit comment payloads that must be ignored** (`: OPENROUTER PROCESSING` keep-alives) | ibid. |
| Tool calling | OpenAI `tools` / `tool_choice` / `tool_calls`; parallel calls tracked by `index` in the delta; first delta of a call carries `id` + `function.name`, later deltas only `function.arguments` fragments | [tool calls / streaming](https://openrouter.ai/docs/agent-sdk/call-model/streaming) |
| Reasoning | request `reasoning: { effort: "max"\|"xhigh"\|"high"\|"medium"\|"low"\|"minimal"\|"none", max_tokens, exclude, enabled }`; response `message.reasoning` (plaintext) and `message.reasoning_details[]` (`reasoning.summary` / `reasoning.encrypted` / `reasoning.text`, with signatures). **`reasoning_details` must be passed back on subsequent turns for multi-turn tool use.** | [Reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens) |
| Cost per response | `usage: { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens, cache_write_tokens, audio_tokens }, completion_tokens_details: { reasoning_tokens }, cost, cost_details: { upstream_inference_cost }, is_byok }`. **Always present now** — `usage.include` / `stream_options.include_usage` are deprecated no-ops. On a stream it rides the **last SSE message**. | [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) |
| Models | `GET /api/v1/models` → `{ data: Model[], total_count, links.next }`. Query params `output_modalities`, `supported_parameters`, `sort`, `offset`, `limit` (max 1000). | [Models](https://openrouter.ai/docs/guides/overview/models) |
| Rate limits | Free variants (`:free`): 20 req/min, 50/day under $10 lifetime credit, 1000/day after. Paid models: no OpenRouter-imposed RPM; upstream limits still apply. `429` carries `X-RateLimit-*` and sometimes `Retry-After`; `402` means out of credit. `GET /api/v1/key` reports remaining credit. | [Limits](https://openrouter.ai/docs/api_reference/limits) |
| Attribution headers | `HTTP-Referer`, `X-Title` (aka `X-OpenRouter-Title`) — optional, for the public app leaderboard | [App attribution](https://openrouter.ai/docs/app-attribution) |

**Verified live, 2026-09-01, unauthenticated:** `GET https://openrouter.ai/api/v1/models` → `200`, `total_count: 419`, of which **353 list `tools` in `supported_parameters`**, spanning 45 provider prefixes. A representative row:

```json
{ "id": "anthropic/claude-fable-5.1",
  "canonical_slug": "anthropic/claude-fable-5.1-20260831",
  "name": "Anthropic: Claude Fable 5.1",
  "context_length": 1000000,
  "architecture": { "modality": "text+image+file->text", "input_modalities": ["text","image","file"], "tokenizer": "Claude" },
  "pricing": { "prompt": "0.00001", "completion": "0.00005", "input_cache_read": "0.00000025", "input_cache_write": "0.0000125" },
  "top_provider": { "context_length": 1000000, "max_completion_tokens": 128000, "is_moderated": true },
  "supported_parameters": ["include_reasoning","max_completion_tokens","max_tokens","reasoning","reasoning_effort","response_format","stop","structured_outputs","tools","verbosity"],
  "reasoning": { "mandatory": true, "supported_efforts": ["max","xhigh","high","medium","low"], "default_effort": "high" } }
```

Two things matter here beyond the obvious: **the catalog is public** (no key needed to populate the picker before the user has pasted one), and `supported_parameters` + `reasoning.supported_efforts` are exactly the two facts Realm needs to decide whether a model can be an agent at all and whether the effort chip should render.

### 1.2 Vercel AI Gateway

| Question | Answer | Source |
|---|---|---|
| OpenAI-compatible? | Yes, first-class. "The Chat Completions API implements the same specification as the OpenAI Chat Completions API." Also offers an Anthropic Messages-compatible surface and an OpenAI Responses surface. | [OpenAI Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions) |
| Base URL | `https://ai-gateway.vercel.sh/v1` | ibid. |
| Auth | `Authorization: Bearer <token>` — an AI Gateway API key, or a Vercel OIDC token (`VERCEL_OIDC_TOKEN`). API key wins if both present, *even if invalid*. | [Authentication and BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok) |
| Endpoints | `GET /models`, `GET /models/{model}`, `POST /chat/completions`, `POST /embeddings` | ibid. |
| Tool calling | Identical OpenAI shape — `tools[].function.{name,description,parameters}`, `tool_choice: 'auto' \| 'none' \| {type:'function',function:{name}}`, response `choices[].message.tool_calls[]`, `finish_reason: "tool_calls"` | [Tool calls](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/tool-calling) |
| Model ids | `provider/model`, e.g. `anthropic/claude-opus-5` | ibid. |
| Cost per response | Not on the completion body the way OpenRouter's is. The generation id is the response `id` (and is injected into the **first content chunk** on a stream); cost is looked up out-of-band via `GET /v1/generation`, or read from `providerMetadata.gateway.cost` when using the AI SDK. | [Usage and billing](https://vercel.com/docs/ai-gateway/observability-and-spend/usage) |
| Markup | None — "Tokens cost the same as they would from the provider directly, with zero markup, including with BYOK." | [AI Gateway](https://vercel.com/docs/ai-gateway) |

**Verified live, 2026-09-01, unauthenticated:** `GET https://ai-gateway.vercel.sh/v1/models` → `200`, **363 models**, of which **241 are `type: "language"` and 227 of those list `tools`**, across 26 provider prefixes. The response is *richer than the documented OpenAI shape* — the docs show only `{id,object,created,owned_by}` but the live body carries:

```json
{ "id": "alibaba/qwen-3-14b", "name": "Qwen3-14B", "owned_by": "alibaba",
  "context_window": 40960, "max_tokens": 16384, "type": "language",
  "tags": ["reasoning","tool-use"], "modalities": { "input": ["text"], "output": ["text"] },
  "supported_parameters": ["max_tokens","temperature","stop","tools","tool_choice","reasoning","include_reasoning"],
  "reasoning_options": [{ "type": "toggle" }], "knowledge": "2025-04",
  "zdr": "all", "no_training": "all", "deprecated_at": null,
  "pricing": { "input": "0.00000012", "output": "0.00000024" } }
```

Full key union across the catalog: `context_window, created, deprecated_at, description, id, interleaved, knowledge, max_tokens, modalities, name, no_training, object, owned_by, pricing, reasoning_options, regions, released, supported_parameters, supported_specifications, tags, temperature, type, video_capabilities, zdr`. `type` ranges over `language, image, embedding, video, speech, transcription, realtime, reranking` — **Realm must filter to `language`**, which the OpenRouter catalog expresses instead through `architecture.output_modalities`.

**Design consequence:** the two catalogs are *not* the same shape and neither is the documented OpenAI `/v1/models` shape. The normalizer has to be per-flavour, and it must degrade to `{ id, label: id }` for an unknown custom gateway that only returns the OpenAI minimum.

### 1.3 What a generic custom gateway needs

Everything both of the above have in common, and nothing else:

| Field | Why |
|---|---|
| `name` | display, and the picker rail label |
| `baseUrl` | joined with `/chat/completions`, `/models`. Must be normalized (strip trailing `/`) and **must be https or loopback** — a plaintext key over plaintext http to a LAN box is a footgun worth refusing |
| `apiKey` | the one secret |
| `authScheme` | `bearer` (default) \| `x-api-key` \| `none`. `none` covers Ollama / LM Studio / vLLM, which is the single most likely "custom gateway" a Realm user actually adds |
| `wireFormat` | `openai-chat` for v1. The enum exists from day one so the field is not a lie later; `anthropic-messages` is a named follow-up, not this build |
| `flavour` | `openrouter` \| `vercel` \| `openai-compatible`. **Only** selects the catalog normalizer and the cost-extraction rule — never the request shape. A custom gateway that happens to be an OpenRouter mirror can be told so |
| `extraHeaders` | `Record<string,string>`, secret-typed. Covers `HTTP-Referer`/`X-Title`, Azure `api-version`, org ids, LiteLLM tenant headers |
| `modelsPath` | default `/models`; overridable because vLLM and some proxies mount it elsewhere |

Deliberately **not** configurable: request body shape, streaming on/off, tool-call encoding. A gateway that cannot do OpenAI-shaped streaming tool calls cannot host a Realm agent, and pretending otherwise produces a session that silently never calls a tool — the exact failure mode `AGENT_HAS_MCP` exists to prevent.

### 1.4 Build the loop, or use the Vercel AI SDK?

**Recommendation: hand-roll the loop and the SSE reader. Do not take the AI SDK.**

The case *for* the AI SDK is real and should be stated first: `streamText` + `stopWhen(stepCountIs(n))` + `ToolLoopAgent` is a production-grade tool loop, it normalizes provider quirks Realm would otherwise discover one 400 at a time, and `@ai-sdk/openai-compatible` plus `createGateway` already speak both target gateways ([Loop control](https://ai-sdk.dev/docs/agents/loop-control), [AI Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway)).

Against, in descending weight:

1. **Double normalization.** Realm already has a normalized event union (`SessionEvent`) and three mappers that produce it. The AI SDK's `fullStream` is a *different* normalized union. Adopting it means mapping SSE → AI SDK parts → `SessionEvent`, and every provider-specific field Realm actually wants — `usage.cost`, `cost_details.upstream_inference_cost`, `reasoning_details`, `is_byok` — arrives only through `providerMetadata` escape hatches that are typed `unknown` anyway. The second layer buys nothing and costs a cast.
2. **The loop is not the hard part; the *gate* is.** The AI SDK executes tools for you. Realm must not: every mutating call has to suspend on a `permission_request` that round-trips through the RPC layer, the UI, and possibly a 15-minute human pause, and must remain cancellable mid-suspension. That is expressible with AI SDK approval hooks, but it means driving the SDK's loop from outside its own control flow — which is most of the loop's value gone, with the SDK's opinions still attached.
3. **Dependency weight.** `packages/adapters` currently has exactly **one** runtime dependency (`@anthropic-ai/claude-agent-sdk`). `ai` + `@ai-sdk/openai-compatible` + `@ai-sdk/gateway` is a fast-moving surface (v5→v6 was a breaking rewrite) in a package whose whole job is to be a stable boundary.
4. **The thing we'd be buying is small.** An SSE reader over Node 22's global `fetch` + `ReadableStream` is ~120 lines including the OpenRouter comment-payload rule and delta-index accumulation. The tool-call accumulator is ~40. Realm has written harder transports already (`jsonrpc/stdio.ts` is 197 lines and dispatches inbound frames by shape).

**Tradeoff accepted:** Realm owns the provider-quirk backlog. Mitigations that are part of this plan: a `live-gateway-check.ts` script in the same family as `live-skills-check.ts`, a recorded-SSE fixture suite per flavour, and the `flavour` field as the place quirks land so they never leak into the loop.

**Fallback if SSE proves fiddly in practice:** take the official `openai` npm package as *transport only* (it handles SSE framing, retries, and timeouts), keep the loop and the mapper hand-written, and cast for the non-standard fields. That is a one-file change from the recommended design, which is the point of keeping the wire behind an interface.

---

## 2. Where gateway config lives, and how the key stays out of agent processes

### 2.1 The precedent to follow

Realm's stated posture is set by the MCP gateway and is worth quoting rather than paraphrasing, because half of it is a *guarantee* and half of it is an *admission*, and this plan inherits both.

The guarantee, `apps/server/src/sessions/service.ts:490-494`:

```ts
// The ONLY MCP config any agent ever receives (W3): one `realm` gateway entry, minted fresh per
// session start by `gateway.register`. Third-party server endpoints, API keys and OAuth tokens never
// leave realm-server — an agent reaches them only by proxy, through the Bearer token below, which
// `onLog` (like every other log line here) never sees.
const mcpServers = [this.d.gateway.register(id, s.spaceId)];
```

The admission, `packages/contracts/src/mcp.ts:38`:

```ts
export const MCP_SECRET_STORAGE_NOTE =
  "Keys and headers are stored in plain text in Realm's database (~/Realm/realm.db) — not encrypted, not in the Keychain. …";
```

There is no Keychain, no `safeStorage`, no encryption anywhere in the repo; `oauth.ts:25` names `safeStorage` as an explicit follow-up. The note is a *tested UI requirement* (`mcp.test.ts:114-120` asserts its wording; `mcp-section.test.tsx` and `connections-page.test.tsx` assert it renders).

### 2.2 What this design does with that

**Storage.** A new `gateways` table, mirroring `mcp_servers` exactly, added as one appended migration string:

```sql
-- v18 — gateway agents (Plan 19). `secrets_json` holds the API key and any extra headers in ONE
-- column, plaintext, same posture and same honesty note as mcp_servers.secrets_json: a gateway has
-- one credential shape, never two. `models_json` caches the last successful catalog fetch so the
-- picker can render before a network round-trip; it is a cache and is never the source of truth for
-- what a model can do at call time. `scope` mirrors mcp_servers v11 so a gateway can be a profile
-- default or one space's own.
CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  flavour TEXT NOT NULL,            -- openrouter | vercel | openai-compatible
  wire_format TEXT NOT NULL DEFAULT 'openai-chat',
  auth_scheme TEXT NOT NULL DEFAULT 'bearer',
  models_path TEXT NOT NULL DEFAULT '/models',
  secrets_json TEXT NOT NULL DEFAULT '{}',
  models_json TEXT NOT NULL DEFAULT '[]',
  models_fetched_at INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL, scope_space_id TEXT, scope_profile_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
```

Per-space enablement rides the existing `settings` KV table with the same key idiom and the same polarity choices as MCP: `gateways.enabled:<spaceId>` (opt-in for space-scoped rows), `gateways.profileDisabled:<spaceId>` (opt-out for inherited rows).

**Containment.** `GatewayRow.secrets` is read in exactly one file — `packages/adapters/src/gateway/wire.ts`'s header builder, fed by a `GatewayConfigPort` the server implements. The rule is the same one `mcp/service.ts:52-55` states for `McpServerRow.secrets`, and it should get the same grep-enforcing test in `scoping.test.ts`. `GatewayService.toContract` projects the row down to `{ id, name, baseUrl, flavour, wireFormat, authScheme, hasKey: boolean, headerKeys: string[], scope, … }` — key **names** only, never values, exactly as `mcp/service.ts:365-382` does.

**Why the key genuinely cannot reach an agent process: there is no agent process.** This is the one place the new design is *stronger* than the existing guarantee rather than merely equal to it. `GatewayAdapter.start()` spawns nothing. The credential is used by a `fetch()` call inside `realm-server`, in the same process that already holds it and already holds every other user secret. Concretely:

- `StartOptions.env` is `{}` for this adapter. The key is never an environment variable, so it is never in a child's `/proc` environ, never in a crash dump of a CLI, never in `ps auxe`.
- `StartOptions.mcpServers` stays exactly one entry — the loopback gateway with its per-session bearer token — so the adapter's own MCP access is proxied on the same terms as Claude's.
- `onLog` never receives a header. Every wire error passes through `redact.ts`'s existing `credentialValues` / `redactValues` before becoming an `error` event. `credentialValues` already expands `"Bearer sk-xyz"` into both the full header value and the bare `sk-xyz`, which is exactly the 401-body shape these gateways return.
- The renderer never receives the key. `gateways.list` returns `hasKey: boolean`; editing shows a masked field that only transmits a value when the user types a new one — the same trick `mcp.update` uses.

**The admission carries over verbatim in spirit.** A new `GATEWAY_SECRET_STORAGE_NOTE` in `packages/contracts/src/gateways.ts`, returned on every `gateways.list` as `secretNote`, rendered by the add/edit form and the row, and pinned by a contract test the way `MCP_SECRET_STORAGE_NOTE` is. Do not weaken the wording. Suggested text:

> "Your gateway API key is stored in plain text in Realm's database (~/Realm/realm.db) — not encrypted, not in the Keychain. Anyone who can read that file, or any process running as you, can read it. The key never leaves realm-server: it is not passed to any agent process, and it is redacted from logs and error messages."

The second sentence is new and is *earned* — it is the one credential claim Realm can make about a gateway that it cannot make about a CLI's own config file.

**Named follow-up, not this build:** `safeStorage`-backed encryption for `gateways.secrets_json` *and* `mcp_servers.secrets_json` together. Doing it for one and not the other would produce a UI that has to explain two different postures.

---

## 3. The adapter

### 3.1 Shape

```
packages/adapters/src/gateway/
  gateway-adapter.ts     GatewayAdapter implements AgentAdapter
  wire.ts                fetch + SSE, chat/completions and models, per-flavour normalizers
  sse.ts                 SSE line reader (handles OpenRouter comment payloads)
  accumulate.ts          delta → { text, reasoning, toolCalls[] } accumulator, keyed by index
  map-stream.ts          createGatewayMapper(): accumulator events → SessionEvent[]
  tools.ts               the native tool schemas + dispatch
  policy.ts              tool → permission decision, given permissionMode + remembered allows
  thread.ts              the provider-shaped message array, and its invariants
  probe.ts               probeGateways(config): ProbeResult
```

Constructor injection, following the `ClaudeAdapter({ query })` precedent, so `packages/adapters` never imports from `apps/server`:

```ts
export class GatewayAdapter implements AgentAdapter {
  readonly kind = "gateway" as const;
  constructor(private readonly d: {
    /** Resolves a gateway id to its row INCLUDING secrets. Implemented in apps/server by GatewayService. */
    config: GatewayConfigPort;
    /** Loads/saves the provider-shaped message array for a providerSessionId. */
    threads: GatewayThreadPort;
    /** Optional: fetch override for tests. Defaults to globalThis.fetch. */
    fetch?: typeof fetch;
  }) {}
}
```

`start()` stays **synchronous** and runs its boot in a detached IIFE that never rejects, per the cross-adapter invariant every existing adapter honours.

### 3.2 The turn loop

```
send(m)
  ├ status: running
  ├ append { role: "user", content: [...text, ...images] } to thread
  └ loop, until finish_reason !== "tool_calls" or the step budget is hit:
      ├ POST /chat/completions { model, messages: thread, tools, tool_choice: "auto",
      │                          stream: true, reasoning?, max_tokens? }   [AbortSignal]
      ├ read SSE:
      │    delta.content            → assistant_delta         (ephemeral)
      │    delta.reasoning          → buffer                  (no streaming thinking variant exists)
      │    delta.reasoning_details  → buffer verbatim
      │    delta.tool_calls[i]      → accumulate by index; id/name on first, arguments concatenated
      │    usage (last message)     → buffer
      │    error object mid-stream  → error event, break
      ├ on stream end:
      │    assistant_text  (persisted; the ephemeral deltas are display-only)
      │    thinking        (if reasoning buffered and non-empty)
      │    usage           { costUsd, inputTokens, outputTokens, numTurns }
      │    append the assistant message to the thread VERBATIM, including
      │      tool_calls and reasoning_details
      ├ for each accumulated tool call, in wire order:
      │    tool_call event    { toolUseId: call.id, name, input: JSON.parse(args), parentToolUseId: null }
      │    gate(call) → allow | prompt | refuse            (§3.4)
      │    execute or refuse
      │    tool_result event  { toolUseId, content, isError }
      │    append { role: "tool", tool_call_id: call.id, content } to the thread
      └ if no tool calls: status: idle, persist thread, done
```

**Three invariants the loop must never violate**, each of which is a 400 from the provider if broken:

1. **Every `tool_calls[i].id` in an assistant message gets exactly one `{ role: "tool", tool_call_id }` reply, in the same request.** Denials count. Interruptions count. This is the single most common way a hand-rolled OpenAI loop corrupts itself, and Realm's permission gate makes denial the *normal* path, not an edge case.
2. **`reasoning_details` round-trips verbatim on Anthropic-family models.** OpenRouter's docs are explicit that this matters "particularly for tool-use scenarios where the model pauses to await external information". Dropping it silently degrades thinking quality on exactly the models a Realm user is most likely to pick.
3. **`assistant_delta` is display-only.** `PERSISTED_EVENT_TYPES` excludes it, so any streamed text must also land as a persisted `assistant_text` before the turn can end — the same rule ACP's `mapper.flush()` and Codex's `flushOpenRuns()` enforce.

**Step budget.** `stopWhen`-equivalent: a hard cap on tool rounds per `send`, default 60, surfaced as an `error` event with an honest message when hit ("stopped after 60 tool rounds without a final answer"). Not configurable in v1; a `maxTurns` constraint already exists on `AgentRunConstraintsSchema` for delegated runs and should feed this.

### 3.3 SessionEvent mapping, field by field

| Wire | `SessionEvent` | Notes |
|---|---|---|
| — (boot, after the first successful `/models` or first request) | `init` | `providerSessionId`: a ULID **Realm mints** (there is no server-side thread; this is the key into `gateway_threads`). `model`: the resolved model id, verbatim. `tools`: the real tool-name list the model was handed. `cwd`: `opts.cwd`. `instructionSources`/`availableModes`: absent. |
| `choices[0].delta.content` | `assistant_delta` | `messageId`: one id per assistant message, minted per request. |
| end of stream, buffered text | `assistant_text` | Same `messageId` as its deltas. |
| `delta.reasoning` / `reasoning_details[].text`\|`.summary` | `thinking` | Emitted once at stream end, not streamed — Realm's `thinking` payload has no delta variant. `reasoning.encrypted` is **never** emitted as `thinking` (it is not human text); it is kept in the thread only. |
| accumulated `tool_calls[i]` | `tool_call` | `toolUseId` = the provider's `call.id`. `input` = `JSON.parse(arguments)`; on a parse failure emit the `tool_call` with `input: {}` and immediately a `tool_result` `isError: true` explaining the malformed arguments, and feed that back as the tool message — do not throw, and do not guess. |
| tool execution result | `tool_result` | `content` is text; non-text MCP content blocks flatten as `[image]` etc., matching `map-sdk-message.ts:64-65`. |
| gate → prompt | `permission_request` | `requestId = newId()` (the Claude/Fake convention — there is no inbound JSON-RPC id to reuse). `suggestions` carries Realm-shaped rules (§3.4). |
| user answer | `permission_response` | Emitted on **every** resolution path, including synthetic denies on interrupt/dispose. |
| `usage` on the final SSE message | `usage` | OpenRouter: `costUsd = usage.cost` directly. Vercel: `usage.cost` is absent — see §3.7. `numTurns` = tool rounds in this `send`. |
| non-2xx, SSE `error`, abort-that-wasn't-ours | `error` + `status: error` | Message passed through `redactValues` first. |
| lifecycle | `status` | `running` on send; `waiting_permission` on `pending.size === 0` before insert; back on `pending.size === 0` after delete; `idle` at turn end; `ended` exactly once from the single shutdown path. |

**No new `SessionEvent` variants are required.** That is a deliberate constraint and it holds: the richest existing implementation's event set is a superset of what a chat-completions stream produces.

### 3.4 Tool calls → permission prompts

This is where the design earns "full peer", so it is worth being precise.

**Tool classes:**

| Class | Tools | `default` | `acceptEdits` | `bypassPermissions` | `plan` |
|---|---|---|---|---|---|
| read-only native | `read_file`, `glob`, `grep`, `list_dir` | run | run | run | run |
| edit native | `write_file`, `edit_file` | **prompt** | run | run | **not offered** |
| exec native | `bash` | **prompt** | **prompt** | run | **not offered** |
| MCP read-only | `BROWSER_READ_ONLY_TOOLS` via the gateway | run | run | run | run |
| MCP other | everything else the gateway lists | **prompt** | **prompt** | run | **not offered** |

Two rules carried over from existing precedent rather than invented:

- **`bash` keeps its prompt under `acceptEdits`.** `acceptEdits` means edits, not execution; conflating them is exactly the axis-conflation the `PERMISSION_MODES` comment already argues against for `plan`.
- **Read-only browser tools run free**, matching `claudeAllowedTools()` — and mutating browser tools stay double-gated, because Realm's own `BrowserPermissionBroker` will *also* prompt inside the MCP call. One prompt too many beats one too few.

**Plan mode is not a system-prompt request, it is a smaller tool list.** In `plan`, the edit/exec/mutating classes are simply absent from `tools[]`, and the system message says so. A model cannot violate a tool it was never handed. This makes `AGENT_SUPPORTS_PLAN_MODE.gateway = true` an honest entry rather than an aspirational one — and it is the only agent for which Realm can make that claim mechanically rather than by delegation.

**Round-trip.** Structurally identical to `ClaudeAdapter`'s, because that is the shape the UI already speaks:

```ts
const gate = async (call: ToolCall): Promise<"run" | "refuse"> => {
  const verdict = policy(call.name, opts.permissionMode, remembered);
  if (verdict !== "prompt") return verdict;
  const requestId = newId();
  if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
  events.push(sessionEvent("permission_request", {
    requestId, toolName: call.name, input: call.input,
    title: titleFor(call),                       // "Run this command?" / "Apply these edits?"
    suggestions: suggestionsFor(call),           // e.g. [{ type: "addRule", tool: call.name, scope: "session" }]
  }));
  const decision = await new Promise<PermissionDecision>((resolve) => {
    pending.set(requestId, { resolve });
    abort.signal.addEventListener("abort", () => {
      if (!pending.delete(requestId)) return;
      events.push(sessionEvent("permission_response", { requestId, decision: "deny" }));
      resolve("deny");
    }, { once: true });
  });
  if (pending.size === 0) events.push(sessionEvent("status", { status: "running" }));
  if (decision === "allow_always") remembered.add(call.name);
  return decision === "deny" ? "refuse" : "run";
};
```

`respondPermission` is the synchronous void resolver, no-op on an unknown id, emitting `permission_response` on every path — the invariant every existing adapter holds and the reason approval cards do not hang.

**A denial is a tool result, not an abort.** `{ role: "tool", tool_call_id, content: "The user denied this tool call." }`. The model gets to react — apologise, try a read-only route, ask a question — which is what a peer does. Aborting the turn on a denial would make `default` mode unusable.

**`allow_always` scope.** Session-scoped in memory for v1 (`remembered: Set<string>`), with the `suggestions` payload shaped so a later workstream can persist a space-scoped rule set without a contract change. Claude's `updatedPermissions` is the model to imitate here.

### 3.5 File, terminal and MCP tools

**MCP: free, via the existing gateway.** `StartOptions.mcpServers[0]` is the loopback `http` entry with a per-session bearer token. The adapter opens an MCP `Client` over `StreamableHTTPClientTransport` against it, calls `tools/list`, and converts each `{ name, description, inputSchema }` into an OpenAI function tool. This buys, at zero incremental design cost: `realm-browser`, `realm-agent` (`agent_run`, `agent_review`, `browser_agent_run`), every third-party MCP server the space enabled, per-space enablement, per-tool allowlists, the Activity call log, the delegation depth-1 recursion guard, and OAuth'd remote servers — all of it, because the gateway does not care who its client is.

Two mechanical notes: OpenAI function names must match `^[a-zA-Z0-9_-]{1,64}$`, and gateway tool names are `<server>__<tool>` (e.g. `realm-browser__browser_snapshot`) — already conformant, but a user-named MCP server could push past 64 chars, so the adapter needs a deterministic truncation-with-suffix map and must route back through it. And `@modelcontextprotocol/sdk` becomes a dependency of `packages/adapters` (it is already in the lockfile via `apps/server`).

**Files and terminal: a new in-process provider, not adapter-local code.** The gateway exposes no filesystem or shell tools today. The right home is a fourth `RealmToolProvider` — `realm-code` — registered in `app.ts` beside `realm-browser` and `realm-agent`, because that seam already has everything needed: the calling `sessionId` (hence the session's `cwd` and space), a permission path, the Activity log, per-space enablement, and the `sessionToolset` restriction hook.

```
realm-code__read_file    { path, offset?, limit? }
realm-code__write_file   { path, content }
realm-code__edit_file    { path, old_string, new_string, replace_all? }
realm-code__glob         { pattern, path? }
realm-code__grep         { pattern, path?, glob?, output_mode? }
realm-code__list_dir     { path }
realm-code__bash         { command, timeout_ms?, description }
```

Constraints, all following `agent-tools.ts` precedent:
- Every `path` is resolved against the session's environment `cwd` and refused if it escapes it — reuse ACP's `containedPath` (`acp-adapter.ts:181-189`) rather than writing a second containment check.
- Read size cap reusing `MAX_FS_READ_BYTES` (10 MiB).
- `bash` runs via `child_process.spawn` with the environment's `portEnv`, a default 120 s timeout, and combined output truncated with an explicit marker. It is **not** the interactive terminal pane — that is a user surface with a pty, and an agent writing into the user's visible terminal is a different feature.
- **`tools()` returns `[]` unless the calling session's `agentKind === "gateway"`.** The provider handles its own visibility exactly as `realm-agent` does for delegated children (`browser-agent.ts:270-281`). Handing `read_file` to a Claude session would give it a second, worse `Read` — and this needs no change to `SessionToolset`.

**Skills.** `AGENT_SKILL_SUPPORT.gateway` ships as `"unsupported"` in W1 and flips to `"injected"` in W9, once the mechanism exists: an index of the space's enabled skills in the system message plus a `realm-code__read_skill { id }` tool over `opts.skills.root`. The table must not promise the mechanism before the mechanism is there — that is the whole argument of the comment above it.

### 3.6 Interrupt, resume, and thread persistence

**Interrupt.** `abort.abort()` on the in-flight fetch, `denyAllPending()`, then — critically — **repair the thread before it is persisted**. A stream cut mid-turn leaves an assistant message whose `tool_calls` have no replies. Two valid repairs; recommend the informative one:

```ts
for (const call of unexecuted) thread.push({ role: "tool", tool_call_id: call.id,
  content: "Interrupted by the user before this ran." });
```

The alternative — strip the unexecuted `tool_calls` from the assistant message — also yields a valid thread but tells the model less. Whichever is chosen, **it must be chosen**, and a test must assert the thread is re-sendable after an interrupt, because this is the failure that only shows up on the user's *next* message.

**Resume is Realm's problem for the first time.** Every other adapter's `StartOptions.resume` names a thread the provider owns. Here there is no such thing. The provider-shaped message array is persisted in a new table:

```sql
CREATE TABLE gateway_threads (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider_session_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL);
```

**Do not rehydrate the thread from `session_events`.** They are a *display* projection: `thinking` drops `reasoning.encrypted` and its signatures, `tool_result` flattens non-text blocks to `[image]`, and no event carries a `tool_call_id` pairing. Reconstructing from them produces a conversation that is subtly not the one the model had — which is exactly the class of lie `AGENT_CONVERSATION_REWIND`'s comment refuses elsewhere. Persist the real array.

**Conversation rewind becomes possible.** `AGENT_CONVERSATION_REWIND.gateway = true` — the first `true` in that table. A checkpoint restore can truncate `messages_json` to the turn boundary it restored to, and the agent genuinely forgets. The table's comment ("a restore puts the FILES back and the agent still remembers writing them") gets a per-kind exception, and `checkpoints/service.ts:227` already reads the table for the sentence it shows, so there is one place to change.

### 3.7 `probe()` and cost

```ts
async probe(): Promise<ProbeResult> {
  const gws = await this.d.config.list();
  if (gws.length === 0) return { kind: "gateway", available: false, version: null, loggedIn: null,
    reason: "No gateway configured — add one in Connections.", models: null };
  const withKey = gws.filter((g) => g.hasKey || g.authScheme === "none");
  return { kind: "gateway", available: true, version: null,
    loggedIn: withKey.length > 0,
    reason: withKey.length ? null : "Gateways are configured but none has an API key.",
    models: await this.pinnedModels() };   // a SHORTLIST — see §5
}
```

`AGENT_CLI_COMMANDS.gateway = { install: null, login: null }` (there is nothing to install; the existing install-card renders the reason alone, which it already handles for `fake`). `AGENT_LOGIN_HINTS.gateway` points at Connections.

**Cost.** `usage.costUsd` on the `usage` event is the number the UI already shows. OpenRouter hands it over directly as `usage.cost`. Vercel does not put it on the completion body; the honest options are (a) `0` with the real token counts, or (b) compute from the cached `pricing.input`/`pricing.output` and mark it derived. Recommend **(a) for v1** — a fabricated cost that silently disagrees with the Vercel dashboard is worse than a zero, and the token counts are real. A `usage` payload field for cost provenance is a contract change worth avoiding until someone asks; the `GET /v1/generation` lookup is the correct fix and is a named follow-up.

---

## 4. Contract changes

### 4.1 The `AgentKind` question, answered

`AgentKindSchema` is `z.enum([...])` and there are **13 exhaustive `Record<AgentKind, …>` tables**, 8 of them in `presets.ts`, plus 452 `AgentKind`/`agentKind` references across 78 files. A dynamic, user-extensible key set does not fit that, and forcing it (widening to `string`, or a union with `z.string()`) breaks all 13 at compile time and — worse — converts every `AGENT_META[kind].label` into a runtime `TypeError` at nine high-traffic render sites.

**So do not put gateways in `AgentKind`.**

`AgentKind` gains exactly **one** member:

```ts
export const AgentKindSchema = z.enum(["claude", "codex", "acp:gemini", "acp:cursor", "fake", "gateway"]);
```

Gateway *identity* rides the axis that is already open. `Session.model` is `z.string().nullable()` with no validation anywhere — the same is true of `effort` and `permissionMode`. The contract already tolerates open-ended values on three of the four agent-config axes; `agentKind` is the outlier, and this design simply stops treating it as the place variability lives.

**Model reference encoding**, defined in `packages/contracts/src/gateways.ts` with a parser and a formatter and nothing else allowed to construct one:

```
gw:<gatewayId>:<modelId>
```

`gatewayId` is a ULID — 26 chars of uppercase Crockford base32, no colons, no slashes — so the value parses by taking the substring after the **second** colon, verbatim, to the end. That is not cosmetic: model ids contain both `/` (`anthropic/claude-opus-5`) and `:` (`deepseek/deepseek-r1:free`), and a naive `split(":")` corrupts every free-tier OpenRouter model.

```ts
export const GATEWAY_MODEL_PREFIX = "gw:";
export function formatGatewayModel(gatewayId: string, modelId: string): string;
export function parseGatewayModel(model: string | null): { gatewayId: string; modelId: string } | null;
```

### 4.2 The full change list

**`packages/contracts`**

| File | Change |
|---|---|
| `entities.ts:161` | `AgentKindSchema` += `"gateway"` |
| `presets.ts` `AGENT_MODELS` | `gateway: []` — empty **on purpose**, the same argument as `codex`/`acp:cursor`: the catalog is live, a hardcoded copy would only ever shadow the truth |
| `presets.ts` `DEFAULT_MODEL_LABEL` | `gateway: "Gateway"` |
| `presets.ts` `SELECTABLE_AGENT_KINDS` | += `"gateway"` |
| `presets.ts` `AGENT_SUPPORTS_PERMISSION_MODES` | `gateway: true` — and it is the only `true` that is mechanically enforced rather than delegated |
| `presets.ts` `AGENT_SUPPORTS_PLAN_MODE` | `gateway: true` |
| `presets.ts` `AGENT_CONVERSATION_REWIND` | `gateway: true` — **the first `true` in the table**; update its doc comment |
| `presets.ts` `AGENT_META` | `gateway: { label: "Gateway", icon: "zap" }` — a Hugeicon, not a brand mark, because the kind stands for no single vendor. Per-gateway branding is a picker concern (§5), not a kind concern |
| `presets.ts` `AGENT_CLI_COMMANDS` | `gateway: { install: null, login: null }` |
| `presets.ts` `AGENT_LOGIN_HINTS` | `gateway: "Uses an API key you add in Connections. The key stays in realm-server and never reaches a model or an agent process."` |
| `skills.ts` `AGENT_SKILL_SUPPORT` | `gateway: "unsupported"` in W1 → `"injected"` in W9 |
| `mcp.ts` `AGENT_HAS_MCP` | `gateway: true` |
| `memory.ts` `AGENT_MEMORY_CHANNEL` | `gateway: "systemPrompt"` — Realm writes the system message itself, the most direct channel any agent has |
| `attachments.ts` `DISPOSITIONS` | `gateway: { image: "inline", other: "path" }` |
| **new** `gateways.ts` | `GatewaySchema`, `GatewayFlavourSchema`, `GatewayWireFormatSchema`, `GatewayAuthSchemeSchema`, `GatewayModelSchema`, `GATEWAY_SECRET_STORAGE_NOTE`, `formatGatewayModel`, `parseGatewayModel`, `gatewaySupportNote` |
| `rpc.ts` `Methods` | `gateways.list` · `gateways.add` · `gateways.update` · `gateways.remove` · `gateways.test` · `gateways.setEnabled` · `gateways.models` (params `{ gatewayId, query?, limit }`, server-side search over the cache) · `gateways.refreshModels` · `gateways.pin` / `gateways.unpin` |
| `rpc.ts` `Events` | `gateways.changed` |

**`apps/desktop`**

| File | Change |
|---|---|
| `panes/session/suggestions.ts` `SUGGESTIONS` | `gateway: [...]` — the 13th exhaustive table, and the only one outside contracts |
| `panes/session/model-rows.ts` | gateway rows (§5) |
| `panes/session/ModelPicker.tsx` | async search for gateway rails (§5) |
| `panes/connections/` | gateway CRUD surface, following `McpSection.tsx` |

**Latent bug to fix while here.** `apps/server/src/delegation/agent-run.ts:303` restates the enum by hand inside the `agent_run` MCP tool's JSON Schema:

```ts
agentKind: { type: "string", enum: ["claude", "codex", "acp:gemini", "acp:cursor", "fake"], … }
```

It is not derived from `AgentKindSchema`, so adding a member will not error — it will silently reject `"gateway"` at the delegation boundary while every type check passes. Same at `browsers/browser-agent.ts:203`. Both should become `enum: [...AgentKindSchema.options]`. This is worth doing in W1 regardless of the rest of the plan.

### 4.3 Do existing persisted sessions break?

**No.** Five independent reasons, each verified:

1. **The DB has no constraint.** `agent_kind TEXT NOT NULL` (migration v3) with **zero `CHECK` constraints anywhere in the schema**. It already stores arbitrary strings.
2. **Adding an enum member is a widening.** Every value any existing row holds still parses. No row anywhere holds `"gateway"` until a user creates one.
3. **The read path does not validate.** `store/sessions.ts` casts rows with a bare `as Row[]`; `SessionSchema` is never `.parse()`d on read, and RPC *results* are not validated (only params are, at `rpc/server.ts:66`). So no old row can start failing.
4. **Every table gets its entry in the same commit**, enforced by `satisfies Record<AgentKind, …>`. TypeScript points at all 13; there is no silent `undefined` path.
5. **`AdapterRegistry` is already `Partial`.** A build without a gateway adapter registered degrades exactly as a build without `fake` does — `sessions.create` throws `AGENT_UNAVAILABLE`, which is the documented behaviour.

The one genuinely new breakage class is *forward* rather than backward: a session persisted with `agentKind: "gateway"` and a `model` of `gw:<id>:<model>` whose gateway row the user later **deletes**. Handle it explicitly — `gateways.remove` warns with the count of sessions referencing it, and a session whose gateway is gone starts with an `error` event naming the missing gateway rather than a cryptic 404. Do not cascade-delete sessions; the transcript outlives the config that produced it, which is the same rule `mcp_call_log.server_id ON DELETE SET NULL` already encodes.

---

## 5. The model picker

### 5.1 The problem, with numbers

Verified live on 2026-09-01: OpenRouter lists **419** models, **353** tool-capable, across 45 provider prefixes. Vercel lists **363**, of which **241** are `type: "language"` and **227** are tool-capable, across 26 prefixes. A user with both configured has ~580 rows. The current picker builds every row eagerly and synchronously in `modelRows()`, then filters client-side.

Rendering 580 rows would not merely be slow — it would destroy the thing the picker is good at. `model-rows.ts` states the design intent plainly: a row IS an `(agent, model)` pair, the current agent leads, and search matches the model name or the agent name because "both are on the row and users reach for either". At 580 rows, "reach for either" stops being true.

### 5.2 Four changes, in order of how much they touch

**1. Gateway rows are *pinned*, not enumerated.** `probe()` returns a shortlist, never the catalog:

- every model the user explicitly pinned (`gateways.pin`), plus
- the last ~8 distinct models used in gateway sessions in this space, minus duplicates, capped at 12.

A fresh gateway with no history seeds from a small curated set matched against the live catalog by id — the frontier models from each major provider prefix that are present *and* tool-capable — so the first-run picker is never empty. Anything not on the shortlist is reached through search.

**2. Search goes async, for gateway rails only.** `ModelPicker` already owns a `query` state and a `filterRows` call. Add: when the active rail is a gateway and `query.length >= 2`, debounce ~120 ms and call `gateways.models { gatewayId, query, limit: 50 }`. The server searches the cached catalog (id, name, provider prefix) and returns normalized `{ id, label, contextWindow, pricing, toolCapable }`. Results append below the pinned rows under a "Search results" heading. `modelRows()` **stays pure and synchronous** — gateway rows arrive as a separate, already-fetched array, so `model-rows.test.ts` keeps working unchanged.

**3. The rail becomes sources, not kinds.** Today `railKinds(rows)` is one entry per `AgentKind`. With gateways it must be one entry per *source*: Claude, Codex, Cursor, then one per configured gateway with its own name and icon. Minimal change — `ModelRow` gains two optional fields:

```ts
/** Overrides `agentLabel`/`icon` for a row whose provider is not its AgentKind — a gateway's own
 *  name and mark. Absent for every existing kind, so nothing about their rows changes. */
sourceKey?: string;    // "gw:<gatewayId>", used for rail identity and grouping
sourceLabel?: string;  // "OpenRouter"
```

`railKinds` becomes `railSources`, keyed on `sourceKey ?? kind`. Rows keep the existing two-line layout: model name over source name. The catalog carries `context_window` and `pricing`, so a dim right-aligned hint (`1M · $10/$50 per Mtok`) is nearly free and is exactly the disambiguation a 580-model space needs.

**4. Zero gateways gets a row, not silence.** `SELECTABLE_AGENT_KINDS` includes `"gateway"` unconditionally; when no gateway is configured, the kind contributes one row labelled "Add a gateway…" that opens Connections. This follows the file's own stated rule about cross-agent rows: *"they are marked rather than hidden: a picker that quietly drops Codex reads as a bug, not as a rule."*

### 5.3 Catalog caching

`gateways.models_json` + `models_fetched_at`. Refreshed on add, on edit of `baseUrl`/`flavour`, on explicit `gateways.refreshModels`, and lazily on read past a 6-hour TTL. Both target catalogs are **public and unauthenticated** (verified), so the cache can be warmed the moment the user types a base URL — before they have pasted a key — which makes the add-gateway form able to say "found 419 models, 353 of them tool-capable" as validation feedback. That is a much better first-run signal than a green checkmark.

Non-language and non-tool-capable models are filtered out **at normalization time**, not at render: an embedding model has no business in an agent picker, and a language model that cannot call tools would produce a session that silently never touches a file. Keep a "show all models" escape hatch in the gateway's own settings row for the user who knows what they want.

---

## 6. Work breakdown

Sequential workstreams, each ending green on all three gates (`SHELL=/bin/bash pnpm vitest run` · `pnpm -r typecheck` · `pnpm -r build`), one commit per workstream, following the ground rules of every plan since 09.

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| **W1** | **Contracts + schema** | `AgentKindSchema` += `gateway`; all 13 exhaustive tables; `contracts/gateways.ts` with the model-ref codec and `GATEWAY_SECRET_STORAGE_NOTE`; migration v18 (`gateways`, `gateway_threads`); `GatewaysStore`; derive the two hand-written JSON-Schema enums from `AgentKindSchema.options`. TDD: contract tests pinning the codec against ids containing `/` and `:`. | **2d** |
| **W2** | **Gateway service + RPC** | `GatewayService` (CRUD, scope, per-space enablement, `toContract` secret projection), the `gateways.*` methods and the `gateways.changed` event, catalog fetch + normalizers per flavour + TTL cache, `gateways.test`. TDD against recorded catalog fixtures from both live endpoints. | **3d** |
| **W3** | **The wire** | `wire.ts` + `sse.ts` + `accumulate.ts`: fetch, auth schemes, streaming, OpenRouter comment payloads, delta-index tool-call accumulation, usage extraction, redacted errors, abort. `scripts/live-gateway-check.ts` in the family of `live-skills-check.ts`. TDD against recorded SSE fixtures; the live script is the proof, not the test. | **3d** |
| **W4** | **The adapter, without native tools** | `GatewayAdapter` + `createGatewayMapper`: the turn loop, MCP tools via the loopback gateway client, the permission round-trip, interrupt with thread repair, thread persistence and resume, `probe`, `setOptions`, `dispose`. First end-to-end session. Test suite modelled on `claude-adapter.test.ts` with an injected `fetch`. | **5d** |
| **W5** | **`realm-code` provider** | The seven native tools, path containment, the `agentKind === "gateway"` visibility rule, `bash` with timeout and output truncation, Activity logging. Wired in `app.ts`. TDD in-process against a temp dir. | **5d** |
| **W6** | **Permission policy + modes** | `policy.ts`, the class table, `allow_always` remembering, plan mode as a filtered tool list, `bypassPermissions`, the browser double-gate interaction. Conversation rewind: `AGENT_CONVERSATION_REWIND.gateway = true` and the `checkpoints` truncation path. | **3d** |
| **W7** | **Model picker** | Pinned-shortlist probe, async gateway search with debounce, `sourceKey`/`sourceLabel` on `ModelRow`, `railSources`, price/context hints, the "Add a gateway…" empty row. RTL tests following `session-pane.test.tsx`. | **4d** |
| **W8** | **Connections UI** | Add/edit/remove gateway, masked key field, `secretNote` rendered (pinned by test), catalog-count validation feedback, per-space enablement, model pinning, delete warning naming referencing sessions. | **3d** |
| **W9** | **Skills, polish, docs** | Flip `AGENT_SKILL_SUPPORT.gateway` to `"injected"` with the system-prompt index + `read_skill` tool; context-window guard and the 400-on-overflow message; step-budget message; `README`/`CHANGELOG`; the `scoping.test.ts` grep rule for `GatewayRow.secrets`. | **3d** |

**Total: ~31 focused engineering days.** Calendar: **6-7 weeks** for one experienced developer at a realistic ratio, assuming the live gateways behave as documented.

**Honest risk premium on that number:** W4 is the estimate most likely to be wrong, in the direction of *worse*. It is the first place all four hard things meet — streaming, tool accumulation, the permission suspension, and thread validity — and the failure modes are provider-specific 400s that only appear on the second turn. Budget +2-3d there before anywhere else.

**W1-W4 is the smallest thing worth shipping to yourself**: a working gateway session with MCP tools but no file or shell access. It is a real proof and a bad product. Do not ship it to users; do dogfood it.

---

## 7. Risks and unknowns

**Tool-calling quality varies enormously across 353 models, and Realm will get blamed.** A Realm session on a small open-weights model that technically lists `tools` will loop, emit malformed JSON arguments, or ignore tool results. This is the single largest product risk and it is not an engineering bug. Mitigations: filter to tool-capable at normalization; make the first-run pinned shortlist frontier models only; and consider a quiet per-model health signal (malformed-argument rate) surfaced as a picker warning rather than a hidden block. **Unknown:** whether users will read a warning or file a bug.

**No provider-side context management.** Claude Code, Codex and Cursor all compact. This adapter does not, and window sizes in the catalog range from 40 960 to 1 000 000 tokens. A long session will hit a hard 400. v1 must at minimum: read `context_window` from the cache, estimate before sending, and fail with a message that names the number rather than passing through the provider's error. Real compaction (summarize-and-truncate) is a workstream of its own and is deliberately out of scope — but it will be requested within a week of shipping.

**`reasoning_details` round-trip is under-specified in practice.** The docs say to pass it back; they do not enumerate which providers reject a thread where it is missing, malformed, or stale. The `reasoning.encrypted` variant in particular carries signatures whose validity across a gateway retry to a *different* upstream provider is untested. **Unknown, needs a live experiment in W3:** what OpenRouter does when a thread's `reasoning_details` came from provider A and the request routes to provider B.

**Vercel gives no per-response cost.** `usage.costUsd` will be `0` for Vercel sessions in v1 while token counts are real. Users compare Realm's number to the Vercel dashboard. The `GET /v1/generation` lookup fixes it at the cost of a second request per turn; deferred, and the deferral is visible.

**Rate limits and 402s are a new error class.** OpenRouter's free tier is 20 req/min and a Realm agent turn is many requests. A `:free` model will 429 mid-turn. Needs `Retry-After`-aware backoff inside the loop and a distinguishable message for 402 (out of credit) versus 429 (slow down) — collapsing them into "request failed" will generate support load.

**Plaintext key storage.** Inherited posture, stated loudly, and now covering a credential with direct billing exposure — an OpenRouter key with auto-recharge is a different blast radius from an MCP server's read-only token. The honesty note is necessary and not sufficient. `safeStorage` should be scheduled, for both tables at once, and should probably not wait long.

**`bash` in a gateway session is a genuinely new capability surface.** Realm has never before executed a shell command on an agent's instruction *in its own process* — Claude and Codex run their own. Under `bypassPermissions` this is arbitrary code execution driven by an arbitrary user-chosen model over an arbitrary user-chosen gateway. Path containment does not contain a shell. The mitigations that exist are the permission modes and the fact that this is a local single-user app; that is the same posture as the existing agents, but it is worth writing down that the trust boundary moved.

**The `realm-code` visibility rule is a soft edge.** "Return `[]` unless `agentKind === "gateway"`" is enforced in one provider, not in the type system, and `sessionToolset`'s existing shapes (`string[]` / `{ exclude }`) do not express "only this kind". If a second in-process agent kind ever appears, revisit before copying the pattern.

**Model ids churn.** `deprecated_at` exists on the Vercel catalog and `expiration_date` on OpenRouter's; a pinned model can vanish. `ModelPicker.tsx:48` already handles the display half correctly (an unlisted id still shows its own name). The session-start half — a 404 on a retired model — needs a specific message pointing at the picker, not a raw provider error.

**Unverified assumptions that a W3 live check should settle**, listed so they are not mistaken for findings: that both gateways stream `tool_calls` deltas with a stable `index` across chunks for parallel calls; that OpenRouter's usage-bearing final SSE chunk arrives before `[DONE]` in all provider routes; that Vercel's generation-id injection into the first content chunk does not disturb a strict OpenAI-shaped parser; and that an OpenAI-shaped `image_url` data URL is accepted by both for vision models.
