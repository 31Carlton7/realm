import { describe, expect, it } from "vitest";
import {
  AGENT_INSTALL_ROUTES, canRunUpdate, compareVersions, installCommand, isNewerVersion,
  parseBrewFormula, parseNpmLatest, parseVersion, updateChannel, updateCommand, updateRefusal,
} from "./cli";
import { AGENT_CLI_COMMANDS } from "./presets";
import { AgentKindSchema } from "./entities";

describe("AGENT_INSTALL_ROUTES", () => {
  it("covers every agent kind", () => {
    for (const kind of AgentKindSchema.options) expect(kind in AGENT_INSTALL_ROUTES).toBe(true);
  });

  it("regenerates exactly the install command presets already offer for copying", () => {
    for (const kind of AgentKindSchema.options) {
      expect(installCommand(AGENT_INSTALL_ROUTES[kind])).toBe(AGENT_CLI_COMMANDS[kind].install);
    }
  });

  it("gives fake no route, so nothing can offer to install the dev adapter", () => {
    expect(AGENT_INSTALL_ROUTES.fake).toBe(null);
    expect(installCommand(AGENT_INSTALL_ROUTES.fake)).toBe(null);
  });
});

describe("updateCommand", () => {
  it("pins npm to the version the check found, not @latest", () => {
    expect(updateCommand({ method: "npm", pkg: "@openai/codex" }, "0.153.4")).toBe("npm install -g @openai/codex@0.153.4");
  });

  it("upgrades a brew formula by name", () => {
    expect(updateCommand({ method: "brew", formula: "block-goose-cli" }, "1.9.0")).toBe("brew upgrade block-goose-cli");
  });

  it("refuses script installers, which cannot promise a version", () => {
    expect(updateCommand(AGENT_INSTALL_ROUTES["acp:fx"], "1.0.0")).toBe(null);
    expect(updateCommand(AGENT_INSTALL_ROUTES["acp:cursor"], "1.0.0")).toBe(null);
  });

  it("refuses with no route and with no version", () => {
    expect(updateCommand(null, "1.0.0")).toBe(null);
    expect(updateCommand({ method: "npm", pkg: "x" }, "")).toBe(null);
  });
});

describe("updateChannel", () => {
  it("escapes only the scope slash — an encoded @ 404s on the registry", () => {
    expect(updateChannel({ method: "npm", pkg: "@openai/codex" })?.url).toBe("https://registry.npmjs.org/@openai%2Fcodex/latest");
  });

  it("leaves an unscoped package alone", () => {
    expect(updateChannel({ method: "npm", pkg: "opencode-ai" })?.url).toBe("https://registry.npmjs.org/opencode-ai/latest");
  });

  it("points brew formulae at the public formula API", () => {
    expect(updateChannel({ method: "brew", formula: "block-goose-cli" })).toEqual({
      url: "https://formulae.brew.sh/api/formula/block-goose-cli.json", kind: "brew",
    });
  });

  it("has no channel for a script installer or a kind with no route", () => {
    expect(updateChannel(AGENT_INSTALL_ROUTES["acp:cursor"])).toBe(null);
    expect(updateChannel(null)).toBe(null);
  });
});

describe("registry parsers", () => {
  it("reads the version off an npm latest document", () => {
    expect(parseNpmLatest({ name: "@openai/codex", version: "0.153.4" })).toBe("0.153.4");
  });

  it("reads versions.stable off a brew formula, ignoring head", () => {
    expect(parseBrewFormula({ versions: { stable: "1.9.0", head: "HEAD" } })).toBe("1.9.0");
  });

  it("answers null rather than throwing on anything else", () => {
    for (const body of [null, undefined, {}, { version: 42 }, { version: "  " }, "nope", []]) {
      expect(parseNpmLatest(body)).toBe(null);
    }
    for (const body of [null, {}, { versions: {} }, { versions: { stable: 3 } }]) {
      expect(parseBrewFormula(body)).toBe(null);
    }
  });
});

describe("parseVersion", () => {
  it("pulls the version out of what each CLI actually prints", () => {
    expect(parseVersion("2.1.223 (Claude Code)")).toBe("2.1.223");
    expect(parseVersion("codex-cli 0.146.0")).toBe("0.146.0");
    expect(parseVersion("2026.09.01")).toBe("2026.09.01");
    expect(parseVersion("0.1.2-rc.3")).toBe("0.1.2-rc.3");
  });

  it("does not mistake a digit in a product name for a version", () => {
    expect(parseVersion("gpt-5-codex")).toBe(null);
    expect(parseVersion("grok 4")).toBe(null);
  });

  it("answers null for nothing at all", () => {
    expect(parseVersion(null)).toBe(null);
    expect(parseVersion("")).toBe(null);
    expect(parseVersion("unknown")).toBe(null);
  });
});

describe("compareVersions", () => {
  it("orders by numeric segment, not by string", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("2.1.223", "2.1.99")).toBeGreaterThan(0);
  });

  it("treats a missing trailing segment as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("orders a prerelease below the release that superseded it", () => {
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0-rc.1", "1.2.0-rc.2")).toBeLessThan(0);
  });
});

describe("isNewerVersion", () => {
  it("is true only when the registry is strictly ahead", () => {
    expect(isNewerVersion("codex-cli 0.146.0", "0.153.4")).toBe(true);
    expect(isNewerVersion("codex-cli 0.153.4", "0.153.4")).toBe(false);
    expect(isNewerVersion("codex-cli 0.154.0", "0.153.4")).toBe(false);
  });

  it("is false when either side cannot be parsed — 'cannot tell' is not 'update available'", () => {
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", null)).toBe(false);
    expect(isNewerVersion("unknown", "1.0.0")).toBe(false);
  });
});

describe("canRunUpdate", () => {
  it("runs an npm route only against an npm install", () => {
    const route = AGENT_INSTALL_ROUTES.codex;
    expect(canRunUpdate(route, "npm")).toBe(true);
    expect(canRunUpdate(route, "brew")).toBe(false);
    expect(canRunUpdate(route, "pnpm")).toBe(false);
    expect(canRunUpdate(route, "unknown")).toBe(false);
  });

  it("runs a brew route only against a brew install", () => {
    const route = AGENT_INSTALL_ROUTES["acp:goose"];
    expect(canRunUpdate(route, "brew")).toBe(true);
    expect(canRunUpdate(route, "npm")).toBe(false);
  });

  it("never runs a script route, whatever the provenance", () => {
    for (const p of ["npm", "pnpm", "brew", "unknown"] as const) {
      expect(canRunUpdate(AGENT_INSTALL_ROUTES["acp:fx"], p)).toBe(false);
    }
  });
});

describe("updateRefusal", () => {
  it("says nothing when the update can actually run", () => {
    expect(updateRefusal(AGENT_INSTALL_ROUTES.codex, "npm")).toBe(null);
  });

  it("names both the method that installed it and the one Realm would have used", () => {
    const why = updateRefusal(AGENT_INSTALL_ROUTES.codex, "brew");
    expect(why).toContain("Homebrew");
    expect(why).toContain("npm");
    expect(why).toContain("second copy");
  });

  it("explains a script installer as a versioning problem, not a provenance one", () => {
    expect(updateRefusal(AGENT_INSTALL_ROUTES["acp:fx"], "unknown")).toContain("script");
  });
});
