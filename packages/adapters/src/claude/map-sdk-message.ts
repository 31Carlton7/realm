import { sessionEvent, type SessionEvent } from "@realm/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Block = { type: string; [k: string]: unknown };

/** Pure, stateful mapper from SDK messages to normalized SessionEvents. Streaming deltas share a synthetic message id with the final assistant message. */
export function createSdkMapper() {
  let streamMsgId: string | null = null; // id for the currently streaming assistant message
  const emittedText = new Set<string>();
  return {
    map(msg: SDKMessage): SessionEvent[] {
      const out: SessionEvent[] = [];
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") out.push(sessionEvent("init", { providerSessionId: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd }));
          break;
        case "stream_event": {
          const ev = msg.event as { type: string; index?: number; content_block?: Block; delta?: Block };
          if (ev.type === "message_start") streamMsgId = msg.uuid;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.push(sessionEvent("assistant_delta", { messageId: streamMsgId ?? msg.uuid, delta: String(ev.delta.text) }));
          break;
        }
        case "assistant": {
          const m = msg.message as unknown as { id: string; content: Block[] };
          const messageId = streamMsgId ?? m.id; streamMsgId = null;
          for (const b of m.content) {
            if (b.type === "text") {
              const key = messageId + ":" + String(b.text);
              if (!emittedText.has(key)) { emittedText.add(key); out.push(sessionEvent("assistant_text", { messageId, text: String(b.text) })); }
            } else if (b.type === "thinking" && String(b.thinking ?? "")) {
              out.push(sessionEvent("thinking", { messageId, text: String(b.thinking) }));
            } else if (b.type === "tool_use") {
              out.push(sessionEvent("tool_call", { toolUseId: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, parentToolUseId: msg.parent_tool_use_id }));
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
          const r = msg as { subtype: string; is_error: boolean; num_turns: number; total_cost_usd: number; usage?: { input_tokens: number; output_tokens: number }; result?: string };
          out.push(sessionEvent("usage", { costUsd: r.total_cost_usd, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0, numTurns: r.num_turns }));
          if (r.subtype !== "success" || r.is_error) out.push(sessionEvent("error", { message: r.result ?? r.subtype }));
          break;
        }
        default: break; // other SDK notices ignored in v1
      }
      return out;
    },
  };
}
