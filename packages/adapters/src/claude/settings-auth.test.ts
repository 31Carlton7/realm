import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { carrySettingsAuth } from "./settings-auth";

/** A scratch home whose `.claude/settings.json` holds `settings` — or holds nothing, when omitted.
 *  Returned as the env the module resolves the file through, so the user's real home is never read.
 *  PATH rides along because the helpers below are shell commands (`touch`, `sleep`), and a helper
 *  that failed on an empty PATH would make "the helper never ran" assertions pass for free. */
function homeWith(settings?: unknown): Record<string, string | undefined> {
  const home = tempDir("realm-settings-auth-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(home, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return { HOME: home, PATH: process.env.PATH };
}

describe("carrySettingsAuth", () => {
  it("carries nothing when there is no settings file, and never throws on one that is not a JSON object", async () => {
    // All of these mean "this machine authenticates some other way": the session must be exactly
    // what it was. `null` is the sharp one — valid JSON whose property reads would throw.
    expect(await carrySettingsAuth({ env: homeWith() })).toEqual({});
    expect(await carrySettingsAuth({ env: homeWith("{ not json") })).toEqual({});
    expect(await carrySettingsAuth({ env: homeWith("null") })).toEqual({});
  });

  it("carries the env block's string entries, and only those", async () => {
    // The child environment can hold nothing but strings; a number or null here is a settings file
    // the CLI itself would reject, not something to coerce.
    const env = homeWith({ env: { ANTHROPIC_BASE_URL: "https://gw.example", RETRIES: 3, EMPTY: null } });
    expect(await carrySettingsAuth({ env })).toEqual({ ANTHROPIC_BASE_URL: "https://gw.example" });
  });

  it("mints the helper's trimmed stdout under both credential names when none exists anywhere", async () => {
    // Both names on purpose: a gateway may authenticate on `x-api-key` (ANTHROPIC_API_KEY) or on
    // `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN); a helper login must satisfy either kind.
    const env = homeWith({ env: { ANTHROPIC_BASE_URL: "https://gw.example" }, apiKeyHelper: "printf '  sk-minted-1\\n'" });
    expect(await carrySettingsAuth({ env })).toEqual({ ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_API_KEY: "sk-minted-1", ANTHROPIC_AUTH_TOKEN: "sk-minted-1" });
  });

  it("runs the helper under the carried env block and Realm's overrides, which may hold what it reads", async () => {
    const env = homeWith({ env: { REALM_PROBE_TOKEN: "sk-from-block" }, apiKeyHelper: 'printf %s "$REALM_PROBE_TOKEN$REALM_PROBE_OVERRIDE"' });
    expect((await carrySettingsAuth({ env, overrides: { REALM_PROBE_OVERRIDE: "-and-override" } })).ANTHROPIC_API_KEY).toBe("sk-from-block-and-override");
  });

  it("runs the helper from the session's cwd, so a relative helper path resolves against the project", async () => {
    const project = tempDir("realm-settings-auth-project-");
    writeFileSync(join(project, "mint"), "#!/bin/sh\nprintf sk-rel", { mode: 0o755 });
    const env = homeWith({ apiKeyHelper: "./mint" });
    expect((await carrySettingsAuth({ env, cwd: project })).ANTHROPIC_API_KEY).toBe("sk-rel");
  });

  it("refuses stdout that is not one printable line — a control character would come back out of a spawn error with the key inside", async () => {
    for (const helper of ["printf 'sk-two\\nlines'", "printf 'sk-nul\\0bad'"]) {
      const logs: string[] = [];
      const env = homeWith({ apiKeyHelper: helper });
      expect((await carrySettingsAuth({ env, onLog: (l) => logs.push(l) })).ANTHROPIC_API_KEY, helper).toBeUndefined();
      expect(logs.join("\n"), helper).toContain("apiKeyHelper");
    }
  });

  it("reports a failed helper by exit status alone — its stderr is where a credential could land", async () => {
    const logs: string[] = [];
    const env = homeWith({ apiKeyHelper: "echo sk-oops-not-for-logs >&2; exit 3" });
    expect(await carrySettingsAuth({ env, onLog: (l) => logs.push(l) })).toEqual({});
    expect(logs.join("\n")).toContain("exit 3");
    expect(logs.join("\n")).not.toContain("sk-oops-not-for-logs");
  });

  it("never runs the helper when a credential is already in reach — base env, env block, or overrides", async () => {
    // The marker file is the assertion: a helper that ran wrote it, whatever else it returned.
    const cases: Array<{ env?: Record<string, string>; blockKey?: string; overrides?: Record<string, string> }> = [
      { env: { ANTHROPIC_API_KEY: "sk-process" } },
      { env: { ANTHROPIC_AUTH_TOKEN: "tok-bearer" } },
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-process" } },
      { blockKey: "ANTHROPIC_API_KEY" },
      { overrides: { ANTHROPIC_API_KEY: "sk-realm" } },
    ];
    for (const [i, c] of cases.entries()) {
      const marker = join(tempDir("realm-settings-auth-marker-"), "ran");
      const home = homeWith({ env: { ...(c.blockKey ? { [c.blockKey]: "sk-block" } : {}) }, apiKeyHelper: `touch ${marker}` });
      const carried = await carrySettingsAuth({ env: { ...home, ...c.env }, overrides: c.overrides });
      expect(existsSync(marker), `case ${i}: the helper ran`).toBe(false);
      // Nothing minted means the credential that suppressed the run is the one the merge keeps —
      // in particular Realm's own `opts.env`, which goes on top of everything carried.
      if (!c.blockKey) expect(carried.ANTHROPIC_API_KEY, `case ${i}`).toBeUndefined();
    }
  });

  it("proceeds without a key — env block intact, onLog told — when the helper fails, prints nothing, or times out", async () => {
    for (const [helper, timeoutMs] of [["exit 3", undefined], ["true", undefined], ["sleep 5", 200]] as const) {
      const logs: string[] = [];
      const env = homeWith({ env: { ANTHROPIC_BASE_URL: "https://gw.example" }, apiKeyHelper: helper });
      const began = Date.now();
      const carried = await carrySettingsAuth({ env, onLog: (l) => logs.push(l), timeoutMs });
      // The deadline must be enforced, not survived: `sleep 5` finishing on its own would satisfy
      // every other assertion here and prove nothing about the timeout.
      if (timeoutMs) expect(Date.now() - began, helper).toBeLessThan(3000);
      // The same failed login as before the carry existed, but no longer a silent one.
      expect(carried, helper).toEqual({ ANTHROPIC_BASE_URL: "https://gw.example" });
      expect(logs.join("\n"), helper).toContain("apiKeyHelper");
    }
  });
});
