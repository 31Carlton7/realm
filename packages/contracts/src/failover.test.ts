import { describe, expect, it } from "vitest";
import {
  AUTH_MAX_RECHECKS, AUTH_RECHECK_BACKOFF_MS, DEFAULT_FAILOVER_POLICY, FAILOVER_BACKOFF_MS,
  FAILOVER_MAX_RETRIES, agentLabel, authBackoffFor, authFix, backoffFor, buildHandoffContext,
  classifyFailure, exhaustedNote, handoffNote, isHandoffable, isRetryable, nextInChain,
} from "./failover";
import type { AgentKind } from "./entities";

/**
 * The classifier's two mistakes are not symmetric, and this file is mostly about the expensive one.
 * Missing a usage limit costs a stopped turn the user restarts by hand. Inventing one spends quota
 * on a loop that cannot succeed, or moves someone's session onto a different agent because a tool
 * the agent ran happened to print the word "quota".
 */
describe("classifyFailure", () => {
  it("reads the harness wordings for an exhausted plan", () => {
    for (const m of [
      "Claude AI usage limit reached|1788555903",
      "You've hit your usage limit. Try again after 5pm.",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
      "You exceeded your current quota, please check your plan and billing details",
      "Rate limit exceeded",
    ]) expect(classifyFailure(m), m).toBe("usage_limit");
  });

  it("separates a dead credential from a spent one", () => {
    // Different answers: a spent quota is worth handing to another agent AND worth waiting on;
    // a dead credential is worth handing over and never worth retrying on the message alone.
    expect(classifyFailure("authentication_error: invalid x-api-key")).toBe("auth");
    expect(isRetryable("auth")).toBe(false);
    expect(isHandoffable("auth")).toBe(true);
  });

  it("reads the wording the Claude harness actually emitted", () => {
    // Verbatim from the transcript, four times on 2026-09-16. It classified as `fatal` — no retry,
    // no handoff, no advice — and the credentials it was about were sound six minutes later. This
    // string is the whole reason the auth path stopped being a guess.
    expect(classifyFailure("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe("auth");
  });

  it("separates an unwell provider from an unwell wire", () => {
    expect(classifyFailure("Overloaded_error: the model is overloaded")).toBe("provider_down");
    expect(classifyFailure("read ECONNRESET")).toBe("transient");
    // The distinction earns its keep here: a dropped socket must never move a session to another
    // agent. Rewriting whose agent is doing the work is a large answer to a hiccup.
    expect(isHandoffable("transient")).toBe(false);
    expect(isRetryable("transient")).toBe(true);
  });

  it("calls everything else fatal, including the things that merely sound like limits", () => {
    for (const m of [
      "TypeError: cannot read properties of undefined",
      "npm ERR! code ELIFECYCLE",
      // A TOOL the agent ran printing about a limit is not the harness hitting one. If these
      // classified, an ordinary failing test run would silently move the session to another agent.
      "test failed: expected disk quota banner to render",
      "warning: approaching the rate limit for this endpoint",
      "the file exceeded your current budget",
      "",
    ]) expect(classifyFailure(m), m).toBe("fatal");
  });

  it("lets the more specific row win when two could match", () => {
    // Both a usage phrase and a transient one are present. Reading this as transient would retry
    // the same exhausted agent three times before doing the thing that could work.
    expect(classifyFailure("rate limit exceeded — connection closed")).toBe("usage_limit");
  });

  it("does not care about case", () => {
    expect(classifyFailure("USAGE LIMIT REACHED")).toBe("usage_limit");
  });
});

describe("the retry ladder", () => {
  it("is short, rising, and clamps outside its range", () => {
    expect(FAILOVER_BACKOFF_MS.length).toBe(FAILOVER_MAX_RETRIES);
    expect([...FAILOVER_BACKOFF_MS]).toEqual([...FAILOVER_BACKOFF_MS].sort((a, b) => a - b));
    expect(backoffFor(1)).toBe(FAILOVER_BACKOFF_MS[0]);
    // Clamped rather than undefined: a caller that asks for attempt 9 gets the longest wait, not a
    // `setTimeout(NaN)` that fires immediately and hammers an agent that is already out of quota.
    expect(backoffFor(0)).toBe(FAILOVER_BACKOFF_MS[0]);
    expect(backoffFor(99)).toBe(FAILOVER_BACKOFF_MS[FAILOVER_MAX_RETRIES - 1]);
  });
});

describe("the chain", () => {
  it("hands off to the first agent this turn has not already tried", () => {
    const chain: AgentKind[] = ["codex", "acp:gemini"];
    expect(nextInChain({ retry: true, chain }, [])).toBe("codex");
    expect(nextInChain({ retry: true, chain }, ["codex"])).toBe("acp:gemini");
    expect(nextInChain({ retry: true, chain }, ["codex", "acp:gemini"])).toBeNull();
  });

  it("defaults to retrying but never to handing off", () => {
    // The safe half is the half that cannot surprise anyone: a retry finishes the turn on the agent
    // the user picked. A handoff changes who is doing their work, and who gets billed for it.
    expect(DEFAULT_FAILOVER_POLICY.retry).toBe(true);
    expect(DEFAULT_FAILOVER_POLICY.chain).toEqual([]);
    expect(nextInChain(DEFAULT_FAILOVER_POLICY, [])).toBeNull();
  });
});

describe("what the transcript is told", () => {
  it("names the agent, the reason and the destination", () => {
    expect(handoffNote("claude", "codex", "usage_limit"))
      .toBe("Claude hit its usage limit. Continuing on Codex.");
    expect(handoffNote("codex", "acp:gemini", "auth"))
      .toBe("Codex is not signed in. Continuing on Gemini.");
    expect(handoffNote("claude", "codex", "provider_down"))
      .toBe("Claude could not be reached. Continuing on Codex.");
  });

  it("says so plainly when there is nowhere to go", () => {
    expect(exhaustedNote("claude", "usage_limit"))
      .toBe("Claude hit its usage limit, and no fallback agent is configured for this space.");
  });

  it("gives every kind a name a sentence can hold", () => {
    // A note reading "acp:gemini hit its usage limit" is an enum leaking into prose.
    expect(agentLabel("acp:gemini")).toBe("Gemini");
    expect(agentLabel("acp:copilot")).toBe("GitHub Copilot");
  });
});

describe("the briefing the incoming agent gets", () => {
  const turns = [
    { role: "user" as const, text: "add a health endpoint" },
    { role: "assistant" as const, text: "done, in src/health.ts" },
  ];

  it("names who it is replacing and says the conversation could not be moved", () => {
    // An agent that believes it remembers the last hour when it does not will confidently
    // contradict work already on disk. Saying so is the whole job of this text.
    const c = buildHandoffContext({ from: "claude", turns });
    expect(c).toContain("running on Claude");
    expect(c).toContain("could not be moved");
    expect(c).toContain("same working directory");
    expect(c).toContain("Work already on disk is real");
  });

  it("carries the spoken turns inside a fence long enough to hold them", () => {
    const c = buildHandoffContext({ from: "claude", turns: [{ role: "assistant", text: "run ```sh\\nls\\n```" }] });
    // A three-backtick fence would be closed by the content's own run, spilling transcript into the
    // instruction as if the agent had written it.
    expect(c).toContain("````transcript");
  });

  it("keeps the TAIL when it has to cut, and says that it cut", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ role: "user" as const, text: `turn ${i} ${"x".repeat(200)}` }));
    const c = buildHandoffContext({ from: "codex", turns: many, max: 2_000 });
    expect(c).toContain("truncated to its newest");
    expect(c).toContain("turn 399");
    expect(c).not.toContain("turn 0 ");
    // The cut lands on a turn boundary — carried text that opens mid-sentence reads as corruption.
    expect(c).toMatch(/`{3,}transcript\nUser: turn /);
  });

  it("says plainly when there is nothing to carry, rather than fencing an empty block", () => {
    const c = buildHandoffContext({ from: "claude", turns: [] });
    expect(c).toContain("no transcript is carried");
    expect(c).not.toContain("transcript\n");
  });
});

describe("the auth ladder", () => {
  it("opens wider than the transient one, because it waits on a different thing", () => {
    // A dropped socket is gone by the next second; an expired OAuth session is waiting on the CLI to
    // refresh its own tokens, which took six minutes on the run this was built from. A ladder that
    // opened at one second would spend itself inside the window that was always going to fail.
    expect(AUTH_RECHECK_BACKOFF_MS.length).toBe(AUTH_MAX_RECHECKS);
    expect(AUTH_RECHECK_BACKOFF_MS[0]!).toBeGreaterThan(FAILOVER_BACKOFF_MS[0]!);
    expect(AUTH_RECHECK_BACKOFF_MS.at(-1)!).toBeGreaterThan(FAILOVER_BACKOFF_MS.at(-1)!);
    expect([...AUTH_RECHECK_BACKOFF_MS]).toEqual([...AUTH_RECHECK_BACKOFF_MS].sort((a, b) => a - b));
  });

  it("still ends, and within the time a person will sit through", () => {
    // Bounded on purpose: an agent that cannot authenticate after three spaced attempts while
    // claiming to be signed in will not on a fourth, and the fix is worth more than the wait.
    expect(AUTH_RECHECK_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    expect(authBackoffFor(0)).toBe(AUTH_RECHECK_BACKOFF_MS[0]);
    expect(authBackoffFor(99)).toBe(AUTH_RECHECK_BACKOFF_MS[AUTH_MAX_RECHECKS - 1]);
  });

  it("keeps auth out of the message-only retry rule", () => {
    // `isRetryable` is read before anything has checked the credentials. An auth failure earns
    // attempts from the probe, never from the phrase that produced it.
    expect(isRetryable("auth")).toBe(false);
  });
});

describe("what the user is told to do about an auth failure", () => {
  it("names the agent's own login command", () => {
    expect(authFix("claude", "signed_out")).toMatchObject({ title: "Claude is not signed in", command: "claude auth login" });
    expect(authFix("codex", "signed_out")).toMatchObject({ title: "Codex is not signed in", command: "codex login" });
  });

  it("tells a signed-in user something other than to sign in", () => {
    // They will check, find themselves signed in, and conclude Realm was wrong. The credential being
    // the problem — rather than its absence — is the only version of this they can act on.
    const fix = authFix("claude", "unverified");
    expect(fix.title).toBe("Claude could not authenticate");
    expect(fix.hint).toContain("signed in");
    expect(fix.hint).toContain("credentials");
    expect(fix.command).toBe("claude auth login");
  });

  it("claims no probe when none was run", () => {
    // With automatic retries off, nothing asked the CLI anything. Both other sentences are accounts
    // of a check — saying either here would be the exact lie they exist to prevent.
    const fix = authFix("claude", "unchecked");
    expect(fix.hint).toContain("did not check");
    expect(fix.hint).not.toContain("reports that it is signed in");
    expect(fix.command).toBe("claude auth login");
  });

  it("still says something for an agent with no login command at all", () => {
    // goose, deepseek and gemini have no `login`. A card with an empty command still has to carry
    // the sentence that says what the agent actually needs.
    for (const kind of ["acp:gemini", "acp:deepseek"] as AgentKind[]) {
      for (const why of ["signed_out", "unverified", "unchecked"] as const) {
        const fix = authFix(kind, why);
        expect(fix.command).toBeNull();
        expect(fix.hint.length).toBeGreaterThan(20);
      }
    }
  });
});
