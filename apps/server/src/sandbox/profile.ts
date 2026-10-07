import type { ExecutionSandboxPolicy } from "@realm/contracts";
import { RpcError } from "../store/rows";

/**
 * Realm policy → a macOS Seatbelt (SBPL) profile.
 *
 * This is the security-critical half of the execution sandbox and the one place where a mistake
 * widens a sandbox rather than breaking it, so it is pure: no filesystem, no environment, no clock.
 * Everything it needs is in the policy it is handed, and the same policy always produces the same
 * bytes.
 *
 * ## The central design decision: no path is ever written into the profile
 *
 * The obvious implementation interpolates each root into the profile text — `(subpath "/Users/x/p")`
 * — with a quoting function in front of it. **That was rejected.** Quoting is exactly where these get
 * broken: a root containing `"` or `)` or a newline gets one escape wrong and the profile either
 * fails to parse (loud, survivable) or parses into something WIDER than intended (silent, fatal).
 * The escape rules for SBPL's Scheme-derived reader are also not documented by Apple, so a quoting
 * function here would be a guess with a security property riding on it.
 *
 * Instead every caller-supplied path is passed out of band, as a `sandbox-exec -D NAME=value`
 * parameter, and referenced as `(subpath (param "NAME"))`. The profile text is then a CONSTANT for a
 * given shape of policy — the number of roots changes it, the CONTENT of a root never does. There is
 * no parser between the path and the kernel, so there is nothing to escape.
 *
 * Measured on macOS 27.0 rather than assumed, because the whole design rests on it:
 *
 *  - a root of `<dir>") (allow file-write* (subpath "/` grants write to `<dir>` and NOT to `/` — the
 *    injection is taken as a literal directory name;
 *  - the same with an embedded newline behaves identically;
 *  - roots containing `"`, `)`, `(`, spaces and newlines all match their real directory correctly;
 *  - an UNDEFINED parameter makes `sandbox-exec` exit 65 without running the command, and an EMPTY
 *    one makes it exit 65 with "empty subpath pattern". Both fail closed, which is the right
 *    direction, but `assertSandboxablePath` refuses them here anyway rather than relying on it.
 *
 * ## What the base policy allows, and why each line is there
 *
 * `(deny default)` and then additions. Every addition below was needed to make a real toolchain run
 * under it — node, git, npm, pnpm and a login `zsh` were all exercised against this exact text.
 *
 * Two consequences of the base policy are worth knowing before you describe the feature:
 *
 *  - **Setuid and setgid binaries cannot be exec'd at all.** `/bin/ps`, `/usr/bin/top` and `sudo`
 *    fail with EPERM inside the sandbox (verified). That blocks a whole class of escalation for
 *    free, and it also means a sandboxed terminal is missing `ps` and `top`. Not fixable from here.
 *  - **`(allow mach-lookup)` is unrestricted, and it is the weakest line in this file.** A process
 *    that can talk to every system service can ask an unsandboxed one to act for it. Realm probed
 *    the obvious route — LaunchServices, i.e. `open -a` — and macOS 27 refuses it (`-54`), and
 *    `launchctl submit` fails too. That is a measurement on one OS version, NOT a proof. Narrowing
 *    this to a global-name allowlist is the single biggest available hardening and is deliberately
 *    not attempted here, because the allowlist that keeps DNS, Keychain-backed git credentials and
 *    dyld working has not been established, and a guess that breaks `git push` would be reverted
 *    within a day.
 */

/** The `-D` parameter names. Realm-prefixed so they cannot collide with a name a future base policy
 *  wants, and indexed because SBPL has no list parameter — one `(param ...)` per root. */
const WRITE_PARAM = (i: number): string => `REALM_WRITE_${i}`;
const READ_PARAM = (i: number): string => `REALM_READ_${i}`;
const READ_ONLY_PARAM = (i: number): string => `REALM_READ_ONLY_${i}`;
const PROTECTED_PARAM = (i: number): string => `REALM_PROTECTED_${i}`;

export type CompiledSeatbeltProfile = {
  /** The SBPL text, for `sandbox-exec -p`. Contains no caller-supplied path. */
  profile: string;
  /** `name → path`, for `sandbox-exec -D name=path`. Every path here is a real absolute path. */
  parameters: Record<string, string>;
};

/**
 * Why a path cannot be used as a sandbox root. Returns null when it can.
 *
 * Exported separately from the assertion so the policy resolver can DROP a bad root with a log line
 * rather than failing a whole session over, say, one toolchain cache that happens to be a symlink
 * loop — while a bad root that arrived from a stored policy still throws.
 */
export function sandboxPathProblem(path: string): string | null {
  if (typeof path !== "string" || path === "") return "is empty";
  if (path.includes("\0")) return "contains a NUL byte";
  if (!path.startsWith("/")) return "is not absolute (Seatbelt matches resolved absolute paths; a relative root matches nothing)";
  // `/` as a writable root turns `(deny default)` into a formality: verified, a policy with
  // `(subpath "/")` lets the process write anywhere on the volume. Refusing it here is the
  // difference between a sandbox and a decoration.
  if (path === "/") return "is the filesystem root, which would grant the whole disk";
  const segments = path.split("/").slice(1);
  if (segments.at(-1) === "") return "has a trailing slash (pass the path as realpath returns it)";
  for (const s of segments) {
    if (s === "") return "contains an empty path segment";
    // `.` and `..` are not resolved by the profile compiler, and must not be: resolving them is
    // filesystem work (a component could be a symlink) and this file does no I/O. The resolver runs
    // realpath before it gets here, so a `..` arriving at this point means the caller skipped it.
    if (s === "." || s === "..") return `contains a "${s}" segment (pass an already-resolved path)`;
  }
  return null;
}

/** The same check, as the refusal a session start reports. */
export function assertSandboxablePath(path: string, role: string): void {
  const problem = sandboxPathProblem(path);
  if (problem) throw new RpcError("SANDBOX_POLICY_INVALID", `${role} ${JSON.stringify(path)} ${problem}`);
}

/**
 * The constant preamble. Kept as one string rather than assembled from pieces so that reading this
 * file tells you the whole of what a sandboxed process may do.
 */
const BASE_POLICY = `(version 1)

; Closed by default; everything below is an addition that a real toolchain needed.
(deny default)

; ── process ────────────────────────────────────────────────────────────────────────────────────
; A sandbox is inherited across exec and fork, so a shell, the compiler it runs and the test runner
; that compiler starts are all inside this policy (verified three levels deep). Setuid/setgid
; binaries are refused by Seatbelt regardless of this line.
(allow process-exec)
(allow process-fork)
(allow process-info*)
; Job control: a shell must be able to signal the children it started. \`same-sandbox\` is the whole
; process tree under this policy and nothing outside it.
(allow signal (target same-sandbox))
; setpriority(2). Without it zsh prints "nice(5) failed" on every backgrounded job.
(allow system-sched)

; ── system ─────────────────────────────────────────────────────────────────────────────────────
; Read-only machine facts: hw.ncpu and friends, which every build tool asks for.
(allow sysctl-read)
; See the file header: unrestricted, and the weakest line here.
(allow mach-lookup)
(allow ipc-posix-shm)

; ── devices ────────────────────────────────────────────────────────────────────────────────────
; Narrow on purpose. \`(subpath "/dev")\` would be simpler and would also hand over /dev/rdisk*,
; which is raw block access to the boot volume — i.e. a complete escape. Enumerated instead.
; /dev/null is not optional: without it \`git\` fails at startup with "could not open '/dev/null'".
(allow file-ioctl (regex #"^/dev/(tty|ttys[0-9]+|ptmx|fd/[0-9]+)$"))
(allow file-write-data (regex #"^/dev/(null|zero|stdout|stderr|tty|ttys[0-9]+|fd/[0-9]+|dtracehelper)$"))
`;

/**
 * Compile a resolved policy.
 *
 * Throws `SANDBOX_POLICY_INVALID` for a posture of `off` — there is no profile that means "no
 * sandbox", and returning an empty one would put a compiler between a user's explicit choice and an
 * unprotected spawn. `sandboxCommand` handles `off` as its own branch, where it is visible.
 */
export function compileSeatbeltProfile(policy: ExecutionSandboxPolicy): CompiledSeatbeltProfile {
  if (policy.posture === "off") {
    throw new RpcError("SANDBOX_POLICY_INVALID", "posture \"off\" has no profile — it is the explicit no-sandbox choice, handled by sandboxCommand");
  }

  const writable = normalizeRoots(policy.writableRoots, "writable root");
  const readable = normalizeRoots(policy.readableRoots, "readable root");
  const readOnly = normalizeRoots(policy.readOnlyPaths, "read-only path");
  const protectedRoots = normalizeRoots(policy.protectedRoots, "protected path");

  const parameters: Record<string, string> = {};
  const lines: string[] = [BASE_POLICY];

  // ── reads ───────────────────────────────────────────────────────────────────────────────────
  lines.push("; ── read ───────────────────────────────────────────────────────────────────────────────────────");
  if (readable.length === 0) {
    lines.push("; Everything is readable; the protected list below carves out of it. This is the default");
    lines.push("; posture and it is a real limit on the claim this feature makes — see execution-sandbox.ts.");
    lines.push("(allow file-read*)");
  } else {
    lines.push("; Deny-by-default reads: only these subtrees, and they must include the system roots the");
    lines.push("; toolchain loads from or the process will not start.");
    for (const [i, root] of readable.entries()) {
      parameters[READ_PARAM(i)] = root;
      lines.push(`(allow file-read* (subpath (param "${READ_PARAM(i)}")))`);
    }
  }

  // ── writes ──────────────────────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("; ── write ──────────────────────────────────────────────────────────────────────────────────────");
  if (writable.length === 0) {
    lines.push("; No writable roots at all. The device allows above are the only writes that succeed.");
  }
  for (const [i, root] of writable.entries()) {
    parameters[WRITE_PARAM(i)] = root;
    lines.push(`(allow file-write* (subpath (param "${WRITE_PARAM(i)}")))`);
  }

  // ── read-only ───────────────────────────────────────────────────────────────────────────────
  // After the write allows, so these win: `~/.claude` is writable and `~/.claude/settings.json`
  // inside it is not. Read stays allowed, which is the whole difference from `protectedRoots` — the
  // CLI has to load its own settings on every run.
  if (readOnly.length > 0) {
    lines.push("");
    lines.push("; ── read-only ──────────────────────────────────────────────────────────────────────────────────");
    for (const [i, path] of readOnly.entries()) {
      parameters[READ_ONLY_PARAM(i)] = path;
      lines.push(`(deny file-write* (subpath (param "${READ_ONLY_PARAM(i)}")))`);
    }
  }

  // ── protected ───────────────────────────────────────────────────────────────────────────────
  // LAST, and that position is the whole point: SBPL's last matching rule wins (verified), so these
  // beat `(allow file-read*)` above AND any writable root that happens to contain one of them. The
  // ordering is why the block is here rather than beside the read rules where it reads better.
  if (protectedRoots.length > 0) {
    lines.push("");
    lines.push("; ── protected ──────────────────────────────────────────────────────────────────────────────────");
    for (const [i, root] of protectedRoots.entries()) {
      parameters[PROTECTED_PARAM(i)] = root;
      lines.push(`(deny file-read* (subpath (param "${PROTECTED_PARAM(i)}")))`);
      lines.push(`(deny file-write* (subpath (param "${PROTECTED_PARAM(i)}")))`);
    }
  }

  // ── network ─────────────────────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("; ── network ────────────────────────────────────────────────────────────────────────────────────");
  if (policy.network) {
    lines.push("; All of it: outbound, inbound and bind. Per-host filtering is not offered because a process");
    lines.push("; that resolves DNS itself defeats it, and a checkbox that does not mean what it says is worse");
    lines.push("; than an honest open switch.");
    lines.push("(allow network*)");
    lines.push("(allow system-socket)");
  } else {
    lines.push("; Nothing. socket(2) itself fails with EPERM, so a connect and a bind both fail (verified).");
    lines.push("; This also blocks unix-domain sockets, which is why an ssh-agent handoff will not work here.");
  }
  lines.push("");

  return { profile: lines.join("\n"), parameters };
}

/** Sorted and de-duplicated so a policy that arrived in a different order compiles to the same bytes
 *  — which is what lets a test assert on the profile at all, and what keeps a cached compile honest. */
function normalizeRoots(roots: readonly string[], role: string): string[] {
  for (const r of roots) assertSandboxablePath(r, role);
  return [...new Set(roots)].sort();
}
