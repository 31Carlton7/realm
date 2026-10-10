import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@realm/contracts";
import { ExecutionSandboxService, type SandboxAvailability } from "./service";
import { sandboxWrapFor } from "./spawn-wrap";

const root = tempDir("realm-spawn-wrap-");
const home = join(root, "home");
const realm = join(root, "Realm");
const tmp = join(root, "tmp");
const checkout = join(root, "repo");
for (const d of [home, realm, tmp, checkout]) mkdirSync(d, { recursive: true });

class FakeSettings {
  rows = new Map<string, unknown>();
  get(key: string): unknown { return this.rows.has(key) ? this.rows.get(key) : null; }
  set(key: string, value: unknown): void { this.rows.set(key, value === undefined ? null : value); }
}
const environments = {
  list: (spaceId: string): Environment[] => [{
    id: "env_1", spaceId, path: checkout, branch: null, kind: "primary",
    portBlockStart: null, createdAt: 0, updatedAt: 0,
  }],
};

const YES: SandboxAvailability = { available: true, error: null, detail: "probe ran" };
const NO: SandboxAvailability = { available: false, error: "sandbox_unavailable", detail: "/usr/bin/sandbox-exec is missing or not executable." };

let settings: FakeSettings;
const service = (probe: () => SandboxAvailability = () => YES) =>
  new ExecutionSandboxService({ settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe });

beforeEach(() => { settings = new FakeSettings(); });

describe("sandboxWrapFor", () => {
  it("installs NOTHING for an un-opted-in space, so its spawns are untouched by this feature", () => {
    // The promise this release makes to the users it ships `off` for, as an assertion. An identity
    // wrapper would produce the same argv and would still be wrong: `ClaudeAdapter` keys
    // `spawnClaudeCodeProcess` on `wrap` being present, and `CodexAdapter` keys its refusal on it —
    // so "a wrapper that does nothing" is not the same thing as "no wrapper".
    //
    // MUTANT: return the wrapper unconditionally and every default-configuration Codex session
    // refuses to start.
    expect(sandboxWrapFor(service(), { spaceId: "sp_1" })).toBeUndefined();
  });

  it("installs a wrapper once the space has a posture, and it really wraps", () => {
    const s = service();
    s.setSpacePrefs("sp_1", { posture: "workspace-write", network: true });
    const wrap = sandboxWrapFor(s, { spaceId: "sp_1" });
    expect(wrap).toBeTypeOf("function");
    const out = wrap!("/bin/zsh", ["-l"]);
    expect(out.command).toBe("/usr/bin/sandbox-exec");
    // `--` then the original command: the argv that was handed in survives intact behind the policy.
    expect(out.args.slice(-3)).toEqual(["--", "/bin/zsh", "-l"]);
  });

  it("makes the session's own checkout writable through extraWritableRoots", () => {
    const s = service();
    s.setSpacePrefs("sp_1", { posture: "workspace-write", network: true });
    const scratch = join(root, "uncatalogued");
    mkdirSync(scratch, { recursive: true });
    // MUTANT: drop `extraWritableRoots` at the SessionService call site and a session opened on a
    // folder that is not one of the space's environments cannot write the directory it is working in.
    // The whole argv, because a writable root reaches `sandbox-exec` as a `-D` parameter rather than
    // as profile text — and as the path the KERNEL resolved, which under a temp dir is not the one
    // this test wrote down.
    const real = realpathSync(scratch);
    expect(sandboxWrapFor(s, { spaceId: "sp_1", extraWritableRoots: [scratch] })!("/bin/zsh", []).args.join(" ")).toContain(real);
    expect(sandboxWrapFor(s, { spaceId: "sp_1" })!("/bin/zsh", []).args.join(" ")).not.toContain(real);
  });

  it("throws rather than returning the bare command when Seatbelt cannot be applied", () => {
    const s = service(() => NO);
    s.setSpacePrefs("sp_1", { posture: "read-only", network: true });
    const wrap = sandboxWrapFor(s, { spaceId: "sp_1" });
    // The fail-closed gate, seen from the call sites' side: the wrapper exists, and using it throws.
    // Every spawn site is documented to let that throw travel.
    expect(() => wrap!("/bin/zsh", ["-l"])).toThrow(/sandbox-exec is missing/);
  });
});

/** The Claude config folder sp_1's profile names, and the one a session of that space still runs
 *  under because its conversation began there. */
const profileDir = join(root, "claude-work");
const sessionDir = join(root, "claude-before");
for (const d of [profileDir, sessionDir]) mkdirSync(d, { recursive: true });

/** A sandboxed service that knows the folder sp_1's profile names, as the app's does once a profile
 *  can name one. */
const withProfileFolder = (): ExecutionSandboxService => {
  const s = new ExecutionSandboxService({
    settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => YES,
    claudeDirOf: (spaceId) => (spaceId === "sp_1" ? profileDir : null),
  });
  s.setDefaults({ posture: "workspace-write", network: true });
  return s;
};

/** The roots a wrapped argv lets the process write: the values of its `REALM_WRITE_n` parameters. */
const writableIn = (args: readonly string[]): string[] =>
  args.filter((a) => /^REALM_WRITE_\d+=/.test(a)).map((a) => a.slice(a.indexOf("=") + 1));

describe("sandboxWrapFor and a Claude config folder", () => {
  it("installs nothing in a space with no sandbox, whatever folder the session or its profile names", () => {
    const s = new ExecutionSandboxService({
      settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => YES,
      claudeDirOf: () => profileDir,
    });
    expect(sandboxWrapFor(s, { spaceId: "sp_1", claudeDir: sessionDir })).toBeUndefined();
    expect(sandboxWrapFor(s, { spaceId: "sp_1" })).toBeUndefined();
  });

  it("makes the folder a session runs under writable, in place of the one its profile names", () => {
    const wrap = sandboxWrapFor(withProfileFolder(), { spaceId: "sp_1", claudeDir: sessionDir });
    const roots = writableIn(wrap!("/bin/zsh", []).args);
    expect(roots).toContain(realpathSync(sessionDir));
    expect(roots).not.toContain(realpathSync(profileDir));
  });

  it("wraps a session on the default folder as it would in a space whose profile names no folder", () => {
    const s = withProfileFolder();
    const wrap = sandboxWrapFor(s, { spaceId: "sp_1", claudeDir: null });
    const unnamed = sandboxWrapFor(s, { spaceId: "sp_2" });
    expect(wrap!("/bin/zsh", []).args).toEqual(unnamed!("/bin/zsh", []).args);
  });

  it("gives a terminal, which names no folder, the one its space's profile names", () => {
    const wrap = sandboxWrapFor(withProfileFolder(), { spaceId: "sp_1" });
    expect(writableIn(wrap!("/bin/zsh", ["-l"]).args)).toContain(realpathSync(profileDir));
  });

  it("keeps the checkout a session was opened on writable beside the folder it runs under", () => {
    const openedOn = join(root, "opened-on");
    mkdirSync(openedOn, { recursive: true });
    const wrap = sandboxWrapFor(withProfileFolder(), { spaceId: "sp_1", extraWritableRoots: [openedOn], claudeDir: sessionDir });
    expect(writableIn(wrap!("/bin/zsh", []).args)).toEqual(expect.arrayContaining([realpathSync(openedOn), realpathSync(sessionDir)]));
  });

  it("asks the sandbox what it asked before, key for key, for a spawn that names no folder or gives undefined for one", () => {
    for (const o of [{ spaceId: "sp_1" }, { spaceId: "sp_1", claudeDir: undefined }]) {
      const s = withProfileFolder();
      const policyFor = vi.spyOn(s, "policyFor");
      const wrap = vi.spyOn(s, "wrap");
      sandboxWrapFor(s, o)!("/bin/zsh", ["-l"]);
      expect(policyFor.mock.calls[0]).toEqual(["sp_1"]);
      expect(wrap.mock.calls.map(([handed]) => Object.keys(handed))).toEqual([["spaceId", "command", "args", "extraWritableRoots"]]);
    }
  });
});
