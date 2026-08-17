import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);

/**
 * Checks the local `claude` CLI is runnable. Login state is only claimed (`true`) when a credentials file or
 * ANTHROPIC_API_KEY is present; otherwise `null` with `reason: "unknown (keychain)"` — the CLI may hold OAuth tokens
 * in the OS keychain, which we don't inspect. Note `true` means "credentials exist", not that they are unexpired.
 */
export async function probeClaude(bin = process.env.REALM_CLAUDE_BIN ?? "claude"): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000 });
    const hasCreds = existsSync(join(homedir(), ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
    return { available: true, version: stdout.trim() || null, loggedIn: hasCreds ? true : null, reason: hasCreds ? null : "unknown (keychain)" };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}
