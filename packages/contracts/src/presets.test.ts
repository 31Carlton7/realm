import { describe, expect, it } from "vitest";
import { SPACE_COLORS, SPACE_ICONS, pickSpaceColor, parseSpaceIcon, acpBuildMode, acpPlanMode, acpSessionConfig, acpWellKnownMode, parseAcpConfigOptions, AGENT_CLI_COMMANDS, AGENT_META, AGENT_MODELS, AGENT_LOGIN_HINTS, AGENT_SUPPORTS_ASK_MODE, AGENT_SUPPORTS_PERMISSION_MODES, AGENT_SUPPORTS_PLAN_MODE, ASK_PERMISSION_MODE, acpAskMode, isReadOnlyMode, sessionModeOf, modeWireValue, DEFAULT_MODEL_LABEL, PERMISSION_MODES, PLAN_PERMISSION_MODE, SELECTABLE_AGENT_KINDS, SESSION_MODES, type AcpSessionMode } from "./presets";
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
  it("still names Plan's and Ask's wire values, which the adapters read off `permissionMode`", () => {
    // Splitting the axes was a UI change; the transport did not move.
    expect(PLAN_PERMISSION_MODE).toBe("plan");
    expect(ASK_PERMISSION_MODE).toBe("ask");
    expect(SESSION_MODES.map((m) => m.id)).toEqual(["build", "plan", "ask"]);
    expect(PERMISSION_MODES.map((m) => m.id)).not.toContain(ASK_PERMISSION_MODE);
  });
  it("calls the `default` rung `Ask each time`, so it cannot be mistaken for the Ask MODE", () => {
    // The mutant: relabelling it back to "Ask". Two controls in the same row would then both offer
    // something called Ask, meaning two unrelated things — per-action prompting, and read-only Q&A.
    const labels = PERMISSION_MODES.map((m) => m.label);
    expect(labels).not.toContain("Ask");
    expect(labels).toContain("Ask each time");
    expect(SESSION_MODES.map((m) => m.label)).toContain("Ask");
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
  it("withholds the dev-only kind while keeping it registered, and offers Gemini again", () => {
    // `fake` stays withheld and still has metadata: it is the scripted dev adapter, and an existing
    // fake session must keep working.
    expect(SELECTABLE_AGENT_KINDS).not.toContain("fake");
    expect(AGENT_META.fake).toBeDefined();
    // Gemini WAS withheld as a dead end. Measured 2026-09-01 against gemini-cli 0.56.0: only the free
    // personal tier is dead; an API key, Vertex AI, and a custom gateway all still open a session. So
    // withholding it is no longer the honest call — offering it with the live routes named is.
    expect(SELECTABLE_AGENT_KINDS).toContain("acp:gemini");
    expect(AGENT_LOGIN_HINTS["acp:gemini"]).toMatch(/Vertex AI/);
  });

  it("offers every ACP agent whose handshake was verified, and each is on the generic ACP adapter", () => {
    // Kills a mutation that adds a kind to AgentKindSchema and its tables but forgets the picker —
    // the agent would be registered, probed, and unreachable.
    for (const k of ["acp:opencode", "acp:copilot", "acp:goose", "acp:qwen", "acp:grok", "acp:fx"] as const) {
      expect(SELECTABLE_AGENT_KINDS, k).toContain(k);
      expect(AGENT_META[k].label).toBeTruthy();
      // The `acp:` prefix is a promise about the protocol, not a naming habit: it means the kind rides
      // the generic AcpAdapter, so its permission/plan/skills/memory answers must match Cursor's.
      expect(AGENT_SUPPORTS_PERMISSION_MODES[k], k).toBe(false);
      expect(AGENT_SUPPORTS_PLAN_MODE[k], k).toBe(false);
      expect(AGENT_SUPPORTS_ASK_MODE[k], k).toBe(false);
    }
  });
});

describe("AGENT_SUPPORTS_ASK_MODE", () => {
  it("has an entry for every agent kind, so a new kind cannot be silently offered Ask", () => {
    expect(Object.keys(AGENT_SUPPORTS_ASK_MODE).sort()).toEqual(Object.keys(AGENT_META).sort());
  });
  it("claims Ask only where an adapter actually refuses the call", () => {
    // Claude denies in canUseTool, Codex runs read-only with approvals disabled. Every ACP kind is
    // false as the pre-handshake floor — acpAskMode answers per session.
    expect(AGENT_SUPPORTS_ASK_MODE.claude).toBe(true);
    expect(AGENT_SUPPORTS_ASK_MODE.codex).toBe(true);
    for (const k of Object.keys(AGENT_SUPPORTS_ASK_MODE)) {
      if (k.startsWith("acp:")) expect(AGENT_SUPPORTS_ASK_MODE[k as keyof typeof AGENT_SUPPORTS_ASK_MODE], k).toBe(false);
    }
  });
});

describe("the mode axis on the permissionMode wire", () => {
  it("round-trips every mode through the field it travels on", () => {
    for (const m of SESSION_MODES) {
      const wire = modeWireValue(m.id);
      // Build is the ABSENCE of a wire value; the other two are their own strings.
      expect(sessionModeOf(wire ?? "default")).toBe(m.id);
    }
    expect(modeWireValue("build")).toBeNull();
  });
  it("reads a permission as Build, so a session on `acceptEdits` is not in some mode of its own", () => {
    for (const p of PERMISSION_MODES) expect(sessionModeOf(p.id)).toBe("build");
    expect(sessionModeOf("some-adapter-string")).toBe("build");
  });
  it("calls exactly Plan and Ask read-only", () => {
    // The mutant: dropping `ask` from isReadOnlyMode. Every gate that refuses mutations in Plan —
    // the browser broker above all — would let an Ask session through, which is the one failure a
    // read-only mode cannot have.
    expect(isReadOnlyMode(PLAN_PERMISSION_MODE)).toBe(true);
    expect(isReadOnlyMode(ASK_PERMISSION_MODE)).toBe(true);
    for (const p of PERMISSION_MODES) expect(isReadOnlyMode(p.id), p.id).toBe(false);
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
  it("falls back to the boot mode, but never to a read-only mode itself", () => {
    const noAgent: AcpSessionMode[] = [{ id: "chat", name: "Chat" }, { id: "plan", name: "Plan" }, { id: "ask", name: "Ask" }];
    expect(acpBuildMode(noAgent, "chat")?.id).toBe("chat");
    // Booted in plan with no `agent` id: leaving Plan has nowhere honest to go.
    expect(acpBuildMode(noAgent, "plan")).toBeNull();
    // The mutant: excluding only plan. A session that booted in Ask would "leave" Ask by being sent
    // straight back into it, and the chip would flip to Build over a session that never moved.
    expect(acpBuildMode(noAgent, "ask")).toBeNull();
    expect(acpBuildMode(noAgent, null)).toBeNull();
    expect(acpBuildMode(null, "agent")).toBeNull();
  });

  it("finds Cursor's ask mode by the agent's own id, and refuses a name that merely sounds like it", () => {
    expect(acpAskMode(CURSOR)?.id).toBe("ask");
    expect(acpAskMode(CURSOR)?.description).toContain("no edits or command execution");
    expect(acpAskMode([{ id: "chat", name: "Ask" }, { id: "agent", name: "Agent" }])).toBeNull();
    expect(acpAskMode([{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }])).toBeNull();
    expect(acpAskMode(null)).toBeNull();
  });

  it("reads the spec URI form of ask, the way Copilot reports plan", () => {
    const uri = "https://agentclientprotocol.com/protocol/session-modes#ask";
    expect(acpWellKnownMode(uri, "ask")).toBe(true);
    expect(acpAskMode([{ id: uri, name: "Ask" }])?.id).toBe(uri);
    // Plan and Ask must never resolve to each other.
    expect(acpWellKnownMode(uri, "plan")).toBe(false);
    expect(acpAskMode([{ id: "plan", name: "Plan" }])).toBeNull();
    expect(acpPlanMode([{ id: "ask", name: "Ask" }])).toBeNull();
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
