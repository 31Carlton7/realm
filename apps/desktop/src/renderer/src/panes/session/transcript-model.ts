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
  /** `parentToolUseId` is the Task/Agent call this one was made UNDER — Claude's
   *  `parent_tool_use_id`, set only on a sub-agent's own calls. Absent is the ordinary case: the
   *  agent made the call itself, and every adapter that reports no hierarchy at all leaves it
   *  absent throughout, so those transcripts nest nothing and read exactly as before. */
  /** `background` is set only on a call that launched a BACKGROUND sub-agent: `running` from the
   *   moment the launch result lands, `stopped` when the harness notifies. Absent on every ordinary
   *   call, including a blocking sub-agent — whose "still going" is simply `result === null`. */
  | { kind: "tool"; toolUseId: string; name: string; input: Record<string, unknown>; parentToolUseId?: string; result: { content: string; isError: boolean } | null; background?: "running" | "stopped"; ts: number }
  | { kind: "error"; message: string; ts: number }
  /**
   * The session changed agents mid-turn, because the one it was on could not finish (failover).
   *
   * Rendered rather than swallowed, and rendered AT the point it happened rather than summarised at
   * the top: everything above this line is one agent's voice and everything below is another's, and
   * a reader comparing the two needs to know where the seam is. `attempt` is how many same-agent
   * retries were spent first, which is what explains the gap in the timestamps.
   */
  | { kind: "handoff"; from: string; to: string; note: string; attempt: number; ts: number }
  /**
   * A retry is pending. Ephemeral in every sense — the event is not persisted, and the block is
   * REPLACED by the next one rather than stacking, so three attempts leave one line saying what is
   * happening now instead of three saying what already did.
   */
  | { kind: "retrying"; attempt: number; waitMs: number; ts: number }
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
  | { kind: "run"; ms: number; startedAt: number; ts: number;
      /** The user pressed stop. The line says so instead of reporting the work as finished — and it
       *  is the only thing the transcript keeps about a cancelled turn, because the harness's own
       *  diagnostic for one is a fact about an API call, not about anything the reader did. */
      stopped?: boolean };

export type Rating = "up" | "down";
export type PendingPermission = { requestId: string; toolName: string; input: Record<string, unknown>; title: string };
export type Usage = { costUsd: number; inputTokens: number; outputTokens: number; numTurns: number;
  /** The last prompt's size in tokens, when the agent stated one — see the `usage` event's own note.
   *  Undefined for every engine that cannot say, which is most of them; the prompter draws no context
   *  meter there rather than a full or an empty one. */
  contextTokens?: number;
  /** What fast mode actually DID on the last turn, as the harness reported it — never what the
   *  session asked for. Undefined where the engine does not report it at all. */
  fastMode?: "off" | "cooldown" | "on";
  /** Why it could not serve, in the harness's own vocabulary. */
  fastModeReason?: string };
export type Transcript = {
  blocks: Block[];
  /** Open permission requests, oldest first (an agent may ask for several tools at once). */
  pendingPermissions: PendingPermission[];
  usage: Usage;
  /** `availableModes`: the agent's OWN session modes as the init event carried them (Plan 14 W3) —
   *  undefined when the agent named none. Per-session ground truth for the ACP Build/Plan chip. */
  init: { model: string; tools: string[]; providerSessionId: string; availableModes?: AcpSessionMode[];
    /** Whether the harness says this session's model can run fast mode. Undefined is "not stated",
     *  which is what every engine but `claude` leaves it as — and what the prompter reads as "offer
     *  no switch" rather than as "no". */
    supportsFastMode?: boolean } | null;
  /** The run in flight: when it started, and the permission-prompt time to take off its clock.
   *  `waitingSince` is the open half of that accounting. Null between runs. */
  run: { startedAt: number; waitedMs: number; waitingSince: number | null } | null;
  /** What the reader made of each answer, keyed by `messageId`. Only rated messages appear: absent
   *  is "not judged", which is a different state from either verdict and must stay tellable. */
  feedback: Record<string, Rating>;
};

/** Stable render identity for a block. Tool calls key on their own id so a card keeps its expanded
 *  state; everything else keys on position, which is stable because blocks are only ever appended or
 *  replaced in place (a streaming assistant block becomes its final self at the same index). */
export const blockKey = (b: Block, i: number): string =>
  b.kind === "tool" ? `tool:${b.toolUseId}` : b.kind === "plan" ? `plan:${b.planId}` : `${b.kind}:${i}`;

export const emptyTranscript = (): Transcript => ({ blocks: [], pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {} });

export type UserBlock = Extract<Block, { kind: "user" }>;

/**
 * The message a retry would ask again: the last one the USER wrote.
 *
 * A `from`-bearing block is skipped rather than returned. Those are another session's words
 * delivered into this one, and re-sending one would put the user's hand on a question they never
 * asked — the same reason the bubble is attributed instead of drawn plain.
 *
 * Null means there is nothing to ask again, which is the honest state of a session before its first
 * send and of one whose only messages arrived from a peer.
 */
export const lastUserMessage = (t: Transcript): UserBlock | null => {
  for (let i = t.blocks.length - 1; i >= 0; i--) {
    const b = t.blocks[i]!;
    if (b.kind === "user" && !b.from) return b;
  }
  return null;
};

/** Drop the trailing run of blocks that a failure/recovery event supersedes. Trailing only — an
 *  error from an EARLIER turn is that turn's history and must survive whatever this one does. */
const dropPending = (blocks: Block[]): Block[] => {
  let end = blocks.length;
  while (end > 0 && (blocks[end - 1]!.kind === "retrying" || blocks[end - 1]!.kind === "error")) end--;
  return blocks.slice(0, end);
};

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
    case "tool_call": blocks.push({ kind: "tool", toolUseId: e.payload.toolUseId, name: e.payload.name, input: e.payload.input, ...(e.payload.parentToolUseId ? { parentToolUseId: e.payload.parentToolUseId } : {}), result: null, ts: e.ts }); return { ...t, blocks };
    case "tool_result": {
      const i = findLast(blocks, (b) => b.kind === "tool" && b.toolUseId === e.payload.toolUseId);
      const b = i >= 0 ? blocks[i] : undefined;
      if (b && b.kind === "tool") blocks[i] = { ...b, result: { content: e.payload.content, isError: e.payload.isError } };
      return { ...t, blocks };
    }
    /* A background sub-agent started or stopped. Folded onto the LAUNCHING call's block, which is
       where the dock reads it from and where the transcript already shows the call itself.
       A notification naming a call this transcript has never seen is dropped on the floor rather
       than pushing a block of its own: the row it would create has no label, no start time and
       nothing to open, and inventing one out of an unattributable message is how a stray `<task-
       notification>` in some quoted text becomes a phantom agent. */
    case "background_task": {
      const i = findLast(blocks, (b) => b.kind === "tool" && b.toolUseId === e.payload.toolUseId);
      const b = i >= 0 ? blocks[i] : undefined;
      if (!b || b.kind !== "tool") return t;
      // A stop only ever settles a call this transcript watched START. The harness notifies about
      // every task it finishes, including the shell commands a sub-agent runs inside itself, and
      // those arrive naming a real `tool_use_id` — the Bash call's. Marking that block `stopped`
      // would be recording an agent's end on a call that never had an agent behind it.
      if (e.payload.status === "stopped" && b.background !== "running") return t;
      blocks[i] = { ...b, background: e.payload.status };
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
    // A failure and the recovery from it are ONE thing, and only one of them should be on screen.
    //
    // The events are all persisted — the record stays complete, and a bug report still has the
    // harness's own words. What changes is which of them the transcript draws, because "the agent
    // hit its usage limit" printed as a red alert directly above "Claude hit its usage limit,
    // continuing on Codex" tells the reader twice, and the first telling says the turn failed when
    // it did not.
    //
    // The three cases, and why the pair below is symmetric rather than one-directional:
    //   error → retrying   the wait supersedes the failure
    //   error → handoff    the seam supersedes the failure
    //   retrying → error   the ladder ran out; the failure supersedes the wait, and is final
    case "error":
      return { ...t, blocks: [...dropPending(blocks), { kind: "error", message: e.payload.message, ts: e.ts }] };
    case "handoff":
      return { ...t, blocks: [...dropPending(blocks),
        { kind: "handoff", from: e.payload.from, to: e.payload.to, note: e.payload.note, attempt: e.payload.attempt, ts: e.ts }] };
    case "retrying": {
      // Replace rather than stack: attempt 2 says what attempt 1 said, one number later, and a
      // transcript that keeps both is a transcript reporting the wait instead of the work.
      return { ...t, blocks: [...dropPending(blocks),
        { kind: "retrying", attempt: e.payload.attempt, waitMs: e.payload.waitMs, ts: e.ts }] };
    }
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
    // Append-only, so the last verdict for a message wins and a retraction is a `null` rating
    // rather than a row going away — the log records the reader changing their mind, not just
    // where they landed.
    case "feedback": {
      const { [e.payload.messageId]: _prev, ...rest } = t.feedback;
      return { ...t, feedback: e.payload.rating ? { ...rest, [e.payload.messageId]: e.payload.rating } : rest };
    }
    case "usage": return { ...t, usage: e.payload };
    // Replaced, not merged. A resume sends a fresh handshake under a new `providerSessionId`, and the
    // Claude adapter restates the whole record when it learns whether the model can run fast mode —
    // in both cases the newer event is the more complete description of the same session.
    case "init": return { ...t, init: { model: e.payload.model, tools: e.payload.tools, providerSessionId: e.payload.providerSessionId,
      ...(e.payload.availableModes ? { availableModes: e.payload.availableModes } : {}),
      ...(e.payload.supportsFastMode === undefined ? {} : { supportsFastMode: e.payload.supportsFastMode }) } };
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
          blocks.push({ kind: "run", ms: Math.max(0, e.ts - run.startedAt - waited), startedAt: run.startedAt, ts: e.ts,
            ...(e.payload.interrupted ? { stopped: true } : {}) });
          return { ...t, blocks, run: null };
        }
      }
    }
  }
}

export const reduceAll = (events: SessionEvent[], start = emptyTranscript()): Transcript => events.reduce(reduceTranscript, start);
