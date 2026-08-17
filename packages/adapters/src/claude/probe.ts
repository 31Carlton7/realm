import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);

/** Checks the local `claude` CLI is runnable and guesses login state from the credentials file / API key env. */
export async function probeClaude(bin = process.env.REALM_CLAUDE_BIN ?? "claude"): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000 });
    const loggedIn = existsSync(join(homedir(), ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY) || null;
    return { available: true, version: stdout.trim() || null, loggedIn, reason: null };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}
