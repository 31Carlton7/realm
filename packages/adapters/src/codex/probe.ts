import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** True when the failure text looks like codex's own "you're not logged in" message, not some other error. */
function looksLoggedOut(output: string): boolean {
  return /not logged in/i.test(output);
}

/**
 * Checks the local `codex` CLI is runnable and whether a login exists.
 *
 * `loggedIn: true` means "credentials are on disk", NOT "credentials work": both `codex login status` and the
 * protocol's `getAuthStatus` were verified to report a healthy ChatGPT login on a machine whose refresh token had
 * been revoked server-side. That failure only surfaces at `thread/start`, as `error.data.action === "relogin"`,
 * which CodexAdapter turns into an `error` event telling the user to re-run `codex login`.
 *
 * A failing `codex login status` is only reported as `loggedIn: false` when its output actually says so (verified
 * against the real CLI: a logged-out `codex login status` exits 1 with "Not logged in" on stderr). Any other
 * failure — observed in practice from a malformed `config.toml`, which fails `login status` with a config-loading
 * error while `--version` still succeeds — is reported as `loggedIn: null` rather than guessed, so the UI doesn't
 * tell an already-logged-in user to re-run `codex login` for an unrelated problem.
 *
 * `versionArgs` exists so tests can point at a stub binary.
 */
export async function probeCodex(
  bin = process.env.REALM_CODEX_BIN ?? "codex",
  versionArgs: string[] = ["--version"],
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  let version: string;
  try {
    const { stdout } = await run(bin, versionArgs, { timeout: 5000 });
    version = stdout.trim();
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
  try {
    await run(bin, ["login", "status"], { timeout: 5000 });
    return { available: true, version: version || null, loggedIn: true, reason: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (looksLoggedOut(output)) {
      return { available: true, version: version || null, loggedIn: false, reason: "not logged in — run `codex login`" };
    }
    const detail = output.trim().split("\n")[0] || err.message;
    return { available: true, version: version || null, loggedIn: null, reason: `could not determine login status: ${detail}` };
  }
}
