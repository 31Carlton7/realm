import { describe, expect, it } from "vitest";
import { SPACE_COLORS, SPACE_ICONS, pickSpaceColor, AGENT_CLI_COMMANDS, AGENT_META, AGENT_MODELS, AGENT_LOGIN_HINTS, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS } from "./presets";
import { AgentKindSchema } from "./entities";
describe("presets", () => {
  it("has at least 8 colors and icons", () => { expect(SPACE_COLORS.length).toBeGreaterThanOrEqual(8); expect(SPACE_ICONS.length).toBeGreaterThanOrEqual(8); });
  it("pickSpaceColor cycles by index", () => { expect(pickSpaceColor(0)).toBe(SPACE_COLORS[0]); expect(pickSpaceColor(SPACE_COLORS.length)).toBe(SPACE_COLORS[0]); });
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
