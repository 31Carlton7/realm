import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one directory every live check runs an agent in — **stable across runs, and deliberately not a
 * `mkdtemp` scratch**.
 *
 * `codex app-server` records every `cwd` it is given as a trusted project in
 * `$CODEX_HOME/config.toml`:
 *
 * ```toml
 * [projects."/private/var/folders/…/T/realm-work-fOtXFa"]
 * trust_level = "trusted"
 * ```
 *
 * Verified against codex-cli 0.146.0 with a scratch `CODEX_HOME`: the write happens on `thread/start`,
 * for **every** approval policy and sandbox mode including `untrusted`/`read-only`, is flushed
 * asynchronously (a client that kills the process a second later never sees it), and is suppressed only
 * when an entry for that path already exists — `untrusted` counts. `initialize` alone writes nothing.
 * `ThreadStartParams` has no field that opts out. It is not a Realm bug and Realm cannot prevent it; it
 * is how the app-server treats a host that has its own trust UI.
 *
 * What Realm *could* prevent, and did not, is pointing it at a directory that then stops existing. Four
 * runs of `live-agent-check.ts` against `mkdtempSync(tmpdir(), "realm-work-")` left four permanent rows
 * in the user's config naming four deleted temp directories. So the live checks use one fixed path and
 * leave it on disk: at most one entry, always pointing somewhere real, and named so its origin is
 * obvious in a config file the user reads.
 *
 * Realm proper is unaffected — its sessions run in space folders and worktrees under `~/Realm`, which
 * are stable directories the user would expect to see trusted.
 */
export function liveWorkspace(): string {
  const path = join(tmpdir(), "realm-live-workspace");
  mkdirSync(path, { recursive: true });
  const readme = join(path, "README.txt");
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      "Scratch working directory for Realm's live agent checks (apps/server/scripts/live-*-check.ts).",
      "",
      "It has a fixed name on purpose. `codex app-server` records every cwd it is asked to start a",
      "thread in as a trusted project in ~/.codex/config.toml, and there is no way to ask it not to.",
      "A fresh temp directory per run would leave one dead [projects.\"...\"] entry in that file per run.",
      "",
      "Safe to delete; it will be recreated on the next run.",
      "",
    ].join("\n"));
  }
  return path;
}
