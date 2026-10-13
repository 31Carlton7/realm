import { homedir } from "node:os";

/**
 * The machine's home as realm-server reads it: where `~/.claude`, `~/.codex`, `~/.cursor` and
 * `~/.agents` hold the person's own skills and commands.
 *
 * A harness may name another (`REALM_USER_HOME`), and only a harness: honoured ONLY with
 * `REALM_ENABLE_FAKE_AGENT=1`, the flag every live check and capture boots with. The site's product
 * captures are published, and a run that booted on the developer's own folders put their skills
 * within reach of every picture that lists them.
 */
export function userHomeFor(env: NodeJS.ProcessEnv = process.env, real: () => string = homedir): string {
  const named = env.REALM_USER_HOME?.trim();
  return env.REALM_ENABLE_FAKE_AGENT === "1" && named ? named : real();
}
