import type { AcpSessionMode, SessionEvent } from "@realm/contracts";

export type Block =
  | { kind: "user"; text: string; ts: number }
  | { kind: "assistant"; messageId: string; text: string; streaming: boolean; ts: number }
  | { kind: "thinking"; messageId: string; text: string; ts: number }
  | { kind: "tool"; toolUseId: string; name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } | null; ts: number }
  | { kind: "error"; message: string; ts: number };

export type PendingPermission = { requestId: string; toolName: string; input: Record<string, unknown>; title: string };
export type Usage = { costUsd: number; inputTokens: number; outputTokens: number; numTurns: number };
export type Transcript = {
  blocks: Block[];
  /** Open permission requests, oldest first (an agent may ask for several tools at once). */
  pendingPermissions: PendingPermission[];
  usage: Usage;
  /** `availableModes`: the agent's OWN session modes as the init event carried them (Plan 14 W3) —
   *  undefined when the agent named none. Per-session ground truth for the ACP Build/Plan chip. */
  init: { model: string; tools: string[]; providerSessionId: string; availableModes?: AcpSessionMode[] } | null;
};

/** Stable render identity for a block. Tool calls key on their own id so a card keeps its expanded
 *  state; everything else keys on position, which is stable because blocks are only ever appended or
 *  replaced in place (a streaming assistant block becomes its final self at the same index). */
export const blockKey = (b: Block, i: number): string => (b.kind === "tool" ? `tool:${b.toolUseId}` : `${b.kind}:${i}`);

export const emptyTranscript = (): Transcript => ({ blocks: [], pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null });

const findLast = (blocks: Block[], pred: (b: Block) => boolean): number => { for (let i = blocks.length - 1; i >= 0; i--) if (pred(blocks[i]!)) return i; return -1; };

/** Pure reducer: normalized session events → what the transcript renders. Deltas accumulate into the open
 *  streaming assistant block; the final `assistant_text` replaces it. */
export function reduceTranscript(t: Transcript, e: SessionEvent): Transcript {
  const blocks = t.blocks.slice(); const last = blocks.at(-1);
  switch (e.type) {
    case "user_message": blocks.push({ kind: "user", text: e.payload.text, ts: e.ts }); return { ...t, blocks };
    case "assistant_delta": {
      if (last?.kind === "assistant" && last.messageId === e.payload.messageId && last.streaming) blocks[blocks.length - 1] = { ...last, text: last.text + e.payload.delta };
      else blocks.push({ kind: "assistant", messageId: e.payload.messageId, text: e.payload.delta, streaming: true, ts: e.ts });
      return { ...t, blocks };
    }
    case "assistant_text": {
      const i = findLast(blocks, (b) => b.kind === "assistant" && b.messageId === e.payload.messageId && b.streaming);
      const block: Block = { kind: "assistant", messageId: e.payload.messageId, text: e.payload.text, streaming: false, ts: e.ts };
      if (i >= 0) blocks[i] = block; else blocks.push(block);
      return { ...t, blocks };
    }
    case "thinking": blocks.push({ kind: "thinking", messageId: e.payload.messageId, text: e.payload.text, ts: e.ts }); return { ...t, blocks };
    case "tool_call": blocks.push({ kind: "tool", toolUseId: e.payload.toolUseId, name: e.payload.name, input: e.payload.input, result: null, ts: e.ts }); return { ...t, blocks };
    case "tool_result": {
      const i = findLast(blocks, (b) => b.kind === "tool" && b.toolUseId === e.payload.toolUseId);
      const b = i >= 0 ? blocks[i] : undefined;
      if (b && b.kind === "tool") blocks[i] = { ...b, result: { content: e.payload.content, isError: e.payload.isError } };
      return { ...t, blocks };
    }
    case "permission_request": {
      const p = { requestId: e.payload.requestId, toolName: e.payload.toolName, input: e.payload.input, title: e.payload.title };
      return { ...t, pendingPermissions: [...t.pendingPermissions.filter((x) => x.requestId !== p.requestId), p] };
    }
    case "permission_response": {
      if (!t.pendingPermissions.some((p) => p.requestId === e.payload.requestId)) return t;
      return { ...t, pendingPermissions: t.pendingPermissions.filter((p) => p.requestId !== e.payload.requestId) };
    }
    case "error": blocks.push({ kind: "error", message: e.payload.message, ts: e.ts }); return { ...t, blocks };
    case "usage": return { ...t, usage: e.payload };
    case "init": return { ...t, init: { model: e.payload.model, tools: e.payload.tools, providerSessionId: e.payload.providerSessionId, ...(e.payload.availableModes ? { availableModes: e.payload.availableModes } : {}) } };
    case "status": return t;
  }
}

export const reduceAll = (events: SessionEvent[], start = emptyTranscript()): Transcript => events.reduce(reduceTranscript, start);
