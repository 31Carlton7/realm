import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type GraphifyProbe = { available: boolean; version: string | null; reason: string | null };

/** The binary both the probe and the extractor spawn, overridable like every other engine's
 *  (`REALM_*_BIN`). One definition, because a probe that answers for a different binary than the one
 *  `graphify update` runs is worse than no probe. uv installs it to ~/.local/bin. */
export const graphifyBin = (): string => process.env.REALM_GRAPHIFY_BIN ?? "graphify";

/** Same 5s ceiling every other Realm probe spends: a probe is advisory, and a binary that cannot
 *  answer `--version` in five seconds is not one we want to block a pane mount on. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Checks the graphify CLI is runnable, the way `probeAcp` checks an agent CLI.
 *
 * There is no `loggedIn` here on purpose: `graphify update` extracts a code graph with no LLM and no
 * API key, so "installed" is the whole question — there is no credential that could be stale.
 *
 * `bin` overrides `graphifyBin()` above, for tests that spawn a stub.
 *
 * Never throws. A missing binary, a non-zero exit and a timeout are all the same answer to the one
 * question asked — `available: false` plus a reason a person can act on.
 */
export async function probeGraphify(bin?: string): Promise<GraphifyProbe> {
  const cmd = bin ?? graphifyBin();
  try {
    const { stdout } = await run(cmd, ["--version"], { timeout: PROBE_TIMEOUT_MS });
    // First line only: a CLI is free to print diagnostics under its version, and `null` rather than
    // `""` for empty output, because the UI renders a version only when there is one to render.
    const version = stdout.trim().split("\n")[0]?.trim() || null;
    return { available: true, version, reason: null };
  } catch (e) {
    return { available: false, version: null, reason: (e as Error).message };
  }
}
