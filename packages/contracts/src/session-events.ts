import { z } from "zod";

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
  }),
  assistant_text: z.object({ messageId: z.string(), text: z.string() }),
  assistant_delta: z.object({ messageId: z.string(), delta: z.string() }),
  thinking: z.object({ messageId: z.string(), text: z.string() }),
  tool_call: z.object({ toolUseId: z.string(), name: z.string(), input: z.record(z.unknown()), parentToolUseId: z.string().nullable() }),
  tool_result: z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
  permission_request: z.object({ requestId: z.string(), toolName: z.string(), input: z.record(z.unknown()), title: z.string(), suggestions: z.array(z.unknown()) }),
  /** `answers` present only for question-shaped tools (AskUserQuestion): question text -> chosen label.
   *  Persisted so a replayed transcript records what was actually answered, not just that it was allowed. */
  permission_response: z.object({ requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]), answers: z.record(z.string()).optional() }),
  status: z.object({ status: z.enum(["idle", "running", "waiting_permission", "error", "ended"]) }),
  error: z.object({ message: z.string() }),
  usage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), numTurns: z.number() }),
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
  variant("permission_request"),
  variant("permission_response"),
  variant("status"),
  variant("error"),
  variant("usage"),
  variant("init"),
  variant("plan"),
  variant("feedback"),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
export type SessionEventPayload<T extends SessionEventType> = z.infer<(typeof P)[T]>;

export function sessionEvent<T extends SessionEventType>(type: T, payload: SessionEventPayload<T>, ts = Date.now()): SessionEventOf<T> {
  return { type, ts, payload } as SessionEventOf<T>;
}

/** Event types the server persists; the rest (assistant_delta) are ephemeral. */
export const PERSISTED_EVENT_TYPES: SessionEventType[] = ["user_message", "assistant_text", "thinking", "tool_call", "tool_result", "permission_request", "permission_response", "status", "error", "usage", "init", "plan", "feedback"];

export const StoredSessionEventSchema = z.object({ seq: z.number().int(), sessionId: z.string(), event: SessionEventSchema });
export type StoredSessionEvent = { seq: number; sessionId: string; event: SessionEvent };
