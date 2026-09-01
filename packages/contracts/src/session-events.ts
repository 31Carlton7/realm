import { z } from "zod";

const P = {
  user_message: z.object({ text: z.string(), attachments: z.array(z.object({ path: z.string(), mime: z.string() })) }),
  assistant_text: z.object({ messageId: z.string(), text: z.string() }),
  assistant_delta: z.object({ messageId: z.string(), delta: z.string() }),
  thinking: z.object({ messageId: z.string(), text: z.string() }),
  tool_call: z.object({ toolUseId: z.string(), name: z.string(), input: z.record(z.unknown()), parentToolUseId: z.string().nullable() }),
  tool_result: z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
  permission_request: z.object({ requestId: z.string(), toolName: z.string(), input: z.record(z.unknown()), title: z.string(), suggestions: z.array(z.unknown()) }),
  permission_response: z.object({ requestId: z.string(), decision: z.enum(["allow", "allow_always", "deny"]) }),
  status: z.object({ status: z.enum(["idle", "running", "waiting_permission", "error", "ended"]) }),
  error: z.object({ message: z.string() }),
  usage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), numTurns: z.number() }),
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
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
export type SessionEventPayload<T extends SessionEventType> = z.infer<(typeof P)[T]>;

export function sessionEvent<T extends SessionEventType>(type: T, payload: SessionEventPayload<T>, ts = Date.now()): SessionEventOf<T> {
  return { type, ts, payload } as SessionEventOf<T>;
}

/** Event types the server persists; the rest (assistant_delta) are ephemeral. */
export const PERSISTED_EVENT_TYPES: SessionEventType[] = ["user_message", "assistant_text", "thinking", "tool_call", "tool_result", "permission_request", "permission_response", "status", "error", "usage", "init"];

export const StoredSessionEventSchema = z.object({ seq: z.number().int(), sessionId: z.string(), event: SessionEventSchema });
export type StoredSessionEvent = { seq: number; sessionId: string; event: SessionEvent };
