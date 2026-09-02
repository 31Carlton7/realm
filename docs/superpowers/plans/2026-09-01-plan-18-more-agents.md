# Realm Plan 18 — More agents (and the ACP change that has to come first)

**Status:** design + survey, ready to implement. Every protocol claim below is either cited or came from a
**live ACP handshake run on this machine** (`initialize` + `session/new` over stdio, ACP `protocolVersion: 1`).
Live-verified rows are marked ✅live.

**The headline:** six of the requested agents speak ACP natively, so they are `AcpAgentSpec` entries rather than
adapters. But **one of them arrives half-broken against today's `AcpAdapter`**, and the reason generalises — ACP
has deprecated the `modes` and `models` fields the adapter reads. Fix that first (§2) or every subsequent add
inherits the same hole.

---

## 1. The survey

| Agent | Real binary | On this Mac? | ACP? | Protocol if not | Auth | Drivable? | Effort |
|---|---|---|---|---|---|---|---|
| **fx** (Vercel Labs) | `fx` (curl installer → `~/.local/bin`) | No (tested a `/tmp` copy, v0.0.7) | **Yes** — `fx acp` ✅live (caveat §4) | — | `fx login` (Vercel OAuth → `~/.fx/auth.json`); or `fx setup` / `AI_GATEWAY_API_KEY` | **Yes** | spec-entry |
| **opencode** | `opencode` | **Yes**, v1.18.13, logged in | **Yes** — `opencode acp` ✅live | — | `opencode auth login` | **Yes** | spec-entry |
| **grok** (xAI Grok Build) | `grok` (`npm i -g @xai-official/grok`) | No | **Yes** — `grok agent stdio` ✅live | — | `grok login` OAuth → `~/.grok/auth.json`; or `XAI_API_KEY` | **Yes** | spec-entry |
| **Pi coding agent** ("pi code") | `pi` (`@earendil-works/pi-coding-agent`) | No | Not natively; 3rd-party `pi-acp` bridge | Native `pi --mode rpc` — LF-delimited JSONL over stdio | `/login` subscription or `--api-key` per provider | **Partial** | small adapter — **but no permission model at all** (§4) |
| **Command Code** ("command code") | `cmd` / `cmdc` (`npm i -g command-code`) | No | **No** — 0 hits for `acp` in its shipped `dist/` | Headless `-p/--print --output-format json`, NDJSON `AgentEvent` frames | `cmd login` | **Partial** (one-way stream) | large adapter (§4) |
| **OpenClaw** | `openclaw` | **Yes**, 2026.3.31, `/opt/homebrew/bin/openclaw` | **Yes, but** — `openclaw acp` bridges to a running Gateway, not a native ACP runtime ✅live | — | Gateway token + a provider key in the gateway | **Partial** | not recommended (§4) |
| **Amp** (Sourcegraph) | `amp` (`@ampcode/cli`) | No | **No** native; registry's `amp-acp` is third-party | `amp -x --stream-json` + `--stream-json-input` | `AMP_API_KEY` | Partial | small-to-medium adapter |
| **Aider** | `aider` (pip) | No | **No** native; community `aider-acp` shells out per turn | `--message` / `--yes`, prose output | provider keys | **No** | not viable |
| **Cline** | `cline` (`npm i -g cline`) | No | **Yes** per registry — `cline --acp`. ⚠️ could NOT reproduce locally | — | Cline account / BYO keys | Likely | spec-entry (verify first) |
| **Goose** (Block) | `goose` (`brew install block-goose-cli`) | No (tested v1.48.0 in `/tmp`) | **Yes** — `goose acp` ✅live | — | `goose configure` (needs `GOOSE_PROVIDER`) | **Yes** | spec-entry |
| **Qwen Code** | `qwen` (`@qwen-code/qwen-code`) | No | **Yes** — `qwen --acp` ✅live | — | `qwen` OAuth, or `OPENAI_API_KEY` | **Yes** | spec-entry |
| **GitHub Copilot CLI** | `copilot` (`@github/copilot`) | No (`gh` is installed, not `copilot`) | **Yes** — `copilot --acp` ✅live | — | `copilot login`; handshake ships `_meta["terminal-auth"]` with the exact login argv | **Yes** | spec-entry |

Sources: [ACP registry](https://github.com/agentclientprotocol/registry) · `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` ·
[agentclientprotocol.com/get-started/agents](https://agentclientprotocol.com/get-started/agents) ·
[fx.sh/docs/using-fx/cli](https://fx.sh/docs/using-fx/cli) · [fx.sh authentication](https://fx.sh/docs/getting-started/authentication) ·
[docs.x.ai/build/overview](https://docs.x.ai/build/overview) · [zed.dev/acp/agent/grok-build](https://zed.dev/acp/agent/grok-build) ·
[zed.dev/acp/agent/goose](https://zed.dev/acp/agent/goose) · [docs.openclaw.ai/cli/acp](https://docs.openclaw.ai/cli/acp) ·
[commandcode.ai/docs/reference/cli](https://commandcode.ai/docs/reference/cli) · [aider.chat/docs/scripting.html](https://aider.chat/docs/scripting.html) ·
[ampcode.com/news/streaming-json](https://ampcode.com/news/streaming-json)

### Identity resolutions worth recording

Three of the six freeform names resolved to something other than the obvious guess. Written down so nobody
re-derives them wrongly later:

- **"fx.sh"** = [fx](https://fx.sh) by **Vercel Labs** — a Zig coding agent, Apache-2.0,
  [github.com/vercel-labs/fx](https://github.com/vercel-labs/fx). **Not** the JSON-viewer `fx` (`antonmedv/fx`),
  a different tool with the same name.
- **"pi code"** = the **Pi coding agent**, [pi.dev](https://pi.dev), repo `earendil-works/pi` (formerly
  `badlogic/pi-mono`), npm `@earendil-works/pi-coding-agent`, binary `pi`. **Not** Inflection AI's Pi chatbot.
  The older npm name `@mariozechner/pi-coding-agent` still shows in search results; `@earendil-works/…` is current.
- **"command code"** = **Command Code** ([commandcode.ai](https://commandcode.ai)), a Node CLI. **Nothing to do
  with Cohere.** Cohere's actual coding play is *North Mini Code*, a 30B-A3B open-weights **model**
  (Apache-2.0, HF `CohereLabs/North-Mini-Code-1.0`) with no agent binary — it is meant to run *inside* other
  scaffolds, and their own eval used SWE-Agent, Mini-SWE-Agent and **OpenCode**. If Cohere is wanted in Realm,
  the route is a model behind opencode or a gateway (Plan 19), not a new adapter.
- **"openclaw"** = [OpenClaw](https://openclaw.ai), a self-hosted **multi-channel AI gateway** (npm `openclaw`,
  MIT, OpenClaw Foundation) bridging WhatsApp / Telegram / Discord / Signal / iMessage to an agent runtime.
  Already installed here at 2026.3.31 (npm latest 2026.8.2, so ~5 months stale). Identified with certainty —
  and it is not a coding-agent CLI. See §4.

---

## 2. Do this first: ACP deprecated `modes` and `models`

This is the most consequential finding in the survey and it affects the adapter Realm already ships.

[ACP Session Config Options](https://agentclientprotocol.com/protocol/session-config-options) says verbatim:
*"If an Agent provides `configOptions`, Clients SHOULD use them instead of the `modes` field. Modes will be
removed in a future version of the protocol."* The replacement RPC is:

```
session/set_config_option { sessionId, configId, value }
```

plus a `session/update` notification with `sessionUpdate: "config_option_update"`.

`AcpAdapter` reads only `session.modes.availableModes` / `session.models.availableModels` and calls
`session/set_mode` / `session/set_model`; `probe.ts:parseAcpModels` reads only `models.availableModels`.
Live evidence of the split, measured here:

- **opencode** `session/new` returns **`configOptions` only** — no `modes`, no `models`:
  ```json
  {"sessionId":"ses_…","configOptions":[
    {"id":"model","category":"model","type":"select","currentValue":"opencode/big-pickle","options":[…6 models…]},
    {"id":"mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build"},{"value":"plan"}]}]}
  ```
  → With today's adapter opencode gets **no Plan chip and no model picker**. It still prompts, streams and
  does permissions fine, so the failure is silent degradation rather than a crash — the worst kind.
- **Copilot** dual-emits both `modes` *and* `configOptions` (its mode ids are URLs, e.g.
  `https://agentclientprotocol.com/protocol/session-modes#plan`), so it works today via `acpPlanMode`.
- **Grok** puts its catalog in `initialize._meta.modelState.availableModels`, not on `session/new` — so
  `modelCatalog: true` would find nothing for it. Leave it off.

**The change:** teach `AcpAdapter` to prefer `configOptions` (`category: "mode"` / `"model"`) and fall back to
`modes`/`models`, with `session/set_config_option` as the write path when the read came from `configOptions`.
`parseAcpModels` gains the same preference. One well-scoped change that unlocks correct behaviour for every
agent below and future-proofs against the deprecation landing.

## 3. Second thing to know: "spec-entry" is not literally one line

`AgentKindSchema` (`packages/contracts/src/entities.ts:161`) is a closed `z.enum`, and **12 exhaustive
`Record<AgentKind, …>` tables** fail to compile until filled: `attachments.ts:101`, `mcp.ts:148`
(`AGENT_HAS_MCP`), `memory.ts:106`, `skills.ts:67`, and six in `presets.ts` (`:65, :80, :96, :120, :175, :216,
:234, :243`), plus `SELECTABLE_AGENT_KINDS` (`presets.ts:75`). So one new ACP agent ≈ 14 mechanical edits plus
the `app.ts` spec. Cheap, but not free — and the compiler names every site, so nothing is silently missed.

Note the same latent bug Plan 19 flags: `delegation/agent-run.ts:303` and `browsers/browser-agent.ts:203`
restate the enum by hand in JSON Schema. They will not error on a new member — they will silently reject it at
the delegation boundary. Derive both from `AgentKindSchema.options` as part of this plan.

## 4. Paste-ready specs

For `defaultAdapters()` in `apps/server/src/app.ts`. All `args` confirmed by a live `initialize` unless noted.

```ts
"acp:opencode": new AcpAdapter({
  kind: "acp:opencode",
  bin: process.env.REALM_OPENCODE_BIN ?? "opencode",
  args: ["acp"],
  label: "OpenCode",
  loginHint: "Run `opencode auth login`.",
  // No `models` on session/new — opencode reports its catalog via ACP `configOptions`
  // (category "model") instead, which parseAcpModels does not read. Leave modelCatalog off until §2 lands.
}),

"acp:copilot": new AcpAdapter({
  kind: "acp:copilot",
  bin: process.env.REALM_COPILOT_BIN ?? "copilot",   // npm i -g @github/copilot
  args: ["--acp"],
  label: "GitHub Copilot",
  loginHint: "Run `copilot login`.",
  // session/new returns modes {agent, plan, autopilot} with URL-shaped ids — acpPlanMode works today.
  // Also returns configOptions with a "model" category; no top-level `models`, so no catalog yet.
}),

"acp:goose": new AcpAdapter({
  kind: "acp:goose",
  bin: process.env.REALM_GOOSE_BIN ?? "goose",       // brew install block-goose-cli
  args: ["acp"],
  label: "goose",
  loginHint: "Run `goose configure` to pick a provider and set its API key.",
  // Advertises mcpCapabilities {http:true, sse:false} — acpMcpServers already honours that.
}),

"acp:qwen": new AcpAdapter({
  kind: "acp:qwen",
  bin: process.env.REALM_QWEN_BIN ?? "qwen",         // npm i -g @qwen-code/qwen-code
  args: ["--acp"],                                    // registry also passes --experimental-skills
  label: "Qwen Code",
  loginHint: "Run `qwen` once to sign in with your Qwen account, or set OPENAI_API_KEY.",
}),

"acp:grok": new AcpAdapter({
  kind: "acp:grok",
  bin: process.env.REALM_GROK_BIN ?? "grok",         // npm i -g @xai-official/grok
  args: ["agent", "stdio"],
  label: "Grok",
  loginHint: "Run `grok login` (browser sign-in, needs SuperGrok or X Premium), or set XAI_API_KEY.",
  // Models live in initialize._meta.modelState, NOT session/new.models — modelCatalog would find nothing.
}),

"acp:fx": new AcpAdapter({
  kind: "acp:fx",
  bin: process.env.REALM_FX_BIN ?? "fx",             // curl -fsSL https://fx.sh/setup.sh | bash
  args: ["acp"],
  label: "fx",
  loginHint: "Run `fx login` (Vercel), or `fx setup` for an AI Gateway API key, or set AI_GATEWAY_API_KEY.",
}),
```

**fx caveat, measured.** fx gates the handshake itself. Unauthenticated, `initialize` returns
`{"code":-32600,"message":"fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an
API key, or set AI_GATEWAY_API_KEY."}` — it fails *before* `session/new` and never publishes `authMethods`.
`acpBootFailureMessage` handles this correctly (a `JsonRpcCallError`, so the message is echoed plus the
loginHint), but it lands on the "could not start a session" branch rather than the auth branch, and
"Sign-in methods it offers:" will be empty. This is also why fx is absent from the ACP registry — that registry
only admits agents returning valid `authMethods`. **fx's post-auth behaviour — `session/prompt`, tool-call
updates, `session/request_permission` — is unverified.** Sign in and smoke-test a real turn before offering it.

**Cline caveat.** Registry-listed as `npx cline@3.0.60 --acp` and CI-verified upstream, but a temp-dir install
of `cline@3.0.60` produced no output on darwin-arm64 for `--acp`, `--help` or `--version` (the 88 MB
`bin/.cline` binary exits silently). Verify with a real global install before shipping the spec.

**Good news on error copy.** Unauthenticated `session/new` returns `-32000` for both Grok
(`{"message":"Authentication required","data":"no auth method id provided"}`) and Qwen
(`"Authentication required: Use Qwen Code CLI to authenticate first."`) — exactly the `AUTH_REQUIRED` code
`acp-adapter.ts:46` already special-cases. Both produce good copy with zero extra work.

**opencode operational note.** `opencode acp` against the user's *real* state dir crashes with
`Error: no such column: name` (a stale sqlite migration in the installed 1.18.13); it works cleanly against a
fresh `XDG_DATA_HOME`. An `opencode upgrade` will likely clear it, but Realm should surface that stderr rather
than swallow it.

## 5. The non-ACP agents — what an adapter would cost, and whether to pay

**Pi coding agent — the interesting one, with a hard blocker.** Pi's own docs state plainly: *"No permission
popups. Run in a container, or build your own confirmation flow with extensions."* Pi has no permission system;
tools just run. Its `--mode rpc` is otherwise excellent: strict LF-delimited JSONL over stdio,
`prompt`/`steer`/`follow_up`/`abort` with request/response `id` correlation, `tool_execution_start|update|end`
with `toolCallId`, `message_update` streaming, `set_model`/`get_available_models`, `fork`/`switch_session`.
That maps onto `SessionEvent` in a clean ~400-line adapter. But Realm's permission card would have nothing to
bind to: the only gate is `extension_ui_request`/`extension_ui_response` (a `select`/`confirm` sub-protocol)
which fires only if *you write a Pi extension* that intercepts tools and calls `ctx.ui.confirm()`. A real
integration is therefore: bespoke RPC adapter **plus** a Realm-authored Pi extension. The community `pi-acp`
bridge (`svkozak/pi-acp`) is a spec-entry away but cannot invent permission requests Pi never emits — you would
inherit "everything auto-approves". **Confidence: high that streaming and tool visibility work; medium that the
permission story is worth the extension.**

**Command Code — one-way stream, no permission channel.** Its headless surface is close to Claude Code's:
`-p/--print --output-format json` emitting *"newline-delimited AgentEvent frames + final result"*,
`--max-turns` (exit 8 on cap), `--permission-mode <default|standard|plan|auto-accept|dont-ask>`,
`--auto-accept`, `--plan`, `--resume`, `--fork-session`, `--add-dir`, and an `ask_user_question` tool.
**But the stream is one-way.** Grepping the shipped bundle: zero hits for `input-format`, `stream-json`,
`permission-prompt-tool`, `can_use_tool`, `canUseTool`, or `permission_request`. There is no stdin control
channel — permission policy is fixed at launch. An adapter could give streaming text and tool-call visibility,
but Realm's permission cards would be dead: you would launch with `auto-accept`/`dont-ask` and have to say so.
**Confidence: high it works as an auto-approve integration; low that it can honour Realm's permission model.**
Wait for a stdin channel.

**Amp — genuinely feasible, ~Codex-shaped.** No native ACP (the registry's `amp-acp` is a third-party bridge by
`tao12345666333`, not Sourcegraph). Amp's own surface is `amp -x --stream-json` with `--stream-json-input` for
multi-turn, streaming System/Assistant/Result types with tool usage visible, and a permissions plugin
supporting `allow`/`ask`/**delegate-to-external-program**. Because `--stream-json-input` exists *and* the
external-program delegation is a real hook Realm could register itself as, a bespoke adapter can honour
permission cards — unlike Command Code. **Confidence: medium-high.** Try the third-party bridge first as a
cheap experiment.

**OpenClaw — hold.** It ships `openclaw acp`, and the docs are explicit that it is *"a Gateway-backed ACP
bridge, not a full ACP-native editor runtime."* [The docs](https://docs.openclaw.ai/cli/acp) list as
**unsupported**: *per-session MCP servers* and *client filesystem and terminal methods* — which is most of what
Realm's ACP adapter relies on (`acpMcpServers` hands every session the gateway's `http` MCP entry, and
`serveFs` implements `fs/read_text_file` / `fs/write_text_file`). Tool streaming and exec approvals are only
*partial*, and `loadSession` replays history only for bridge-created sessions. It also needs a running Gateway
— confirmed here: the bridge dies with `connect ECONNREFUSED 127.0.0.1:18789` when none is up. Adding it would
technically connect, but Realm's MCP gateway and permission cards would both be degraded, and the "session"
would be a chat-channel session, not a repo session. **Confidence it is worth doing: low.**

**Aider — not viable.** `--message`/`--message-file` are one-shot, `--yes` blanket-approves, output is prose
meant for a human terminal, and there is no structured event stream, no tool-call framing, no permission
protocol. The Python `Coder` API is explicitly *"not officially supported or documented, and could change
without backwards compatibility."* The `aider-acp` bridge shells out to the `aider` binary per turn and
inherits all of it. **Confidence it can meet Realm's bar: low.**

## 6. Recommended order

1. **Fix `configOptions` in `AcpAdapter`** (§2) — the difference between opencode arriving half-functional and
   arriving whole, and it future-proofs every subsequent add against the deprecation.
2. **opencode** — already installed and logged in here, so it is testable today.
3. **Copilot, Goose, Qwen, Grok** — four spec entries, all handshake-verified, all with clean `authMethods` and
   correct `-32000` auth errors.
4. **fx** — spec entry, but sign in and smoke-test a real turn before promising it in the UI.
5. **Re-enable Gemini** — see §7.
6. Leave Pi, Command Code, Amp, Aider, OpenClaw and Cline for a later pass.

## 7. Gemini

`acp:gemini` is already registered (`app.ts:75`) and already works at the protocol level; it is only hidden from
`SELECTABLE_AGENT_KINDS` (`presets.ts:75`) because Google discontinued the free personal tier.

Measured here on 2026-09-01 against gemini-cli 0.56.0: `initialize` succeeds and advertises four auth methods —
`oauth-personal`, `gemini-api-key`, `vertex-ai`, and **`gateway` ("Use a custom AI API Gateway")**. `session/new`
under the user's current personal OAuth fails with
`IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals` — i.e. the
free tier is genuinely dead, exactly as the comment says.

But three of the four auth methods still work, so "offering it is offering a dead end" is now only true for one
of them. Re-enable the kind with a login hint that names the live routes rather than the dead one, and let the
adapter's existing `AUTH_REQUIRED` handling surface the tier error for anyone still on personal OAuth. The
`gateway` auth method is also a natural seam onto Plan 19.

## 8. Risks and unknowns

- **`configOptions` write path is unverified.** §2's read side is measured; `session/set_config_option` has not
  been exercised against any of these agents. Verify against opencode (which has both a mode and a model
  option) before relying on the Plan chip.
- **fx and Cline are unverified past the handshake** (§4). Neither should be offered in the UI until a real
  turn has been driven through it.
- **Six new kinds is six new rows in every honesty table** (§3), and each row is a claim. `AGENT_HAS_MCP`,
  `AGENT_SKILL_SUPPORT`, `AGENT_SUPPORTS_PERMISSION_MODES` and `AGENT_MEMORY_CHANNEL` must be filled from
  measurement, not from the fact that the agent speaks ACP. A `true` nobody checked is worse than a `false`.
- **The picker gets crowded.** `SELECTABLE_AGENT_KINDS` goes from 3 to 9-10. Combined with Plan 19's gateway
  rails, the model picker's rail design (Plan 19 §5) becomes load-bearing sooner than that plan assumes.
