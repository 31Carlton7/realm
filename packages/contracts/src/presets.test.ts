import { describe, expect, it } from "vitest";
import { SPACE_COLORS, SPACE_ICONS, pickSpaceColor, parseSpaceIcon, acpBuildMode, acpPlanMode, AGENT_CLI_COMMANDS, AGENT_META, AGENT_MODELS, AGENT_LOGIN_HINTS, AGENT_SUPPORTS_PERMISSION_MODES, AGENT_SUPPORTS_PLAN_MODE, DEFAULT_MODEL_LABEL, PERMISSION_MODES, PLAN_PERMISSION_MODE, SELECTABLE_AGENT_KINDS, SESSION_MODES, type AcpSessionMode } from "./presets";
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
