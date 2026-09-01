import { describe, expect, it } from "vitest";
import { SPACE_COLORS, SPACE_ICONS, pickSpaceColor, parseSpaceIcon, acpBuildMode, acpPlanMode, acpSessionConfig, acpWellKnownMode, parseAcpConfigOptions, AGENT_CLI_COMMANDS, AGENT_META, AGENT_MODELS, AGENT_LOGIN_HINTS, AGENT_SUPPORTS_PERMISSION_MODES, AGENT_SUPPORTS_PLAN_MODE, DEFAULT_MODEL_LABEL, PERMISSION_MODES, PLAN_PERMISSION_MODE, SELECTABLE_AGENT_KINDS, SESSION_MODES, type AcpSessionMode } from "./presets";
import { AgentKindSchema } from "./entities";
describe("presets", () => {
  it("has at least 8 colors and a lot more icons", () => { expect(SPACE_COLORS.length).toBeGreaterThanOrEqual(8); expect(SPACE_ICONS.length).toBeGreaterThanOrEqual(50); });
  it("has no duplicate icon names", () => { expect(new Set(SPACE_ICONS).size).toBe(SPACE_ICONS.length); });
  it("pickSpaceColor cycles by index", () => { expect(pickSpaceColor(0)).toBe(SPACE_COLORS[0]); expect(pickSpaceColor(SPACE_COLORS.length)).toBe(SPACE_COLORS[0]); });
});

describe("parseSpaceIcon", () => {
  it("parses a bare name (every icon ever stored before user-generated icons existed) as a hugeicon", () => {
    expect(parseSpaceIcon("folder")).toEqual({ kind: "hugeicon", name: "folder" });
  });
  it("parses emoji: and asset: prefixes", () => {
    expect(parseSpaceIcon("emoji:🚀")).toEqual({ kind: "emoji", char: "🚀" });
    expect(parseSpaceIcon("asset:01ABC")).toEqual({ kind: "asset", id: "01ABC" });
  });
  it("parses an explicit hugeicon: prefix", () => {
    expect(parseSpaceIcon("hugeicon:rocket")).toEqual({ kind: "hugeicon", name: "rocket" });
  });
  it("degrades a malformed prefix (nothing after the colon) to a hugeicon lookup, never throwing", () => {
    expect(parseSpaceIcon("emoji:")).toEqual({ kind: "hugeicon", name: "emoji:" });
    expect(parseSpaceIcon("asset:")).toEqual({ kind: "hugeicon", name: "asset:" });
  });
});

describe("AGENT_LOGIN_HINTS", () => {
  it("has a hint for every agent kind that has display metadata", () => {
    for (const kind of Object.keys(AGENT_META)) {
      expect(typeof AGENT_LOGIN_HINTS[kind as keyof typeof AGENT_LOGIN_HINTS]).toBe("string");
    }
  });
  it("names the exact command for each CLI", () => {
    expect(AGENT_LOGIN_HINTS.claude).toContain("claude auth login");
    expect(AGENT_LOGIN_HINTS.codex).toContain("codex login");
    expect(AGENT_LOGIN_HINTS["acp:cursor"]).toContain("cursor-agent login");
  });
});

describe("AGENT_CLI_COMMANDS", () => {
  it("has an entry for every agent kind that has display metadata", () => {
    expect(Object.keys(AGENT_CLI_COMMANDS).sort()).toEqual(Object.keys(AGENT_META).sort());
  });
  it("never collapses install and login into the same command", () => {
    // The install card picks one or the other from the probe; handing a user `codex login` when codex
    // isn't installed (or the install command when they're merely signed out) is a dead end.
    for (const [kind, { install, login }] of Object.entries(AGENT_CLI_COMMANDS)) {
      if (install !== null && login !== null) expect(install, kind).not.toBe(login);
    }
    expect(AGENT_CLI_COMMANDS.claude.install).not.toBe(AGENT_CLI_COMMANDS.claude.login);
    expect(AGENT_CLI_COMMANDS.codex.install).not.toBe(AGENT_CLI_COMMANDS.codex.login);
  });
  it("gives every selectable kind a real install command", () => {
    for (const kind of SELECTABLE_AGENT_KINDS) expect(AGENT_CLI_COMMANDS[kind].install, kind).toBeTruthy();
  });
  it("agrees with the prose login hints on the command name", () => {
    expect(AGENT_LOGIN_HINTS.claude).toContain(AGENT_CLI_COMMANDS.claude.login);
    expect(AGENT_LOGIN_HINTS.codex).toContain(AGENT_CLI_COMMANDS.codex.login);
    expect(AGENT_LOGIN_HINTS["acp:cursor"]).toContain(AGENT_CLI_COMMANDS["acp:cursor"].login);
  });
  it("is honest about the kinds with no single command", () => {
    expect(AGENT_CLI_COMMANDS.fake).toEqual({ install: null, login: null }); // compiled in
    expect(AGENT_CLI_COMMANDS["acp:gemini"].login).toBeNull();               // needs an API key, not a login
  });
});

describe("AGENT_SUPPORTS_PLAN_MODE", () => {
  it("has an entry for every agent kind that has display metadata", () => {
    expect(Object.keys(AGENT_SUPPORTS_PLAN_MODE).sort()).toEqual(Object.keys(AGENT_META).sort());
  });
  it("is true exactly where an adapter actually acts on the plan mode", () => {
    // claude: Claude Code's own `permissionMode: "plan"`.
    // codex:  codexPolicyFor("plan") → approvalPolicy "untrusted" + sandbox "read-only".
    expect(AGENT_SUPPORTS_PLAN_MODE.claude).toBe(true);
    expect(AGENT_SUPPORTS_PLAN_MODE.codex).toBe(true);
    // ACP mode ids are agent-defined; AcpAdapter never transmits Realm's, so a Plan chip would be inert.
    expect(AGENT_SUPPORTS_PLAN_MODE["acp:cursor"]).toBe(false);
    expect(AGENT_SUPPORTS_PLAN_MODE["acp:gemini"]).toBe(false);
  });
});

describe("PERMISSION_MODES", () => {
  it("no longer carries Plan — that is the mode axis, not the permission axis", () => {
    expect(PERMISSION_MODES.map((m) => m.id)).toEqual(["default", "acceptEdits", "bypassPermissions"]);
    expect(PERMISSION_MODES.map((m) => m.id)).not.toContain(PLAN_PERMISSION_MODE);
  });
  it("still names Plan's wire value, which the adapters read off `permissionMode`", () => {
    // Splitting the axes was a UI change; the transport did not move.
    expect(PLAN_PERMISSION_MODE).toBe("plan");
    expect(SESSION_MODES.map((m) => m.id)).toEqual(["build", "plan"]);
  });
});

describe("DEFAULT_MODEL_LABEL", () => {
  it("names the head of the kind's own model list", () => {
    // The prompter leans on this: a session with `model: null` runs the adapter's default, and the
    // model picker marks AGENT_MODELS[kind][0] as the selected row on that basis. If the two ever
    // drift, the picker would tick a model the session is not on.
    for (const [kind, models] of Object.entries(AGENT_MODELS)) {
      if (models.length === 0) continue;
      expect(models[0]!.label, kind).toContain(DEFAULT_MODEL_LABEL[kind as keyof typeof DEFAULT_MODEL_LABEL]);
    }
  });
});

describe("AGENT_SUPPORTS_PERMISSION_MODES", () => {
  it("has an entry for every agent kind that has display metadata", () => {
    for (const kind of Object.keys(AGENT_META)) {
      expect(typeof AGENT_SUPPORTS_PERMISSION_MODES[kind as keyof typeof AGENT_SUPPORTS_PERMISSION_MODES]).toBe("boolean");
    }
    expect(Object.keys(AGENT_SUPPORTS_PERMISSION_MODES).sort()).toEqual(Object.keys(AGENT_META).sort());
  });
  it("marks the ACP kinds as unable to carry Realm's permission modes", () => {
    // ACP mode ids are agent-defined, so Realm's own ids are never transmitted by AcpAdapter.start().
    expect(AGENT_SUPPORTS_PERMISSION_MODES["acp:cursor"]).toBe(false);
    expect(AGENT_SUPPORTS_PERMISSION_MODES["acp:gemini"]).toBe(false);
    expect(AGENT_SUPPORTS_PERMISSION_MODES.claude).toBe(true);
    expect(AGENT_SUPPORTS_PERMISSION_MODES.codex).toBe(true);
  });
});

describe("SELECTABLE_AGENT_KINDS", () => {
  it("only lists kinds that are real agents with display metadata, models and a default model label", () => {
    for (const kind of SELECTABLE_AGENT_KINDS) {
      expect(AgentKindSchema.safeParse(kind).success).toBe(true);
      expect(AGENT_META[kind]).toBeDefined();
      expect(AGENT_MODELS[kind]).toBeDefined();
      expect(typeof DEFAULT_MODEL_LABEL[kind]).toBe("string");
    }
    expect(new Set(SELECTABLE_AGENT_KINDS).size).toBe(SELECTABLE_AGENT_KINDS.length);
  });
  it("deliberately withholds the dead-end and dev-only kinds while keeping them registered", () => {
    // Both still have metadata (existing sessions keep working); neither is offered as a new choice.
    expect(SELECTABLE_AGENT_KINDS).not.toContain("acp:gemini"); // free personal tier discontinued
    expect(SELECTABLE_AGENT_KINDS).not.toContain("fake");       // scripted dev adapter
    expect(AGENT_META["acp:gemini"]).toBeDefined();
    expect(AGENT_META.fake).toBeDefined();
  });
});

describe("acpPlanMode / acpBuildMode (Plan 14 W3)", () => {
  // The real cursor-agent 2026.07.25 handshake, captured live 2026-09-01.
  const CURSOR: AcpSessionMode[] = [
    { id: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
    { id: "plan", name: "Plan", description: "Read-only mode for planning and designing before implementation" },
    { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
  ];
  it("finds Cursor's plan mode by the agent's own id", () => {
    expect(acpPlanMode(CURSOR)?.id).toBe("plan");
    expect(acpPlanMode(CURSOR)?.description).toContain("Read-only");
  });
  it("matches on id, never on a name that merely sounds like Plan", () => {
    // The lie the per-session capability exists to end: a mode Realm HOPES means plan-only.
    expect(acpPlanMode([{ id: "design", name: "Plan" }, { id: "agent", name: "Agent" }])).toBeNull();
  });
  it("answers null for no modes at all", () => {
    expect(acpPlanMode([])).toBeNull();
    expect(acpPlanMode(null)).toBeNull();
    expect(acpPlanMode(undefined)).toBeNull();
  });
  it("maps Build onto the agent's `agent` mode when it has one", () => {
    expect(acpBuildMode(CURSOR, null)?.id).toBe("agent");
    // …even when the session booted elsewhere: `agent` is the mode Build claims to be.
    expect(acpBuildMode(CURSOR, "ask")?.id).toBe("agent");
  });
  it("falls back to the boot mode, but never to the plan mode itself", () => {
    const noAgent: AcpSessionMode[] = [{ id: "chat", name: "Chat" }, { id: "plan", name: "Plan" }];
    expect(acpBuildMode(noAgent, "chat")?.id).toBe("chat");
    // Booted in plan with no `agent` id: leaving Plan has nowhere honest to go.
    expect(acpBuildMode(noAgent, "plan")).toBeNull();
    expect(acpBuildMode(noAgent, null)).toBeNull();
    expect(acpBuildMode(null, "agent")).toBeNull();
  });
});

/**
 * Payloads captured from real `session/new` answers on 2026-09-01 (Plan 18 §2). These are fixtures of
 * observed wire traffic, not of what the spec says — which is the whole point: the spec's `modes` field
 * is deprecated and agents have already split three ways.
 */
/** opencode 1.18.13 — `configOptions` ONLY. No `modes`, no `models`. */
const OPENCODE_SESSION = {
  sessionId: "ses_abc",
  configOptions: [
    { id: "model", category: "model", type: "select", currentValue: "opencode/big-pickle",
      options: [{ value: "opencode/big-pickle", name: "Big Pickle" }, { value: "anthropic/claude-opus-5", name: "Claude Opus 5" }] },
    { id: "mode", category: "mode", type: "select", currentValue: "build",
      options: [{ value: "build" }, { value: "plan" }] },
  ],
};
/** cursor-agent 2026.07.25 — the deprecated shape only. */
const CURSOR_SESSION = {
  sessionId: "ses_cur",
  modes: { currentModeId: "agent", availableModes: [
    { id: "agent", name: "Agent" }, { id: "plan", name: "Plan", description: "Read-only mode" }, { id: "ask", name: "Ask" }] },
  models: { currentModelId: "default[]", availableModels: [
    { modelId: "default[]", name: "Auto" }, { modelId: "composer-2.5[fast=true]", name: "Composer Fast" }] },
};

describe("acpWellKnownMode — bare id or ACP spec URI, never a name (Plan 18 §2)", () => {
  it("matches the bare id and the spec URI form, and nothing else", () => {
    expect(acpWellKnownMode("plan", "plan")).toBe(true);
    expect(acpWellKnownMode("https://agentclientprotocol.com/protocol/session-modes#plan", "plan")).toBe(true);
    expect(acpWellKnownMode("agent", "agent")).toBe(true);
    expect(acpWellKnownMode("https://agentclientprotocol.com/protocol/session-modes#agent", "agent")).toBe(true);
    // Kills a `.endsWith("plan")` or `.includes("plan")` mutation, which would match a mode named by a
    // hostile or merely careless agent — the fuzzy matching acpPlanMode's doc comment refuses.
    expect(acpWellKnownMode("planning", "plan")).toBe(false);
    expect(acpWellKnownMode("https://evil.example.com/#plan", "plan")).toBe(false);
    expect(acpWellKnownMode("plan", "agent")).toBe(false);
  });

  it("lets acpPlanMode and acpBuildMode see URI-shaped ids", () => {
    const uri = (m: string) => `https://agentclientprotocol.com/protocol/session-modes#${m}`;
    const copilot = [{ id: uri("agent"), name: "Agent" }, { id: uri("plan"), name: "Plan" }];
    // Kills reverting the helpers to `m.id === "plan"`, which gives Copilot no Plan chip at all.
    expect(acpPlanMode(copilot)?.id).toBe(uri("plan"));
    expect(acpBuildMode(copilot, null)?.id).toBe(uri("agent"));
    // ...and a boot mode that IS the URI-shaped plan must not be offered as Build.
    expect(acpBuildMode([{ id: uri("plan"), name: "Plan" }], uri("plan"))).toBeNull();
  });
});

describe("parseAcpConfigOptions", () => {
  it("drops entries with no string id rather than repairing them", () => {
    // A config option Realm cannot address is one it must not offer — a repaired id would be written
    // back to the agent and silently rejected.
    const rows = parseAcpConfigOptions([{ category: "mode" }, { id: "", category: "mode" }, { id: "mode", category: "mode" }, "junk", null]);
    expect(rows.map((r) => r.id)).toEqual(["mode"]);
  });

  it("accepts an option as a bare string or an object, and falls back to the value for a missing name", () => {
    const [row] = parseAcpConfigOptions([{ id: "mode", category: "mode", options: ["build", { value: "plan", name: "Plan" }, { name: "no value" }] }]);
    // opencode emits `{"value":"build"}` with no name; the label must be the value, never invented.
    expect(row!.options).toEqual([
      { value: "build", name: null, description: null },
      { value: "plan", name: "Plan", description: null },
    ]);
  });
});

describe("acpSessionConfig — configOptions wins, with the write channel carried alongside", () => {
  it("reads opencode's configOptions-only answer, which the deprecated fields would miss entirely", () => {
    const cfg = acpSessionConfig(OPENCODE_SESSION);
    // Kills reverting to reading `session.modes`/`session.models`: opencode would get an empty mode
    // list (no Plan chip) and an empty model list (one dead picker row), silently.
    expect(cfg.modes.map((m) => m.id)).toEqual(["build", "plan"]);
    expect(cfg.currentModeId).toBe("build");
    expect(cfg.models.map((m) => m.id)).toEqual(["opencode/big-pickle", "anthropic/claude-opus-5"]);
    expect(cfg.currentModelId).toBe("opencode/big-pickle");
    // The seam: non-null means the write is session/set_config_option with THIS id.
    expect(cfg.modeConfigId).toBe("mode");
    expect(cfg.modelConfigId).toBe("model");
    expect(acpPlanMode(cfg.modes)?.id).toBe("plan");
  });

  it("falls back to the deprecated shape for an agent that only speaks it, and reports NO config id", () => {
    const cfg = acpSessionConfig(CURSOR_SESSION);
    expect(cfg.modes.map((m) => m.id)).toEqual(["agent", "plan", "ask"]);
    expect(cfg.currentModeId).toBe("agent");
    expect(cfg.models.map((m) => m.id)).toEqual(["default[]", "composer-2.5[fast=true]"]);
    expect(cfg.models[0]!.label).toBe("Auto");
    // Kills a mutation that returns a config id unconditionally — Cursor would then be written to via
    // session/set_config_option, which it does not implement, and every mode switch would silently fail.
    expect(cfg.modeConfigId).toBeNull();
    expect(cfg.modelConfigId).toBeNull();
  });

  it("prefers configOptions when an agent dual-emits both (Copilot)", () => {
    const both = { ...CURSOR_SESSION, configOptions: OPENCODE_SESSION.configOptions };
    const cfg = acpSessionConfig(both);
    // The spec says clients SHOULD use configOptions when present. Kills a fallback-first mutation,
    // which would read one channel and write on the other.
    expect(cfg.modes.map((m) => m.id)).toEqual(["build", "plan"]);
    expect(cfg.modeConfigId).toBe("mode");
  });

  it("survives a session answer with neither shape, and one that is not an object at all", () => {
    for (const bad of [{ sessionId: "x" }, null, undefined, "nope", 42, []]) {
      const cfg = acpSessionConfig(bad);
      expect(cfg.modes).toEqual([]);
      expect(cfg.models).toEqual([]);
      expect(cfg.modeConfigId).toBeNull();
      expect(cfg.currentModeId).toBeNull();
    }
  });

  it("skips a config option whose category is neither mode nor model", () => {
    const cfg = acpSessionConfig({ configOptions: [{ id: "verbosity", category: "output", options: [{ value: "terse" }] }] });
    expect(cfg.modes).toEqual([]);
    expect(cfg.models).toEqual([]);
  });
});
