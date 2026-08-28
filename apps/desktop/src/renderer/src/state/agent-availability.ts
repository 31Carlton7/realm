import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, type AgentKind } from "@realm/contracts";
import type { AgentProbe } from "./store";

/**
 * What the prompter shows for a session's agent.
 *
 * - `ready` — the prompter. Also the answer while the probe is `unknown`: never replace a working
 *   prompter on a guess. `unknown` is reported separately so the onboarding sheet can say "Checking…".
 * - `missing` — the CLI isn't on PATH. Needs the *install* command.
 * - `logged_out` — the CLI runs but has no credentials. Needs the *login* command. Only an explicit
 *   `loggedIn === false` counts: `null` means the probe couldn't tell (Claude's keychain, both ACP
 *   agents), and telling a signed-in user to log in again is worse than saying nothing.
 */
export type AgentAvailability =
  | { state: "ready" | "unknown" }
  | { state: "missing" | "logged_out"; title: string; reason: string; command: string | null };

export function agentAvailability(kind: AgentKind, probe: AgentProbe[]): AgentAvailability {
  const p = probe.find((x) => x.kind === kind);
  if (!p) return { state: "unknown" };
  const label = AGENT_META[kind].label;
  if (!p.available) {
    return {
      state: "missing",
      title: `${label} isn’t installed`,
      reason: p.reason ?? `Realm could not run the ${label} CLI.`,
      command: AGENT_CLI_COMMANDS[kind].install,
    };
  }
  if (p.loggedIn === false) {
    return {
      state: "logged_out",
      title: `${label} isn’t signed in`,
      reason: p.reason ?? AGENT_LOGIN_HINTS[kind],
      command: AGENT_CLI_COMMANDS[kind].login,
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
