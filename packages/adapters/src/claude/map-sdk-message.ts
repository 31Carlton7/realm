import { sessionEvent, type SessionEvent } from "@realm/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { backgroundTaskFrom } from "./background-task";

type Block = { type: string; [k: string]: unknown };

/**
 * Claude's plan, which arrives as an ordinary `ExitPlanMode` tool call.
 *
 * The markdown is `input.plan` — verified against real SDK transcripts on disk, whose tool_use input
 * is `{plan, planFilePath}`; the generated `ExitPlanModeInput` types only the deprecated
 * `allowedPrompts` and leaves the rest to its index signature, so the schema cannot be read for it.
 * Null when there is no plan string, and the call then maps as the plain tool call it is: a plan card
 * with no plan in it would be worse than the generic one.
 *
 * The `canUseTool` permission this same call raises is deliberately untouched. Approving it is how
 * the session leaves Plan, so it stays on the permission channel and keeps its decision.
 */
function exitPlanText(name: string, input: Record<string, unknown>): string | null {
  if (name !== "ExitPlanMode") return null;
  const plan = input["plan"];
  return typeof plan === "string" && plan.trim() ? plan : null;
}

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
/** The three states the SDK documents. Anything else is a build newer than this one, and an
 *  unrecognised string is safer left unstated than coerced into `off`. */
const FAST_STATES = new Set(["off", "cooldown", "on"]);

/**
 * `resumed` says this session asked the SDK to continue an earlier conversation, so the `init` event
 * can report what came of it. The claim is deliberately narrow — the SDK forks to a NEW session id on
 * resume rather than continuing the old one, so "the request was accepted" is the strongest thing
 * that is true, and it is what `resumeOutcome: "continued"` means here.
 */
export function createSdkMapper(opts: { resumed?: boolean } = {}) {
  const streamMsgIds = new Map<string | null, string>(); // parent_tool_use_id -> current streaming message id
  const emittedText = new Set<string>();
  return {
    map(msg: SDKMessage): SessionEvent[] {
      const out: SessionEvent[] = [];
      switch (msg.type) {
        case "system": {
          if (msg.subtype === "init") {
            out.push(sessionEvent("init", {
              providerSessionId: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd,
              ...(opts.resumed ? { resumeRequested: true, resumeOutcome: "continued" as const } : {}),
            }));
            break;
          }
          // The harness dropped the conversation and kept a summary. Nothing else on the wire says
          // it happened: the transcript keeps every message the model can no longer see, and the
          // context meter simply falls between one turn and the next with no account of why.
          if (msg.subtype === "compact_boundary") {
            const m = (msg as { compact_metadata?: { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown } }).compact_metadata;
            const post = typeof m?.post_tokens === "number" ? m.post_tokens : undefined;
            out.push(sessionEvent("compacted", {
              trigger: m?.trigger === "manual" ? "manual" : "auto",
              preTokens: typeof m?.pre_tokens === "number" ? m.pre_tokens : 0,
              ...(post === undefined ? {} : { postTokens: post }),
            }));
            break;
          }
          // The harness's task protocol — how a BACKGROUND sub-agent says it started and stopped.
          // Nothing else on the wire says it: its launching call returns immediately and then the
          // agent works for minutes in silence. See background-task.ts for the whole shape.
          const task = backgroundTaskFrom(msg);
          if (task) out.push(sessionEvent("background_task", task));
          break;
        }
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
              const toolUseId = String(b.id), name = String(b.name), input = (b.input as Record<string, unknown>) ?? {};
              const plan = exitPlanText(name, input);
              out.push(plan
                ? sessionEvent("plan", { planId: toolUseId, text: plan })
                : sessionEvent("tool_call", { toolUseId, name, input, parentToolUseId: parent }));
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
          const r = msg as { subtype: string; is_error: boolean; num_turns: number; total_cost_usd: number; usage?: { input_tokens: number; output_tokens: number }; result?: string; errors?: string[]; fast_mode_state?: string; fast_mode_disabled_reason?: string };
          // No context figure here, deliberately. `input_tokens + cache_read + cache_creation` off
          // this result reads like the size of the prompt just sent, and it is not: the SDK's
          // per-turn `usage` sums every REQUEST the turn made, so a turn with thirty tool calls
          // counts its cached prompt thirty times. It reached 1.19M against a 1M window on a session
          // nowhere near full. The occupancy comes from `getContextUsage` instead — see
          // `reportContextUsage` in claude-adapter.ts — which is the harness's own measurement of
          // what is actually resident.
          // What fast mode DID, as against what the session asked for. Carried only when the result
          // said — the field is optional in the SDK's own type, and an absent state means "this build
          // does not report it", which is a different thing from `off`.
          const fast = FAST_STATES.has(String(r.fast_mode_state)) ? (r.fast_mode_state as "off" | "cooldown" | "on") : undefined;
          const reason = fast !== undefined && fast !== "on" && typeof r.fast_mode_disabled_reason === "string"
            ? r.fast_mode_disabled_reason : undefined;
          out.push(sessionEvent("usage", { costUsd: r.total_cost_usd, inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0, numTurns: r.num_turns,
            ...(fast === undefined ? {} : { fastMode: fast }),
            ...(reason === undefined ? {} : { fastModeReason: reason }) }));
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
