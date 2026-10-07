import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);

/** What `claude auth status --json` answers with. Only the field this file acts on is named; the
 *  command also reports the account, org and plan, which are none of Realm's business here. */
type AuthStatus = { loggedIn?: unknown };

/** Where to look for `claude`. Both are seams for the suite; production passes neither. */
export type ClaudeLookup = {
  /** Whose PATH and REALM_CLAUDE_BIN are read — the process's own when absent. */
  env?: NodeJS.ProcessEnv;
  /** Where Realm's own copy is (`bundledClaude`), so a test never depends on the real binary. */
  bundled?: () => string | null;
};

/** A `claude` that answered `--version`, or why none did. */
type Located =
  | { ok: true; bin: string; version: string | null; bundled: boolean }
  | { ok: false; reason: string };

/**
 * The Claude Code binary the Agent SDK carries inside Realm, or null when this install has none.
 *
 * Every Claude session already runs this one. `claude-adapter.ts` hands the SDK no executable unless
 * REALM_CLAUDE_BIN is set, and the SDK then spawns the native binary from its own platform package —
 * so a Mac with no npm and no `claude` on PATH runs Claude sessions fine, and until this existed the
 * probe told that Mac "Claude isn't installed".
 *
 * Resolved the way `sdk.mjs` resolves it — from the SDK's own entry point, then the platform package
 * by name — so the answer is the file the SDK would spawn rather than one that merely looks like it.
 * In a packaged app that is under `Contents/Resources/server/node_modules`, and `import.meta.url` is
 * the server bundle's, which is what makes the lookup start there. (On Linux the SDK also tries a
 * `-musl` variant; Realm ships for the Mac only.)
 */
export function bundledClaude(): string | null {
  try {
    // `process.getBuiltinModule` rather than `import { createRequire } from "node:module"`: this file
    // is bundled into the server, whose banner (tsup.config.ts) already declares that import, and a
    // second one is a SyntaxError in the built bundle that no test here can see.
    const { createRequire } = process.getBuiltinModule("node:module") as typeof import("node:module");
    const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    // No SDK, or no platform package for this machine — an install made with `--omit=optional`.
    return null;
  }
}

/** The first executable `name` on PATH, which is the one a spawn would run. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable: the next entry is the next candidate, as for a spawn.
    }
  }
  return null;
}

async function versionOf(bin: string, env: NodeJS.ProcessEnv, bundled: boolean): Promise<Located> {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000, env });
    return { ok: true, bin, version: stdout.trim() || null, bundled };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Which `claude` Realm would run: the override when there is one, else the first on PATH that runs,
 * else the copy Realm carries.
 *
 * "That runs", not "that is there": a PATH entry can be a shim whose interpreter has gone, and
 * reporting Claude as installed on the strength of a file that cannot start would send the sign-in
 * to the one copy guaranteed to fail.
 *
 * An override gets no fallback behind it. The SDK spawns REALM_CLAUDE_BIN for every session, so a
 * probe that quietly answered for some other copy would be reporting on a binary no session runs —
 * and a stub that is meant to read as missing would read as installed.
 */
async function locate(bin: string | undefined, o: ClaudeLookup): Promise<Located> {
  const env = o.env ?? process.env;
  // Blank counts as unset, as it does for `agentBin` — the two must name the same binary.
  const override = bin ?? (env.REALM_CLAUDE_BIN?.trim() ? env.REALM_CLAUDE_BIN : undefined);
  if (override) return versionOf(override, env, false);
  const found = onPath("claude", env);
  const tried = found ? await versionOf(found, env, false) : null;
  if (tried?.ok) return tried;
  const carried = (o.bundled ?? bundledClaude)();
  if (!carried) return tried ?? { ok: false, reason: "`claude` is not on PATH, and this copy of Realm carries none of its own" };
  const own = await versionOf(carried, env, true);
  return own.ok ? own : { ok: false, reason: `Realm's own copy of Claude Code did not run: ${own.reason}` };
}

/**
 * Ask the CLI itself whether it is signed in.
 *
 * This is the only source that can say `false`. The credentials FILE cannot: on macOS the CLI keeps
 * its OAuth tokens in the login keychain and `~/.claude/.credentials.json` is left behind from
 * whenever it last wrote one — on this machine it was five months stale while the keychain entry was
 * current, so a file check reports a signed-out agent as signed in and a signed-in one as unknown.
 *
 * Every failure answers `null` rather than `false`. A CLI too old to have the subcommand, a keychain
 * that refuses to open, a parse of something that was not JSON — none of those is evidence the user
 * is signed out, and telling a signed-in user to log in again is the one wrong answer that costs
 * them something.
 */
async function claudeAuthStatus(bin: string, bundled: boolean, env: NodeJS.ProcessEnv): Promise<{ loggedIn: boolean | null; reason: string | null }> {
  try {
    // `--json` explicitly, though it is the default today: `--text` exists, so the default is a
    // choice the CLI could revisit, and a parse of the human-readable form would answer `null`.
    const stdout = await run(bin, ["auth", "status", "--json"], { timeout: 5000, env }).then(
      (r) => r.stdout,
      // Signed out, the CLI prints `{"loggedIn": false, …}` and exits 1 (2.1.281, checked on a
      // scratch config dir) — the exit status restates the verdict rather than failing to give one.
      // So what it printed is read either way; only output that is not the JSON falls through to
      // the fallback, and treating the exit as a failure had made `false` unreachable.
      (e: { stdout?: unknown }) => { if (typeof e.stdout === "string") return e.stdout; throw e; },
    );
    const parsed = JSON.parse(stdout) as AuthStatus;
    if (typeof parsed.loggedIn !== "boolean") return { loggedIn: null, reason: "unknown (auth status said nothing about it)" };
    if (parsed.loggedIn) return { loggedIn: true, reason: null };
    // Realm's own copy has no `claude` on PATH behind it, so the usual advice would send someone to
    // a terminal to type a command that is not there. The sign-in that works is Realm's.
    return bundled
      ? { loggedIn: false, reason: "not signed in — sign in from Realm: this is the Claude Code that comes with Realm, so there is no `claude` command to run in a terminal" }
      : { loggedIn: false, reason: "not signed in — run `claude auth login`" };
  } catch {
    // The fallback the subcommand replaced, kept for CLIs that predate it. It can only ever say
    // "credentials exist", never that they are valid or unexpired, so it never claims `false`.
    const hasCreds = existsSync(join(homedir(), ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
    return hasCreds ? { loggedIn: true, reason: null } : { loggedIn: null, reason: "unknown (keychain)" };
  }
}

/**
 * Checks a `claude` is runnable, and whether it is signed in.
 *
 * `available` is `--version`; the login answer comes from `claude auth status`, which is the CLI's
 * own verdict rather than an inference from a file. `loggedIn: true` still means "the CLI says it
 * has a session", not that the session's access token is unexpired this second — that only the next
 * request can settle, which is what `failover.ts` re-probes for after an auth failure.
 *
 * `bin` probes exactly that file and nothing else; without it the probe looks the way `locate` does.
 * The version is reported as printed whichever copy answered — Realm's own prints
 * `2.1.281 (Claude Code)` like any other, and it is the version every session really runs.
 */
export async function probeClaude(bin?: string, o: ClaudeLookup = {}): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  const found = await locate(bin, o);
  if (!found.ok) return { available: false, version: null, loggedIn: null, reason: found.reason };
  return { available: true, version: found.version, ...(await claudeAuthStatus(found.bin, found.bundled, o.env ?? process.env)) };
}

/**
 * The `claude` a sign-in should run: the very one `probeClaude` reports on, or null when neither the
 * PATH nor Realm has one that runs.
 *
 * Asked the same way rather than approximated with a PATH check, because the two disagreeing is the
 * worst case there is — a probe that found Realm's copy signed out, and a sign-in sent to a broken
 * shim on PATH, would offer "Sign in with Claude" and fail it every time.
 */
export async function claudeExecutable(o: ClaudeLookup = {}): Promise<string | null> {
  const found = await locate(undefined, o);
  return found.ok ? found.bin : null;
}
