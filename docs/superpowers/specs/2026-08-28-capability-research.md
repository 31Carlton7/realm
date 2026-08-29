# Capability research — Vercel, sandboxing, simulators, browser, mac-cli

**Date:** 2026-08-28
**Status:** Research / recommendation. No implementation.
**Scope:** six requested capabilities, each assessed against Realm as it exists today.

## 0. Baseline — what Realm is today

Read before the recommendations; several of them turn on these facts.

- `apps/server` (realm-server, Node, plain TS) owns SQLite, the session manager, terminals (node-pty), and the WebSocket RPC surface defined in `packages/contracts/src/rpc.ts`. The renderer talks only to realm-server. That hard rule from the v1 spec is intact.
- Implemented today: profiles, spaces, projects, items, layouts, sessions (Claude / Codex / ACP adapters), terminals, settings. RPC surface is ~46 methods.
- **Not yet implemented:** `packages/mcp` (realm-mcp gateway), `packages/context`, browser pane, simulator pane, artifacts pane. The spec describes them; no code exists.
- **No secret store exists.** The spec plans one (`Account.authRef`, `McpServer.envRef` → Keychain) but nothing is built. Agent auth currently lives entirely in each CLI's own config — `packages/adapters/src/claude/probe.ts` explicitly notes it does not inspect the keychain.
- Electron main already appends `--remote-debugging-port` when `REALM_DEVTOOLS_PORT` is set (`apps/desktop/src/main/index.ts:28`). That is the hook the browser ability was designed around.
- Machine reality: Xcode 26.6, iOS 26.x simulators available, `ffmpeg`, `adb`, `docker`, `mac` v0.6.0 and `vercel` 50.44.0 all on PATH. No `idb`, no Android SDK emulator, no `scrcpy`.

**The distinction that drives half this document:** Realm's agents are *external CLIs with their own tool systems*. Giving Realm a capability and giving the agent a capability are different problems with different answers. Anything the agent needs must arrive as an MCP tool, a skill, a CLI on PATH, or an env var — not as a Realm RPC method. Realm RPC methods serve the *renderer*.

---

## 1. Vercel Sandbox

### What it is

Ephemeral Linux microVMs (Firecracker) run on Vercel's infrastructure, for executing untrusted or agent-generated code. Generally available.

- Docs: https://vercel.com/docs/sandbox
- SDK reference: https://vercel.com/docs/sandbox/sdk-reference
- CLI reference: https://vercel.com/docs/sandbox/cli-reference
- Auth: https://vercel.com/docs/sandbox/concepts/authentication
- Pricing/quotas: https://vercel.com/docs/sandbox/pricing
- Repo: https://github.com/vercel/sandbox

### Shape

Three interfaces, all equivalent: `@vercel/sandbox` (JS/TS), `vercel.sandbox` (Python), and a standalone `sandbox` / `sbx` CLI modelled on Docker (`npm i -g sandbox`; subcommands `create fork run exec connect copy stop remove config sessions snapshot snapshots drives login logout`).

Runtime: default image `vercel/sandbox/universal` (Node LTS, Python 3.14, coding agents, common utilities); custom OCI images via Vercel Container Registry. Root access, system-privileged processes (Docker-in-sandbox, FUSE, VPN clients). 32 GB ephemeral NVMe per sandbox. Persistent sandboxes auto-save on stop and resume; snapshots are the manual equivalent.

Network: `allow-all` by default, or `deny-all`, or a custom egress firewall (`--allowed-domain`, `--allowed-cidr`, `--denied-cidr`). Up to 15 published ports with public URLs. Inbound/outbound on published ports is billable; package downloads are free.

Limits (Hobby → Pro): max vCPU 4 → 8, max memory 8 GB → 16 GB, max session duration **45 min → 24 h**, concurrent sandboxes 10 → 10,000. Default timeout 5 min, extendable with `sandbox.extendTimeout()`.

Pricing (Pro, `iad1`): Active CPU $0.128/hr, Provisioned Memory $0.0212/GB-hr, Creations $0.60/1M, Data Transfer $0.15/GB. Hobby includes 5 CPU-hours + 420 GB-hours/month free, then creation is paused until the cycle resets. Vercel's own worked example: a 30-min 4-vCPU build ≈ $0.34.

### Does it fit a local-first single-user desktop app?

**Technically yes, conceptually no.**

Technically: the access-token path is explicitly supported for "non-Vercel environments." You need `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`, or a `VERCEL_OIDC_TOKEN` pulled by `vercel env pull` (which expires in 12 hours and therefore is not a desktop-app auth model). A Vercel *project* is required even though nothing is deployed to it. The `sandbox` CLI additionally has its own `sandbox login`, storing a token itself — which sidesteps Realm's missing secret store entirely.

Conceptually, the mismatch is severe:

1. **The code is on the wrong machine.** Realm's whole premise is agents working in the user's repos on the user's Mac. A Vercel Sandbox starts empty in `iad1`. To use it you must ship the repo up, run, and ship results back. For a solo developer's daily driver that is pure friction with no compensating benefit.
2. **Latency and the feedback loop.** Every `runCommand` is a control-plane HTTP round trip to Virginia. Interactive agent work — edit, run tests, read output, edit again — becomes unbearable.
3. **Isolation is already solved locally, for free, better.** See below.

### The thing that actually answers "some kind of sandboxing"

Both of Realm's primary agents already ship a kernel-enforced sandbox on macOS:

- **Claude Code** has a sandboxed Bash tool using **Seatbelt** on macOS with zero setup (bubblewrap on Linux/WSL2). Configured entirely through `settings.json` under a `sandbox` key: `enabled`, `filesystem.allowWrite` / `denyWrite` / `allowRead` / `denyRead` / `disabled`, `network.allowedDomains` / `tlsTerminate`, `credentials.files` and `credentials.envVars` with `deny` or `mask` modes (mask substitutes the real secret at a local TLS-terminating proxy so the agent never sees it), `excludedCommands`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`. Anthropic reports it cut permission prompts ~84% internally.
  Docs: https://code.claude.com/docs/en/sandboxing and https://code.claude.com/docs/en/sandbox-environments
- **Codex CLI** has `sandbox_mode` = `read-only` | `workspace-write` | `danger-full-access`, also Seatbelt (`sandbox-exec`) on macOS 12+, Landlock + seccomp on Linux, configurable per profile in `~/.codex/config.toml` and selectable per-invocation with `--profile` / `CODEX_PROFILE`.

This is the real answer. It is local, kernel-enforced, free, zero-latency, and already installed. What is missing is not a sandbox — it's a **UI for it**. Right now a solo developer has to hand-edit two different config files in two different formats to express "this space's agents may write only inside the repo and may reach only github.com and registry.npmjs.org."

### Integration sketch (the recommended version)

**Realm-native, no Vercel.** Add a per-space *isolation policy* and translate it into each agent's native sandbox config at session start.

- **Owner:** realm-server, in the session manager, next to the existing cwd/model/mcpServers assembly in `apps/server/src/sessions/service.ts`.
- **Data model:** `Space` gains `isolationJson` (or a new `IsolationPolicy` row keyed by spaceId): `{ mode: 'off'|'workspace'|'strict', allowWrite: string[], denyRead: string[], allowedDomains: string[], denyEnv: string[] }`.
- **Translation:** for Claude, write a `.claude/settings.json` fragment into the session cwd (or pass `--setting-sources` / `--add-dir`); for Codex, generate a profile in `~/.codex/config.toml` and launch with `--profile realm-<space>`; for ACP agents, degrade to a note in the UI that isolation is unavailable.
- **RPC surface:** `spaces.getIsolation` / `spaces.setIsolation`, plus a `session.isolation` field on `sessions.get` so the transcript header can show a badge ("workspace-write · 3 domains").
- **UI:** one section in the existing Space Settings sheet — three radio modes and two text lists. Do not build a policy editor.
- **Cost:** ~3 days, most of it the two config translators and their tests.

### Recommendation

**Vercel Sandbox: DROP.** It solves remote untrusted-code execution for a *hosted* product. Realm is a local single-user workstation whose whole value is proximity to the user's files. Adopting it would mean shipping repos to Virginia to run tests slower. The one narrow case with real merit — "run this sketchy npm postinstall / this scraped script somewhere that isn't my laptop" — is served today by `docker run` or by the standalone `sandbox` CLI, both of which an agent can invoke from a Realm terminal with no Realm code at all. If that case ever gets hot, ship a skill that documents `sandbox run`, not an integration.

**Agent sandbox policy UI: BUILD** (~3 days). This is what "some kind of sandboxing" should become. It is the single highest-leverage item in this document: it directly reduces permission-prompt fatigue in the app's core loop, uses infrastructure that already exists on the machine, costs nothing to run, and is exactly the kind of thing a control plane should own that a bare CLI cannot.

---

## 2. Vercel AI Gateway (and the general "external gateway" pattern)

### What it is

A single endpoint fronting 200+ models across providers, with keys, budgets, failover, and observability.

- Docs: https://vercel.com/docs/ai-gateway
- Coding agents: https://vercel.com/docs/ai-gateway/coding-agents
- Anthropic-compatible API: https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api
- OpenAI-compatible API: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions
- BYOK: https://vercel.com/docs/ai-gateway/authentication-and-byok/byok

### Can it front the CLI agents Realm drives? Yes — and this is the important finding.

The gateway exposes protocol-compatible surfaces and, as of 2026, *dedicated per-agent endpoints*:

| Agent | Endpoint |
|---|---|
| Generic | `https://ai-gateway.vercel.sh/coding-agent/v1` (drop `/v1` for clients that append `/v1/messages` themselves) |
| Claude Code | `https://ai-gateway.vercel.sh/claude-code` |
| OpenAI Codex | `https://ai-gateway.vercel.sh/codex/v1` |
| Cursor | `https://ai-gateway.vercel.sh/cursor/v1` |

**Claude Code**, by environment variable:

```bash
export ANTHROPIC_BASE_URL="https://ai-gateway.vercel.sh/claude-code"
export ANTHROPIC_API_KEY=""            # must be empty — Claude Code checks it first
export ANTHROPIC_AUTH_TOKEN="<ai-gateway-key>"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1   # populates /model with the full catalog
```

**Codex**, in `~/.codex/config.toml`:

```toml
model_provider = "vercel"
[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "https://ai-gateway.vercel.sh/codex/v1"
env_key = "AI_GATEWAY_API_KEY"
wire_api = "responses"     # required; Codex no longer speaks Chat Completions
```

**OpenCode / Pi / omp / Kilo / Cline / Crush** have first-class gateway providers and need only the key. **Grok Build** takes `GROK_MODELS_BASE_URL` + `GROK_CODE_XAI_API_KEY`.

Pricing: zero markup on tokens, including BYOK. $5/month free credits per Vercel team. Budget alerts and hard limits return HTTP 402; per-user rate limits return 429.

### The competition, because this is a commodity slot

The same trick works against several backends, and Realm should model the *pattern*, not the vendor:

| Backend | Claude Code | Codex / OpenAI-compatible |
|---|---|---|
| Vercel AI Gateway | `ANTHROPIC_BASE_URL=…/claude-code` | `base_url=…/codex/v1`, `wire_api="responses"` |
| OpenRouter | `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1` (via its Anthropic-compat surface) | `OPENAI_BASE_URL=https://openrouter.ai/api/v1` |
| LiteLLM (self-hosted) | `ANTHROPIC_BASE_URL=http://localhost:4000` | `OPENAI_BASE_URL=http://localhost:4000/v1` |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds | — |
| Google Vertex | `CLAUDE_CODE_USE_VERTEX=1` + GCP creds | — |
| Anthropic direct (default) | unset everything; uses the CLI's own OAuth login | — |

### Fit for local-first single-user

**Good fit, with one large caveat.** The gateway is a stateless HTTP endpoint; nothing about it assumes a Vercel-hosted caller. Realm sets env vars on a child process it already spawns. That is a ~1-day change.

The caveat: **routing Claude Code through a gateway means paying per token instead of using a Claude Max subscription.** For a solo developer whose daily driver is Claude Code on a Max plan, this is a direct downgrade for normal work. The value is real but narrow — using a non-Anthropic model inside Claude Code's harness, keeping one spend dashboard across agents, or failing over when a provider is down.

Vercel does document a Max-subscription coexistence mode (Claude Code keeps its own `Authorization` header, the gateway uses `x-ai-gateway-api-key`) for observability at no extra token cost. Treat that as unverified until tested; it is the only configuration that makes gateway routing strictly additive.

### Credentials

An API key is required, and Realm has nowhere to put it. Note that `vercel ai-gateway coding-agents setup` already solves this properly — it detects installed agents, shows a diff before writing, and **stores the key in the macOS Keychain** rather than plaintext config. Realm should not compete with that.

If Realm stores any provider key itself, use Electron's `safeStorage` API (Keychain-backed, no native module, works with the existing `node:sqlite` store by encrypting the blob). Do not add `keytar`.

### Integration sketch

- **Owner:** realm-server. This is per-session process environment, which lives in `packages/adapters/src/types.ts` (`AgentAdapter.start`) and the session service.
- **Data model:** new `ModelProvider` table — `id, name, kind ('anthropic-compat'|'openai-compat'|'bedrock'|'vertex'|'native'), baseUrl, keyRef, extraEnvJson`. `Space` (or `Session`) gains `providerId?`. Default `null` = the CLI's own login, which must stay the zero-config default.
- **Adapter change:** `start()` gains an `env` passthrough; each adapter maps the provider to its own variables (Claude → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""`; Codex → a generated `~/.codex/config.toml` profile plus `AI_GATEWAY_API_KEY`).
- **RPC surface:** `providers.list/create/update/delete`, `providers.test` (one cheap completion), and `providerId` on `sessions.create` / `sessions.setOptions`.
- **UI:** a provider picker beside the existing model picker in the New Session sheet, plus a Settings → Providers list. Show the resolved base URL in the session header so it is never ambiguous which endpoint a session is hitting.
- **Cost:** ~2 days for the plumbing, ~1 day for `safeStorage`-backed key storage, ~1 day UI. Call it **4 days**.

### Recommendation

**BUILD, scoped to the generic pattern — not to Vercel.** Ship "custom model provider" with Vercel AI Gateway, OpenRouter, and a manual base-URL entry as presets. Building it Vercel-specific would be a mistake: this slot is a commodity and the differentiator is that Realm can set it *per space*, which no CLI can do.

Sequence it **after** the sandbox policy work. It is genuinely useful — being able to run a Codex session on Gemini and a Claude session on GPT from one window is a real control-plane feature — but it does not improve the daily loop the way isolation does, and for a Max subscriber the default path stays "don't use it."

---

## 3. "Vercel connect" — what he most likely means

Four candidates. They are not close in value.

### 3a. Vercel Connect (the actual product)

**It is an OAuth token broker**, not a network product. Docs: https://vercel.com/docs/connect

It obtains scoped third-party tokens (Slack, GitHub, Linear, Snowflake, arbitrary OAuth 2.0 servers, and **any MCP server** registered as `mcp.<host>/<path>`) on behalf of an app or a user, authenticated by a Vercel OIDC token. Three subject types: `user`, `app`, `jwt-bearer`.

Surfaces:
- CLI: `vercel connect create <service>`, `vercel connect list`, `vercel connect token <connector> --subject user|app`
- SDK: `getToken(connectorId, { subject })` from `@vercel/connect`
- REST: `POST /v1/connect/token/{connector}`, `/v1/connect/connectors`, `/v1/connect/authorize/{connector}` — all authenticated with `VERCEL_OIDC_TOKEN`
- Framework adapters for Eve, Better Auth, and Auth.js

**This is a surprisingly good conceptual match for the v1 spec's unbuilt MCP gateway**, which promised "credentials held by Realm, agents never see tokens, OAuth redirects handled in a Realm browser tab." Vercel Connect does exactly that job, including the OAuth dance and refresh, for MCP servers specifically.

**But the fit is wrong for a local-first app.** The SDK path requires a `VERCEL_OIDC_TOKEN`, which locally comes from `vercel env pull` and expires in 12 hours. That is a non-starter for a desktop app. The CLI path (`vercel connect token`) works off the user's stored `vercel login` and is viable — but then you have made Realm's credential store a dependency on a Vercel account, on a Vercel project directory context (the docs are emphatic that `vercel connect` must run from the consuming project folder), and on Vercel staying interested in this product. For a single-user Mac app, `safeStorage` + the OAuth flow in the browser pane Realm is already building is less code and no vendor.

**Verdict: DROP.** Revisit only if Realm ever grows a hosted component.

### 3b. Vercel CLI — `vercel link` / `dev` / `deploy` / `env`

Already installed (50.44.0). Agents can already run it from a Realm terminal. The `vercel` Claude Code plugin on this machine already ships `/vercel:deploy`, `/vercel:env`, `/vercel:status`, `/vercel:bootstrap` skills.

**Verdict: DROP as an integration. Nothing to build.** It works today.

### 3c. Vercel REST API (projects / deployments / logs)

Base `https://api.vercel.com`, bearer access token, `?teamId=` scoping. Relevant endpoints: `GET /v7/deployments`, `GET /v13/deployments/{idOrUrl}`, `GET /v3/deployments/{idOrUrl}/events` (build logs), `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`, `GET /v10/projects`, the `environment` group for env vars.
Docs: https://vercel.com/docs/rest-api

Building a Realm-native deployments pane would mean an access token, a polling loop, a table UI, and a log viewer — days of work to reimplement `vercel ls` and the Vercel dashboard, for one vendor, in an app that is not a deployment tool.

**Verdict: DROP.** If deployment status genuinely belongs in the window, it is a browser tab pointed at the dashboard.

### 3d. Vercel MCP — `https://mcp.vercel.com`

Official remote MCP server, OAuth, Streamable HTTP, MCP spec 2026-07-28. Tools for docs search, projects, deployments, deployment logs, Web Analytics, and (per changelog) deploying code. Claude Code and Codex CLI are both on the approved-client list.
Docs: https://vercel.com/docs/agent-resources/vercel-mcp
Install: `claude mcp add --transport http vercel https://mcp.vercel.com` or `npx -y add-mcp https://mcp.vercel.com -g`

This gives the *agent* everything 3c would have given the *renderer*, with zero Realm code, and the auth is OAuth handled by the CLI.

**Verdict: this is the winner in the category — and the thing to build is not Vercel-specific.** It is `packages/mcp`: the MCP gateway from §7 of the v1 spec, still unbuilt. Once Realm can add an MCP server once and toggle it per space, "Vercel connect" is a row in a list.

### Recommendation for #3

**What he probably means:** "let my agents talk to Vercel." **What that costs:** one line in an MCP config, today, with no Realm involvement.

**Build the MCP gateway (`packages/mcp`), not a Vercel integration.** It is already specced, it is the missing keystone for every third-party capability, and it converts "add Vercel" from a project into a settings row. Rough cost for a first useful version — realm-mcp process per session, a server registry with per-space enablement, `safeStorage`-backed env injection, call logging — **6–8 days**. Ship remote/HTTP+OAuth server support in that first cut specifically so `https://mcp.vercel.com` and `https://mcp.linear.app/mcp` work on day one.

---

## 4. iOS + Android simulators as agent-controllable surfaces

### The v1 spec is wrong about this, and it was measured

The spec says: *"live view from periodic `xcrun simctl io <udid> screenshot` frames (~5–10 fps); tap/type forwarded via `simctl`."*

Both halves are wrong, and a third assumption elsewhere in this document turned out to be wrong too.

**Measured on this machine** (Xcode 26.6, iPhone 17 Pro / iOS 27.0, warm, one simulator booted), across two independent runs:

| Invocation | Per shot | Effective fps |
|---|---|---|
| `xcrun simctl io booted screenshot x.png` | **~500–680 ms** | ~1.6–2.0 |
| direct `.../usr/bin/simctl`, PNG (skips `xcrun`) | 593 ms | 1.69 |
| direct simctl, `--type=jpeg` | 462 ms | 2.16 |
| `xcrun simctl help` (pure process-spawn overhead) | 203 ms | — |

So roughly 200 ms is process startup and 250–400 ms is real capture and encode. **Realistic ceiling: ~2 fps**, not 5–10, at **~3.8–4 MB per PNG** (1206 × 2622). And it degrades badly under exactly the conditions Realm creates — with a second simulator booted on a loaded machine, single calls were measured at **1.4 s to 63 s**. Screenshot polling is an agent observation channel, not a live view.

Two undocumented traps, both hit in testing: `simctl io ... screenshot -` **does not write to stdout** despite what the help text says — it creates a literal file named `-` in the working directory. Named FIFOs also yield 0 bytes; simctl needs a seekable file. **You must write a real file and read it back.**

**And `simctl` has no input verbs at all.** There is no `simctl tap`, no `swipe`, no `type`. The verified surface is everything you can *observe* and *configure* and nothing you can *touch*: `list` (use `-j`), `boot` / `bootstatus` / `shutdown` / `erase` / `clone`, `install` / `launch` (with `--console-pty`) / `terminate`, `openurl` (deep links — verified working), `io … screenshot` / `io … recordVideo` / `io … enumerate`, `ui <udid> appearance dark` (verified working), `status_bar override`, `push` (≤4096 bytes, needs an `aps` key), `privacy`, `addmedia`, `get_app_container`, `listapps`, `pbcopy` / `pbpaste`, `spawn`. Child env vars pass through with a `SIMCTL_CHILD_` prefix.

`simctl pbcopy` is worth noting: host→device clipboard is a clean text-entry side channel that avoids the input problem entirely for the common "type into a field" case.

### `simctl io recordVideo` cannot be streamed — verified

This looked like the obvious fix for the 2 fps problem and it does not work. The output file stays at **0 bytes for the entire recording** and is only written on SIGINT, when simctl prints "Recording completed. Writing to disk." There is no incremental muxing to tail and FIFOs yield nothing. There is no `recordVideo | ffmpeg` pipeline. Cross it off.

### How input actually happens on iOS

| Route | Reality in 2026 |
|---|---|
| **`baguette`** (Apache-2.0) | Swift; dlopens CoreSimulator/SimulatorKit, injects via **IndigoHID**. `brew install baguette`, v0.1.96 in homebrew-core. Taps, swipes, multi-finger, hardware buttons, keyboard, edge gestures, camera injection — **plus** 60 fps IOSurface streaming and the AX tree. |
| **`sim-use`** (Apache-2.0, ~1.3k★) | Swift; statically links idb's XCFrameworks. **Also does Android** via a bridge APK. `brew install lycorp-jp/tap/sim-use`. Compact outline AX format claims ~16× fewer tokens than raw JSON. |
| `AXe` (MIT) | Wraps a pinned idb fork; broke on Xcode 27 when SimulatorKit moved. |
| `idb` (facebook/idb) | Alive but slow-moving. Needs Homebrew **plus a Python 3.10+ environment**. Weaker AX data — Maestro publicly migrated off it to XCUITest for a richer hierarchy. Not installed here. |
| WebDriverAgent / Appium | Heavy (30–60 min first WDA build), but gives the MJPEG stream on port 9100. |
| XCUITest directly | Most faithful; needs a test target compiled into the app under test. Useless for driving arbitrary apps. |

**These are private APIs and they break.** iOS 26 changed the SimulatorHID wire format: the 5-argument `IndigoHIDMessageForMouseNSEvent` signature used by idb and AXe now drops messages or crashes `backboardd`; the working path is the 9-arg signature to digitizer target `0x32`. Separately, **Xcode 27 moved `SimulatorKit.framework`** from `Developer/Library/PrivateFrameworks/` to `Contents/SharedFrameworks/`, breaking AXe and XcodeBuildMCP. Budget for breakage every Xcode release — or let a maintained tool absorb it.

### Accessibility tree

Use `AXPTranslation` (the `AccessibilityPlatformTranslation` private framework), which reads the *iOS app's* tree through CoreSimulator and returns role, label, value, identifier, and **frame in device points**. It needs no macOS Accessibility TCC grant, because it never touches the macOS AX API. This is what `baguette describe-ui` and `sim-use` use. Do **not** run `AXUIElement` against Simulator.app — you get macOS window chrome, not iOS elements, and it needs a TCC grant.

**Prefer the tree over screenshots.** The DailyDroid benchmark (75 tasks / 25 apps) found text-only and text+screenshot performed comparably, with multimodal only marginally higher — the image tokens mostly do not pay for themselves. AX-first with screenshot fallback for canvas / game / WebView surfaces is the settled design.

**Coordinate mapping is a real bug source.** The iPhone 17 Pro screenshot is 1206 × 2622 **pixels**; the device is 402 × 874 **points** (@3x). Every HID API takes points; the agent sees pixels. Compute `scale = pixelWidth / logicalWidth` at runtime — never hardcode 3, since @2x devices exist.

### Android is the easy one

`adb` ships everything natively: `adb shell input tap X Y` / `swipe` / `text` / `keyevent`; `adb exec-out screencap -p` for frames; `adb shell uiautomator dump` for a full view hierarchy as XML; deep links via `am start -a android.intent.action.VIEW -d`; `adb shell cmd uimode night yes` for dark mode.

Three details that will otherwise cost a day each:
- **`exec-out`, never `shell`, for binary data.** `adb shell` allocates a pty whose line discipline rewrites `\n` → `\r\n`, corrupting every `0x0A` byte in a PNG. Android's own docs annotate this.
- **`input text` silently drops most emoji and many non-Latin scripts** with no error — characters unmapped on the virtual keyboard vanish. The literal two-character sequence `%s` becomes a space. Reliable Unicode entry needs an IME workaround.
- **`uiautomator dump` is blind to canvas-drawn UI** — games, Flutter, custom Compose `Canvas`, OpenGL all collapse to a single opaque leaf node. That is exactly when you need the screenshot fallback.

`scrcpy` (Apache-2.0) gives **35–70 ms** latency at 60 fps by encoding on-device via MediaCodec and shipping H.264 over an adb-forwarded socket. Consuming the stream yourself is explicitly supported — `doc/develop.md` documents `raw_stream=true` for third-party tools. `ws-scrcpy` (MIT) brokers it to a browser and includes a **WebCodecs** decoder, which Electron gets for free from Chromium. Note it is an app to fork, not an npm library.

The emulator's gRPC endpoint (`emulator -grpc <port>`) offers `sendTouch` / `sendKey` / `streamScreenshot`, consumable from Electron's main process via `@grpc/grpc-js`. But Google's own `.proto` says *"experimental… might change without notice"* and its usage doc says there is **no authentication or TLS** and *"DO NOT RUN THIS AS IS IN A PRODUCTION ENVIRONMENT."* Treat as unusable.

On this machine only `platform-tools` is installed — `emulator`, `avdmanager`, `sdkmanager`, a system image, and `scrcpy` would all need installing first.

### Rendering a live view in an Electron pane

| Approach | fps | Latency | Headless? | Verdict |
|---|---|---|---|---|
| `simctl` screenshot polling | ~2 | ~500 ms | **Yes** | Agent loop only, not a live view |
| `simctl recordVideo` → ffmpeg | — | — | — | **Verified impossible** (0 bytes until SIGINT) |
| `desktopCapturer` on the Simulator window | 30–60 | Low | **No** | Cheap demo, **strategically dead** — see below |
| **`baguette` IOSurface H.264 / MJPEG** | **60** | Low | **Yes** | **Recommended for iOS** |
| WDA MJPEG on :9100 | 1–60 (default 10) | Moderate | Yes | Solid fallback if WDA is already up |
| **scrcpy H.264** | 60 | 35–70 ms | Yes | **Recommended for Android** |
| NSView reparenting | — | — | No | Don't |

**Window capture deserves a specific warning, because it is the obvious idea and it is a trap.** It works today and is the fastest route to pretty pixels, but: it needs a **Screen Recording TCC** grant (which requires an app restart after granting); the coordinate chain is four stages (pane px → window px → subtract chrome and bezel → ÷ backing scale → device points) and the *inner device rect* is not exposed by `CGWindowListCopyWindowInfo`, so it must be inferred and re-tracked across ⌘1/2/3 zoom, rotation, and resize; it **requires a visible window**, whereas `simctl boot` leaves zero on-screen windows and screenshots still work headless; and decisively, **Xcode 27 removes Simulator.app entirely**, replacing it with `DeviceHub.app`, which unifies all devices into one window with a source list. Per-device window capture stops being meaningful. There is already an open `anthropics/claude-code` issue (#79991) about exactly this breaking a shipped simulator pane.

**NSView reparenting:** cross-process window embedding on macOS is effectively unsolved (Electron issue #10547 is still open; CEF hit the identical wall). macOS allows one key window at a time, so the embedded simulator and the Chromium window cannot both hold focus. Weeks of private-API work for something Apple is actively removing.

### Prior art worth not rebuilding

- **The iOS-simulator MCP already on this machine** (`mcp__Claude_Code_iOS_Simulator__*`) is the interface to copy: `attach` (live panel), `launch`, `screenshot`, `tap`, `swipe`, `touch_path` / `touch2_path` (eased drags, pinch, rotate), `text`, `button`, `open_url`, `detach`, plus `build`. Coordinates in device points, origin top-left. It even documents the edge-gesture trap — a swipe starting within 4 pt of an edge fires the OS gesture (back / shade / app switcher / Control Center) instead of a content drag.
- **`baguette`** — https://github.com/tddworks/baguette. Solves streaming, HID injection, and the AX tree in one Apache-2.0 brew-installable binary, works headless, has a `serve` mode with REST + WebSocket, and **has already absorbed the iOS 26 HID wire-format change** that broke idb and AXe.
- **`sim-use`** — https://github.com/lycorp-jp/sim-use. Same idea, covers iOS *and* Android behind one interface.
- **mobile-mcp** — https://github.com/mobile-next/mobile-mcp, ~6.1k★, 25+ tools, iOS simulator + iOS device + Android emulator + Android device. Accessibility-first with screenshot fallback. Note it drives iOS through **WebDriverAgent on :8100** (migrating to its own Go `mobilecli` binary), so the WDA build cost applies.
- Also worth knowing: **there is no official Appium MCP**, and **Playwright cannot drive real iOS at all** — its "Mobile Safari" profiles are desktop WebKit with a resized viewport and a spoofed UA.

### Integration sketch

Two independently shippable pieces with very different value-per-effort:

**(a) Agent control — cheap.** Register `sim-use` (both platforms) or `baguette` + `mobile-mcp` as MCP servers in the gateway, enabled per space. The agent gets simulator control immediately. **Cost: hours, once `packages/mcp` exists.** No simulator code in Realm.

**(b) The pane — expensive.**
- **Owner:** realm-server supervises the `baguette serve` / scrcpy process and owns device lifecycle; the renderer consumes the video stream; Electron main is *not* needed, because the recommended path avoids `desktopCapturer` entirely.
- **RPC surface:** `simulators.list/boot/shutdown/launchApp/openUrl`, plus a stream handle. Input verbs deliberately do **not** go through Realm RPC — the agent drives via MCP; the RPC surface exists so the *user* can click into the pane.
- **Architectural rule:** keep **two pipelines** — a slow AX-tree-plus-occasional-screenshot channel for the agent, and a fast 60 fps video channel for the human. Conflating them is the central design trap here, and it is what the v1 spec did.
- **Cost: 8–12 days** with real variance.

### Recommendation

**(a) MCP server registration: BUILD** — a config row, not a project.

**(b) The simulator pane: DEFER.** Highest cost, highest variance, narrowest use, and the platform is moving underneath it (Device Hub in Xcode 27). Interrogate the use case first: if the goal is "an agent iterates on my SwiftUI app and I watch," the honest comparison is Xcode's own simulator window open beside Realm — zero days, 60 fps, real touch, and the debugger. Realm's pane only wins when the agent's actions and the device view belong in the *same recorded transcript*. That is a genuine benefit and a v2 one.

If it does get built: **do Android first.** `adb` gives input for free and scrcpy gives video for free, so it surfaces the pane, coordinate, and streaming problems at a fraction of the cost — after which iOS is a second backend rather than a first draft. And on iOS, integrate `baguette` rather than dlopening the private frameworks yourself; that is the difference between days and weeks, and between breaking every Xcode release and letting someone else break.

---

## 5. Browser connection

### Three architectures, and they are not mixable

| | **A. Embedded view** (`WebContentsView` + `webContents.debugger`) | **B. Attach to the user's Chrome** | **C. MV3 extension bridge** (`chrome.debugger`) |
|---|---|---|---|
| User's real logins | none — fresh profile | **yes** | **yes** |
| Lives inside the Realm window | **yes** | no | no |
| Ships as one binary | **yes** | user must launch Chrome a specific way | Web Store review + native-host installer |
| Control surface | full CDP | full CDP | ~25 CDP domains only |
| "Being debugged" banner | **no** | yes | **yes**, effectively unsuppressable |
| Main fragility | native-view-over-DOM layering | Chrome ≥136 profile lockout | store policy, review risk, banner |

For a workstation app where the user watches, **A is the only one that puts the browser inside the window.** B and C are the only ones that reach the user's real logged-in sessions.

### Attaching to the user's Chrome: dead by the old route, alive by a new one

**The old route is closed.** Since **Chrome 136**, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored unless accompanied by a `--user-data-dir` pointing somewhere other than the default profile. Google's stated rationale, verbatim: *"Since App-Bound Encryption was enabled we've seen an increase in attackers using Chrome Remote Debugging to extract cookies."*
Doc: https://developer.chrome.com/blog/remote-debugging-port

The failure mode is nasty: Chrome starts normally and simply does not open the port, so the client gets `ECONNREFUSED` and every bug report reads like a networking problem. Playwright ships the matching warning on `launchPersistentContext`: *"Due to recent Chrome policy changes, automating the default Chrome user profile is not supported."*

The usual workaround — copy the profile to a new `--user-data-dir` — is **platform-dependent in a way most write-ups get wrong**. On Windows, App-Bound Encryption (Chrome 127+, Windows-only) binds the cookie key to app identity, so copied logins do not survive. On macOS there is no ABE; Chrome encrypts cookies under a per-installation key in the login Keychain ("Chrome Safe Storage") that is not bound to the profile path, so a copy on the same machine and account generally does decrypt. Either way the copy is a point-in-time fork that immediately diverges from the real profile, and it is a full duplicate of the user's browsing data sitting in a second location.

**But there is now a sanctioned replacement, and it changes the recommendation.** Chrome 144+ adds `--autoConnect`: the user enables incoming debugging at `chrome://inspect/#remote-debugging` (off by default), and Chrome shows a **permission dialog on every session request**, then displays the "controlled by automated test software" banner while attached. No port flag, no profile copy, real profile, real logins.
Doc: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session

So the correct statement is not "you can't attach to the user's Chrome" — it is **"the hack is dead and the supported path is new and version-gated."** If Realm ever ships a "use my Chrome" mode, target `--autoConnect` and treat the port flag as legacy.

For completeness, Playwright's `chromium.connectOverCDP(endpointURL)` still works against any CDP endpoint but is documented as *"significantly lower fidelity than the Playwright protocol connection."* Concretely: `recordVideo` is unavailable (the context already exists), and every context-creation option — `viewport`, `locale`, `timezoneId`, `geolocation`, `permissions`, `userAgent`, `colorScheme`, `storageState` — silently does not apply. Pass `noDefaults` to stop Playwright mutating the user's context. Puppeteer's `puppeteer.connect({browserURL})` is equivalent; **pass `defaultViewport: null`** or it will resize the user's window to 800×600.

### Option A is what the v1 spec chose, and it is right

**Electron 37 is Chromium 138**, so its bundled engine is post-136 — but the 136 lockout targets *the default Chrome data directory* specifically. Electron has its own `userData` path and `webContents.debugger` needs no port at all, so none of the above applies to Realm's own view.

- `WebContentsView` (https://www.electronjs.org/docs/latest/api/web-contents-view) replaces the deprecated `BrowserView`: `win.contentView.addChildView(view)`, `view.setBounds({x,y,width,height})`. The `<webview>` tag carries an explicit "we currently recommend to not use" banner and should not be used for new code.
- **Full CDP is available.** From Electron's own source, `electron_api_debugger.cc` does `agent_host_ = DevToolsAgentHost::GetOrCreateFor(web_contents())` — a plain `content::DevToolsAgentHost`, the same object DevTools attaches to, with **pure pass-through and no domain filtering**. So `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent` and `Accessibility.getFullAXTree` all work. Browser-level domains (`Browser`, app-wide `Target` discovery, `SystemInfo`) do not, because this is a content-level host.
- **`chrome.debugger` is not implemented in Electron.** You cannot run an extension inside Realm that drives CDP; you drive it from main. Worth knowing that when someone tried to load the Claude in Chrome extension into Electron ([electron#49830](https://github.com/electron/electron/issues/49830)), Felix Rieseberg — at Anthropic and in Electron governance — replied that replicating the functionality *"(to interact with a given WebContents, maybe using CDP) is likely easier than properly enabling the many extension APIs offered in Chrome that are not supported in Electron."* That is a direct endorsement of this architecture.

### The layering problem is wontfix, and it will shape the UI

Native views composite **above** the window's DOM, always. There is no shared z-index — the `BrowserWindow`'s page is one leaf in the native view tree and any sibling paints over it. Closed as wontfix: [electron#16854](https://github.com/electron/electron/issues/16854), [#15899](https://github.com/electron/electron/issues/15899).

Consequences, all real: React-rendered modals, dropdowns, popovers, tooltips, toasts, and **the ⌘K command palette** are occluded wherever they overlap the view. No CSS filters, transforms, blend modes, backdrop blur, or opacity animations can be applied to the view from the DOM side. Native OS menus (`Menu.popup`) *do* render above, since they are separate platform windows.

Four known workarounds, in descending frequency: `view.setVisible(false)` whenever an overlay opens (cheap, costs a flash); reserve a chrome gutter so DOM UI never overlaps (this is why every Electron browser has thick chrome); make each overlay its own stacked `WebContentsView` (Mattermost does this; "a lot of processes"); or a transparent child `BrowserWindow` with `setIgnoreMouseEvents` (the only true free-form overlay, and universally described as the worst hack). [electron#49039](https://github.com/electron/electron/issues/49039) proposes a CSS `-electron-interactivity` property to fix this properly; open, nothing merged.

**Decide this in week one, not month three** — it determines the whole pane design, and Realm's ⌘K palette and sheets already overlap where the browser pane will live.

Two more sharp edges: there is **no `setAutoResize` on `View`** ([#43802](https://github.com/electron/electron/issues/43802), open), so bounds sync is a placeholder `<div>` + `ResizeObserver` + IPC → `setBounds`, and the IPC round trip means the view visibly trails during a live pane drag. Do **not** debounce it (that turns trailing into stutter-then-jump); paint the placeholder the same color as the view so the gap does not flash white. And `setBorderRadius` exists but its docs warn *"the area cutout of the view's border still captures clicks"* — visual mask only, hit-testing stays rectangular.

### Simpler primitives worth using

- **`webContents.capturePage([rect, opts])`** is the lowest-friction observation primitive: no OSR, no CDP attach, works whether or not the view is attached to a window. **Pass `stayHidden: true`** — without it, capturing a background view makes it visible as a side effect (it starts painting and un-throttles). For an agent that screenshots once per step rather than streaming, start here.
- **`webContents.sendInputEvent`** requires the containing window to be focused, **bails silently** when there is no `RenderWidgetHostView` (no throw, events just vanish), and **silently rewrites `keyDown` to `rawKeyDown`** for backwards compatibility — which is exactly why sending only `keyDown` never produces text. To type a character you must send `keyDown`, then `char`, then `keyUp`.
- **`Page.startScreencast`** delivers whole base64 JPEGs (not a video codec, not deltas) via `Page.screencastFrame` with metadata carrying `offsetTop`, `pageScaleFactor`, `deviceWidth/Height`, `scrollOffsetX/Y` — which you need to map a click in the rendered `<img>` back to page coordinates. **The ack protocol is mandatory and is the number one way people break this:** you must call `Page.screencastFrameAck({sessionId})` per frame, or with the default `maxFramesInFlight: 3` the stream **silently stalls after three frames** with no error. There is no fps parameter; frames are compositor-driven (a static page emits nothing, which is good), and `everyNthFrame` is a crude decimator — ack lazily on a timer for a real cap. Realm mostly does not need this, since the page already renders on screen in the pane.

### agent-browser — the spec's choice, validated

https://github.com/vercel-labs/agent-browser · https://agent-browser.dev

A Rust CLI plus a persistent Rust daemon speaking CDP directly, distributed as a native binary via npm, Homebrew, or Cargo. What matters for Realm:

- `agent-browser connect <port>` attaches to an existing CDP endpoint; `--cdp` accepts a port or a `wss://` URL. **This is exactly the hook Realm already has** — `apps/desktop/src/main/index.ts:28` already appends `--remote-debugging-port` behind `REALM_DEVTOOLS_PORT`.
- **Sessions bind to specific CDP target IDs and persist across daemon restarts**, with `--pin-tab` for strict binding — precisely the `TAB_GONE`-never-retarget guarantee the v1 spec demanded, already implemented.
- `snapshot` gives an accessibility tree with compact `@eN` refs (`-i` interactive-only, `-c` compact, depth limiting, CSS scoping); `screenshot --annotate` overlays numbered labels matching those refs.
- Safety flags already exist: `--allowed-domains`, `--action-policy`, `--confirm-actions`, `--max-output`.
- **It ships an MCP server mode** — `agent-browser mcp`, with tool profiles `core`, `network`, `state`, `debug`, `tabs`, `react`, `mobile`, `all`.

That last point changes the build. The spec envisioned realm-mcp reimplementing `browser.snapshot/click/fill/…`. It does not need to: point the agent at `agent-browser mcp --cdp <Realm's port>` and the tools exist. **Realm's job shrinks to owning the window** — the pane, the tab list, the per-profile partition, the visible "agent is driving" state, and the permission gate.

### Agent legibility — and a correction

The convergent design across playwright-mcp, agent-browser, Browser Use, and Claude in Chrome is **accessibility/DOM snapshot with stable refs as the primary channel, screenshot as an occasional check.** But the usual justification for it is wrong and worth stating correctly:

**"The accessibility tree saves tokens" is not true in general.** A screenshot costs **≈1568 tokens, hard-capped** (Claude in Chrome's own constants: `pxPerToken: 28`, `maxTargetPx: 1568`, downscaling by `sqrt(1568 / ceil(w/28 × h/28))`). A dense page's element list is comparable or *more*: Browser Use caps its clickable-element string at 40,000 characters, and Claude in Chrome caps its tree at 50,000 characters (~12k tokens) / depth 15 / 10,000 elements. Snapshots are often cheaper, but not reliably so.

**The real arguments are determinism and not needing a vision model.** A `ref` resolves to one element; a coordinate is a guess that breaks on scroll, animation, or a one-pixel layout shift. playwright-mcp says exactly this: *"Deterministic tool application. Avoids ambiguity common with screenshot-based approaches."*

Honest failure modes on both sides: the AX tree collapses on div-soup with no roles, `<div onclick>` without `tabindex`, canvas-rendered apps (Figma, Maps, most charting libraries), and closed shadow DOM — and it misses purely visual state like a red border or a spinner. Screenshots miss everything below the fold, and the model cannot tell how much it is missing, which is why every serious implementation emits an explicit scroll marker in the text. Refs go stale on navigation, so re-snapshot after every action.

**Steal Claude in Chrome's read/write split**: extract the tree via script injection (cheap, no debugger attach, no banner) and attach the Input domain only when actually acting. A read-only mode enforced by *not having the capability* is worth ten enforced by a boolean.

### Security posture

**Prompt injection from page content is the load-bearing risk**, because the agent's input is attacker-controlled by construction — hidden DOM text, `aria-label`s, off-screen elements, alt text, and response bodies all flow into the tree the model reads. Anthropic's published numbers for browser use: **23.6% attack success with no mitigations, 11.2% with them**; on a challenge set of four browser-specific attack classes, 35.7% → 0%. Treat ~11% as the honest floor for a naive implementation.

Mitigations, in descending value for Realm:

1. **Separate profile — Realm gets this for free and it is the whole argument for architecture A.** An embedded `WebContentsView` with its own Electron `session` partition shares nothing with the user's Chrome: no cookies, no autofill store, no password manager, no OAuth grants. That is a structural isolation boundary, not a policy, and it is Realm's advantage over every extension-based tool. The v1 spec's per-profile partition is right; keep it, and never load the user's real Chrome profile into it.
2. **Redact at the extraction layer, not at prompt-build.** `input[type=password|hidden]` and `autocomplete` matching `current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp*` should render as `[value redacted]` before the data ever leaves the page. Two hours of work; removes an entire class of leak. The nastiest failure mode this prevents: a synthesized click triggers Chrome autofill, credentials populate, and an injected instruction submits the form — the agent never "saw" the password.
3. **Human-in-the-loop on irreversible actions**, routed through the `permission_request` SessionEvent machinery that already exists. The set worth gating: cross-origin navigation, form submit, file download, entering personal or financial data, purchases, destructive UI (delete/archive/send), and **OAuth consent screens as a hard stop, not a confirmation** — an agent that clicks "Authorize" grants persistent third-party access that survives logout and password rotation.
4. **Origin allowlist per space.** In Electron this can be enforced far harder than playwright-mcp's `--allowed-origins` (whose own docs admit *"these flags do not serve as a security boundary and do not affect redirects"*): use `will-navigate` + `preventDefault()`, `setWindowOpenHandler`, and `session.webRequest.onBeforeRequest` for a real network-level block.
5. **Make control visible.** Chrome shows a banner for a reason. An embedded view has none, so Realm owes the user an unmistakable "agent is driving" state, a live action log, and a kill switch.
6. If Realm ever exposes a CDP or WebSocket endpoint, **bind loopback and require a token** — any web page in any browser can open `ws://localhost:PORT`. Browser MCP shipped this bug ([#158](https://github.com/BrowserMCP/mcp/issues/158)): its server bound `0.0.0.0`, letting anyone on the LAN drive the user's browser.

### Integration sketch

- **Owner:** Electron main owns the `WebContentsView` per `BrowserTab`, its partition, and the debugger attach; realm-server supervises the `agent-browser` daemon, attaches it to Electron's CDP port, and maps `BrowserTab.id` → CDP target ID; the renderer owns chrome (URL bar, tabs, badge) and drives `setBounds`.
- **Data model:** `BrowserTab` already exists in the spec. Add `cdpTargetId` and `agentControlled: boolean`.
- **RPC surface:** `browser.tabs.list/create/close/navigate`, `browser.tab.changed` for title/url/favicon/loading, `browser.setAgentControl` for the badge. Bounds sync goes renderer→main over IPC, not the WebSocket — it is per-frame and must not cross the server.
- **Agent surface:** not Realm RPC. `agent-browser mcp --cdp <port>` registered through the MCP gateway, scoped per space.
- **Cost: ~10–12 days.** Roughly 3 for view lifecycle and the bounds/layering plumbing, 2 for tabs and partitions, 2 for agent-browser supervision and target-ID mapping, 2 for the permission gate and redaction, and 2 for the overlay rework the layering problem forces on the command palette and sheets.

### Five things to verify in week one

Each is a short spike and each is load-bearing enough to change the design:

1. **Does CDP `Input.dispatchMouseEvent` work against an unfocused/background Electron window?** `sendInputEvent` documents that it needs focus, and both paths bottom out in the same `RenderWidgetHost` forwarding — which argues *against* CDP being a magic bypass. If CDP also needs focus, an agent working in a background pane is impossible and the entire UX changes. **This is the biggest open question in the document.**
2. **Does `Page.startScreencast` yield frames for a hidden or zero-size `WebContentsView`?** If not, the "user watches" pane must keep the view visible, or fall back to polled `capturePage(rect, {stayHidden: true})`.
3. **Does `Accessibility.enable` alone populate the AX tree in Electron**, or is `--force-renderer-accessibility` also needed? Global a11y has real perf cost and is user-visible on macOS.
4. **Does `--autoConnect` (Chrome 144+) work from a desktop app** the way it does from an MCP server, and what does the consent dialog say when the requester is Realm? This decides whether "use my Chrome" is offerable at all.
5. Whether `agent-browser`'s `--pin-tab` target binding survives Electron's view lifecycle across pane close/reopen.

### Recommendation

**BUILD, as architecture A — Realm's own browser.** This is the best capability on the list. It is named in the v1 definition of done; it is genuinely differentiating (a control plane can show you what the agent is doing, a terminal CLI cannot); the agent-side tooling is already solved by agent-browser; the hook already exists in `main/index.ts`; and the separate session partition is a real security boundary Realm gets for free.

**Do not build an "attach to my everyday Chrome" mode now.** The `--remote-debugging-port` path is a treadmill Google is actively deprecating, and the sanctioned replacement is gated on Chrome 144+ with a per-session consent dialog. Revisit it as an opt-in mode once `--autoConnect` is broadly available — and when you do, target that, not the profile-copy hack.

---

## 6. mac-cli integration

### What it is

`/Users/carltonaikins/Desktop/Home/Work/Projects/mac-cli` — a shipped Swift CLI, v0.6.0, MIT, installed at `/opt/homebrew/bin/mac`. Site: https://macoscli.sh. Repo: https://github.com/31Carlton7/mac-cli

Fifteen subcommands: `calendar reminders contacts mail messages notes music tv shortcuts call facetime finder keynote pages numbers doctor`. Calendar/Reminders/Contacts run on EventKit and Contacts natively; the rest go through AppleScript plus a read-only Messages database.

It is already built for agents in a way most CLIs are not: `--json` on every command with sorted keys and ISO 8601 dates, exit codes `0` success / `1` not found or bad input / `2` permission denied / `64` malformed invocation, mutations that accept exact IDs only so an agent must `list` before it can `delete`, actionable one-line errors on stderr, and `mac doctor` reporting missing TCC permissions with fix steps. The README's "For agents" and "Known limitations" sections are unusually honest — windowed Mail reads, `messages send` not proving delivery, iWork operating on open documents by name.

### The four options, against the Realm/agent distinction

**A. MCP server.** Wrap `mac` in an MCP server exposing ~40 tools. This is the option that looks most obvious and is the worst.
Costs: a new package to build and maintain in lockstep with a CLI that ships new modules regularly (Photos, QuickTime, Preview, TextEdit are on the roadmap); ~40 tool schemas duplicating help text that already exists; every one of those schemas burning context in every session whether or not the user is doing calendar work; and a translation layer between a CLI whose semantics are already correct and a protocol that adds nothing here. MCP earns its cost when the capability needs a persistent connection, held credentials, or a non-shell transport. `mac` needs none of those — it is a fast local binary with typed output.

**B. Realm-native tool surface** (a `mac.*` namespace in realm-mcp, or RPC methods). Worse than A. It puts Realm in the business of tracking another project's CLI surface, and RPC methods would serve the renderer, which is not who needs this.

**C. Skill.** A single `SKILL.md` in `~/Realm/skills/` — say 60–100 lines: what `mac` is, the exit-code contract, the `--json` rule, the ID-before-mutation rule, the four or five gotchas that will otherwise bite an agent (draft over send, exact handles for `messages send`, `--scan` on large mailboxes, `mac doctor` when a permission error appears), and a pointer to `mac help <subcommand>`. The agent then discovers everything else itself, at the moment it needs it, by running `--help`.
This costs about **half a day**, has no maintenance burden when `mac` v0.7 adds Photos, and adds ~1 KB of context instead of ~40 tool schemas.

**D. PATH only, no prompt.** Already true, and already insufficient — an agent will not spontaneously guess that a binary called `mac` exists and drives Calendar.

### Recommendation

**BUILD option C — one skill — and nothing else.** Cost: half a day.

Reasoning, stated in terms of the distinction the brief draws: Realm does not need a `mac` tool; the *agent* does. The agent already has a Bash tool. `mac` is already agent-shaped. The only thing missing is **discovery**, and a skill is precisely the mechanism for making a shell capability discoverable without paying tool-schema tax on every turn. Wrapping an agent-friendly CLI in MCP is re-solving a solved problem and taking on a maintenance dependency between two of your own projects.

Two things make this materially better than a skill in `~/.claude/skills` (where the voice skills already live):

1. **Profile scoping is the actual feature.** The v1 spec already gives skills per-profile enablement and per-space sync. `mac` in a Personal profile and not in a Work profile is a genuinely useful boundary — it is exactly the kind of thing a control plane can express that a bare CLI cannot. This is the argument for putting it in Realm's skills library rather than globally.
2. **`mac doctor` belongs in the agent probe panel.** Realm already probes agent CLIs and surfaces "installed / logged in" in Settings. Adding a `mac` row that shells `mac doctor --json` and shows which TCC permissions are missing, with fix steps, costs an hour and turns the most common failure mode (exit 2, permission denied, mid-task) into something the user sees before starting. That is the one place a Realm-native surface earns its keep here.

Do not build an MCP server for it. If a future agent handles skills poorly and genuinely cannot discover `mac`, revisit — but revisit with a *three-tool* MCP server (`mac_help`, `mac_run`, `mac_doctor`) that shells out, not forty generated schemas.

---

## 7. Ranking — value per effort for a solo developer's daily driver

| # | Capability | Verdict | Effort | Why |
|---|---|---|---|---|
| 1 | **mac-cli as a skill** (§6) | **BUILD** | **0.5 d** | Highest ratio on the list by an order of magnitude. Half a day makes an already-shipped, already-installed, already-agent-shaped CLI discoverable, with per-profile scoping as a bonus. Add the `mac doctor` probe row for another hour. |
| 2 | **Agent sandbox policy UI** (§1) | **BUILD** | **3 d** | Directly attacks permission-prompt fatigue in the core loop, using Seatbelt-backed isolation that both primary agents already ship. Free to run, zero latency, and exactly what a control plane should own. This is what "some kind of sandboxing" should become. |
| 3 | **MCP gateway** `packages/mcp` (§3) | **BUILD** | **6–8 d** | The missing keystone. Converts "add Vercel MCP", "add sim-use", "add agent-browser", "add Linear" from four projects into four settings rows. Everything else on this list gets cheaper once it exists. Include remote HTTP + OAuth servers in the first cut. |
| 4 | **Browser pane** (§5) | **BUILD** | **10–12 d** | The flagship ability and the one named in the v1 DoD. Agent-side tooling already solved by agent-browser; the CDP hook already exists in `main/index.ts`; the separate session partition is a real security boundary. Estimate went up from my first pass because the native-view-over-DOM layering problem is wontfix and forces an overlay rework. Sequence after the gateway so agent tools arrive as config. |
| 5 | **Custom model provider / AI Gateway** (§2) | **BUILD, later** | **4 d** | Real and generalizable — per-space model routing is something no CLI can do. But for a Max subscriber the default path stays "don't use it," so it improves flexibility rather than the daily loop. Build the *pattern* (base URL + key), with Vercel and OpenRouter as presets. |
| 6 | **Simulator pane** (§4) | **DEFER** | **8–12 d** | Highest cost, highest variance, narrowest use — and the platform is moving underneath it. Measurement killed the spec's design (~2 fps not 5–10; ~4 MB/frame; `recordVideo` cannot be streamed at all; no `simctl` input verbs). Window capture, the obvious fallback, is invalidated by Xcode 27 removing Simulator.app for Device Hub. Get 90% of the value in hours by registering `sim-use` or `baguette` + `mobile-mcp` in the gateway; revisit the pane only if the transcript-plus-device-view combination proves necessary. Android first if it happens. |

**Dropped outright:** Vercel Sandbox (wrong machine, wrong latency, and local Seatbelt already wins), Vercel Connect (an OAuth broker needing a 12-hour OIDC token and a Vercel project — `safeStorage` is less code and no vendor), the Vercel REST API (reimplements `vercel ls` and the dashboard), and the Vercel CLI as an "integration" (it already works; nothing to build).

**The through-line:** four of the six requests are best answered by *not building an integration*. Vercel Sandbox is answered by Seatbelt, "Vercel connect" by an MCP row, simulator control by an existing MCP server, and mac-cli by a 100-line skill. The two things genuinely worth Realm's own code are the ones where Realm owns something no CLI can: **a window the user watches** (browser pane) and **per-space policy** (sandbox config, model providers, MCP enablement). That is the shape of the product. Capabilities that do not fit it are usually someone else's binary plus a config row.

**Suggested order:** mac-cli skill → sandbox policy → MCP gateway → browser pane → model providers → (reassess simulator). The first three total under two weeks and make the fourth substantially cheaper.

### Corrections to the v1 spec this research forces

Three claims in `2026-08-17-realm-v1-design.md` are now known to be wrong and should be amended:

1. **§5 Simulator** — "live view from periodic `xcrun simctl io <udid> screenshot` frames (~5–10 fps)" is off by 3–5× (measured ~2 fps at ~4 MB/frame, degrading to seconds per frame under load), and "tap/type forwarded via `simctl`" is impossible — `simctl` has no input verbs at all.
2. **§5 Browser** — the plan to implement `browser.click/fill/type/press` in realm-mcp is redundant; `agent-browser` ships an MCP mode with the same tools and CDP target pinning.
3. **§2 Architecture** — the diagram implies the browser pane is straightforward. The native-view-over-DOM layering constraint is wontfix in Electron and needs to be a stated design constraint, because it affects the command palette and every sheet.
