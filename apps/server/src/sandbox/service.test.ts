import { readFileSync } from "node:fs";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_SANDBOX_DEFAULT_KEY, executionSandboxSpaceKey, type Environment } from "@realm/contracts";
import * as policyModule from "./policy";
import { resolveExecutionSandboxPolicy } from "./policy";
import { ExecutionSandboxService, probeSandboxExec, type SandboxAvailability } from "./service";
import { sandboxCommand } from "./spawn";

const root = tempDir("realm-sandbox-service-");
const home = join(root, "home");
const realm = join(root, "Realm");
const tmp = join(root, "tmp");
const checkout = join(root, "repo");
for (const d of [home, realm, tmp, checkout]) mkdirSync(d, { recursive: true });

/** The two stores this service touches, and nothing else — no database, no rpc, no spawning. */
class FakeSettings {
  rows = new Map<string, unknown>();
  get(key: string): unknown { return this.rows.has(key) ? this.rows.get(key) : null; }
  set(key: string, value: unknown): void { this.rows.set(key, value === undefined ? null : value); }
}
const environments = {
  list: (spaceId: string): Environment[] => spaceId === "sp_empty" ? [] : [{
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

describe("prefs", () => {

  it("reads a hand-corrupted settings row as 'not chosen' rather than as a posture of its own", () => {
    // What this guards is unchanged even though the shipped default is now `off`: a mangled row is
    // never OBEYED. It cannot switch the sandbox on for someone who never asked (junk that looks
    // like a posture name), and — the direction that actually costs something —
    for (const junk of ["workspace-write", { posture: "off!" }, 7, []]) {
      settings.rows.set(EXECUTION_SANDBOX_DEFAULT_KEY, junk);
      expect(service().defaults().posture).toBe("off");
    }
    // — it cannot take protection AWAY from a space whose default was deliberately turned on.
    const s = service();
    s.setDefaults({ posture: "workspace-write", network: true });
    for (const junk of ["off", { posture: "off!" }, 7, []]) {
      settings.rows.set(executionSandboxSpaceKey("sp_1"), junk);
      expect(s.prefsFor("sp_1")).toEqual({ prefs: { posture: "workspace-write", network: true }, inherited: true });
    }
  });

  it("lets a space override the default, and says the override is not inherited", () => {
    const s = service();
    s.setDefaults({ posture: "workspace-write", network: true });
    expect(s.prefsFor("sp_1")).toEqual({ prefs: { posture: "workspace-write", network: true }, inherited: true });
    s.setSpacePrefs("sp_1", { posture: "read-only", network: false });
    expect(s.prefsFor("sp_1")).toEqual({ prefs: { posture: "read-only", network: false }, inherited: false });
    // …and the neighbouring space is untouched.
    expect(s.prefsFor("sp_2").inherited).toBe(true);
  });

  it("clears an override back to the inherited default with null", () => {
    const s = service();
    // A default that DIFFERS from the override, because the shipped default is `off` and an
    // override of `off` cleared back to `off` would pass whether or not the clear did anything.
    s.setDefaults({ posture: "workspace-write", network: true });
    s.setSpacePrefs("sp_1", { posture: "off", network: true });
    expect(s.prefsFor("sp_1").prefs.posture).toBe("off");
    expect(s.setSpacePrefs("sp_1", null)).toEqual({ prefs: { posture: "workspace-write", network: true }, inherited: true });
    expect(settings.rows.get(executionSandboxSpaceKey("sp_1"))).toBeNull();
  });

  it("refuses to store a posture that does not exist", () => {
    expect(() => service().setSpacePrefs("sp_1", { posture: "yolo", network: true } as never)).toThrow();
    expect(settings.rows.has(executionSandboxSpaceKey("sp_1"))).toBe(false);
  });
});

describe("policyFor", () => {
  /** The posture is stated rather than inherited: the SHIPPED default is `off`, which resolves to an
   *  empty policy, and these tests are about what a sandbox contains — not about what ships. */
  const on = (probe: () => SandboxAvailability = () => YES) => {
    const s = service(probe);
    s.setDefaults({ posture: "workspace-write", network: true });
    return s;
  };

  it("makes the space's own checkout writable and protects the credential dirs", () => {
    const p = on().policyFor("sp_1");
    expect(p.writableRoots.some((r) => r.endsWith("/repo"))).toBe(true);
    expect(p.protectedRoots.some((r) => r.endsWith("/.ssh"))).toBe(true);
  });

  it("sees a checkout added after the service was built — nothing here is cached", () => {
    const s = on();
    expect(s.policyFor("sp_empty").writableRoots.some((r) => r.endsWith("/repo"))).toBe(false);
    expect(s.policyFor("sp_1").writableRoots.some((r) => r.endsWith("/repo"))).toBe(true);
  });

  it("resolves an unchosen space to `off`, so an untouched Realm compiles no profile at all", () => {
    // The shape of the opt-in default, at the layer that decides it. MUTANT: give the service its
    // own fallback posture instead of reading the contract's and this is the cell that changes.
    expect(service().policyFor("sp_1")).toEqual({
      posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true,
    });
  });
});

describe("the fail-closed gate", () => {
  /*
   * The matrix that matters. Every cell is (posture chosen) × (can the mechanism be applied), and
   * the assertion is that exactly one shape of outcome exists per cell — in particular that an
   * unsandboxed command is only ever produced by the user's own `off`, never by a failure.
   */
  const postures = ["workspace-write", "read-only", "off"] as const;

  for (const posture of postures) {
    it(`${posture} + an available sandbox`, () => {
      const s = service(() => YES);
      s.setSpacePrefs("sp_1", { posture, network: true });
      const out = s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: ["hi"] });
      expect(out.sandboxed).toBe(posture !== "off");
      expect(out.command).toBe(posture === "off" ? "/bin/echo" : "/usr/bin/sandbox-exec");
    });

    it(`${posture} + an unavailable sandbox`, () => {
      const s = service(() => NO);
      s.setSpacePrefs("sp_1", { posture, network: true });
      if (posture === "off") {
        // The user asked for no sandbox, so a missing sandbox is not an error — the command runs
        // exactly as every Realm before this feature ran it, because that is what was chosen.
        const out = s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: [] });
        expect(out.sandboxed).toBe(false);
      } else {
        expect(() => s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: [] }))
          .toThrow(/sandbox-exec is missing/);
      }
    });
  }

  it("raises an RPC code the renderer can branch on, not a bare Error", () => {
    const s = service(() => NO);
    s.setSpacePrefs("sp_1", { posture: "workspace-write", network: true });
    try {
      s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: [] });
      expect.unreachable("wrap must throw when the sandbox cannot be applied");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("SANDBOX_UNAVAILABLE");
    }
  });

  it("asks the probe once, not once per spawn", () => {
    let calls = 0;
    const s = service(() => { calls += 1; return YES; });
    // A posture that actually consults the probe: under `off` — the shipped default — `wrap` never
    // asks at all, which is a different (and also correct) answer to a different question.
    s.setSpacePrefs("sp_1", { posture: "workspace-write", network: true });
    for (let i = 0; i < 5; i++) s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: [] });
    expect(calls).toBe(1);
  });

  it("has exactly one place in the spawn wrapper that can produce an unsandboxed command", () => {
    /* A behavioural matrix cannot see a fallback that has not been added yet. This can: the literal
       `sandboxed: false` appears once in spawn.ts, in the `off` branch. A later `catch { return
       {sandboxed:false, ...} }` adds a second and fails here, which is the point — the mutant that
       matters for this feature is a well-meaning "don't break the user's session" rescue. */
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "spawn.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // prose about it is not a use of it
    // The comma is what distinguishes the object literal from the type declaration's `false;`.
    expect(src.match(/sandboxed: false,/g)).toHaveLength(1);
  });
});

describe("probeSandboxExec", () => {
  it("says unsupported_platform off darwin rather than pretending it might work", () => {
    const r = probeSandboxExec("linux");
    expect(r).toMatchObject({ available: false, error: "unsupported_platform" });
    expect(r.detail).toContain("linux");
  });

  const onDarwin = process.platform === "darwin" ? it : it.skip;
  onDarwin("actually applies a trivial profile on this machine", () => {
    // Not `existsSync`: the interesting future failure is a deprecated binary that is still present
    // and has stopped confining anything, and only running it tells you that.
    const r = probeSandboxExec("darwin");
    expect(r.available).toBe(true);
    expect(r.error).toBeNull();
  });
});

describe("state", () => {
  it("carries the availability verdict beside the posture, so a picker cannot offer a dead choice", () => {
    const s = service(() => NO);
    s.setSpacePrefs("sp_1", { posture: "read-only", network: false });
    const st = s.state("sp_1");
    expect(st).toMatchObject({
      prefs: { posture: "read-only", network: false },
      inherited: false,
      // The shipped default, unchosen — which is what makes the `inherited: false` above meaningful.
      defaults: { posture: "off", network: true },
      available: false,
    });
    expect(st.unavailableReason).toMatch(/sandbox-exec is missing/);
    expect(st.summary).toMatch(/^Sandboxed:/);
    expect(st.policy.posture).toBe("read-only");
  });

  it("reports no reason when the mechanism works", () => {
    expect(service(() => YES).state("sp_1").unavailableReason).toBeNull();
  });
});

describe("env", () => {
  it("states the posture for a shell prompt or a bug report to read", () => {
    const s = service();
    s.setSpacePrefs("sp_1", { posture: "read-only", network: false });
    expect(s.env("sp_1")).toEqual({ REALM_SANDBOX: "read-only", REALM_SANDBOX_NETWORK: "0" });
  });
});

/** The Claude config folder sp_1's profile names, and the one a session of that space still runs
 *  under because its conversation began there. */
const profileDir = join(root, "claude-work");
const sessionDir = join(root, "claude-before");
for (const d of [profileDir, sessionDir]) mkdirSync(d, { recursive: true });

/** The service as the app builds it once a profile can name a folder: sp_1's profile names one and
 *  every other space's names none. Sandboxed, since a policy of `off` has no roots to read. */
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

/** The policy a sandboxed space resolved to before a profile could name a folder: the resolver's
 *  own answer for this machine, with no folder in what it is given. */
const withNoFolder = () => resolveExecutionSandboxPolicy({
  prefs: { posture: "workspace-write", network: true }, checkouts: [checkout], home, tmpDir: tmp, realmHome: realm,
});

/** The keys of what `policyFor` handed the resolver before a profile could name a folder, in the
 *  order it wrote them. */
const HANDED_BEFORE = ["prefs", "checkouts", "home", "tmpDir", "realmHome", "extraWritableRoots", "onDrop"];

describe("the Claude config folder a policy is resolved for", () => {
  it("resolves the policy every space had before, when it is built with no way to ask about profiles", () => {
    const s = service();
    s.setDefaults({ posture: "workspace-write", network: true });
    expect(s.policyFor("sp_1")).toEqual(withNoFolder());
  });

  it("uses the folder the space's profile names when the caller names none", () => {
    const s = withProfileFolder();
    expect(s.policyFor("sp_1").writableRoots).toContain(realpathSync(profileDir));
    expect(s.policyFor("sp_2")).toEqual(withNoFolder());
  });

  it("takes a folder given as undefined for one left out, and asks the profile", () => {
    expect(withProfileFolder().policyFor("sp_1", { claudeDir: undefined }).writableRoots).toContain(realpathSync(profileDir));
  });

  it("uses the caller's folder when it names one, whatever the profile names", () => {
    const p = withProfileFolder().policyFor("sp_1", { claudeDir: sessionDir });
    expect(p.writableRoots).toContain(realpathSync(sessionDir));
    expect(p.writableRoots).not.toContain(realpathSync(profileDir));
  });

  it("uses the caller's folder in a service built with no way to ask about profiles", () => {
    const s = service();
    s.setDefaults({ posture: "workspace-write", network: true });
    expect(s.policyFor("sp_1", { claudeDir: sessionDir }).writableRoots).toContain(realpathSync(sessionDir));
  });

  it("uses no folder for a caller on the default one, even where the profile names one", () => {
    expect(withProfileFolder().policyFor("sp_1", { claudeDir: null })).toEqual(withNoFolder());
  });

  it("describes the space to Settings with its profile's folder, as a terminal there gets it", () => {
    const s = withProfileFolder();
    expect(s.state("sp_1").policy.writableRoots).toContain(realpathSync(profileDir));
    expect(s.describe("sp_1")).toBe(s.state("sp_1").summary);
  });

  it("leaves a space with no sandbox as it was, whatever folder is named: an empty policy and the bare command", () => {
    const s = new ExecutionSandboxService({
      settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => NO,
      claudeDirOf: () => profileDir,
    });
    expect(s.policyFor("sp_1", { claudeDir: sessionDir })).toEqual({
      posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true,
    });
    expect(s.wrap({ spaceId: "sp_1", command: "/bin/echo", args: ["hi"], claudeDir: sessionDir }))
      .toMatchObject({ sandboxed: false, command: "/bin/echo", args: ["hi"] });
  });

  it("wraps a session's command for the folder the session runs under, not the one its profile names", () => {
    const out = withProfileFolder().wrap({ spaceId: "sp_1", command: "/bin/echo", args: [], claudeDir: sessionDir });
    expect(writableIn(out.args)).toContain(realpathSync(sessionDir));
    expect(writableIn(out.args)).not.toContain(realpathSync(profileDir));
  });

  it("wraps the command of a session on the default folder as it did before, with nothing from its profile's folder", () => {
    const out = withProfileFolder().wrap({ spaceId: "sp_1", command: "/bin/echo", args: [], claudeDir: null });
    expect(out.args).toEqual(sandboxCommand({ command: "/bin/echo", args: [], policy: withNoFolder() }).args);
  });

  it("wraps a terminal's command, which names no folder, for the one its space's profile names", () => {
    const out = withProfileFolder().wrap({ spaceId: "sp_1", command: "/bin/zsh", args: ["-l"] });
    expect(writableIn(out.args)).toContain(realpathSync(profileDir));
  });

  it("keeps the checkout a session was opened on writable beside the folder it runs under", () => {
    const openedOn = join(root, "opened-on");
    mkdirSync(openedOn, { recursive: true });
    const out = withProfileFolder().wrap({
      spaceId: "sp_1", command: "/bin/echo", args: [], extraWritableRoots: [openedOn], claudeDir: sessionDir,
    });
    expect(writableIn(out.args)).toEqual(expect.arrayContaining([realpathSync(openedOn), realpathSync(sessionDir)]));
  });

  it("asks which folder the profile names only for a caller that does not say", () => {
    const asked: string[] = [];
    const s = new ExecutionSandboxService({
      settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => YES,
      claudeDirOf: (spaceId) => { asked.push(spaceId); return profileDir; },
    });
    s.setDefaults({ posture: "workspace-write", network: true });
    s.policyFor("sp_1", { claudeDir: sessionDir });
    s.policyFor("sp_1", { claudeDir: null });
    expect(asked).toEqual([]);
    s.policyFor("sp_1");
    expect(asked).toEqual(["sp_1"]);
  });

  it("resolves the policy with the options it passed before, key for key, for a command that names no folder or gives undefined for one", () => {
    for (const o of [{}, { claudeDir: undefined }]) {
      const s = withProfileFolder();
      const policyFor = vi.spyOn(s, "policyFor");
      s.wrap({ spaceId: "sp_1", command: "/bin/zsh", args: ["-l"], ...o });
      expect(policyFor.mock.calls.map(([spaceId, handed]) => [spaceId, Object.keys(handed ?? {})])).toEqual([["sp_1", ["extraWritableRoots"]]]);
    }
  });

  it("hands the resolver what it was handed before, wherever no folder is named", () => {
    const resolver = vi.spyOn(policyModule, "resolveExecutionSandboxPolicy");
    try {
      const cannotAsk = service();
      cannotAsk.setDefaults({ posture: "workspace-write", network: true });
      cannotAsk.policyFor("sp_1");
      withProfileFolder().policyFor("sp_2");
      withProfileFolder().policyFor("sp_1", { claudeDir: null });
      expect(resolver.mock.calls.map(([input]) => Object.keys(input))).toEqual([HANDED_BEFORE, HANDED_BEFORE, HANDED_BEFORE]);
    } finally {
      resolver.mockRestore();
    }
  });

  it("passes on a folder nothing can be made of, an empty one included, so the drop is said and not skipped", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const dir of ["claude-work", ""]) {
        const s = new ExecutionSandboxService({
          settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => YES,
          claudeDirOf: () => dir,
        });
        s.setDefaults({ posture: "workspace-write", network: true });
        s.policyFor("sp_1");
      }
      expect(said.mock.calls).toEqual([
        ["[sandbox] not a usable root for sp_1: claude-work — nothing along this path exists"],
        ["[sandbox] not a usable root for sp_1:  — nothing along this path exists"],
      ]);
    } finally {
      said.mockRestore();
    }
  });
});

/** The service as the app builds it: it can ask which folders Realm starts Claude under. */
const withFolders = (dirs: readonly string[]): ExecutionSandboxService => {
  const s = new ExecutionSandboxService({
    settings, environments, home, tmpDir: tmp, realmHome: realm, platform: "darwin", probe: () => YES,
    claudeDirs: () => dirs,
  });
  s.setDefaults({ posture: "workspace-write", network: true });
  return s;
};

describe("the Claude config folders every policy freezes", () => {
  it("freezes what Claude Code runs from each folder in every space's policy, and makes none of them writable", () => {
    const s = withFolders([profileDir, sessionDir]);
    for (const spaceId of ["sp_1", "sp_2"]) {
      const p = s.policyFor(spaceId);
      for (const dir of [profileDir, sessionDir]) {
        expect(p.readOnlyPaths).toContain(join(realpathSync(dir), "settings.json"));
        expect(p.writableRoots).not.toContain(realpathSync(dir));
      }
    }
  });

  it("freezes them for a session on the default folder, and for one under a folder of its own", () => {
    const s = withFolders([profileDir, sessionDir]);
    const onDefault = s.policyFor("sp_1", { claudeDir: null });
    const onItsOwn = s.policyFor("sp_1", { claudeDir: sessionDir });
    for (const p of [onDefault, onItsOwn]) {
      for (const dir of [profileDir, sessionDir]) expect(p.readOnlyPaths).toContain(join(realpathSync(dir), "settings.json"));
    }
    expect(onDefault).toEqual(s.policyFor("sp_2"));
    expect(onItsOwn.writableRoots).toContain(realpathSync(sessionDir));
    expect(onItsOwn.writableRoots).not.toContain(realpathSync(profileDir));
  });

  it("asks for the folders at each policy, so one named after the service was built is frozen in the next", () => {
    const dirs: string[] = [];
    const s = withFolders(dirs);
    expect(s.policyFor("sp_1")).toEqual(withNoFolder());
    dirs.push(profileDir);
    expect(s.policyFor("sp_1").readOnlyPaths).toContain(join(realpathSync(profileDir), "settings.json"));
  });

  it("hands the resolver what it was handed before, where there is no folder to freeze", () => {
    const resolver = vi.spyOn(policyModule, "resolveExecutionSandboxPolicy");
    try {
      withFolders([]).policyFor("sp_1");
      expect(resolver.mock.calls.map(([input]) => Object.keys(input))).toEqual([HANDED_BEFORE]);
    } finally {
      resolver.mockRestore();
    }
  });
});
