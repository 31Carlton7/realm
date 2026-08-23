import { sessionEvent, type SessionEvent } from "@realm/contracts";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Item types Realm renders as a tool card, and the tool name it shows. */
function toolNameFor(item: Bag): string | null {
  switch (str(item.type)) {
    case "commandExecution": return "exec_command";
    case "fileChange": return "apply_patch";
    case "mcpToolCall": return `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`;
    case "dynamicToolCall": case "collabAgentToolCall": case "webSearch": return str(item.type);
    default: return null;
  }
}

function toolInputFor(item: Bag): Record<string, unknown> {
  switch (str(item.type)) {
    case "commandExecution": return { command: str(item.command), cwd: str(item.cwd) };
    case "fileChange": return { changes: item.changes ?? [] };
    case "mcpToolCall": return obj(item.arguments);
    default: { const { id: _id, type: _type, ...rest } = item; return rest; }
  }
}

function toolOutputFor(item: Bag): string {
  switch (str(item.type)) {
    case "commandExecution": {
      const out = str(item.aggregatedOutput);
      const code = item.exitCode;
      return typeof code === "number" && code !== 0 ? `${out}\n[exit ${code}]`.trim() : out;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Bag[]) : [];
      return changes.map((c) => `${str(obj(c.kind).type) || "change"} ${str(c.path)}\n${str(c.diff)}`.trimEnd()).join("\n\n");
    }
    case "mcpToolCall": {
      const err = str(item.error);
      if (err) return err;
      return typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? null);
    }
    default: return JSON.stringify(item);
  }
}

/**
 * Pure, stateful mapper from `codex app-server` notifications to Realm SessionEvents.
 *
 * - Codex's `userMessage` item is dropped: SessionService already emits `user_message` on send.
 * - Reasoning is emitted once, on `item/completed`, because Realm's `thinking` event has no delta variant.
 * - Open tool items are force-closed on `turn/completed`; an interrupt never sends their `item/completed`.
 * - Advisory notifications return `[]` — the adapter logs them instead of putting them in the transcript.
 */
export function createCodexMapper() {
  /** itemIds of tool items still awaiting item/completed. */
  const openTools = new Set<string>();
  let numTurns = 0;

  return {
    map(method: string, rawParams: unknown): SessionEvent[] {
      const p = obj(rawParams);
      const out: SessionEvent[] = [];

      switch (method) {
        case "item/started": {
          const item = obj(p.item);
          const id = str(item.id);
          const name = toolNameFor(item);
          if (name) { openTools.add(id); out.push(sessionEvent("tool_call", { toolUseId: id, name, input: toolInputFor(item), parentToolUseId: null })); }
          return out; // userMessage / agentMessage / reasoning starts carry no Realm event
        }

        case "item/completed": {
          const item = obj(p.item);
          const id = str(item.id);
          const type = str(item.type);
          if (type === "agentMessage") { out.push(sessionEvent("assistant_text", { messageId: id, text: str(item.text) })); return out; }
          if (type === "reasoning") {
            const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).map(str) : [];
            const content = Array.isArray(item.content) ? (item.content as unknown[]).map(str) : [];
            const text = [...summary, ...content].filter(Boolean).join("\n\n");
            if (text) out.push(sessionEvent("thinking", { messageId: id, text }));
            return out;
          }
          if (openTools.has(id)) {
            openTools.delete(id);
            out.push(sessionEvent("tool_result", { toolUseId: id, content: toolOutputFor(item), isError: str(item.status) !== "completed" }));
          }
          return out;
        }

        case "item/agentMessage/delta":
          return [sessionEvent("assistant_delta", { messageId: str(p.itemId), delta: str(p.delta) })];

        case "item/commandExecution/outputDelta":
          // Streamed stdout. Realm has no partial-tool-result event in v1; the full output arrives on item/completed.
          return [];

        case "turn/started":
          numTurns += 1;
          return [];

        case "turn/completed": {
          const turn = obj(p.turn);
          const status = str(turn.status);
          // An item still open here never got its own item/completed (an interrupt skips it entirely).
          for (const id of openTools) out.push(sessionEvent("tool_result", { toolUseId: id, content: status === "interrupted" ? "interrupted" : `turn ended without a result (${status})`, isError: true }));
          openTools.clear();
          if (status === "failed") out.push(sessionEvent("error", { message: str(obj(turn.error).message) || "turn failed" }));
          out.push(sessionEvent("status", { status: "idle" }));
          return out;
        }

        case "thread/status/changed": {
          const t = str(obj(p.status).type);
          if (t === "active") return [sessionEvent("status", { status: "running" })];
          if (t === "idle") return [sessionEvent("status", { status: "idle" })];
          if (t === "systemError") return [sessionEvent("status", { status: "error" })];
          return [];
        }

        case "thread/tokenUsage/updated": {
          const total = obj(obj(p.tokenUsage).total);
          return [sessionEvent("usage", { costUsd: 0, inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens), numTurns })];
        }

        case "error": {
          const message = str(obj(p.error).message) || "agent error";
          return [sessionEvent("error", { message: p.willRetry === true ? `${message} (retrying)` : message })];
        }

        default:
          return []; // advisory + firehose notifications; the adapter logs them
      }
    },

    /** Close anything still open — used when the process dies mid-turn. */
    closeOpenTools(reason: string): SessionEvent[] {
      const out = [...openTools].map((id) => sessionEvent("tool_result", { toolUseId: id, content: reason, isError: true }));
      openTools.clear();
      return out;
    },
  };
}
