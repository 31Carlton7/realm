import type { AcpSessionMode, SessionEvent, SessionEventPayload } from "@realm/contracts";

export type PlanStep = NonNullable<SessionEventPayload<"plan">["steps"]>[number];

export type Block =
  /** `attachments` present only when the message carried any — an attachment-only message (Plan 14
   *  W5) still renders a bubble naming its files rather than an empty one. */
  /** `from` is present only when ANOTHER session delivered this message (Plan 20). Absent means the
   *  user typed it — the ordinary case — and the pane must not attribute those to anyone. */
  | { kind: "user"; text: string; attachments?: { path: string; mime: string }[]; from?: { sessionId: string; title: string }; ts: number }
  | { kind: "assistant"; messageId: string; text: string; streaming: boolean; ts: number }
  | { kind: "thinking"; messageId: string; text: string; ts: number }
  | { kind: "tool"; toolUseId: string; name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } | null; ts: number }
  | { kind: "error"; message: string; ts: number }
  /** A plan the agent proposed. `text` is prose, `steps` a checklist, and at least one is present —
   *  which of them depends on the protocol, not on the agent's mood (see the `plan` event). A revised
   *  plan REPLACES this block rather than appending a second one, so `ts` stays the moment the plan
   *  first appeared: the card keeps its place in the scrollback, and claiming the revision's time
   *  would put it out of order with the messages around it. */
  | { kind: "plan"; planId: string; text?: string; steps?: PlanStep[]; ts: number }
  /** A finished run, banked where it finished. `ms` is how long the agent actually worked — the time
   *  the run sat parked on a permission prompt is subtracted, because a run the user left waiting on
   *  an Allow button for twenty minutes did not work for twenty minutes. `startedAt` rides along as
   *  the label's seed, so the settled line says "Cooked for 2m" under the "Cooking…" the reader was
   *  just watching (see run-label.ts). */
  | { kind: "run"; ms: number; startedAt: number; ts: number };

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
  /** The run in flight: when it started, and the permission-prompt time to take off its clock.
   *  `waitingSince` is the open half of that accounting. Null between runs. */
  run: { startedAt: number; waitedMs: number; waitingSince: number | null } | null;
};

/** Stable render identity for a block. Tool calls key on their own id so a card keeps its expanded
 *  state; everything else keys on position, which is stable because blocks are only ever appended or
 *  replaced in place (a streaming assistant block becomes its final self at the same index). */
export const blockKey = (b: Block, i: number): string =>
  b.kind === "tool" ? `tool:${b.toolUseId}` : b.kind === "plan" ? `plan:${b.planId}` : `${b.kind}:${i}`;

export const emptyTranscript = (): Transcript => ({ blocks: [], pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null });

const findLast = (blocks: Block[], pred: (b: Block) => boolean): number => { for (let i = blocks.length - 1; i >= 0; i--) if (pred(blocks[i]!)) return i; return -1; };

/** Pure reducer: normalized session events → what the transcript renders. Deltas accumulate into the open
 *  streaming assistant block; the final `assistant_text` replaces it. */
export function reduceTranscript(t: Transcript, e: SessionEvent): Transcript {
  const blocks = t.blocks.slice(); const last = blocks.at(-1);
  switch (e.type) {
    case "user_message": blocks.push({ kind: "user", text: e.payload.text, ...(e.payload.attachments.length ? { attachments: e.payload.attachments } : {}), ...(e.payload.from ? { from: e.payload.from } : {}), ts: e.ts }); return { ...t, blocks };
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
    case "plan": {
      const i = findLast(blocks, (b) => b.kind === "plan" && b.planId === e.payload.planId);
      const block: Block = {
        kind: "plan", planId: e.payload.planId,
        ...(e.payload.text ? { text: e.payload.text } : {}),
        ...(e.payload.steps ? { steps: e.payload.steps } : {}),
        ts: i >= 0 ? blocks[i]!.ts : e.ts,
      };
      if (i >= 0) blocks[i] = block; else blocks.push(block);
      return { ...t, blocks };
    }
    case "usage": return { ...t, usage: e.payload };
    case "init": return { ...t, init: { model: e.payload.model, tools: e.payload.tools, providerSessionId: e.payload.providerSessionId, ...(e.payload.availableModes ? { availableModes: e.payload.availableModes } : {}) } };
    case "status": {
      const run = t.run;
      switch (e.payload.status) {
        // A second `running` inside an open run is ordinary — the user queued another message, or the
        // adapter re-announced it as the last permission cleared — and must NOT restart the clock.
        case "running":
          if (!run) return { ...t, run: { startedAt: e.ts, waitedMs: 0, waitingSince: null } };
          if (run.waitingSince === null) return t;
          return { ...t, run: { ...run, waitedMs: run.waitedMs + (e.ts - run.waitingSince), waitingSince: null } };
        case "waiting_permission":
          if (!run || run.waitingSince !== null) return t;
          return { ...t, run: { ...run, waitingSince: e.ts } };
        // idle / error / ended all settle the run. Each also arrives with no run open — an adapter
        // announces `idle` when it boots and `ended` after the `idle` that closed the last turn — and
        // there the event is nothing: no clock was started, so there is no span to report.
        default: {
          if (!run) return t;
          const waited = run.waitedMs + (run.waitingSince === null ? 0 : e.ts - run.waitingSince);
          blocks.push({ kind: "run", ms: Math.max(0, e.ts - run.startedAt - waited), startedAt: run.startedAt, ts: e.ts });
          return { ...t, blocks, run: null };
        }
      }
    }
  }
}

export const reduceAll = (events: SessionEvent[], start = emptyTranscript()): Transcript => events.reduce(reduceTranscript, start);
