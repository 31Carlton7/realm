import { z } from "zod";
import { PlanAlertSchema, PlanLimitsUnavailableSchema, PlanWindowSchema } from "./plan-limits";

const P = {
  /** `from` is present ONLY when another session delivered this message (Plan 20's interjection).
   *  Absent means the user typed it, and absence is the ordinary case — the same polarity
   *  `dispatchedBy` uses. Optional so every row ever written still parses; no migration, no backfill.
   *  The pane reads it to label the bubble: rendering another agent's words as the user's would be a
   *  lie by omission, and the user would believe they had typed it. */
  user_message: z.object({
    text: z.string(),
    attachments: z.array(z.object({ path: z.string(), mime: z.string() })),
    from: z.object({ sessionId: z.string(), title: z.string() }).optional(),
    /** This turn was written by the session's own goal rather than typed by anyone — a continuation,
     *  or the handover a spent budget asks for. Absent on everything a person sent, including the
     *  objective itself, which the user really did write. The transcript attributes it for `from`'s
     *  reason: a reader must never come away believing they typed it. */
    goal: z.enum(["continuation", "budget"]).optional(),
  }),
  assistant_text: z.object({ messageId: z.string(), text: z.string() }),
  assistant_delta: z.object({ messageId: z.string(), delta: z.string() }),
  thinking: z.object({ messageId: z.string(), text: z.string() }),
  tool_call: z.object({ toolUseId: z.string(), name: z.string(), input: z.record(z.unknown()), parentToolUseId: z.string().nullable() }),
  tool_result: z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
  /**
   * A sub-agent the HARNESS is running in its own process, started or stopped.
   *
   * The gap this closes: a BACKGROUND sub-agent (`Agent`/`Task` launched async) returns its tool
   * result within a second — "Async agent launched successfully" — and then works for minutes with
   * nothing on the wire. Realm's only signal that a call was still running was a tool result that
   * had not arrived, so ten background agents looked exactly like ten finished ones, and the
   * delegation dock showed nothing for the whole run.
   *
   * `toolUseId` is the LAUNCHING call's id, which is how the harness itself refers back to the agent
   * in its completion notification. The harness's internal agent id is deliberately NOT carried: it
   * tells the model, in the tool result, not to repeat it, and a field Realm never renders is a field
   * Realm should never have.
   *
   * `stopped` rather than `finished` because that is what the notification means — it fires each time
   * the agent comes to rest, and the parent may send it another message and start it again. Realm
   * drops the row on the first stop, which under-reports a resumed agent rather than leaving a row
   * that outlives the work it names.
   */
  background_task: z.object({
    toolUseId: z.string(),
    status: z.enum(["running", "stopped"]),
    /** The harness's own one-line account of how it ended. Absent on `running`, and absent on a stop
     *  whose notification carried no summary — never defaulted to a sentence Realm made up. */
    summary: z.string().optional(),
  }),
  permission_request: z.object({ requestId: z.string(), toolName: z.string(), input: z.record(z.unknown()), title: z.string(), suggestions: z.array(z.unknown()) }),
  /** `answers` present only for question-shaped tools (AskUserQuestion): question text -> chosen label.
   *  Persisted so a replayed transcript records what was actually answered, not just that it was allowed. */
  permission_response: z.object({ requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]), answers: z.record(z.string()).optional() }),
  status: z.object({ status: z.enum(["idle", "running", "waiting_permission", "error", "ended"]),
    /** The turn ended because the USER pressed stop, not because the agent finished or failed.
     *  Present only on the settle that an interrupt produced. It is what lets the transcript say
     *  "Stopped" instead of banking the harness's own diagnostic as an error the user has to read —
     *  a cancelled turn is not a fault, and reporting it as one is the loudest lie in the log. */
    interrupted: z.boolean().optional() }),
  error: z.object({ message: z.string() }),
  /**
   * The provider's accounting of the ACCOUNT's plan quota, as it changes.
   *
   * Carried on the session's event channel because that is the only wire an adapter has, but it is
   * not about this session and is deliberately absent from `PERSISTED_EVENT_TYPES`: a transcript is
   * what happened in a conversation, and "your weekly window is at 78%" was true of the account for
   * a moment and will be wrong by the time anyone re-reads the log. The server folds it into
   * per-agent state instead, where the newest reading simply replaces the last.
   */
  /**
   * The next-move suggestion the prompter offers as its hint text, written by a model once per
   * settled turn (`PromptHintService`).
   *
   * Persisted, and `throughSeq` is why: a hint is about the turn that just ended, so reopening a
   * session should find the same suggestion rather than pay for it again — and an out-of-order
   * arrival must not overwrite a newer one. The renderer drops it the moment the user sends
   * anything, because at that point it is a suggestion about a turn that is no longer the last one.
   *
   * Absence is ordinary, not a failure: no generator, no Claude CLI, nothing worth suggesting, or a
   * call that failed all land here as "no event", and the prompter falls back to the deterministic
   * ladder in `prompt-hint.ts`.
   */
  prompt_hint: z.object({ text: z.string(), throughSeq: z.number().int() }),
  rate_limit: z.object({
    subscriptionType: z.string().nullable(),
    organization: z.string().nullable(),
    windows: z.array(PlanWindowSchema),
    alert: PlanAlertSchema,
    alertWindow: z.string().nullable(),
    unavailable: PlanLimitsUnavailableSchema.nullable(),
    detail: z.string().nullable(),
  }),
  /**
   * The session changed agents mid-flight, because the one it was on could not finish the turn
   * (`failover.ts` decides when). Persisted, and rendered — a session that changes hands has to say
   * so, or the reader is left comparing two agents' voices and wondering which of them wrote what.
   *
   * `attempt` counts the same-agent retries that were spent before the handoff, so the record is
   * complete: "we waited three times, then moved" is a different story to "we moved immediately",
   * and only the first one explains where thirty seconds went.
   */
  handoff: z.object({
    from: z.string(), to: z.string(),
    reason: z.enum(["usage_limit", "provider_down", "transient", "auth", "fatal"]),
    /** The sentence shown. Built server-side so every surface tells it identically. */
    note: z.string(),
    attempt: z.number().int(),
  }),
  /**
   * A same-agent retry is about to happen, after `waitMs`. Ephemeral rather than persisted: it is a
   * "hold on" for someone watching the pane right now, and a transcript reopened tomorrow should
   * show the turn that eventually ran, not three announcements of it being about to.
   */
  retrying: z.object({ reason: z.enum(["provider_down", "transient"]), attempt: z.number().int(), waitMs: z.number().int() }),
  /**
   * `contextTokens` is how much of the window the conversation OCCUPIES, and `contextWindow` is what
   * that was measured against. Both are the harness's own measurement — Claude's `getContextUsage`,
   * Codex's `tokenUsage.last` against `modelContextWindow` — never arithmetic on the other numbers
   * here.
   *
   * That arithmetic was tried, and it is wrong twice over. `inputTokens` on a `cumulative` series is
   * the session's running total and grows without bound. And the per-turn `usage` on Claude's result,
   * which reads like exactly the right thing, sums every REQUEST the turn made: a turn with thirty
   * tool calls re-reads its whole prompt from cache thirty times, so `input + cache_read +
   * cache_creation` reached 1.19M against a 1M window — a meter that could only climb, pinned at
   * 100%, on a session that had never come close to filling anything.
   *
   * The window rides along rather than being looked up in the model catalog because the two are not
   * the same number: Claude measures against the AUTOCOMPACT window, which on a 1M-window model is
   * often the 200K compaction boundary. A fraction whose halves come from different sources is a
   * fraction of nothing.
   *
   * Optional, and absent is a real answer rather than zero: only an adapter that can state the figure
   * emits it, every persisted row written before these fields existed parses without them, and a
   * reader with no value draws no context meter.
   */
  usage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), numTurns: z.number(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    /**
     * What fast mode ACTUALLY did on this turn, as the harness reported it — not what the session
     * asked for. `cooldown` is its own state rather than a flavour of `off`: it means the request
     * was honoured and then paused by a rate limit, which is a different thing to tell the user
     * than "your plan does not include this".
     *
     * On the `usage` event because that event is Realm's name for "the four numbers off the result",
     * and this is a fifth fact off the same result — the same reason `contextTokens` is here.
     * Absent from every engine that has no such concept. `claude` reports it off the result;
     * `codex` reports the service tier the thread is actually on (`priority` is its Fast), which it
     * announces before every turn — the other engines say nothing, and the switch is not offered.
     */
    fastMode: z.enum(["off", "cooldown", "on"]).optional(),
    /** Why it could not serve, verbatim from the harness (`free`, `model_not_allowed`, …). Present
     *  only alongside a `fastMode` that is not `on`, and only when the harness said. */
    fastModeReason: z.string().optional() }),
  /**
   * The harness replaced the conversation so far with a summary of it, because it stopped fitting.
   *
   * A seam, like `handoff`, and for the same reason: everything above the line is out of the model's
   * context and everything below it is working from a précis. The transcript still holds every one of
   * those messages, so without this event a reader scrolling back has no way to tell which of them the
   * agent can still see — and the meter above would have nothing to explain its own drop.
   *
   * `postTokens` is absent on builds that do not report it. The PAIR is what makes the line worth
   * reading, so a half-stated one is dropped rather than shown alone. `trigger` is carried and not
   * rendered: a manual compaction is one the user asked for and already knows about, and the line
   * says the same true thing either way.
   */
  compacted: z.object({ trigger: z.enum(["manual", "auto"]), preTokens: z.number(), postTokens: z.number().optional() }),
  /**
   * The agent below this line is NOT reading the conversation above it.
   *
   * Written when a session that HELD a provider session id came back without it — the provider was
   * asked to continue and declined, or the build could not be asked at all. Everything in the
   * transcript is still here and still true; what changed is that the agent no longer has it.
   *
   * A sibling of `handoff` and `compacted` rather than a variant of either, because it reports a
   * third thing: `handoff` is a different agent, `compacted` is the same agent with a summarised
   * context, and this is the same agent with NO context. All three draw as the same seam, because
   * what they have in common — "what is above is not what is below" — is the part the reader needs.
   *
   * Failover needs no special case here: it clears the token BEFORE the restart, so the session has
   * no id to have been refused and `handoff` is the only seam that speaks there.
   */
  context_reset: z.object({
    agent: z.string(),
    reason: z.enum(["declined", "unsupported"]),
    /** The sentence shown. Built server-side so every surface tells it identically. */
    note: z.string(),
  }),
  /** A plan the agent proposed. Both shapes are carried because the three protocols send genuinely
   *  different artifacts and neither derives from the other:
   *
   *   - **Claude** — `ExitPlanMode`'s `input.plan`, markdown prose. No structure at all.
   *   - **Codex** — TWO things. The `plan` ThreadItem is `{id, text}`, prose again; `turn/plan/updated`
   *     is `{step, status}[]`, a checklist. (`codex app-server generate-ts`, codex 0.146.0.)
   *   - **ACP** — the `plan` update's `entries: {content, status}[]`, a checklist
   *     (docs/dev/acp-protocol.md:182).
   *
   *  Collapsing the checklist to prose would throw away per-step status; synthesising steps out of
   *  Claude's markdown would invent structure it never sent. So a plan carries whichever it was given
   *  and at least one is always present — a mapper holding neither emits nothing rather than a card
   *  with no plan in it.
   *
   *  `planId` is the identity a REVISION lands on. Codex re-sends the whole plan on every
   *  `turn/plan/updated` and ACP says its `plan` is "not incremental: replace the whole list each
   *  time", so a repeat has to replace the card already drawn rather than stack a second one.
   *
   *  Both payload fields optional, per this file's rule that a new field must not break rows already
   *  on disk — transcripts are rebuilt from `session_events` at every relaunch. */
  plan: z.object({
    planId: z.string(),
    text: z.string().optional(),
    steps: z.array(z.object({ text: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })).optional(),
  }),
  /** The reader's verdict on one assistant message, and the only event here the USER authors about
   *  the agent rather than to it.
   *
   *  It is an event, not a settings row, for three reasons. A transcript is rebuilt from this log at
   *  every relaunch, so a verdict kept anywhere else has to be re-joined to a message by a second
   *  lookup that can silently drift. `permission_response` is the precedent — a user's decision
   *  recorded beside the thing it decides. And `session_events` is `ON DELETE CASCADE` from
   *  `sessions`, while the settings table has no delete at all: KV feedback would outlive by years
   *  the session it was about.
   *
   *  `rating: null` is a retraction — the reader taking it back. Append-only, so the LAST rating for
   *  a `messageId` wins and the earlier ones stay as the record of a mind being changed.
   *
   *  This never leaves the machine. Nothing reads it but the transcript that drew it. */
  feedback: z.object({ messageId: z.string(), rating: z.enum(["up", "down"]).nullable() }),
  /**
   * A model-written account of the session so far, replacing the derived one the panes fall back to.
   *
   * An EVENT rather than a column on the session row, because everything a summary needs is already
   * true of this rail: it is persisted, it replays in order when a transcript loads, and it
   * broadcasts to every open pane without a second channel. That is also what makes it cached — a
   * reopened session reads the last one off its own log instead of paying for another call.
   *
   * `throughSeq` is the event it was written from. It is what stops a settle from re-summarising a
   * transcript nothing has been added to (a status flap, a reconnect), and it is how a pane knows a
   * summary is stale rather than merely old.
   */
  summary: z.object({ text: z.string(), throughSeq: z.number().int() }),
  init: z.object({
    providerSessionId: z.string(), model: z.string(), tools: z.array(z.string()), cwd: z.string(),
    /** The instruction files the agent says it loaded — Codex `thread/start` `instructionSources`, W3's
     *  ground truth for the memory pane. Absent for agents that report nothing (all the others today). */
    instructionSources: z.array(z.string()).optional(),
    /** The agent's OWN session modes — ACP `session/new`/`session/load` `modes.availableModes`,
     *  captured verbatim (Plan 14 W3). Per-session ground truth for the Build/Plan chip on ACP
     *  sessions: the chip only appears when THIS list carries a Plan-equivalent (`acpPlanMode`).
     *  Absent for agents whose plan support is static (Claude, Codex) and for ACP builds that
     *  returned no `modes`. */
    availableModes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })).optional(),
    /** Whether the harness says THIS session's model can run fast mode, read from its own model list
     *  rather than from a table here (claude-adapter.ts asks `supportedModels()` after the handshake).
     *  Absent means the question was not answered — an agent that has no such concept, or a list the
     *  CLI declined — and the prompter offers nothing rather than guessing. */
    supportsFastMode: z.boolean().optional(),
    /** Whether Realm ASKED this handshake to continue an earlier conversation. False on a session's
     *  first boot, true on every boot after one. */
    resumeRequested: z.boolean().optional(),
    /**
     * What came of that ask. Absent when the adapter does not report it.
     *
     * - `continued` — the provider ACCEPTED the resume request. Deliberately not "the conversation is
     *   the same one": the Claude SDK forks to a fresh session id on resume, so "accepted" is the
     *   strongest claim Realm can make for every agent that reports this, and the one it makes.
     * - `declined` — the provider was asked and said no. Codex when the thread is gone from
     *   `~/.codex`; ACP when `session/load` rejects. The adapter started a fresh conversation instead.
     * - `unsupported` — never asked, because this build cannot. ACP where `initialize` did not answer
     *   `loadSession: true`.
     */
    resumeOutcome: z.enum(["continued", "declined", "unsupported"]).optional(),
  }),
} as const;

export type SessionEventType = keyof typeof P;

const variant = <T extends SessionEventType>(t: T) => z.object({ type: z.literal(t), ts: z.number(), payload: P[t] });

export const SessionEventSchema = z.discriminatedUnion("type", [
  variant("user_message"),
  variant("assistant_text"),
  variant("assistant_delta"),
  variant("thinking"),
  variant("tool_call"),
  variant("tool_result"),
  variant("background_task"),
  variant("permission_request"),
  variant("permission_response"),
  variant("status"),
  variant("error"),
  variant("handoff"),
  variant("retrying"),
  variant("usage"),
  variant("compacted"),
  variant("init"),
  variant("context_reset"),
  variant("plan"),
  variant("feedback"),
  variant("summary"),
  variant("rate_limit"),
  variant("prompt_hint"),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
export type SessionEventPayload<T extends SessionEventType> = z.infer<(typeof P)[T]>;

export function sessionEvent<T extends SessionEventType>(type: T, payload: SessionEventPayload<T>, ts = Date.now()): SessionEventOf<T> {
  return { type, ts, payload } as SessionEventOf<T>;
}

/** Event types the server persists; the rest (assistant_delta) are ephemeral. */
export const PERSISTED_EVENT_TYPES: SessionEventType[] = ["user_message", "assistant_text", "thinking", "tool_call", "tool_result", "background_task", "permission_request", "permission_response", "status", "error", "usage", "init", "plan", "feedback", "handoff", "compacted", "context_reset", "summary", "prompt_hint"];

export const StoredSessionEventSchema = z.object({ seq: z.number().int(), sessionId: z.string(), event: SessionEventSchema });
export type StoredSessionEvent = { seq: number; sessionId: string; event: SessionEvent };
