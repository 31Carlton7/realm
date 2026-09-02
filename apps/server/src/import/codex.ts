import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { EVENTS_MAX, arr, clipTool, clipToolInput, fallbackTitle, rec, readJsonl, str, toMs, type ParsedTranscript } from "./transcript";

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` — Codex's rollout log, one JSON object per
 * line, each `{timestamp, type, payload}`.
 *
 * The log carries the conversation TWICE, in two different registers, and choosing between them is
 * the whole of this parser's judgement:
 *
 * - `event_msg` is what Codex showed the user: `user_message` is the message they actually typed,
 *   `agent_message` what the agent actually said, `agent_reasoning` its summarised thinking.
 * - `response_item` is what went on the wire to the model: the same turns, but with the harness's
 *   injected context stapled on — `<permissions instructions>`, `<recommended_plugins>`, a
 *   `developer` role message carrying the whole system prompt.
 *
 * Speech is therefore read from `event_msg` and tool calls from `response_item` (which is the only
 * register that has them). Reading speech from `response_item` instead would import a "user message"
 * that is four kilobytes of plugin advertisements the user never wrote.
 */
export function parseCodexRollout(text: string, now: number): ParsedTranscript | null {
  const { rows } = readJsonl(text);
  const events: SessionEvent[] = [];
  let sessionId = "", cwd = "", originator = "", model: string | null = null;
  let startedAt = 0, updatedAt = 0, messages = 0;
  let usage: { input: number; output: number } | null = null;
  let truncated = false;

  for (const row of rows) {
    const type = str(row.type);
    const p = rec(row.payload);
    const ts = toMs(row.timestamp, updatedAt || now);

    // A rollout file can hold several `session_meta` lines: resuming a thread appends a fresh one.
    // The FIRST wins — it names the conversation this file is, and the id is the dedup key, so
    // letting a later line move it would make re-scans disagree with themselves.
    if (type === "session_meta") {
      if (!sessionId) {
        sessionId = str(p.session_id) || str(p.id);
        cwd = str(p.cwd);
        originator = str(p.originator);
        startedAt = toMs(p.timestamp ?? row.timestamp, now);
      }
      continue;
    }
    // `turn_context` is the only line that names the model in plain text.
    if (type === "turn_context") { if (!model) model = str(p.model) || null; if (!cwd) cwd = str(p.cwd); continue; }

    if (!startedAt) startedAt = ts;
    updatedAt = Math.max(updatedAt, ts);

    if (type === "event_msg") {
      const kind = str(p.type);
      if (kind === "user_message") {
        const t = str(p.message);
        if (t.trim() !== "") { events.push(sessionEvent("user_message", { text: t, attachments: [] }, ts)); messages++; }
      } else if (kind === "agent_message") {
        const t = str(p.message);
        if (t.trim() !== "") { events.push(sessionEvent("assistant_text", { messageId: `codex-${events.length}`, text: t }, ts)); messages++; }
      } else if (kind === "agent_reasoning") {
        const t = str(p.text);
        if (t.trim() !== "") events.push(sessionEvent("thinking", { messageId: `codex-${events.length}`, text: t }, ts));
      } else if (kind === "token_count") {
        // Emitted after every model call — 469k of them across this corpus. Only the running total
        // matters, so it is accumulated and spent as ONE `usage` event at the end rather than
        // becoming a third of the imported transcript.
        const info = rec(rec(p.info).total_token_usage);
        const i = Number(info.input_tokens), o = Number(info.output_tokens);
        if (Number.isFinite(i) && Number.isFinite(o)) usage = { input: i, output: o };
      }
      continue;
    }

    if (type !== "response_item") continue;
    const kind = str(p.type);
    // Both tool registers, normalised: `function_call` carries JSON `arguments`, `custom_tool_call`
    // a free-text `input` (an apply_patch hunk, a script). Realm's `tool_call.input` is a record,
    // so the free-text form is wrapped under one key rather than being made to look like arguments
    // it never had.
    if (kind === "function_call") {
      let parsed: unknown = str(p.arguments);
      try { parsed = JSON.parse(str(p.arguments)); } catch { /* not JSON: keep the raw string */ }
      events.push(sessionEvent("tool_call", {
        toolUseId: str(p.call_id) || str(p.id), name: str(p.name) || "tool",
        input: clipToolInput(parsed), parentToolUseId: null,
      }, ts));
    } else if (kind === "custom_tool_call") {
      events.push(sessionEvent("tool_call", {
        toolUseId: str(p.call_id) || str(p.id), name: str(p.name) || "tool",
        input: clipToolInput({ input: str(p.input) }), parentToolUseId: null,
      }, ts));
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      events.push(sessionEvent("tool_result", {
        toolUseId: str(p.call_id) || str(p.id), content: clipTool(outputText(p.output)), isError: false,
      }, ts));
    }
    if (events.length >= EVENTS_MAX) { truncated = true; break; }
  }

  if (!sessionId || events.length === 0) return null;
  if (usage) {
    events.push(sessionEvent("usage", { costUsd: 0, inputTokens: usage.input, outputTokens: usage.output, numTurns: messages }, updatedAt || now));
  }
  if (truncated) {
    events.push(sessionEvent("error", { message: `Realm imported the first ${EVENTS_MAX.toLocaleString("en-US")} events of this transcript; the rest is still in the source rollout file.` }, updatedAt || now));
  }
  return {
    providerSessionId: sessionId, cwd,
    title: fallbackTitle(events),
    events, messages,
    startedAt: startedAt || now,
    updatedAt: updatedAt || startedAt || now,
    // Codex records WHO drove it, so unlike the Claude side this is the source's own statement
    // rather than a guess: `realm` (and the `realm-smoke` live check) are Realm's own sessions.
    fromRealm: originator.startsWith("realm"),
    model,
  };
}

/** A tool output: a plain string, or the API's `[{type: "input_text", text}]` list form. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return arr(output).map((raw) => { const b = rec(raw); return str(b.text) || `[${str(b.type) || "content"}]`; }).join("\n");
}
