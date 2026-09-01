import { sessionEvent, type SessionEvent } from "@realm/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Block = { type: string; [k: string]: unknown };

/**
 * Pure, stateful mapper from SDK messages to normalized SessionEvents.
 * - Streaming deltas share a message id with the final `assistant` message: `message_start` sets the id and
 *   `message_stop` retires it, keyed by `parent_tool_use_id` so concurrent subagent streams don't clobber the
 *   top-level one. Retiring on an interim `assistant` notification instead (one can arrive per completed content
 *   block — e.g. after `thinking`, before the trailing `text` block even starts) would drop the id mid-stream and
 *   splinter every remaining delta onto its own id.
 * - v1 drops assistant text/thinking/delta events from subagents (`parent_tool_use_id != null`); their output reaches
 *   the transcript via the Task tool's `tool_result`. Subagent `tool_call`/`tool_result` events are kept (with
 *   `parentToolUseId`) so the UI can nest them.
 * - `assistant_text` is de-duplicated per (messageId, text) because the SDK can re-emit the same assistant message;
 *   the dedupe set is cleared on `result`.
 */
export function createSdkMapper() {
  const streamMsgIds = new Map<string | null, string>(); // parent_tool_use_id -> current streaming message id
  const emittedText = new Set<string>();
  return {
    map(msg: SDKMessage): SessionEvent[] {
      const out: SessionEvent[] = [];
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") out.push(sessionEvent("init", { providerSessionId: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd }));
          break;
        case "stream_event": {
          const parent = msg.parent_tool_use_id;
          const ev = msg.event as { type: string; index?: number; content_block?: Block; delta?: Block };
          // A message's content can hold several blocks (thinking, then text); the SDK reports each as
          // it completes via an interim `assistant` notification well before `message_stop` — completion
          // of the id's owning stream, not completion of any one block, is what should retire the id.
          if (ev.type === "message_start") streamMsgIds.set(parent, msg.uuid);
          else if (ev.type === "message_stop") streamMsgIds.delete(parent);
          if (parent !== null) break;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            out.push(sessionEvent("assistant_delta", { messageId: streamMsgIds.get(parent) ?? msg.uuid, delta: String(ev.delta.text) }));
          }
          break;
        }
        case "assistant": {
          const parent = msg.parent_tool_use_id;
          const m = msg.message as unknown as { id: string; content: Block[] };
          const messageId = streamMsgIds.get(parent) ?? m.id;
          for (const b of m.content) {
            if (b.type === "tool_use") {
              out.push(sessionEvent("tool_call", { toolUseId: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, parentToolUseId: parent }));
            } else if (parent !== null) {
              continue; // subagent prose dropped in v1 (see header comment)
            } else if (b.type === "text") {
              const key = messageId + ":" + String(b.text);
              if (!emittedText.has(key)) { emittedText.add(key); out.push(sessionEvent("assistant_text", { messageId, text: String(b.text) })); }
            } else if (b.type === "thinking" && String(b.thinking ?? "")) {
              out.push(sessionEvent("thinking", { messageId, text: String(b.thinking) }));
            }
          }
          break;
        }
        case "user": {
          const m = msg.message as { content: string | Block[] };
          if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") {
            const c = b.content as string | Block[] | undefined;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x.type === "text" ? String(x.text) : `[${x.type}]`)).join("\n") : "";
            out.push(sessionEvent("tool_result", { toolUseId: String(b.tool_use_id), content: text, isError: Boolean(b.is_error) }));
          }
          break;
        }
        case "result": {
          const r = msg as { subtype: string; is_error: boolean; num_turns: number; total_cost_usd: number; usage?: { input_tokens: number; output_tokens: number }; result?: string; errors?: string[] };
          out.push(sessionEvent("usage", { costUsd: r.total_cost_usd, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0, numTurns: r.num_turns }));
          if (r.subtype !== "success" || r.is_error) out.push(sessionEvent("error", { message: r.errors?.join("\n") || r.result || r.subtype }));
          emittedText.clear();
          streamMsgIds.clear();
          break;
        }
        default: break; // other SDK notices ignored in v1
      }
      return out;
    },
  };
}
