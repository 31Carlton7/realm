import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  EXECUTION_SANDBOX_DEFAULT_KEY,
  EXECUTION_SANDBOX_ERROR_CODES,
  ExecutionSandboxPrefsSchema,
  describeExecutionSandbox,
  executionSandboxSpaceKey,
  parseExecutionSandboxPrefs,
  type ExecutionSandboxError,
  type ExecutionSandboxPolicy,
  type ExecutionSandboxPrefs,
} from "@realm/contracts";
import type { EnvironmentsStore } from "../store/environments";
import type { SettingsStore } from "../store/settings";
import { realmHome } from "../paths";
import { RpcError } from "../store/rows";
import { resolveExecutionSandboxPolicy } from "./policy";
import { SANDBOX_EXEC_PATH, sandboxCommand, sandboxEnv, type SandboxedCommand } from "./spawn";

/**
 * The one place a spawn site asks "what am I allowed to start this with".
 *
 * Everything below it is pure; this class is where the settings table, the environments table and
 * the host machine meet. Two things live here and nowhere else:
 *
 *  1. **Availability**, asked once. Not `existsSync` alone: a file that is present but refuses to
 *     apply a profile is the failure this feature must not paper over, so the probe actually RUNS a
 *     trivial sandboxed `/usr/bin/true` and believes the exit code. It costs about 30ms, once.
 *  2. **The fail-closed gate.** `wrap` throws when a non-`off` posture cannot be applied. There is
 *     deliberately no `catch` anywhere in this file that returns the unwrapped command instead —
 *     that single line is what would turn the whole feature into decoration. `service.test.ts` walks
 *     the whole posture × availability matrix and asserts that an unsandboxed command comes back
 *     from exactly one cell of it: the one where the user chose `off`.
 */

export type SandboxAvailability = {
  available: boolean;
  /** A word, for the renderer to turn into a sentence. Null when available. */
  error: ExecutionSandboxError | null;
  /** Realm's own words about what it found, for a detail well. */
  detail: string;
};

/** The smallest profile that proves the mechanism works end to end: closed by default, plus the two
 *  rules `/usr/bin/true` needs to be exec'd and mapped at all. */
const PROBE_PROFILE = "(version 1)(deny default)(allow file-read*)(allow process-exec)";

export class ExecutionSandboxService {
  private readonly home: string;
  private readonly tmpDir: string;
  private readonly realmHome: string;
  private readonly platform: string;
  private readonly probeOnce: () => SandboxAvailability;
  private cached: SandboxAvailability | null = null;

  constructor(private readonly d: {
    settings: Pick<SettingsStore, "get" | "set">;
    environments: Pick<EnvironmentsStore, "list">;
    /** All four are injected so a test describes a machine rather than running on one. */
    home?: string;
    tmpDir?: string;
    realmHome?: string;
    platform?: string;
    probe?: () => SandboxAvailability;
  }) {
    this.home = d.home ?? homedir();
    this.tmpDir = d.tmpDir ?? tmpdir();
    this.realmHome = d.realmHome ?? realmHome();
    this.platform = d.platform ?? process.platform;
    this.probeOnce = d.probe ?? (() => probeSandboxExec(this.platform));
  }

  /** Memoised: `sandbox-exec` does not appear or disappear while this process runs, and a probe per
   *  spawn would put a 30ms fork in front of every terminal the user opens. */
  availability(): SandboxAvailability {
    return (this.cached ??= this.probeOnce());
  }

  /** The posture every space inherits. Falls back to the shipped default for an absent or corrupt
   *  row — a settings value is user-editable JSON, and a bad one must not stop Realm booting. */
  defaults(): ExecutionSandboxPrefs {
    return parseExecutionSandboxPrefs(this.d.settings.get(EXECUTION_SANDBOX_DEFAULT_KEY))
      ?? ExecutionSandboxPrefsSchema.parse({});
  }

  setDefaults(prefs: ExecutionSandboxPrefs): ExecutionSandboxPrefs {
    const next = ExecutionSandboxPrefsSchema.parse(prefs);
    this.d.settings.set(EXECUTION_SANDBOX_DEFAULT_KEY, next);
    return next;
  }

  /** What this space uses, and whether that came from the space or from the default. The renderer
   *  needs both to draw an override as an override rather than as a duplicate of the default. */
  prefsFor(spaceId: string): { prefs: ExecutionSandboxPrefs; inherited: boolean } {
    const own = parseExecutionSandboxPrefs(this.d.settings.get(executionSandboxSpaceKey(spaceId)));
    return own ? { prefs: own, inherited: false } : { prefs: this.defaults(), inherited: true };
  }

  /** `null` clears the override and puts the space back on the default. */
  setSpacePrefs(spaceId: string, prefs: ExecutionSandboxPrefs | null): { prefs: ExecutionSandboxPrefs; inherited: boolean } {
    this.d.settings.set(executionSandboxSpaceKey(spaceId), prefs === null ? null : ExecutionSandboxPrefsSchema.parse(prefs));
    return this.prefsFor(spaceId);
  }

  /**
   * The resolved policy for a space, as it would be compiled right now.
   *
   * Resolved per call rather than cached: the writable roots are this space's checkouts, and a
   * worktree added while Realm is running must be writable in the next session without a restart.
   */
  policyFor(spaceId: string, o: { extraWritableRoots?: readonly string[] } = {}): ExecutionSandboxPolicy {
    const { prefs } = this.prefsFor(spaceId);
    return resolveExecutionSandboxPolicy({
      prefs,
      checkouts: this.d.environments.list(spaceId).map((e) => e.path),
      home: this.home,
      tmpDir: this.tmpDir,
      realmHome: this.realmHome,
      extraWritableRoots: o.extraWritableRoots,
      onDrop: (root, why) => console.error(`[sandbox] not a usable root for ${spaceId}: ${root} — ${why}`),
    });
  }

  /** One sentence about this space's sandbox, for a session's detail well and for Settings. */
  describe(spaceId: string): string {
    return describeExecutionSandbox(this.policyFor(spaceId));
  }

  /**
   * Everything Settings needs about one space, in a single call.
   *
   * `available` rides along rather than living behind its own method because a posture picker that
   * did not show it would be offering three choices of which two silently refuse to start a session.
   * The reason is Realm's own words; the renderer shows it verbatim.
   */
  state(spaceId: string): {
    prefs: ExecutionSandboxPrefs; inherited: boolean; defaults: ExecutionSandboxPrefs;
    policy: ExecutionSandboxPolicy; summary: string;
    available: boolean; unavailableReason: string | null;
  } {
    const { prefs, inherited } = this.prefsFor(spaceId);
    const policy = this.policyFor(spaceId);
    const avail = this.availability();
    return {
      prefs, inherited, defaults: this.defaults(), policy,
      summary: describeExecutionSandbox(policy),
      available: avail.available,
      unavailableReason: avail.available ? null : avail.detail,
    };
  }

  /**
   * A command a spawn site is about to run → the command it should actually run.
   *
   * **Throws** when the posture is anything but `off` and the sandbox cannot be applied. Callers must
   * let that propagate: the session or terminal fails to start, with a code the UI explains and a
   * user-visible way out (set the space's posture to `off`, on purpose, in Settings). Catching this
   * and spawning `o.command` unchanged would reintroduce exactly the silent downgrade this design
   * exists to prevent.
   */
  wrap(o: { spaceId: string; command: string; args: readonly string[]; extraWritableRoots?: readonly string[] }): SandboxedCommand {
    const policy = this.policyFor(o.spaceId, { extraWritableRoots: o.extraWritableRoots });
    if (policy.posture !== "off") {
      const avail = this.availability();
      if (!avail.available) {
        throw new RpcError(EXECUTION_SANDBOX_ERROR_CODES[avail.error ?? "sandbox_unavailable"], avail.detail);
      }
    }
    return sandboxCommand({ command: o.command, args: o.args, policy });
  }

  /** The `REALM_SANDBOX*` variables for a space, to merge into a spawn's env beside `portEnv`. */
  env(spaceId: string): Record<string, string> {
    return sandboxEnv(this.policyFor(spaceId));
  }
}

/**
 * Is a Seatbelt policy applicable on this machine, right now?
 *
 * Three questions, in the order that gives the most useful answer: the platform, the binary, and
 * then whether it actually works. The third is the one that matters — Apple has marked
 * `sandbox-exec` deprecated, so the interesting future failure is a binary that is still present and
 * has stopped confining anything, and only running it tells you that.
 *
 * What this probe does NOT establish: that a FULL Realm policy will apply. A profile that is too
 * long for the argv, or that uses an operation a future macOS drops, would fail at the real spawn,
 * not here. That failure is still fail-closed — `sandbox-exec` exits non-zero without running the
 * command (verified: exit 65 for a bad profile, 71 for an exec it refuses) — so the session reports
 * a failed start rather than running unprotected.
 */
export function probeSandboxExec(platform: string = process.platform): SandboxAvailability {
  if (platform !== "darwin") {
    return { available: false, error: "unsupported_platform", detail: `Seatbelt is a macOS facility; this is ${platform}. Realm has no sandbox for it in this release.` };
  }
  try {
    accessSync(SANDBOX_EXEC_PATH, constants.X_OK);
  } catch {
    return { available: false, error: "sandbox_unavailable", detail: `${SANDBOX_EXEC_PATH} is missing or not executable. macOS marks it deprecated; if a release has removed it, Realm cannot sandbox on this machine.` };
  }
  const r = spawnSync(SANDBOX_EXEC_PATH, ["-p", PROBE_PROFILE, "--", "/usr/bin/true"], { timeout: 10_000 });
  if (r.error) {
    return { available: false, error: "sandbox_unavailable", detail: `${SANDBOX_EXEC_PATH} could not be run: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr?.toString() ?? "").trim();
    return { available: false, error: "sandbox_unavailable", detail: `${SANDBOX_EXEC_PATH} refused a trivial profile (exit ${r.status ?? "null"})${stderr ? `: ${stderr}` : ""}` };
  }
  return { available: true, error: null, detail: `${SANDBOX_EXEC_PATH} applied a test profile successfully.` };
}
