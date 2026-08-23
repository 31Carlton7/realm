import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Checks an ACP agent CLI is runnable.
 *
 * `loggedIn` is deliberately `null`: neither Cursor nor Gemini exposes a trustworthy offline login check.
 * `cursor-agent status` was observed printing "Login successful" and "unable to fetch user details" in the same
 * breath, and Gemini's credentials file can exist for a tier that no longer accepts sessions. Auth failures
 * surface at `session/new` and AcpAdapter turns them into an actionable error event.
 */
export async function probeAcp(
  bin: string,
  versionArgs: string[] = ["--version"],
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, versionArgs, { timeout: 5000 });
    const version = stdout.trim().split("\n")[0]?.trim() || null;
    return { available: true, version, loggedIn: null, reason: "unknown until a session starts" };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}
