import { describe, expect, it } from "vitest";
import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, claudeLoginHint } from "@realm/contracts";
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

/** What the card offers a signed-out agent whose row reads `row`: the line to run, and the sentence
 *  beside it. */
const offered = (kind: AgentProbe["kind"], row: Partial<AgentProbe> = {}): { command: string | null; reason: string } => {
  const a = agentAvailability(kind, [probe({ kind, version: "2.1.296", loggedIn: false, ...row })]);
  if (!isBlocked(a)) throw new Error(`a signed-out ${kind} answered ${a.state}`);
  return a;
};

describe("Claude signed out of a config folder a profile names", () => {
  const home = "/Users/u/.claude-work";

  it("is offered the login line for that folder, since the bare command would sign the default folder in", () => {
    expect(offered("claude", { home }).command).toBe("env CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude auth login");
  });

  it("is told where that folder's sign-in is kept, where the probe gave no reason of its own", () => {
    const { reason } = offered("claude", { home });
    expect(reason).toBe(claudeLoginHint(home));
    expect(reason).toContain(home);
  });

  it("keeps the probe's own reason where it gave one", () => {
    const reason = "not signed in — run `env CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude auth login`";
    expect(offered("claude", { home, reason }).reason).toBe(reason);
  });
});

/** What the server's row says of a named folder that is not a directory now. */
const gone = { home: "/Users/u/.claude-work", homeMissing: true, reason: "The Claude config folder ~/.claude-work is missing." };

describe("Claude under a config folder that is missing", () => {
  it("is offered no login line, which would have Claude Code make the folder", () => {
    expect(offered("claude", gone).command).toBeNull();
  });

  it("is told the folder is missing in the card's title, with the row's own reason under it", () => {
    expect(offered("claude", gone)).toEqual({ state: "logged_out", title: "Claude’s config folder is missing", reason: gone.reason, command: null });
  });

  it("is told so even where the row says Claude Code is not installed, since the row's reason is about the folder", () => {
    expect(offered("claude", { ...gone, available: false })).toMatchObject({ title: "Claude’s config folder is missing", command: null });
  });

  it("still has a sentence to read where the row gives no reason", () => {
    expect(offered("claude", { ...gone, reason: null }).reason).toBe("The Claude config folder is missing.");
  });
});

describe("a signed-out agent no config folder is named for", () => {
  it("offers Claude the table's command and sentence on the default folder, stamped or not", () => {
    for (const row of [{ home: null }, {}]) {
      expect(offered("claude", row)).toMatchObject({ command: AGENT_CLI_COMMANDS.claude.login, reason: AGENT_LOGIN_HINTS.claude });
    }
  });

  it("offers another agent its own login, whatever folder its row carries", () => {
    expect(offered("codex", { home: "/Users/u/.claude-work" })).toMatchObject({ command: AGENT_CLI_COMMANDS.codex.login, reason: AGENT_LOGIN_HINTS.codex });
  });

  it("offers another agent its own login where its row says a folder is missing, which only Claude's row can say", () => {
    expect(offered("codex", { homeMissing: true })).toMatchObject({ command: AGENT_CLI_COMMANDS.codex.login, reason: AGENT_LOGIN_HINTS.codex });
  });
});
