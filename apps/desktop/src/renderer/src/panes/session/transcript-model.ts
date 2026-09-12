import type { AcpSessionMode, SessionEvent, SessionEventPayload } from "@realm/contracts";

export type PlanStep = NonNullable<SessionEventPayload<"plan">["steps"]>[number];

export type Block =
  /** `attachments` present only when the message carried any — an attachment-only message (Plan 14
   *  W5) still renders a bubble naming its files rather than an empty one. */
  /** `from` is present only when ANOTHER session delivered this message (Plan 20). Absent means the
   *  user typed it — the ordinary case — and the pane must not attribute those to anyone. */
  | { kind: "user"; text: string; attachments?: { path: string; mime: string }[]; from?: { sessionId: string; title: string }; goal?: "continuation" | "budget"; ts: number }
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
  /**
   * The harness summarised the conversation above and dropped it. A seam for the same reason
   * `handoff` is one: the messages are all still here, and this line is the only thing that says the
   * agent below it can no longer see them.
   *
   * `postTokens` is absent where the harness did not report it, and the pair is then not drawn — half
   * of a before-and-after is a number with nothing to compare it to.
   */
  | { kind: "compacted"; preTokens: number; postTokens?: number; ts: number }
  /**
   * The agent below this line has NO context, rather than a summarised one.
   *
   * The third member of the seam family, and the one that reports the sharpest version of the same
   * fact: `handoff` is a different agent, `compacted` is the same agent with less, this is the same
   * agent with nothing. Written when a session that held a provider session id came back without it —
   * the provider was asked to continue and declined, or the build could not be asked at all.
   */
  | { kind: "context_reset"; note: string; reason: "declined" | "unsupported"; ts: number }
  /**
   * Where you stopped reading.
   *
   * Not an event — nothing happened here. It is a mark about THIS reader, inserted while the
   * transcript is rebuilt at open time, which is why it is placed by the store rather than derived
   * from anything on the wire. It appears at most once, and only when there is something on both
   * sides of it: a session opened for the first time has nothing above the line, and one you are
   * caught up on has nothing below it.
   */
  | { kind: "unseen-mark"; ts: number }
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
  /** How much of the window the conversation occupies, as the harness measured it — see the `usage`
   *  event's own note for why this is never derived from the numbers beside it. Undefined for every
   *  engine that cannot say, which is most of them; the prompter draws no context meter there rather
   *  than a full or an empty one. */
  contextTokens?: number;
  /** The window `contextTokens` was measured against, when the harness stated it. Preferred over the
   *  model catalog's figure, which is a different number: Claude measures against the autocompact
   *  window, often the 200K boundary on a 1M-window model. */
  contextWindow?: number;
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
  /** The model-written account of this session, and the event it was written from. Null until one
   *  has been produced (a session that has never settled, a machine with no Claude CLI to write it,
   *  a summary still in flight) — and null is exactly when the panes fall back to the derived text,
   *  so the surfaces never wait on a model to say something. */
  summary: { text: string; throughSeq: number } | null;
  /** The model-written next-move suggestion, when the server produced one for the LAST turn. Null is
   *  the ordinary case — no generator, no Claude CLI, a decline, or a turn the user has already
   *  answered — and it is exactly when the prompter falls back to the deterministic ladder. */
  promptHint: { text: string; throughSeq: number } | null;
};

/** Stable render identity for a block. Tool calls key on their own id so a card keeps its expanded
 *  state; everything else keys on position, which is stable because blocks are only ever appended or
 *  replaced in place (a streaming assistant block becomes its final self at the same index). */
export const blockKey = (b: Block, i: number): string =>
  b.kind === "tool" ? `tool:${b.toolUseId}` : b.kind === "plan" ? `plan:${b.planId}` : `${b.kind}:${i}`;

export const emptyTranscript = (): Transcript => ({ blocks: [], pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, run: null, feedback: {}, summary: null, promptHint: null });

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
/**
 * `markUnseen` inserts the "new since you were here" rule immediately BEFORE this event's block.
 *
 * An argument rather than a synthetic event because it is not one: nothing happened at that point in
 * the session, and putting it on the wire would mean persisting one reader's place in a log that is
 * shared by every window.
 */
export function reduceTranscript(t: Transcript, e: SessionEvent, markUnseen = false): Transcript {
  const blocks = t.blocks.slice(); const last = blocks.at(-1);
  if (markUnseen && !blocks.some((b) => b.kind === "unseen-mark")) blocks.push({ kind: "unseen-mark", ts: e.ts });
  switch (e.type) {
    /* The hint is cleared here, and that is the whole of how a stale suggestion is prevented: it was
       written about the turn that had just ended, and the moment the user sends anything it is a
       suggestion about a turn that is no longer the last one. The prompter shows the deterministic
       ladder in the gap until the next settle produces a new one. */
    case "user_message": blocks.push({ kind: "user", text: e.payload.text, ...(e.payload.attachments.length ? { attachments: e.payload.attachments } : {}), ...(e.payload.from ? { from: e.payload.from } : {}), ...(e.payload.goal ? { goal: e.payload.goal } : {}), ts: e.ts }); return { ...t, blocks, promptHint: null };
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
    case "context_reset":
      return { ...t, blocks: [...dropPending(blocks),
        { kind: "context_reset", note: e.payload.note, reason: e.payload.reason, ts: e.ts }] };
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
    // Last one wins, and only forwards. Events replay in seq order on load, but a summary generated
    // for an older transcript can still land LATE — the call takes seconds and a fast turn can settle
    // under it — and overwriting a newer account with an older one would make the line go backwards
    // in front of the reader.
    case "summary":
      return t.summary && t.summary.throughSeq > e.payload.throughSeq ? t
        : { ...t, summary: { text: e.payload.text, throughSeq: e.payload.throughSeq } };
    /* Same forward-only rule as the summary above it, and for the same reason: a hint generated for
       an earlier turn can land after a newer one on a slow machine, and the newer answer wins. */
    case "prompt_hint":
      return t.promptHint && t.promptHint.throughSeq > e.payload.throughSeq ? t
        : { ...t, promptHint: { text: e.payload.text, throughSeq: e.payload.throughSeq } };
    case "feedback": {
      const { [e.payload.messageId]: _prev, ...rest } = t.feedback;
      return { ...t, feedback: e.payload.rating ? { ...rest, [e.payload.messageId]: e.payload.rating } : rest };
    }
    // A plan-quota reading is about the ACCOUNT, not this conversation, and the store folds it into
    // per-agent state off the event stream. The transcript is unchanged by it on purpose: a block
    // saying "weekly window at 78%" would be a sentence nobody said, stuck between two that were.
    case "rate_limit": return t;
    // The four numbers are replaced wholesale; the context measurement is CARRIED when the new event
    // does not state one. Not staleness — occupancy does not reset between turns, so the last
    // measurement is still the last true thing known about this window, and the adapter restates the
    // event a beat later with the answer (claude-adapter.ts `reportContextUsage`). Blanking the ring
    // in that gap would flicker it off and on again after every single turn.
    case "usage": {
      const carry = e.payload.contextTokens === undefined && t.usage.contextTokens !== undefined
        ? { contextTokens: t.usage.contextTokens, ...(t.usage.contextWindow === undefined ? {} : { contextWindow: t.usage.contextWindow }) }
        : {};
      return { ...t, usage: { ...e.payload, ...carry } };
    }
    // The seam, and the meter's answer for why it just fell. `postTokens` is what the window holds
    // now, so the ring stops reading the pre-compaction figure the moment the boundary lands rather
    // than at the end of the next turn — which on a long turn is minutes of a meter known to be wrong.
    case "compacted": {
      const post = e.payload.postTokens;
      return { ...t,
        blocks: [...dropPending(blocks), { kind: "compacted", preTokens: e.payload.preTokens, ...(post === undefined ? {} : { postTokens: post }), ts: e.ts }],
        usage: post === undefined ? t.usage : { ...t.usage, contextTokens: post } };
    }
    // Replaced, not merged — with one exception, and the exception is the point.
    //
    // A resume sends a fresh handshake under a new `providerSessionId`, and the Claude adapter
    // restates the whole record when it learns whether the model can run fast mode; in both cases
    // the newer event is the more complete description of the same session.
    //
    // `supportsFastMode` is the exception because it is a fact about the MODEL, not about this
    // handshake, and it is learned a `supportedModels()` round trip LATE — after the init that
    // triggered it. Every later plain handshake (a resume, the next query's own init) would replace
    // that hard-won answer with silence, and the prompter's Speed control would disappear mid-session
    // for no reason the user could see: the "shows up occasionally" this fixes. So the answer
    // survives a restatement of the SAME model, and only that — on a different model it describes
    // something else and has to be earned again.
    //
    // `??` and not `||`: `false` is an answer ("this model cannot"), and the switch stays hidden on
    // it just as it does on silence — but it must not be mistaken for "not stated" and re-inherited
    // from the model before it.
    case "init": {
      const sameModel = t.init?.model === e.payload.model;
      const fast = e.payload.supportsFastMode ?? (sameModel ? t.init?.supportsFastMode : undefined);
      return { ...t, init: { model: e.payload.model, tools: e.payload.tools, providerSessionId: e.payload.providerSessionId,
        ...(e.payload.availableModes ? { availableModes: e.payload.availableModes } : {}),
        ...(fast === undefined ? {} : { supportsFastMode: fast }) } };
    }
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

// Wrapped rather than passed directly: `reduce` hands its callback an index as the third argument,
// which would land on `markUnseen` and mark whichever event happened to be at a truthy position.
export const reduceAll = (events: SessionEvent[], start = emptyTranscript()): Transcript =>
  events.reduce((t, e) => reduceTranscript(t, e), start);
