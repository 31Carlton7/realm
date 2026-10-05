#!/usr/bin/env node
/**
 * Fake `claude` — what the Agent SDK spawns when REALM_CLAUDE_BIN points at it: the CLI's stream-json
 * mode over stdio, the control protocol the SDK drives it with, and one short turn per message. No
 * model is ever asked anything, so a live check can run a whole Claude session on a scratch home.
 *
 * Shaped from the real CLI rather than from what Realm happens to read:
 *
 *   - `--version` and `auth status --json` answer as 2.1.281 does, signed in;
 *   - every line is one JSON object; the SDK's requests are `control_request{request_id, request}`
 *     and each is answered `control_response{response{subtype: success|error, request_id, …}}`;
 *   - `initialize`'s `models` is what `supportedModels()` reads, and it is the real CLI's shape: ALIASES
 *     (`default`, `opus[1m]`, `sonnet`, `haiku`) resolving to model ids, Opus 5.5 listed only under
 *     its 1M variant, Haiku stating nothing about fast mode and taking no effort at all;
 *   - a subtype it does not know is refused with the CLI's own error, never left unanswered;
 *   - `system/init` opens the first turn, not the process: in streaming input mode the CLI says who
 *     it is only once there is a message to answer.
 *
 * The flag layer starts from `--settings` — the SDK serialises `query()`'s inline `settings` into that
 * one argument as JSON — and `--effort`; `apply_flag_settings` merges into it the way the CLI's does
 * (null deletes a key). The turn's reply says what the layer holds — `effort <level>, fast <on|off>` —
 * so the transcript shows what a turn actually ran under. `fast_mode_state` on the result is `on`
 * only where the model's row says it can and the layer asked.
 *
 * FAKE_CLAUDE_JOURNAL=<file> appends every control request as a JSON line, for a check to read back.
 * FAKE_CLAUDE_MUTE=<subtype,…> leaves those control requests unanswered (a CLI that hangs on one).
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("2.1.281 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "auth") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "owner@example.com" })}\n`);
  process.exit(0);
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Fable 5.1 · Best for everyday tasks",
    resolvedModel: "claude-fable-5-1", supportsEffort: true, supportedEffortLevels: LEVELS, supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true },
  { value: "opus[1m]", displayName: "Opus (1M context)", description: "Opus 5.5 with 1M context · Most capable for complex work",
    resolvedModel: "claude-opus-5-5[1m]", supportsEffort: true, supportedEffortLevels: LEVELS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Fast and capable",
    resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: LEVELS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: "haiku", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers",
    resolvedModel: "claude-haiku-4-5", supportsEffort: false, supportsAdaptiveThinking: false },
];

const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = randomUUID();
const muted = new Set((process.env.FAKE_CLAUDE_MUTE ?? "").split(",").filter(Boolean));
let model = arg("--model") ?? "default";
const inline = (() => { try { const v = arg("--settings"); return v && v.trim().startsWith("{") ? JSON.parse(v) : {}; } catch { return {}; } })();
const flags = { ...inline, ...(arg("--effort") ? { effortLevel: arg("--effort") } : {}) };
let introduced = false;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const journal = (entry) => { if (process.env.FAKE_CLAUDE_JOURNAL) appendFileSync(process.env.FAKE_CLAUDE_JOURNAL, `${JSON.stringify(entry)}\n`); };
const answer = (request_id, response) => write({ type: "control_response", response: { subtype: "success", request_id, response } });
const refuse = (request_id, error) => write({ type: "control_response", response: { subtype: "error", request_id, error } });

/** The model a value runs, as the init frame and the turn name it: an alias resolves, an id is itself. */
const resolved = (value) => (MODELS.find((m) => m.value === value)?.resolvedModel ?? value).replace(/\[1m\]$/, "");
const rowFor = (value) => MODELS.find((m) => m.value === value || m.resolvedModel === value || m.resolvedModel?.replace(/\[1m\]$/, "") === value);

function control(id, request) {
  journal(request);
  if (muted.has(request.subtype)) return;
  switch (request.subtype) {
    case "initialize":
      answer(id, {
        commands: [{ name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "" }],
        agents: [], output_style: "default", available_output_styles: ["default"], models: MODELS,
        account: { email: "owner@example.com", subscriptionType: "max", tokenSource: "claude.ai" }, pid: process.pid,
      });
      return;
    case "set_model": model = request.model ?? "default"; answer(id, {}); return;
    case "set_permission_mode": answer(id, {}); return;
    case "apply_flag_settings":
      for (const [k, v] of Object.entries(request.settings ?? {})) { if (v === null) delete flags[k]; else flags[k] = v; }
      answer(id, {});
      return;
    case "interrupt": answer(id, {}); return;
    case "mcp_status": answer(id, { mcpServers: [] }); return;
    default: refuse(id, `Unsupported control request subtype: ${request.subtype}`);
  }
}

function turn(message) {
  const name = resolved(model);
  if (!introduced) {
    introduced = true;
    write({ type: "system", subtype: "init", session_id: sessionId, model: name, cwd: process.cwd(), tools: ["Read", "Edit", "Bash"],
      mcp_servers: [], permissionMode: "default", apiKeySource: "none", claude_code_version: "2.1.281", slash_commands: ["compact"],
      output_style: "default", skills: [], plugins: [], uuid: randomUUID() });
  }
  const row = rowFor(model);
  const effort = flags.effortLevel ?? (row?.supportsEffort === false ? "none" : "high");
  const fast = flags.fastMode === true && row?.supportsFastMode === true;
  const asked = typeof message?.content === "string" ? message.content
    : (message?.content ?? []).map((b) => (b?.type === "text" ? b.text : "")).join(" ");
  const text = `Ran on ${name}: effort ${effort}, fast ${fast ? "on" : "off"}. You said: ${asked.trim().slice(0, 80)}`;
  const msgId = `msg_${randomUUID().slice(0, 8)}`;
  write({ type: "assistant", session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(),
    message: { id: msgId, type: "message", role: "assistant", model: name, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 18 } } });
  write({ type: "result", subtype: "success", session_id: sessionId, uuid: randomUUID(), duration_ms: 420, duration_api_ms: 380, is_error: false,
    num_turns: 1, result: text, stop_reason: "end_turn", total_cost_usd: 0.0042,
    usage: { input_tokens: 12, output_tokens: 18, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {}, permission_denials: [],
    ...(flags.fastMode === true ? { fast_mode_state: fast ? "on" : "off", ...(fast ? {} : { fast_mode_disabled_reason: "unsupported_model" }) } : {}) });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type === "control_request") control(msg.request_id, msg.request ?? {});
  else if (msg?.type === "user") turn(msg.message);
});
rl.on("close", () => process.exit(0));
