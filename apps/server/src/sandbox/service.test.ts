import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { EXECUTION_SANDBOX_DEFAULT_KEY, executionSandboxSpaceKey, type Environment } from "@realm/contracts";
import { ExecutionSandboxService, probeSandboxExec, type SandboxAvailability } from "./service";

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
  it("ships OPT-IN — nothing chosen means no sandbox, and the network flag still defaults on", () => {
    // The shipped default is `off` for this release (see EXECUTION_SANDBOX_DEFAULT_POSTURE). The
    // service has no default of its own; it must read the contract's, or the two disagree about
    // what an untouched Realm does.
    expect(service().defaults()).toEqual({ posture: "off", network: true });
  });

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

describe("describe", () => {
  it("does not call an off space sandboxed", () => {
    const s = service();
    s.setSpacePrefs("sp_1", { posture: "off", network: true });
    expect(s.describe("sp_1")).toMatch(/^Not sandboxed/);
  });
});
