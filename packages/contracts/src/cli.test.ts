import { describe, expect, it } from "vitest";
import {
  AGENT_INSTALL_ROUTES, canRunUpdate, compareVersions, installCommand, isNewerVersion, updatePlan,
  parseBrewFormula, parseNpmLatest, parsePypiLatest, parseVersion, updateChannel, updateCommand, updateRefusal,
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

describe("the uv route", () => {
  it("carries the interpreter pin the package demands into the command", () => {
    // openhands declares `requires-python == 3.12.*`; without the pin uv resolves nothing on a
    // machine whose default is 3.13 or 3.14.
    expect(installCommand({ method: "uv", pkg: "openhands", python: "3.12" })).toBe("uv tool install --python 3.12 openhands");
  });

  it("omits the pin when there is none, rather than inventing a version", () => {
    expect(installCommand({ method: "uv", pkg: "ruff" })).toBe("uv tool install ruff");
  });

  it("updates by re-installing at the pinned version, so the button's version is the one landed", () => {
    expect(updateCommand({ method: "uv", pkg: "openhands", python: "3.12" }, "1.17.0")).toBe("uv tool install --python 3.12 openhands==1.17.0");
  });

  it("asks PyPI what the newest version is", () => {
    expect(updateChannel({ method: "uv", pkg: "openhands" })).toEqual({ url: "https://pypi.org/pypi/openhands/json", kind: "pypi" });
  });

  it("updates a uv install only when uv is what installed it", () => {
    const route = { method: "uv", pkg: "openhands" } as const;
    expect(canRunUpdate(route, "uv")).toBe(true);
    for (const p of ["npm", "pnpm", "brew", "unknown"] as const) expect(canRunUpdate(route, p), p).toBe(false);
  });

  it("names uv in the refusal, so the sentence says which manager Realm would have used", () => {
    expect(updateRefusal({ method: "uv", pkg: "openhands" }, "brew")).toContain("won't update it with uv");
  });

  it("will not run an npm route against a uv install, or the reverse", () => {
    expect(updatePlan({ method: "npm", pkg: "x" }, "uv", "acp:goose")).toBe(null);
    expect(updatePlan({ method: "uv", pkg: "openhands" }, "npm", "acp:goose")).toBe(null);
  });
});

describe("parsePypiLatest", () => {
  it("reads info.version, the field PyPI's project document carries it in", () => {
    expect(parsePypiLatest({ info: { version: "1.16.0" }, releases: { "1.15.0": [], "1.16.0": [] } })).toBe("1.16.0");
  });

  it("answers null rather than throwing on anything else", () => {
    expect(parsePypiLatest({ version: "1.16.0" })).toBe(null);
    expect(parsePypiLatest({ info: { version: "  " } })).toBe(null);
    expect(parsePypiLatest(null)).toBe(null);
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
  it("sends a scoped name in the form npm's registry documents", () => {
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
    // The document formulae.brew.sh actually returned for block-goose-cli on 2026-09-05. `head` is
    // the literal string "HEAD", so a parser reaching for the wrong key would return that as a
    // version and every comparison against it would be nonsense.
    expect(parseBrewFormula({ versions: { stable: "1.49.0", head: "HEAD", bottle: true } })).toBe("1.49.0");
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
    // Every string here was read off a real `--version` on 2026-09-05, except the last.
    expect(parseVersion("2.1.258 (Claude Code)")).toBe("2.1.258");
    expect(parseVersion("codex-cli 0.146.0")).toBe("0.146.0");
    expect(parseVersion("2026.07.25-e42b078")).toBe("2026.07.25-e42b078");
    expect(parseVersion("1.18.13")).toBe("1.18.13");
    expect(parseVersion("0.0.7")).toBe("0.0.7");
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

describe("the CLI's own updater", () => {
  it("outranks every provenance rule, because it is right for all of them", () => {
    /* The failure this fixes: claude installs a native binary to ~/.local/bin, which the provenance
       classifier honestly reports as `unknown`, so Realm refused to update the one CLI in the list
       that most obviously updates itself. Same command whether that copy came from npm, Homebrew or
       the native installer — which is exactly why the vendor publishes it. */
    for (const p of ["npm", "pnpm", "brew", "unknown"] as const) {
      expect(updatePlan(AGENT_INSTALL_ROUTES.claude, p, "claude")).toEqual({ method: "self", command: "claude update" });
      expect(canRunUpdate(AGENT_INSTALL_ROUTES.claude, p, "claude")).toBe(true);
      expect(updateRefusal(AGENT_INSTALL_ROUTES.claude, p, "claude")).toBe(null);
    }
  });

  it("reaches a script-route CLI, which no other method could", () => {
    // cursor-agent installs by piping a vendor script into a shell. There is no registry to ask and
    // no package to reinstall, so before `cursor-agent update` its row had no path forward at all.
    expect(updatePlan(AGENT_INSTALL_ROUTES["acp:cursor"], "unknown", "acp:cursor"))
      .toEqual({ method: "self", command: "cursor-agent update" });
  });

  it("takes no version, because none of them accept one", () => {
    // The npm command pins the exact version the check found; a self-updater resolves latest itself
    // at the moment it runs. Passing a version must not silently produce a different command.
    const plan = updatePlan(AGENT_INSTALL_ROUTES.codex, "npm", "codex")!;
    expect(updateCommand(plan, "")).toBe("codex update");
    expect(updateCommand(plan, "0.153.4")).toBe("codex update");
  });

  it("leaves the provenance rule standing for every CLI that has no updater of its own", () => {
    expect(updatePlan(AGENT_INSTALL_ROUTES["acp:gemini"], "npm", "acp:gemini")).toEqual(AGENT_INSTALL_ROUTES["acp:gemini"]);
    expect(updatePlan(AGENT_INSTALL_ROUTES["acp:gemini"], "unknown", "acp:gemini")).toBe(null);
    expect(updateRefusal(AGENT_INSTALL_ROUTES["acp:gemini"], "unknown", "acp:gemini")).toContain("second copy");
  });

  it("is never an install route: `claude update` cannot put claude on a machine", () => {
    expect(installCommand({ method: "self", command: "claude update" })).toBe(null);
    for (const route of Object.values(AGENT_INSTALL_ROUTES)) {
      expect(route?.method).not.toBe("self");
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
