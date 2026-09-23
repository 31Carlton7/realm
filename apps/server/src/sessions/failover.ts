import {
  AUTH_MAX_RECHECKS, DEFAULT_FAILOVER_POLICY, FailoverPolicySchema, authBackoffFor, authFix, backoffFor,
  buildHandoffContext, classifyFailure, exhaustedNote, failoverPolicyKey, handoffContextKey, handoffNote,
  isHandoffable, isRetryable, nextInChain, sessionEvent, FAILOVER_MAX_RETRIES,
  type AgentKind, type FailoverPolicy, type FailureKind, type Session, type SessionEvent,
} from "@realm/contracts";
import type { SessionsStore, SessionEventsStore } from "../store/sessions";
import type { SettingsStore } from "../store/settings";
import type { AdapterRegistry, ProbeResult } from "@realm/adapters";
import type { SendMessage } from "./service";

/**
 * Failover: finishing a turn the agent could not.
 *
 * Two moves, and the whole design is in knowing which one a failure deserves (`classifyFailure`
 * makes that call, and is where the evidence lives):
 *
 *  - **Retry.** Same agent, same provider conversation, after a short backoff. Nothing is lost —
 *    `resume: providerSessionId` still holds — so this is cheap and correct for a dropped socket or
 *    an overloaded upstream.
 *  - **Handoff.** Next agent in the space's chain, SAME session row, same worktree, conversation
 *    carried across as written text.
 *
 * ## Why a handoff may rewrite `agentKind` when `sessions.setAgent` refuses to
 *
 * `setAgent` refuses after a session's first event, and its reason is sound: "a transcript, a
 * providerSessionId and a resume are all tied to the agent that produced them, so there is no
 * coherent switch after the first message." A handoff is the coherent version of that switch, and it
 * is coherent because it answers every clause of the objection rather than ignoring it:
 *
 *  - the `providerSessionId` is CLEARED, so nothing resumes a thread the new agent never had;
 *  - `model` and `effort` are cleared, because model ids are per-kind and asking Codex for
 *    `claude-opus-5` is a lie the adapter would have to invent an answer to;
 *  - the transcript so far is carried as TEXT, the same mechanism forks use and for the same reason
 *    (no adapter can import another vendor's conversation);
 *  - and a `handoff` event is persisted, so the transcript states where the voice changed instead of
 *    leaving a reader to infer it.
 *
 * ## What this never does
 *
 * It never fires on a `fatal` failure, which is nearly all of them — an agent that failed because
 * the code is wrong will fail identically on the next agent, and spending someone's quota to prove
 * that is worse than stopping. It never hands off on a `transient` one either: rewriting whose agent
 * is doing your work is a large answer to a dropped socket. And with the default policy it never
 * hands off at all, because the chain starts empty — moving work between agents changes who is
 * billed for it, and that is the user's decision to make once, not Realm's to make silently.
 */

/** One turn's failover state. Discarded whenever the session settles cleanly. */
type Attempt = {
  /** The message being retried or carried. Null once the turn settles — a failure with nothing to
   *  replay can only be reported, never resumed. */
  msg: SendMessage | null;
  /** Same-agent retries already spent on this turn. */
  retries: number;
  /** Verified re-auth attempts already spent on this turn. Counted apart from `retries` because the
   *  two ladders answer different failures, and a turn that survived a dropped socket should not
   *  arrive at an expired token with its budget already gone. */
  reauths: number;
  /** Set when a re-auth probe read the agent's own CLI as having no session. With `reauths` it is
   *  the whole of what the user is told: which of the three sentences in `authFix` Realm has earned
   *  the right to say. */
  authSignedOut: boolean;
  /** Agent kinds this turn has already run on, oldest first. Keeps a chain from looping back. */
  tried: AgentKind[];
  /** The pending backoff, so an interrupt or a new message can cancel it. */
  timer: ReturnType<typeof setTimeout> | null;
};

export type FailoverDeps = {
  sessions: SessionsStore;
  events: SessionEventsStore;
  settings: SettingsStore;
  adapters: AdapterRegistry;
  /** Put an event on the session's transcript, down the same path the pump uses. */
  emit: (sessionId: string, ev: SessionEvent) => void;
  /** Re-deliver a turn's message without re-recording it as something the user typed and without
   *  taking a second checkpoint. `SessionService.resendTurn`. */
  resend: (sessionId: string, msg: SendMessage) => Promise<void>;
  /** Tear down the live adapter so the next `ensureLive` starts the new kind. */
  stop: (sessionId: string) => Promise<void>;
  /**
   * Ask the agent CLIs what they are. `SessionService.probe`, and ALWAYS called forced: a cached
   * answer is exactly the one this cannot use, because the thirty seconds the probe cache holds are
   * the thirty seconds in which the credential changed.
   */
  probe: (opts: { force: boolean }) => Promise<ProbeResult[]>;
  /** Injectable so tests do not spend real seconds on the backoff ladder. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
};

/**
 * The seam `SessionService` depends on, rather than the class itself.
 *
 * Same shape and same reason as the `notifications` and `browserAgents` hooks beside it: the service
 * is built AFTER the session service (it needs `resend` and `stop` off it), so the dependency has to
 * be an interface a late-bound closure can satisfy. It also keeps the "built without failover" case
 * honest — every call site is already `?.`-guarded.
 */
export type FailoverHooks = {
  turnStarted: (sessionId: string, msg: SendMessage) => void;
  cancel: (sessionId: string) => void;
  release: (sessionId: string) => void;
  close: () => void;
  onError: (session: Session, message: string) => void;
  extraSystemContext: (sessionId: string) => string | undefined;
};

export class FailoverService {
  private turns = new Map<string, Attempt>();
  private closing = false;
  constructor(private d: FailoverDeps) {}

  private setTimer = (fn: () => void, ms: number) => (this.d.setTimer ?? setTimeout)(fn, ms);
  private clearTimer = (t: ReturnType<typeof setTimeout>) => (this.d.clearTimer ?? clearTimeout)(t);

  /** The space's policy, or the default. A stored value that no longer parses degrades to the
   *  default rather than throwing: a malformed settings row must not be able to break `send`. */
  policy(spaceId: string): FailoverPolicy {
    const p = FailoverPolicySchema.safeParse(this.d.settings.get(failoverPolicyKey(spaceId)));
    return p.success ? p.data : DEFAULT_FAILOVER_POLICY;
  }

  setPolicy(spaceId: string, policy: FailoverPolicy): FailoverPolicy {
    // Kinds with no registered adapter are dropped rather than refused: a chain naming an agent that
    // this build does not ship should degrade to the agents it does, not fail to save.
    const chain = policy.chain.filter((k) => this.d.adapters[k]);
    const clean = { retry: policy.retry, chain: [...new Set(chain)] };
    this.d.settings.set(failoverPolicyKey(spaceId), clean);
    return clean;
  }

  /**
   * The carried context for a session that was handed over, re-injected on every adapter start (the
   * same standing-context posture forks and memory docs have). Undefined for every other session.
   */
  extraSystemContext(sessionId: string): string | undefined {
    const v = this.d.settings.get(handoffContextKey(sessionId));
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  /** A turn is starting. Records what to replay, and — because this is a NEW turn — forgets the
   *  previous one's retry budget and chain position. */
  turnStarted(sessionId: string, msg: SendMessage): void {
    this.cancel(sessionId);
    this.turns.set(sessionId, { msg, retries: 0, reauths: 0, authSignedOut: false, tried: [], timer: null });
  }

  /** The user pressed stop, or the session is going away. Any scheduled retry dies with it —
   *  resuming a turn somebody cancelled is the rudest thing this service could do. */
  cancel(sessionId: string): void {
    const t = this.turns.get(sessionId);
    // `!== null`, not truthiness: a timer handle is an opaque value and `0` is a legal one. A
    // truthiness check leaks a scheduled retry that then fires into a cancelled turn.
    if (t && t.timer !== null) this.clearTimer(t.timer);
    this.turns.delete(sessionId);
  }

  /** Forget a deleted session's carried context, wired into the session-release fan-out. */
  release(sessionId: string): void {
    this.cancel(sessionId);
    this.d.settings.set(handoffContextKey(sessionId), null);
  }

  /** Shutdown. Every pending backoff is dropped; nothing is scheduled after this. */
  close(): void {
    this.closing = true;
    for (const id of [...this.turns.keys()]) this.cancel(id);
  }

  /**
   * An `error` event arrived. Returns what will happen, so the caller can log it and tests can read
   * the decision without waiting on a timer.
   *
   * Deliberately fire-and-forget on the effects: `onEvent` is synchronous and on the pump's path, and
   * a retry that awaited the adapter would hold the transcript's event loop behind a network call.
   */
  onError(session: Session, message: string): "retry" | "reauth" | "handoff" | "stop" {
    if (this.closing) return "stop";
    const kind = classifyFailure(message);
    if (kind === "fatal") { this.cancel(session.id); return "stop"; }
    const turn = this.turns.get(session.id);
    // Nothing to replay: the failure arrived outside a turn this service saw start (a boot-time
    // drain, a session resumed by another producer). Reporting it is all that is honest.
    if (!turn?.msg) return "stop";
    const policy = this.policy(session.spaceId);

    if (policy.retry && isRetryable(kind) && turn.retries < FAILOVER_MAX_RETRIES) {
      const attempt = turn.retries + 1;
      const waitMs = backoffFor(attempt);
      turn.retries = attempt;
      this.d.emit(session.id, sessionEvent("retrying", { reason: kind === "provider_down" ? "provider_down" : "transient", attempt, waitMs }));
      this.scheduleResend(session.id, turn, waitMs);
      return "retry";
    }

    // The one failure Realm can CHECK instead of guessing about. Everything above this line decides
    // on the message; an auth failure gets decided on the agent's own answer to "are you signed in",
    // which is the difference between a token that expired mid-turn and a user who never signed in.
    // Behind `policy.retry` with the ladder above, because it is the same promise: this space has
    // said Realm may finish a turn its agent could not.
    if (kind === "auth" && policy.retry && turn.reauths < AUTH_MAX_RECHECKS) {
      void this.reauth(session, turn).catch((e) => {
        console.error(`[failover] re-auth failed for ${session.id}: ${e instanceof Error ? e.message : String(e)}`);
      });
      return "reauth";
    }

    return this.escalate(session, kind, turn, policy);
  }

  /**
   * The tail every unrecoverable failure reaches: hand the turn to the next agent, or stop and say
   * what happened. Shared with `reauth`, which arrives here having learned something `onError` could
   * not know without waiting on a child process.
   */
  private escalate(session: Session, kind: FailureKind, turn: Attempt, policy: FailoverPolicy): "handoff" | "stop" {
    if (!isHandoffable(kind)) { this.cancel(session.id); return "stop"; }
    const to = nextInChain(policy, [session.agentKind, ...turn.tried]);
    if (!to) {
      // Nowhere to go. Said out loud rather than swallowed: a user who configured no chain and just
      // lost an hour to a usage limit should learn that a chain is the thing that would have helped.
      //
      // Cancelled BEFORE the event goes out, and that order is load-bearing rather than tidy: `emit`
      // runs back through `onEvent`, which calls this very method again. With the turn already gone
      // the re-entry stops at "nothing to replay" instead of depending on how the sentence below
      // happens to classify.
      // Derived from what this turn actually did, not from a flag something remembered to set: the
      // CLI said no, or it said yes to every attempt this turn spent, or nobody asked it at all.
      const why = turn.authSignedOut ? "signed_out" : turn.reauths > 0 ? "unverified" : "unchecked";
      this.cancel(session.id);
      if (kind === "auth") {
        // The fix, not the post-mortem. `exhaustedNote` would say "is not signed in" here, which is
        // a claim about the user's credentials that Realm has either checked and found false, or —
        // with retries off — never checked at all.
        const fix = authFix(session.agentKind, why);
        this.d.emit(session.id, sessionEvent("error", { message: `${fix.title}. ${fix.hint}`, failure: "auth", fix }));
      } else if (policy.chain.length === 0) {
        this.d.emit(session.id, sessionEvent("error", { message: exhaustedNote(session.agentKind, kind), failure: kind }));
      }
      return "stop";
    }
    void this.handoff(session, to, kind, turn).catch((e) => {
      console.error(`[failover] handoff failed for ${session.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
    return "handoff";
  }

  /**
   * One verified re-auth attempt.
   *
   * The probe is the whole point and it is always FORCED — a cached answer is the one this cannot
   * use, since the window the cache holds is the window in which the credential changed.
   *
   * Three answers, three different things to do:
   *
   *  - `false` — the CLI says it has no session. Retrying would burn the ladder proving what has
   *    already been established, so this escalates immediately, carrying the reason so the user is
   *    told to sign in rather than told about a credential that does not exist.
   *  - `true` — the CLI says it is signed in and the turn failed to authenticate anyway. That is the
   *    refresh race, and asking again is exactly what resolves it.
   *  - `null` — the probe could not tell (an ACP agent, a CLI with no status command). Treated as
   *    `true`, because the ladder is bounded and three spaced attempts cost a turn ninety seconds,
   *    where refusing to try costs a turn that was going to succeed.
   */
  private async reauth(session: Session, turn: Attempt): Promise<void> {
    const attempt = turn.reauths + 1;
    turn.reauths = attempt;
    const signedIn = await this.signedIn(session.agentKind);
    // The await let the world move: the user may have pressed stop, sent something else, or closed
    // the app while a child process ran.
    if (this.closing || this.turns.get(session.id) !== turn || !turn.msg) return;
    if (signedIn === false) {
      turn.authSignedOut = true;
      this.escalate(session, "auth", turn, this.policy(session.spaceId));
      return;
    }
    const waitMs = authBackoffFor(attempt);
    this.d.emit(session.id, sessionEvent("retrying", { reason: "auth", attempt, waitMs }));
    this.scheduleResend(session.id, turn, waitMs);
  }

  /** Replay this turn after `waitMs`, unless it is no longer the turn. Both ladders end here, and
   *  the re-read is why: a backoff is dead time in which the user can press stop or send something
   *  else, and resuming a turn somebody moved on from is the rudest thing this service could do. */
  private scheduleResend(sessionId: string, turn: Attempt, waitMs: number): void {
    turn.timer = this.setTimer(() => {
      turn.timer = null;
      if (this.turns.get(sessionId) !== turn || !turn.msg) return;
      void this.d.resend(sessionId, turn.msg).catch(() => {});
    }, waitMs);
  }

  /** What the agent's own CLI says about being signed in, or null when it will not say. A probe that
   *  throws is null too: a failed probe is not evidence of a signed-out user. */
  private async signedIn(kind: AgentKind): Promise<boolean | null> {
    try {
      const results = await this.d.probe({ force: true });
      const row = results.find((r) => r.kind === kind);
      // An agent that no longer runs at all is not a sign-in problem, and answering `false` here
      // would send the user to a login command for a CLI that is missing.
      if (!row || !row.available) return null;
      return row.loggedIn;
    } catch {
      return null;
    }
  }

  /**
   * Move the session onto `to` and replay the turn there.
   *
   * Order matters and is load-bearing throughout: the adapter is stopped BEFORE the row is rewritten
   * (a live handle outliving its own `agentKind` would keep pumping the old agent's events into a
   * session that now claims to be another one), and the context is written BEFORE the row moves,
   * because `ensureLive` reads both and must never see one without the other.
   */
  private async handoff(session: Session, to: AgentKind, kind: FailureKind, turn: Attempt): Promise<void> {
    await this.d.stop(session.id);
    if (this.closing || this.turns.get(session.id) !== turn) return;

    const turns = this.d.events.transcript(session.id, Date.now());
    this.d.settings.set(handoffContextKey(session.id), buildHandoffContext({ from: session.agentKind, turns }));
    this.d.sessions.update({
      id: session.id, agentKind: to,
      // All three are per-kind and none of them survives the move. A stale providerSessionId would
      // ask the new adapter to resume a thread it has never heard of; a stale model id would ask it
      // for a model from another vendor's catalogue.
      providerSessionId: null, model: null, effort: null,
    });
    turn.tried = [...turn.tried, session.agentKind];
    this.d.emit(session.id, sessionEvent("handoff", {
      from: session.agentKind, to, reason: kind,
      note: handoffNote(session.agentKind, to, kind),
      attempt: turn.retries,
    }));
    // Every budget and verdict here is per-AGENT: the reason the old one was out of attempts says
    // nothing about this one, and neither does what its CLI said about being signed in. Carrying
    // either across would put the outgoing agent's sentence — and its login command — under the
    // incoming agent's failure.
    turn.retries = 0;
    turn.reauths = 0;
    turn.authSignedOut = false;
    if (turn.msg) await this.d.resend(session.id, turn.msg);
  }
}
