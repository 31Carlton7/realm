import { randomBytes } from "node:crypto";
import { isReadOnlyMode, loggableAnswers, normalizeAnswers, requiredAnswered, sessionEvent, type AskAnswers, type AskCard, type SessionEvent } from "@realm/contracts";
import type { PermissionDecision } from "@realm/adapters";

/** Distinguishes broker-owned requestIds from adapter-owned ones in `sessions.respondPermission` —
 *  the router's ONLY signal, so it must never collide with an adapter id (adapters use `newId()`
 *  ULIDs, which cannot start with this prefix). */
const REQUEST_PREFIX = "bperm_";

/** A pending prompt older than this is answered "deny" on the user's behalf. Mirrors nothing in the
 *  adapters (they wait forever), but a browser tool call is a blocking MCP request inside an agent's
 *  turn — an abandoned prompt should eventually fail the tool call rather than wedge the turn until
 *  the agent's own transport gives up at some unhelpful place. */
const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

/** How a prompt ends. `cancelled` is nobody answering at all — the session went — which a question's
 *  asker may need told apart from the user's own "no". */
type Settle = (r: { decision: PermissionDecision; answers?: AskAnswers; cancelled?: boolean }) => void;
type PendingPrompt = { sessionId: string; toolKey: string; settle: Settle; timer: NodeJS.Timeout; alwaysPrompt: boolean; perSession: boolean; onAlwaysAllow?: () => void;
  /** Set for a QUESTION (`ask`): what its answers are held to, and how the log keeps them. */
  card?: AskCard };

/**
 * How a question ended, for the caller that asked it. `refused`: Realm declined it before anyone saw
 * it (the card says why). `timeout`: nobody answered within the prompt limit. `cancelled`: it stopped
 * mattering — the asker withdrew it, or the session went.
 */
export type AskOutcome =
  | { outcome: "answered"; answers: AskAnswers }
  | { outcome: "skipped" }
  | { outcome: "refused" }
  | { outcome: "timeout" }
  | { outcome: "cancelled" };

/**
 * Per-call gate behaviour.
 *
 * `alwaysPrompt` makes ONE call prompt every single time: `bypassPermissions` does not skip it and
 * `allow_always` neither satisfies it nor gets recorded by it. Exactly one tool sets it —
 * `browser_fill_credential`, the only tool that puts a real secret onto a page, and it sets it for
 * the password Realm generates as much as for the one the user enrolled.
 *
 * The reasoning, since this is the sole place a mode's meaning is narrowed: `bypassPermissions` means
 * "stop asking me about ordinary actions", and Realm has never treated a secret entering a page as an
 * ordinary action — `browser_act` refuses password fields in that mode too. A batched or remembered
 * approval is also the wrong shape for this specific decision: the card names an origin, and the
 * whole point of the origin gate is that the answer changes when the origin does.
 *
 * `promptUnderBypass` is the softer sibling: `bypassPermissions` does NOT skip the card, but
 * `allow_always` both satisfies and is recorded by it — so the user is asked once per `toolKey` and
 * never again for that key in that session.
 *
 * The computer-use tools set it, keyed per application. `bypassPermissions` means "stop asking me
 * about ordinary actions", and it earns that meaning from the blast radius being a web page in
 * Realm's own pane. Driving the whole machine has no such bound: the first time a session reaches
 * for Mail is a decision the user should get to make, and the difference between "drive TextEdit"
 * and "drive anything on this Mac" is not one a mode set for coding agents can express. Keying the
 * grant per app is what keeps approving one from licensing the rest.
 */
export type GateOptions = {
  alwaysPrompt?: boolean;
  promptUnderBypass?: boolean;
  /**
   * A durable grant the CALLER holds already covers this gate, so do not ask.
   *
   * The broker owns modes and prompting; where a standing approval is kept, and what it is keyed on,
   * belongs to whoever made it — the computer tools store bundle ids per space, which is not a shape
   * this class should know. Consulted in the same place a session `allow_always` is, so it satisfies
   * a `promptUnderBypass` gate for the same reason one does, and so plan and ask still refuse: a
   * standing approval says which apps are eligible, never that a read-only session may act.
   */
  preapproved?: boolean;
  /** Answered "always": persist it wherever `preapproved` will be read from next time. */
  onAlwaysAllow?: () => void;
  /**
   * The card asks for the rest of the SESSION, not for this one call, so a plain "Allow" is kept for
   * the session and key exactly as "Allow always" is. The simulator input tools set it, keyed per
   * device: a tap is one step of a run that takes dozens, and a card per tap is a card nobody reads
   * by the tenth. It records nothing durable — `onAlwaysAllow` still answers to "always" alone.
   */
  perSession?: boolean;
};

export type GateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * The mutating browser tools' permission gate (Plan 11 W3) — Realm's NORMAL permission flow, raised
 * from the server side instead of an adapter. A mutating tool call:
 *
 *   - runs free under `bypassPermissions` (parity with every adapter: that mode's whole meaning is
 *     "no prompts") — the HARD blocks (password fields, OAuth consent URLs, downloads) are not
 *     prompts and live elsewhere (the act executor in Electron main; the URL guard in agent-tools).
 *     Two narrowings exist, both opt-in per call and both documented on `GateOptions`:
 *     `alwaysPrompt` and `promptUnderBypass`;
 *   - is refused outright under `plan` (a read-only session must not click things);
 *   - otherwise emits a `permission_request` session event — the same event, card and
 *     `sessions.respondPermission` round trip the user already knows — and blocks the tool call on
 *     the decision. `allow_always` is remembered per session + tool for the session's lifetime.
 *
 * The broker owns its requestIds (`bperm_…`); `SessionService.respondPermission` routes those here
 * and everything else to the live adapter handle.
 *
 * It also asks QUESTIONS (`ask`), for the two askers Realm raises itself: `realm-ui`'s `ui_ask` and an
 * MCP server behind the hub eliciting mid-call. Same card channel, same round trip, answers carried.
 */
export class BrowserPermissionBroker {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly always = new Map<string, Set<string>>();

  constructor(private readonly d: {
    /** Fresh read of the session's CURRENT permission mode — a mid-session setOptions must count. */
    permissionMode: (sessionId: string) => string;
    /** Persist + broadcast one session event through the session's normal event path. */
    emit: (sessionId: string, ev: SessionEvent) => void;
  }) {}

  owns(requestId: string): boolean {
    return requestId.startsWith(REQUEST_PREFIX);
  }

  /** The user's answer, routed here by `SessionService.respondPermission`. Unknown ids are ignored
   *  (a stale card answered after the timeout already denied it), and so is an answer naming another
   *  session than the one the card was put to. */
  resolve(requestId: string, decision: PermissionDecision, answers?: AskAnswers, sessionId?: string): void {
    const p = this.pending.get(requestId);
    if (!p || (sessionId !== undefined && p.sessionId !== sessionId)) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    if (p.card) {
      // A question: held to its card, kept in the log with a mark where a masked answer was, and an
      // answer that leaves a required field empty is not an answer.
      const given = decision !== "deny" && answers ? normalizeAnswers(p.card, answers) : undefined;
      const answered = given !== undefined && Object.keys(given).length > 0 && requiredAnswered(p.card, given);
      this.d.emit(p.sessionId, sessionEvent("permission_response", { requestId, decision: answered ? "allow" : "deny", ...(answered ? { answers: loggableAnswers(p.card, given) } : {}) }));
      this.settled(p.sessionId);
      p.settle(answered ? { decision: "allow", answers: given } : { decision: "deny" });
      return;
    }
    // An `alwaysPrompt` gate records nothing: the user answering "always" to a credential fill card
    // must not silently license the next one, on whatever origin that turns out to be.
    const kept = decision === "allow_always" || (decision === "allow" && p.perSession);
    if (kept && !p.alwaysPrompt) {
      let set = this.always.get(p.sessionId);
      if (!set) { set = new Set(); this.always.set(p.sessionId, set); }
      set.add(p.toolKey);
      // The session set is kept even for a gate that also persists: it is what answers if the
      // durable write fails, and it keeps the answer working for the rest of THIS session either way.
      if (decision === "allow_always") p.onAlwaysAllow?.();
    }
    this.d.emit(p.sessionId, sessionEvent("permission_response", { requestId, decision }));
    this.settled(p.sessionId);
    p.settle({ decision });
  }

  /** The session is waiting on nothing of the broker's any more, so it is running again — and not
   *  before: a card still open beside the one just answered must keep its session waiting, or the
   *  transcript stops drawing it. */
  private settled(sessionId: string): void {
    for (const p of this.pending.values()) if (p.sessionId === sessionId) return;
    this.d.emit(sessionId, sessionEvent("status", { status: "running" }));
  }

  /** A session ended or was deleted: its prompts die with it (denied), its allow-always set is
   *  forgotten — a resumed session re-earns its grants. */
  release(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.settle({ decision: "deny", cancelled: true });
    }
    this.always.delete(sessionId);
  }

  /**
   * Put a question to the user on Realm's card and wait for the answers — the gate, extended to carry
   * them back. Used by Realm's own `ui_ask` and by the hub for an MCP server's elicitation, so both
   * reach the same card, the same `respondPermission` round trip and every surface that answers one.
   *
   * Allowed in EVERY mode, Plan, Ask and bypass included: a question changes nothing, and a session
   * whose mode refused it would be one that cannot ask what it needs to know. For the same reason
   * there is no "always": every question is asked.
   *
   * A card Realm already declined (`refused`) is recorded and answered at once, so the transcript says
   * what was declined and why. `signal` is the asker withdrawing the question — an MCP server whose
   * own request timed out, say — and takes the card down with it.
   */
  ask(sessionId: string, card: AskCard, o: { toolName: string; title: string; input?: Record<string, unknown>; signal?: AbortSignal }): Promise<AskOutcome> {
    const requestId = REQUEST_PREFIX + randomBytes(12).toString("base64url");
    const request = sessionEvent("permission_request", { requestId, toolName: o.toolName, input: o.input ?? {}, title: o.title, suggestions: [], ask: card });
    if (card.refused) {
      this.d.emit(sessionId, request);
      this.d.emit(sessionId, sessionEvent("permission_response", { requestId, decision: "deny" }));
      return Promise.resolve({ outcome: "refused" });
    }
    if (o.signal?.aborted) return Promise.resolve({ outcome: "cancelled" });
    return new Promise<AskOutcome>((resolve) => {
      /** The card goes without an answer: told to the transcript, and to the caller as `outcome`. */
      const withdraw = (outcome: "timeout" | "cancelled") => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        this.d.emit(sessionId, sessionEvent("permission_response", { requestId, decision: "deny" }));
        this.settled(sessionId);
        resolve({ outcome });
      };
      const timer = setTimeout(() => withdraw("timeout"), PROMPT_TIMEOUT_MS);
      o.signal?.addEventListener("abort", () => withdraw("cancelled"), { once: true });
      this.pending.set(requestId, {
        sessionId, toolKey: o.toolName, timer, alwaysPrompt: true, perSession: false, card,
        settle: (r) => resolve(r.cancelled ? { outcome: "cancelled" } : r.decision === "deny" || !r.answers ? { outcome: "skipped" } : { outcome: "answered", answers: r.answers }),
      });
      // After the pending entry exists, as the gate does: a same-tick answer must find it.
      this.d.emit(sessionId, request);
      this.d.emit(sessionId, sessionEvent("status", { status: "waiting_permission" }));
    });
  }

  /**
   * Forget one grant in every live session.
   *
   * Deliberately broad: a durable list is scoped to a space, this map is scoped to a session, and
   * the broker is never told which space a session belongs to. Dropping the key everywhere errs
   * towards asking again, which is the safe direction — the alternative is a session that keeps
   * driving an application the user has just taken off the list.
   */
  revoke(toolKey: string): void {
    for (const set of this.always.values()) set.delete(toolKey);
  }

  /**
   * Gate one mutating tool call. `toolKey` scopes `allow_always` (the tool name — "the user said
   * browser_act may always act in this session"); `title` is the human-readable line the ApprovalCard
   * shows; `input` is echoed onto the event so the card can show what the agent asked for.
   */
  async gate(sessionId: string, toolKey: string, title: string, input: Record<string, unknown>, toolName: string = toolKey, opts: GateOptions = {}): Promise<GateResult> {
    const mode = this.d.permissionMode(sessionId);
    if (isReadOnlyMode(mode)) return { allowed: false, reason: `this session is in ${mode === "plan" ? "Plan" : "Ask"} (read-only) mode — mutating tools are refused; switch modes to act` };
    if (!opts.alwaysPrompt) {
      // `allow_always` is consulted BEFORE the mode, so a `promptUnderBypass` gate the user has
      // already answered "always" to stops asking. For every other caller the two orders agree:
      // both branches return allowed.
      if (opts.preapproved) return { allowed: true };
      if (this.always.get(sessionId)?.has(toolKey)) return { allowed: true };
      if (mode === "bypassPermissions" && !opts.promptUnderBypass) return { allowed: true };
    }

    const requestId = REQUEST_PREFIX + randomBytes(12).toString("base64url");
    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.d.emit(sessionId, sessionEvent("permission_response", { requestId, decision: "deny" }));
        this.settled(sessionId);
        resolve("deny");
      }, PROMPT_TIMEOUT_MS);
      this.pending.set(requestId, { sessionId, toolKey, settle: (r) => resolve(r.decision), timer, alwaysPrompt: opts.alwaysPrompt === true, perSession: opts.perSession === true, onAlwaysAllow: opts.onAlwaysAllow });
      // Emitted AFTER the pending entry exists: a same-tick respondPermission must find it.
      // `toolName` is what the card SHOWS; `toolKey` is what `allow_always` remembers. They differ when
      // the grant must be narrower than the tool — Plan 20's ask keys on `agent_ask:<targetId>` so
      // approving one peer does not license interrupting every session in the space, while the card
      // still reads `agent_ask` rather than a bare ULID.
      this.d.emit(sessionId, sessionEvent("permission_request", { requestId, toolName, input, title, suggestions: [] }));
      this.d.emit(sessionId, sessionEvent("status", { status: "waiting_permission" }));
    });
    return decision === "deny"
      ? { allowed: false, reason: "the user denied this action" }
      : { allowed: true };
  }
}
