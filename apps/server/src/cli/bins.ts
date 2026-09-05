import type { AgentKind } from "@realm/contracts";

/**
 * The binary each agent kind runs as, and the environment variable that repoints it.
 *
 * `defaultAdapters()` reads its ACP specs' `bin` from here rather than restating them, so pointing an
 * adapter at a stub binary points the CLI manager's provenance lookup at the same one. Claude and
 * Codex resolve their own defaults inside their probes (`probeClaude`, `probeCodex`) from the same two
 * env vars; `provenance.test.ts` pins those names by proving an override moves both.
 *
 * `fake` is null: the scripted dev adapter is compiled in and has no binary to find.
 */
const AGENT_BINS = {
  claude: { env: "REALM_CLAUDE_BIN", bin: "claude" },
  codex: { env: "REALM_CODEX_BIN", bin: "codex" },
  "acp:cursor": { env: "REALM_CURSOR_BIN", bin: "cursor-agent" },
  "acp:gemini": { env: "REALM_GEMINI_BIN", bin: "gemini" },
  "acp:opencode": { env: "REALM_OPENCODE_BIN", bin: "opencode" },
  "acp:copilot": { env: "REALM_COPILOT_BIN", bin: "copilot" },
  "acp:goose": { env: "REALM_GOOSE_BIN", bin: "goose" },
  "acp:qwen": { env: "REALM_QWEN_BIN", bin: "qwen" },
  "acp:grok": { env: "REALM_GROK_BIN", bin: "grok" },
  "acp:fx": { env: "REALM_FX_BIN", bin: "fx" },
  "acp:deepseek": { env: "REALM_DEEPSEEK_BIN", bin: "dsh-acp-demo" },
  fake: null,
} as const satisfies Record<AgentKind, { env: string; bin: string } | null>;

/** Every kind that runs a binary at all — which is every kind but the compiled-in `fake`. The
 *  overload exists so an adapter spec, whose `bin` is a plain string, does not have to widen it. */
type BinnedKind = Exclude<AgentKind, "fake">;

/** What Realm would spawn for `kind` right now, override included. Null only for `fake`. */
export function agentBin(kind: BinnedKind, env?: NodeJS.ProcessEnv): string;
export function agentBin(kind: AgentKind, env?: NodeJS.ProcessEnv): string | null;
export function agentBin(kind: AgentKind, env: NodeJS.ProcessEnv = process.env): string | null {
  const entry = AGENT_BINS[kind];
  if (!entry) return null;
  const override = env[entry.env];
  return override && override.trim() !== "" ? override : entry.bin;
}
