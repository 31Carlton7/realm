import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, claudeLoginHint, claudeLoginLine, type AgentKind } from "@realm/contracts";
import type { AgentProbe } from "./store";

/**
 * The Claude config folder a probe row answers for, where it names one. Null for the default
 * folder, for a row that does not say which folder it answers for, and for every other agent's row,
 * whose sign-in no folder decides.
 */
export function namedClaudeHome(row: AgentProbe | undefined): string | null {
  return row?.kind === "claude" && typeof row.home === "string" ? row.home : null;
}

/**
 * How a signed-out agent signs in: the line to run, and the sentence that stands beside it where
 * the probe gave no reason of its own.
 *
 * Both are the table's, except for Claude under a named config folder. The table's bare
 * `claude auth login` signs the default folder in and leaves the named one as it was, so a person
 * who ran it would come back to the same card. The line and the sentence name the folder instead.
 */
function signInFix(kind: AgentKind, row: AgentProbe): { command: string | null; hint: string } {
  const home = namedClaudeHome(row);
  return home === null
    ? { command: AGENT_CLI_COMMANDS[kind].login, hint: AGENT_LOGIN_HINTS[kind] }
    : { command: claudeLoginLine(home), hint: claudeLoginHint(home) };
}

/**
 * What the prompter shows for a session's agent.
 *
 * - `ready` — the prompter. Also the answer while the probe is `unknown`: never replace a working
 *   prompter on a guess. `unknown` is reported separately so the onboarding sheet can say "Checking…".
 * - `missing` — the CLI isn't on PATH. Needs the *install* command.
 * - `logged_out` — the CLI runs but has no credentials. Needs the *login* command. Only an explicit
 *   `loggedIn === false` counts: `null` means the probe couldn't tell (Claude's keychain, both ACP
 *   agents), and telling a signed-in user to log in again is worse than saying nothing.
 *
 * Claude's row for a config folder that is missing (`homeMissing`) is `logged_out` with no command.
 * The row reads signed out, and the login line for that folder is the one thing not to offer:
 * Claude Code makes a folder it is pointed at, which is the folder the server refuses a sign-in to
 * keep from being made. The card says the row's own reason, and Check again is all it offers. It is
 * read before whether the CLI is installed, since the row's reason is about the folder either way.
 */
export type AgentAvailability =
  | { state: "ready" | "unknown" }
  | { state: "missing" | "logged_out"; title: string; reason: string; command: string | null };

/** What a missing folder's card says where the row gave no reason of its own. */
const FOLDER_MISSING = "The Claude config folder is missing.";

export function agentAvailability(kind: AgentKind, probe: AgentProbe[]): AgentAvailability {
  const p = probe.find((x) => x.kind === kind);
  if (!p) return { state: "unknown" };
  const label = AGENT_META[kind].label;
  if (kind === "claude" && p.homeMissing) {
    return { state: "logged_out", title: `${label}’s config folder is missing`, reason: p.reason ?? FOLDER_MISSING, command: null };
  }
  if (!p.available) {
    return {
      state: "missing",
      title: `${label} isn’t installed`,
      reason: p.reason ?? `Realm could not run the ${label} CLI.`,
      command: AGENT_CLI_COMMANDS[kind].install,
    };
  }
  if (p.loggedIn === false) {
    const fix = signInFix(kind, p);
    return {
      state: "logged_out",
      title: `${label} isn’t signed in`,
      reason: p.reason ?? fix.hint,
      command: fix.command,
    };
  }
  return { state: "ready" };
}

/** True when the prompter must be replaced by the install card. `unknown` is not blocking. */
export function isBlocked(a: AgentAvailability): a is Extract<AgentAvailability, { command: string | null }> {
  return a.state === "missing" || a.state === "logged_out";
}

/** One-word status for the agent chip's menu and the onboarding CLI list. Null when there is nothing
 *  worth saying (ready agents read as plain rows). */
export function availabilityNote(a: AgentAvailability): string | null {
  return a.state === "missing" ? "not installed" : a.state === "logged_out" ? "signed out" : null;
}
