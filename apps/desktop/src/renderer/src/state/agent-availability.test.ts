import { describe, expect, it } from "vitest";
import { AGENT_CLI_COMMANDS } from "@realm/contracts";
import { agentAvailability, availabilityNote, isBlocked } from "./agent-availability";
import type { AgentProbe } from "./store";

const probe = (extra: Partial<AgentProbe> & { kind: AgentProbe["kind"] }): AgentProbe =>
  ({ available: true, version: null, loggedIn: null, reason: null, ...extra });

describe("agentAvailability", () => {
  it("an available agent is ready — the prompter stays", () => {
    const a = agentAvailability("claude", [probe({ kind: "claude", version: "2.0.1", loggedIn: true })]);
    expect(a.state).toBe("ready");
    expect(isBlocked(a)).toBe(false);
    expect(availabilityNote(a)).toBeNull();
  });

  it("an unavailable agent blocks, carrying the probe's OWN reason and the INSTALL command", () => {
    const a = agentAvailability("claude", [probe({ kind: "claude", available: false, reason: "spawn claude ENOENT" })]);
    expect(isBlocked(a)).toBe(true);
    expect(a).toMatchObject({ state: "missing", reason: "spawn claude ENOENT", command: AGENT_CLI_COMMANDS.claude.install });
    expect(availabilityNote(a)).toBe("not installed");
  });

  it("installed-but-signed-out is a DIFFERENT state with a DIFFERENT command", () => {
    const missing = agentAvailability("codex", [probe({ kind: "codex", available: false, reason: "not found" })]);
    const out = agentAvailability("codex", [probe({ kind: "codex", loggedIn: false, version: "1.2", reason: "not logged in — run `codex login`" })]);
    expect(out.state).toBe("logged_out");
    expect(isBlocked(out)).toBe(true);
    // The mutant that matters: collapsing these two would hand a signed-out user an install command
    // (or a user with no CLI a login command). Neither gets them anywhere.
    expect((out as { command: string | null }).command).toBe(AGENT_CLI_COMMANDS.codex.login);
    expect((missing as { command: string | null }).command).toBe(AGENT_CLI_COMMANDS.codex.install);
    expect((out as { command: string | null }).command).not.toBe((missing as { command: string | null }).command);
    expect((out as { title: string }).title).not.toBe((missing as { title: string }).title);
    expect(availabilityNote(out)).toBe("signed out");
  });

  it("loggedIn: null is NOT signed out — the probe simply could not tell", () => {
    // Claude keeps OAuth tokens in the keychain and both ACP agents refuse to answer offline. Blocking
    // on `null` would put the install card in front of every correctly signed-in Claude user.
    for (const kind of ["claude", "acp:cursor"] as const) {
      const a = agentAvailability(kind, [probe({ kind, loggedIn: null, reason: "unknown (keychain)" })]);
      expect(a.state, kind).toBe("ready");
      expect(isBlocked(a), kind).toBe(false);
    }
  });

  it("an un-probed agent is unknown, never blocked — no card on a guess", () => {
    const a = agentAvailability("claude", []);
    expect(a.state).toBe("unknown");
    expect(isBlocked(a)).toBe(false);
    // …and it is distinguishable from ready, so onboarding can say "Checking…".
    expect(a.state).not.toBe("ready");
  });

  it("falls back to prose when a probe reports failure without a reason", () => {
    const a = agentAvailability("claude", [probe({ kind: "claude", available: false, reason: null })]);
    expect((a as { reason: string }).reason).toMatch(/Claude/);
  });

  it("reads the entry for the kind asked about, not just the first one", () => {
    const list = [probe({ kind: "claude", available: false, reason: "gone" }), probe({ kind: "codex", loggedIn: true })];
    expect(agentAvailability("codex", list).state).toBe("ready");
    expect(agentAvailability("claude", list).state).toBe("missing");
  });
});
