import { z } from "zod";
import { AgentKindSchema, type AgentKind } from "./entities";
import { AGENT_META } from "./presets";

/**
 * Failover: finishing a turn that the agent could not.
 *
 * A turn that dies because the agent hit its usage limit, or because the provider went down, is not
 * a turn that failed. It is a turn that has not finished. Every part of Realm's answer to that lives
 * behind this file's one judgement — `classifyFailure` — because the decision to spend more of
 * someone's quota, or to hand their work to a different agent entirely, has to be made on evidence
 * rather than on a hopeful substring.
 *
 * The classifier is deliberately CONSERVATIVE. Its two mistakes are not symmetric:
 *
 *  - Missing a usage limit costs a stopped turn the user restarts by hand. Annoying, recoverable,
 *    and exactly what happens today.
 *  - Inventing one costs an automatic retry of work that genuinely failed — burning quota on a loop
 *    that cannot succeed, or silently moving a session onto a different agent because a *tool* the
 *    agent ran printed the word "quota". That is the failure mode that makes a feature like this
 *    something people turn off.
 *
 * So a phrase only earns a classification if it names the HARNESS's own limit, not any limit. This
 * is why the table below is phrases and not keywords.
 */

/**
 * What stopped the turn, as far as anything can tell from the message.
 *
 * - `usage_limit` — this agent is out of quota. Waiting does not help on any horizon a session
 *   cares about; another agent might. → handoff.
 * - `provider_down` — the far side is unwell (5xx, overloaded, capacity). Waiting genuinely helps,
 *   and so does another agent. → retry, then handoff.
 * - `transient` — a socket died, a stream ended early, a timeout. The same agent will very likely
 *   work on the next attempt. → retry only; NEVER a handoff, because moving agents for a dropped
 *   connection would rewrite someone's session over a hiccup.
 * - `auth` — not signed in, token expired, key rejected. No amount of retrying fixes it and no
 *   other agent's credentials are implied by it. → handoff, but never a retry.
 * - `fatal` — a real error. The turn is over and the user should read it.
 */
export const FailureKindSchema = z.enum(["usage_limit", "provider_down", "transient", "auth", "fatal"]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

/** Whether a kind is worth trying again ON THE SAME AGENT. */
export const isRetryable = (k: FailureKind): boolean => k === "provider_down" || k === "transient";

/** Whether a kind is worth handing to a DIFFERENT agent. A `transient` failure is pointedly not:
 *  the agent is fine, the wire hiccuped, and moving the session would be a large answer to a small
 *  problem. `fatal` is not either — a different agent would fail the same way. */
export const isHandoffable = (k: FailureKind): boolean =>
  k === "usage_limit" || k === "provider_down" || k === "auth";

/**
 * The phrase table.
 *
 * Every entry is a phrase Realm has a reason to believe an agent actually emits, and the reason is
 * written beside it. Where a phrase was read off a vendor's error catalogue rather than seen in a
 * live Realm session, it says so — a table that cannot tell those apart is a table nobody can audit
 * later, and this one will be audited every time a failover fires when it should not have.
 *
 * Matching is case-insensitive against the whole message. Ordering matters: the first matching row
 * wins, and the more specific kinds come first, so "rate limit exceeded, please retry" reads as a
 * usage limit rather than as something transient.
 */
const TABLE: { kind: FailureKind; phrases: readonly string[] }[] = [
  {
    kind: "usage_limit",
    phrases: [
      // Claude Code's own wording when the plan's window is exhausted; it appends a reset timestamp.
      "usage limit reached",
      "claude ai usage limit",
      // Codex's wording for the same condition.
      "you've hit your usage limit",
      "you have hit your usage limit",
      "usage limit exceeded",
      // The Anthropic and OpenAI API error types, which reach the harness verbatim on a 429.
      "rate_limit_error",
      "insufficient_quota",
      "quota exceeded",
      "exceeded your current quota",
      // The generic form, kept last in this group so a more specific row above claims it first.
      "rate limit exceeded",
      "too many requests",
    ],
  },
  {
    kind: "auth",
    phrases: [
      // Read off vendor error catalogues rather than seen live: Realm's probes catch a signed-out
      // agent long before a turn starts, so these fire mainly for a token that expired MID-session.
      "authentication_error",
      "invalid_api_key",
      "invalid api key",
      "oauth token has expired",
      "please run `claude login`",
      "please run `codex login`",
      "not authenticated",
      "unauthorized",
    ],
  },
  {
    kind: "provider_down",
    phrases: [
      "overloaded_error",
      "api_error",
      "service unavailable",
      "internal server error",
      "bad gateway",
      "server had an error",
      "temporarily unavailable",
      "capacity constraints",
      "upstream connect error",
    ],
  },
  {
    kind: "transient",
    phrases: [
      "econnreset",
      "econnrefused",
      "etimedout",
      "epipe",
      "enetdown",
      "enetunreach",
      "socket hang up",
      "network error",
      "fetch failed",
      "stream ended unexpectedly",
      "premature close",
      "request timed out",
      "connection closed",
    ],
  },
];

/**
 * Read one adapter `error` message and say what it was.
 *
 * Anything the table does not claim is `fatal` — the default has to be the one that does nothing,
 * because every other kind spends something (quota, or the user's session moving under them).
 */
export function classifyFailure(message: string): FailureKind {
  const m = message.toLowerCase();
  for (const row of TABLE) {
    for (const p of row.phrases) if (m.includes(p)) return row.kind;
  }
  return "fatal";
}

/**
 * How long to wait before attempt N (1-based) on the same agent.
 *
 * Three attempts, then stop trying and hand off. The ladder is short on purpose: a person is often
 * watching the pane, and a fourth wait of half a minute is longer than they will sit through — the
 * handoff is the better answer by then anyway.
 */
export const FAILOVER_BACKOFF_MS: readonly number[] = [1_000, 4_000, 12_000];

/** How many same-agent retries one turn gets before Realm stops asking that agent. */
export const FAILOVER_MAX_RETRIES = FAILOVER_BACKOFF_MS.length;

export const backoffFor = (attempt: number): number =>
  FAILOVER_BACKOFF_MS[Math.min(Math.max(attempt, 1), FAILOVER_MAX_RETRIES) - 1] ?? 0;

/**
 * A session's failover policy.
 *
 * `chain` is ordered and explicit rather than derived. A derived chain ("try whatever else is
 * installed") would send someone's half-finished work to an agent they have never used and may not
 * want billed, which is a decision that belongs to them and not to a heuristic.
 */
export const FailoverPolicySchema = z.object({
  /** Retry the same agent on a transient or upstream failure. */
  retry: z.boolean(),
  /** Agents to hand the turn to, in order, when retrying is not the answer. Empty = never hand off. */
  chain: z.array(AgentKindSchema),
});
export type FailoverPolicy = z.infer<typeof FailoverPolicySchema>;

/** Retries on, handoffs off. The safe half is the half that cannot surprise anyone: a retry finishes
 *  the turn the user asked for on the agent they picked, where a handoff changes who is doing the
 *  work. The second one is opt-in. */
export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = { retry: true, chain: [] };

/** The settings key holding one space's policy. Per-space rather than per-session: the chain is a
 *  statement about which agents you are willing to have do your work, and that does not change from
 *  one session to the next. */
export const failoverPolicyKey = (spaceId: string): string => `failover.policy:${spaceId}`;

/** The next agent to try, given the chain and everything already tried on this turn. Null when the
 *  chain is exhausted — the turn stops there, as an error, the way it does today. */
export function nextInChain(policy: FailoverPolicy, tried: readonly AgentKind[]): AgentKind | null {
  return policy.chain.find((k) => !tried.includes(k)) ?? null;
}

/** One line of plain speech for the transcript. Names the agent, the reason, and the destination —
 *  a handoff the reader cannot see is a session that changed hands behind their back. */
export function handoffNote(from: AgentKind, to: AgentKind, kind: FailureKind): string {
  const because = kind === "usage_limit" ? "hit its usage limit"
    : kind === "auth" ? "is not signed in"
    : "could not be reached";
  return `${agentLabel(from)} ${because}. Continuing on ${agentLabel(to)}.`;
}

/** The same sentence for the case where there is nowhere to go. */
export function exhaustedNote(from: AgentKind, kind: FailureKind): string {
  const because = kind === "usage_limit" ? "hit its usage limit"
    : kind === "auth" ? "is not signed in"
    : "could not be reached";
  return `${agentLabel(from)} ${because}, and no fallback agent is configured for this space.`;
}

/** The display name, from the one table that already holds it. A second map here would drift, and
 *  the drift would show up as one screen calling an agent "GitHub Copilot" while the note beside it
 *  said "Copilot" — or worse, said `acp:copilot`, an enum leaking into prose. */
export const agentLabel = (kind: AgentKind): string => AGENT_META[kind].label;

/**
 * The cap on transcript carried across a handoff, in characters (~6k tokens) — the same budget a
 * fork carries, for the same reason: the tail is what the next agent needs, and a briefing longer
 * than the work is a briefing nobody reads.
 */
export const HANDOFF_CONTEXT_MAX = 24_000;

/** The settings key holding one session's carried handoff context, read on every adapter start. */
export const handoffContextKey = (sessionId: string): string => `failover.context:${sessionId}`;

/**
 * What the incoming agent is told.
 *
 * The hard truth stated first, because everything else depends on it: the provider conversation
 * CANNOT be moved. No adapter Realm ships can rewind or import another vendor's thread, so a handoff
 * is a fresh conversation holding a written summary of the old one — and an agent that believes it
 * remembers the last hour when it does not will confidently contradict work already on disk.
 *
 * Spoken turns only. Tool chatter is bulk rather than context, and the files it touched are on disk
 * where the new agent can read them for itself.
 */
export function buildHandoffContext(input: {
  from: AgentKind;
  turns: { role: "user" | "assistant"; text: string }[];
  max?: number;
}): string {
  const max = input.max ?? HANDOFF_CONTEXT_MAX;
  let body = input.turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  let truncated = false;
  if (body.length > max) {
    // Keep the tail; cut forward to the next turn boundary so the carried text never opens mid-block.
    const tail = body.slice(body.length - max);
    const boundary = tail.indexOf("\n\n");
    body = boundary === -1 ? tail : tail.slice(boundary + 2);
    truncated = true;
  }
  const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((r) => r.length + 1)));
  const carried = input.turns.length === 0
    ? "There was no conversation before the handover, so no transcript is carried."
    : `The conversation so far is carried below as plain text${truncated
      ? ` — truncated to its newest ${max.toLocaleString("en-US")} characters; earlier turns are omitted`
      : ""}.`;
  return [
    "# Handed over mid-session",
    `This session was running on ${agentLabel(input.from)}, which could not finish the turn. ` +
    "You are taking it over IN PLACE: same working directory, same files, same task. " +
    "The provider conversation could not be moved, so this is a fresh conversation for you. " +
    carried +
    " Work already on disk is real — read it before redoing it.",
    ...(input.turns.length === 0 ? [] : [`${fence}transcript\n${body}\n${fence}`]),
  ].join("\n\n");
}
