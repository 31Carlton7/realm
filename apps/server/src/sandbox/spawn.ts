import type { ExecutionSandboxPolicy } from "@realm/contracts";
import { compileSeatbeltProfile } from "./profile";

/**
 * A command plus a policy → the argv that actually runs it.
 *
 * Pure. No `stat`, no spawn, no environment: it is a function from two values to a third, so a test
 * can assert on the exact argv rather than on what a process did with it. Whether `sandbox-exec`
 * exists on this machine is a different question, asked once at startup by `ExecutionSandboxService`
 * — asking it here would make every call site's test depend on the host.
 */

/** Not looked up on PATH, on purpose. A `sandbox-exec` earlier in PATH than /usr/bin would be a
 *  complete bypass, and it is exactly the kind of thing a compromised agent could arrange in a
 *  shell profile it was allowed to write. This is the system one or nothing. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * The result is a DISCRIMINATED UNION rather than a plain argv, and that shape is the point.
 *
 * A function that returned `{command, args}` could quietly hand back the original command when it
 * could not build a profile, and every call site would look correct while running unsandboxed. Here
 * a caller has to read `sandboxed` to get at the fields, and `sandboxed: false` is reachable from
 * exactly one input — an explicit posture of `off`. There is no error branch that produces it.
 */
export type SandboxedCommand =
  | {
      sandboxed: true;
      /** Always `SANDBOX_EXEC_PATH`. */
      command: string;
      args: string[];
      posture: Exclude<ExecutionSandboxPolicy["posture"], "off">;
      /** The compiled SBPL, carried so a caller can log or show it without recompiling. */
      profile: string;
    }
  | {
      sandboxed: false;
      command: string;
      args: string[];
      posture: "off";
      /** Why there is no sandbox. Only ever the user's own stored choice. */
      reason: string;
    };

export function sandboxCommand(o: {
  command: string;
  args: readonly string[];
  policy: ExecutionSandboxPolicy;
}): SandboxedCommand {
  if (o.policy.posture === "off") {
    return {
      sandboxed: false,
      command: o.command,
      args: [...o.args],
      posture: "off",
      reason: "the sandbox posture for this space is set to off",
    };
  }

  const { profile, parameters } = compileSeatbeltProfile(o.policy);
  const args: string[] = ["-p", profile];
  // Sorted so the argv is deterministic; `compileSeatbeltProfile` names them, so nothing here can
  // produce a key the profile does not reference (an unreferenced `-D` is harmless; a referenced
  // one that is missing makes sandbox-exec exit 65 before running anything).
  for (const name of Object.keys(parameters).sort()) args.push("-D", `${name}=${parameters[name]!}`);
  // `--` is load-bearing: without it, a command whose own name begins with `-` is eaten by
  // sandbox-exec's getopt. Verified that sandbox-exec accepts and consumes it.
  args.push("--", o.command, ...o.args);

  return { sandboxed: true, command: SANDBOX_EXEC_PATH, args, posture: o.policy.posture, profile };
}

/**
 * The environment variables a sandboxed process is spawned with, in the shape `portEnv` established.
 *
 * These are a STATEMENT, not a control: nothing reads them back to decide anything, and a process
 * that unsets them is no less sandboxed. They exist so a shell prompt, a wrapper script or a bug
 * report can say which posture a process is under — "why did this write fail" is otherwise a
 * mystery with no visible cause.
 */
export function sandboxEnv(policy: ExecutionSandboxPolicy): Record<string, string> {
  return {
    REALM_SANDBOX: policy.posture,
    REALM_SANDBOX_NETWORK: policy.network ? "1" : "0",
  };
}
