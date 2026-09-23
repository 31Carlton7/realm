import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);

/** What `claude auth status --json` answers with. Only the field this file acts on is named; the
 *  command also reports the account, org and plan, which are none of Realm's business here. */
type AuthStatus = { loggedIn?: unknown };

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
async function claudeAuthStatus(bin: string): Promise<{ loggedIn: boolean | null; reason: string | null }> {
  try {
    // `--json` explicitly, though it is the default today: `--text` exists, so the default is a
    // choice the CLI could revisit, and a parse of the human-readable form would answer `null`.
    const { stdout } = await run(bin, ["auth", "status", "--json"], { timeout: 5000 });
    const parsed = JSON.parse(stdout) as AuthStatus;
    if (typeof parsed.loggedIn !== "boolean") return { loggedIn: null, reason: "unknown (auth status said nothing about it)" };
    return parsed.loggedIn
      ? { loggedIn: true, reason: null }
      : { loggedIn: false, reason: "not signed in — run `claude auth login`" };
  } catch {
    // The fallback the subcommand replaced, kept for CLIs that predate it. It can only ever say
    // "credentials exist", never that they are valid or unexpired, so it never claims `false`.
    const hasCreds = existsSync(join(homedir(), ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
    return hasCreds ? { loggedIn: true, reason: null } : { loggedIn: null, reason: "unknown (keychain)" };
  }
}

/**
 * Checks the local `claude` CLI is runnable, and whether it is signed in.
 *
 * `available` is `--version`; the login answer comes from `claude auth status`, which is the CLI's
 * own verdict rather than an inference from a file. `loggedIn: true` still means "the CLI says it
 * has a session", not that the session's access token is unexpired this second — that only the next
 * request can settle, which is what `failover.ts` re-probes for after an auth failure.
 */
export async function probeClaude(bin = process.env.REALM_CLAUDE_BIN ?? "claude"): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000 });
    return { available: true, version: stdout.trim() || null, ...(await claudeAuthStatus(bin)) };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}
