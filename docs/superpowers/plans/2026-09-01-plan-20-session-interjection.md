# Realm Plan 20 — Session interjection: one session asks another, mid-turn

> **Status:** design, ready to implement. **Builds on:** Plan 11 W3/W5 (`BrowserPermissionBroker`, delegation), Plan 13 W1/W3 (`DelegationEngine`, `agent_run`, `agent_review`), Plan 9 (gateway providers).
> **The feature:** session A calls a tool; Realm delivers A's question into session B's *live* turn, blocks A until B answers, returns the answer to A, and B carries on with its own work.
> **The verdict up front:** this is buildable on all three real agent kinds, but "B resumes its own way" means two different things depending on the kind, and only **Codex** can do it literally. Everything below is written so the implementer knows which is which and never claims the stronger one.

---

## 1. The shape, in one paragraph

Three new tools on the existing `realm-agent` gateway provider: `agent_peers` (who may I ask), `agent_ask(sessionId, question)` (the blocking ask), `agent_answer(requestId, answer)` (the reply, called *by the asked session, inside its own turn*). `agent_ask` is a **sibling of `agent_run`, not a variant of it**: same permission-cap posture, same fenced-output posture, same one-run-per-session registry, same engine — but it targets an **existing peer session** instead of spawning a child, and therefore must never do the two things `agent_run` does to its target (create it, and kill it when the run ends). The whole feature is one new server module (`delegation/ask.ts`), one new public method on `SessionService`, a flag on `ActiveRun`, a second wait loop inside the engine, three tool definitions, and one optional field on `user_message`. **No gateway change, no new RPC method, no new `DispatchKind`, no migration.**

The asked session is called the **target** or **peer** throughout; never "child". A child is something we created and may kill. A peer is not.

---

## 2. Per-agent-kind feasibility — the gate

This is the question that decides whether the feature is honest. Answer per kind, with the code.

### 2.1 Claude — **survives interrupt, cannot resume the turn; must be re-prompted**

`packages/adapters/src/claude/claude-adapter.ts:219`:

```ts
interrupt: async () => {
  denyAllPending();
  try { await q?.interrupt(); } catch { /* process may already be gone; result/ended will report */ }
},
```

Three facts follow directly from the file:

1. **The handle survives.** `interrupt` touches neither `disposed` (set only in `dispose`, L228), nor `input` (closed only in `dispose`, L231), nor `abort` (fired only in `dispose`, L232). `send` (L196) guards on exactly `disposed || input.isClosed` — both still false. So a post-interrupt `send` pushes a new `SDKUserMessage` onto the same live streaming-input query, on the same provider conversation, with the full prior history intact.
2. **The turn is over, irrecoverably.** The SDK answers the interrupt with a `result` message; the pump (L156-161) sets `running = false; sawResult = true` and emits `status: idle`. `claude-adapter.test.ts:206-222` pins exactly this: `interrupt` calls `query.interrupt`, the adapter itself pushes no `idle`, and the single `idle` arrives from the `result`. There is no "resume the aborted turn" verb anywhere in the options object.
3. **Interrupting also denies every open permission request** (`denyAllPending()`, L220 → L90 → `resolve({behavior:"deny", message:"User denied"})`). This is the sharpest cost in the whole design and it drives the `waiting_permission` guard in §4.3.

**Verdict:** interrupt-and-re-prompt. B literally cannot continue the aborted turn; it starts a *new* turn whose context already contains everything it was doing (that is the provider conversation, not something Realm reconstructs). What Realm adds is one instruction — "answer, then continue what you were doing" — and nothing else. **We do not synthesise a "here is what you were doing" summary: B's own transcript is in B's context and any summary we wrote would be a worse, lossier copy of it, presented in Realm's voice.**

**Not verified on disk:** that a `send` immediately following `q.interrupt()` lands on a *fresh* turn rather than being swallowed by the dying one. The unit test above stops at the deny. → live check, §7 W5, and the ordering mitigation in §4.5.

### 2.2 Codex — **needs no interrupt at all: `turn/steer` injects into the live turn**

`packages/adapters/src/codex/codex-adapter.ts:467-491`:

```ts
send: async (m: UserMessage) => {
  ...
  if (activeTurnId) {
    const steered = obj(await conn.request("turn/steer", { threadId, expectedTurnId: activeTurnId, input }));
    activeTurnId = str(steered.turnId) || activeTurnId;
    return;
  }
  const started = obj(await conn.request("turn/start", { threadId, input }));
```

`docs/dev/codex-app-server-protocol.md:375` marks `turn/steer` **verified**, including its `expectedTurnId` precondition and the `-32600 "no active turn to steer"` failure the adapter already races against (L478-483). The adapter tracks `activeTurnId` from `turn/started` / `turn/completed` (L343-344).

**Verdict:** for Codex the ask is a plain `SessionService.send` with **no interrupt**. The question rides into the running turn; the model sees it and continues. This is the only kind where "B resumes its own way" is literally true — there is nothing to resume, because nothing stopped.

Corollary worth stating: `turn/interrupt` on Codex is *lossier* than Claude's. The protocol doc (L380-383) verifies `turn/completed` arrives with `turn.status: "interrupted"` and **`turn.items: []`**, and the in-flight item gets no `item/completed`. Interrupting a Codex peer would throw away the partial item entirely. Steering is not merely nicer; interrupting is actively worse here.

**Not verified:** what the *model* does with steered input — true mid-turn injection versus a turn hand-off (the `{turnId}` in the response hints the latter is possible). Either way B keeps its context and is not stopped, which is what the feature needs. → live check, §7 W5.

### 2.3 ACP (`acp:cursor`, `acp:gemini`) — **survives cancel, turn ends, must be re-prompted; and cancel is mandatory**

`packages/adapters/src/acp/acp-adapter.ts:508-514`:

```ts
interrupt: async () => {
  cancelAllPending();
  if (!rpc || !sessionId) return;
  // A notification, not a request (§6). The connection stays up ...
  rpc.notify("session/cancel", { sessionId });
},
```

`docs/dev/acp-protocol.md:298-312` (§6) confirms: the agent MUST still resolve the original `session/prompt` with `stopReason: "cancelled"`, MAY keep streaming updates first, and the client must not tear the connection down. The adapter's `.then` handler (L491-505) turns that resolution into `status: idle`. A subsequent `send` issues a fresh `session/prompt` on the same `sessionId`, and the agent keeps its own history.

The mandatory half: `send` (L484) fires `session/prompt` **unconditionally** — it does not track whether a turn is in flight. ACP §3 (`docs/dev/acp-protocol.md:153`) describes `session/prompt` as "one request that stays pending for the whole turn"; two concurrent prompts on one `sessionId` is undefined behaviour in the protocol and untracked in the adapter. So on ACP we **must** cancel before sending — sending without cancelling is not a nicer option, it is a protocol violation with an unknown failure mode.

**Verdict:** interrupt-and-re-prompt, same as Claude. Additional honest limit already recorded in the repo: whether Cursor and Gemini actually honour `stopReason: "cancelled"` is **unverified** (`acp-protocol.md:311`), and `acp:gemini` is not selectable anyway (`SELECTABLE_AGENT_KINDS`). Treat `acp:gemini` as supported-but-unexercised.

### 2.4 `fake` — models the interrupt kinds

`fake-adapter.ts:81`: `interrupt: async () => { interrupted = true; denyAllPending(); }` breaks the step loop (L43) while the turn still emits its trailing `usage` + `idle`, and `send` chains behind the current run (L75). That is Claude/ACP semantics, which is what the behaviour suite needs. **The fake gets no steer path**; the Codex branch is tested by registering the fake under the `codex` adapter key and asserting `interrupt` was *not* called (§6).

### 2.5 The table this becomes

New in `packages/contracts/src/presets.ts`, in the style of `AGENT_SUPPORTS_PERMISSION_MODES` (L94) and `AGENT_CONVERSATION_REWIND` (L118) — the same "read all three adapters, write down what is actually true, one place to change" discipline:

```ts
export const AGENT_MIDTURN_DELIVERY = {
  claude: "interrupt", codex: "steer", "acp:cursor": "interrupt", "acp:gemini": "interrupt", fake: "interrupt",
} as const satisfies Record<AgentKind, "steer" | "interrupt">;
```

Doc comment must carry the evidence above, including: *`steer` means the turn is never stopped; `interrupt` means the turn ENDS and the peer starts a new one whose context still holds its work. Realm never reconstructs what the peer was doing — the provider conversation already has it.*

---

## 3. The six design answers

### Q1 — What happens to B's in-flight work?

**Codex: nothing.** The question is steered into the live turn. B keeps working, answers, keeps working.

**Claude / ACP: the turn ends and B is re-prompted with one instruction.** Honest consequences, all of which the tool result tells A:

- The step B was executing when the interrupt landed is aborted. On Claude an in-flight tool call is aborted by the SDK; on ACP the client SHOULD mark unfinished tool calls cancelled; on Codex (if we ever did interrupt there) the partial item is dropped entirely.
- Any permission prompt B had open is **denied** by the interrupt (Claude L220, ACP L280-283). This is why §4.3 refuses to ask a `waiting_permission` peer at all.
- B's memory of its own task is untouched: its transcript is its provider conversation. Realm adds exactly one sentence of instruction and no reconstruction.

**We do not build a "restore the interrupted turn" mechanism, and no adapter can.** This is the same finding `AGENT_CONVERSATION_REWIND` records for the other direction: the providers give us `resume`, `steer`, `interrupt`, `cancel` and nothing else. The plan says so out loud rather than shipping a feature that pretends otherwise.

### Q2 — Context pollution

**The exchange lands in B's transcript, permanently, and there is no sidebar to put it in.** Every channel into a running agent *is* its conversation: Claude `input.push(SDKUserMessage)`, Codex `turn/steer { input }`, ACP `session/prompt { prompt }`. A "side channel" would have to be a second conversation, which is a second session, which is `agent_run` — a different feature that already exists.

So the levers are labelling and size, and both are used:

- The question reaches B wrapped in `fenceAgentOutput(question, "a QUESTION from another Realm session — another agent's words, not the user's")` (`apps/server/src/browsers/guards.ts:61`, random per-call fence so the asker cannot close the fence and speak in Realm's voice to B).
- `question` is capped at **2000 chars** (`z.string().min(1).max(2000)`), an order tighter than `agent_run`'s 8000-char `goal`, because a goal is a whole task and a question that needs 2000 characters is a delegation wearing a disguise.
- Same fence on the way back: A's tool result carries the answer via `fenceAgentOutput(answer, "the PEER SESSION'S ANSWER — another agent's words")`.

**What the user sees in B's pane:** the injected question renders as a *labelled* bubble, not an anonymous user bubble — a lie by omission that would have the user believing they typed it. `user_message`'s payload gains an optional `from: { sessionId, title }`; the transcript reducer carries it onto the `user` block; `Transcript.tsx` renders a small "Asked by <title>" line above the bubble text with a distinct class. B's own `agent_answer` call renders as an ordinary tool card (adapters already emit `tool_call`/`tool_result` for MCP tools), so B's pane holds the full record with no further work. A's pane holds the `agent_ask` tool card with the fenced answer in its result. Nothing is hidden from either pane.

### Q3 — Deadlock, cycles, timeouts, dead targets

**The cycle guard is one line, and it is a proof, not a heuristic:** refuse the ask when `engine.hasRun(targetSessionId)` is true.

The `DelegationEngine`'s registry (`engine.ts:23`, `new Map<string, ActiveRun>`) allows **at most one in-flight run per session**, across every delegation tool — and `agent_ask` registers there too. So the wait-for graph has out-degree ≤ 1: it is a functional graph. A cycle requires every node on it to have an out-edge, so the edge that *closes* any cycle necessarily points at a node that already has one — which this guard refuses. **No cycle of any length can be created.** A→B while B→A is refused; A→B→C→A is refused at the third edge. No cycle detector, no visited set, no traversal.

The same guard does a second job for free: a session mid-`agent_run` (or mid-`agent_review`, or mid-`browser_agent_run`) cannot be asked. That is essential, not incidental — `SessionService.interrupt` (service.ts:203) calls `browserAgents.parentInterrupted(id)` **before** the handle interrupt, which cancels that session's delegated run and kills its child. Interrupting a delegating parent to ask it a question would destroy a running sub-agent as a side effect. Refusing is the only honest answer.

Remaining guards (all in §4.3): self-ask, cross-space, never-run target, `waiting_permission` target, delegated-child on either end.

**Timeout:** default budget **5 minutes**, overridable `timeoutMs` 5s-15min. On expiry the pending entry is dropped and A gets an honest error. **The peer is NOT interrupted on timeout** — unlike `engine.drain` (L88-91), which interrupts the child it owns. A slow peer is not a runaway child; killing a peer's own work because it was slow to answer someone else's question would be indefensible. B finds out only if it later calls `agent_answer`, which then tells it plainly that nobody is waiting.

**A is interrupted while waiting:** `engine.parentInterrupted(A)` sets `run.cancelled`; the wait returns `cancelled`; **B is not touched** (see the `interruptOnCancel: false` flag, §4.1). B keeps working. Today `parentInterrupted` unconditionally interrupts `run.childSessionId` — for an ask that would mean "A stopped, so we stop B's unrelated work too", which is the single worst mutant in this plan.

**Target deleted mid-wait:** `SessionService.events` throws → the wait returns `gone`.

**Target errors / its adapter dies:** last status `error` or `ended` with no answer → `failed`, with the status named.

### Q4 — Consent

**Yes, the user is prompted, and it reuses Realm's existing prompt end to end — no new broker, no new event, no new RPC.** `BrowserPermissionBroker.gate` (`apps/server/src/browsers/permissions.ts:84`) already does exactly what is needed: `bypassPermissions` runs free, `plan` refuses, otherwise it emits a real `permission_request` on the calling session, blocks the tool call on the answer, honours `allow_always`, times out at 15 minutes with a deny, and is already routed by `SessionService.respondPermission` (service.ts:212-222) and released on session delete (service.ts:347).

Decisions on top of that:

- **The card appears on A, the asker** — parity with every other broker-gated call: the prompt belongs where the blocked call is. There is exactly one user; prompting on both panes would be two questions for one decision.
- **`allow_always` is scoped to the (asker, target) pair**, by passing ``toolKey = `agent_ask:${targetSessionId}` ``. A coordinator that consults one peer repeatedly is asked once; the same coordinator reaching for a *different* peer is asked again. This falls out of the broker's existing per-session `Set<toolKey>` (L88, L57-61) with no new mechanism.
- **`plan` mode refuses**, verbatim parity with the browser gate: interrupting another session is an action on the world, and a read-only session does not take actions.
- **Same space only.** Cross-space is refused before the gate is ever reached — the same line every delegation tool draws (`agent_run.ts:204`, `review.ts:164`).
- The broker's one-line extension: `gate()` takes an optional display `toolName` (defaulting to `toolKey`) so the card reads `agent_ask` rather than `agent_ask:01J…`. `PermissionCard.tsx:71` renders `toolName` verbatim, so this matters.

**Deliberately not renamed:** the broker keeps its `BrowserPermissionBroker` name and `browsers/permissions.ts` home. A rename ripples through `SessionService`'s `browserPermissions` dep, `app.ts`, and three test files, and buys this plan nothing. The new call site carries a one-line comment saying why a browser-named broker gates a non-browser call, and the rename is a named follow-up.

### Q5 — Tool schemas

All three land on the existing `realm-agent` provider (`createRealmAgentProvider`, `browser-agent.ts:256`), which already handles per-space enablement and the depth-1 child refusal.

```ts
// agent_peers — discovery. Without it the feature is unusable: A has no way to learn a peer's id.
{ name: "agent_peers", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
// → JSON array: [{ sessionId, title, agentKind, status, askable: boolean, reason: string | null }]

// agent_ask — the blocking ask.
{
  name: "agent_ask",
  description:
    "Ask ANOTHER session in this space a question and block until it answers. That session is interrupted "
    + "mid-turn to take the question (on Codex it is steered in without interrupting), answers, and resumes "
    + "its own work — its turn is its own, not yours. The exchange enters that session's transcript "
    + "permanently, so ask one self-contained question about what it already knows; delegate work with "
    + "agent_run instead. The user is asked to approve the interruption. Depth-1: a delegated agent can "
    + "neither ask nor be asked.",
  inputSchema: { type: "object", properties: {
    sessionId: { type: "string", description: "The session to ask. Must be in this space (agent_peers lists them)." },
    question:  { type: "string", description: "One self-contained question, no more than 2000 chars. The peer sees only this — it has no access to your context." },
    timeoutMs: { type: "number", description: "How long to wait for an answer (5s-15min; default 5min). On timeout the peer is NOT interrupted — it simply stops being waited on." },
  }, required: ["sessionId", "question"], additionalProperties: false },
}

// agent_answer — called by the ASKED session, inside its own turn.
{
  name: "agent_answer",
  description:
    "Answer a question another Realm session asked you. Use the requestId from that question. Answer from "
    + "what you already know — the asking session is blocked waiting. Then continue exactly what you were "
    + "doing: your own task is unchanged.",
  inputSchema: { type: "object", properties: {
    requestId: { type: "string" }, answer: { type: "string", description: "No more than 8000 chars, returned verbatim to the asking session." },
  }, required: ["requestId", "answer"], additionalProperties: false },
}
```

**What A gets back** (success, `isError: false`):

```
Answer from session "Refactor the parser" (claude). That session was interrupted mid-turn to take this
question and has been told to resume its own work; its turn continues in its own pane.

Answering session: {"sessionId":"01J…","title":"Refactor the parser","agentKind":"claude","interrupted":true,"answeredVia":"agent_answer"}

<<<agent-output-9f2c…
The parser's error type is ParseFailure, defined in packages/contracts/src/parse.ts:41.
agent-output-9f2c…>>>
```

The middle line is a machine-readable identity, exactly the shape `agent_run.ts:245` established. `interrupted` is the *observed* fact (was the handle live and did we call `interrupt`), never an assumption; on a Codex peer the sentence becomes "Delivered into that session's running turn without interrupting it." `answeredVia` is `"agent_answer"` or `"final-message"` (§4.6's fallback).

**What B gets back from `agent_answer`:** `"Delivered to session \"<A title>\". Nothing about your own task changed — continue exactly what you were doing before the question arrived."` The tool result *is* the resume nudge, delivered inside B's turn at the moment B is ready for it. That is better placed than any preamble.

### Q6 — Failure modes and exactly what A is told

Wording matched to `agent-run.ts` / `review.ts` — lowercase refusals for argument-level problems, sentence-case for outcomes, always the real reason, never a euphemism. All are `isError: true` unless marked.

| Condition | Text returned to A |
|---|---|
| bad args | `invalid arguments: <zod path>: <message>` |
| caller is a delegated child | `refused: a delegated agent may not interrupt other sessions — delegation is depth-1 only, and your own caller is blocked waiting for you.` |
| caller already has a run in flight | `refused: this session already has a delegated run in flight; wait for that call's result.` (verbatim from `agent_run.ts:160`) |
| `sessionId` is the caller | `refused: a session cannot ask itself.` |
| no such session | `session <id> does not exist.` |
| other space | `refused: that session belongs to another space — a session may only ask sessions in its own space.` |
| target is a delegated child | `refused: session <id> is a delegated agent working on one goal for another session; it is not available to answer questions.` |
| **target has a run in flight (the cycle guard)** | `refused: session <id> is itself blocked on a delegated run or a question of its own. Interrupting it would cancel that run — and this is also what makes a question cycle impossible.` |
| target `waiting_permission` | `refused: session <id> is waiting on a permission prompt from the user. Interrupting it now would DENY that prompt on the user's behalf. Try again once it is running or idle.` |
| target never ran | `refused: session <id> has never run — it has no context to answer from.` |
| A in `plan` mode | `refused: this session is in Plan (read-only) mode — interrupting another session is an action, not a read.` |
| user denied the card | `the user denied interrupting session <id>.` |
| user never answered (15min) | `the user did not answer the request to interrupt session <id> within 15 minutes; nothing was delivered.` (broker's own deny path) |
| delivery threw (`AGENT_UNAVAILABLE`, adapter start failure) | `could not deliver the question to session <id>: <real message>. That session was not interrupted.` |
| timeout | `Session <id> did not answer within <n>s. It was NOT interrupted again and keeps working; if it answers later, that answer is discarded.` |
| A interrupted while waiting | `Question cancelled: this session was interrupted while waiting. Session <id> was left running — it was not stopped.` |
| target errored/ended | `Session <id> ended with status "<lastStatus>" before answering.` |
| target deleted | `Session <id> was deleted before it answered.` |
| **fallback answer** (settled with prose, no `agent_answer`) | success, with `"answeredVia":"final-message"` and the sentence `That session replied in prose and settled rather than calling agent_answer; its final message is below.` |

And for `agent_answer` called with a dead id: `refused: no question is outstanding for requestId <id> — it expired, or the asking session stopped waiting. Nothing was delivered. Continue your own work.`

---

## 4. File-by-file map

### 4.1 `apps/server/src/delegation/engine.ts` — three changes, all small

**(a) `ActiveRun` gains `interruptOnCancel`.** L97 becomes:

```ts
export type ActiveRun = { childSessionId: string; cancelled: boolean; interruptOnCancel: boolean };
```

**(b) `begin` takes the flag, defaulting true** so both delegation tools and `review.ts` are byte-unchanged at their call sites:

```ts
begin(parentSessionId: string, targetSessionId: string, opts: { interruptOnCancel?: boolean } = {}): ActiveRun
```

**(c) `parentInterrupted` (L53) honours it:**

```ts
run.cancelled = true;
// A delegated CHILD is ours to stop; a PEER being asked a question is not — it was doing its own
// work before the question arrived and is still doing it. Cancelling the wait is the whole action.
if (run.interruptOnCancel) void this.d.sessions.interrupt(run.childSessionId).catch(() => {});
```

**(d) `scan` extracted, `awaitAnswer` added.** `drain` (L68) keeps its exact public behaviour — the settle condition `lastStatus === "idle" && finalText !== null` and the cancelled-wins return stay in this file, byte-identical, because `structure.test.ts:36-42` pins those strings to `engine.ts` alone. Factor the cursor advance both loops need:

```ts
/** Advance past `cursor`, folding the slice into last-status / last-assistant-text. `null` = the
 *  session is gone (its events threw). The ONE place either wait reads the transcript. */
private scan(id: string, cursor: number, acc: { lastStatus: string | null; finalText: string | null }): number | null
```

Then:

```ts
/**
 * The interjection wait (Plan 20) — `drain`'s sibling, and deliberately NOT `drain`. Three differences,
 * each a decision:
 *   - The settle condition is an ANSWER (a resolved `answer` box, written by the agent_answer tool),
 *     not the peer's turn ending. A peer's turn ending is its own business.
 *   - A timeout does NOT interrupt the peer. `drain` interrupts, because the child is ours; the peer
 *     is not, and killing a peer's own work for being slow to answer someone else is indefensible.
 *   - The fallback: a peer that settles to idle with assistant text and never called agent_answer has
 *     still, in the only sense that matters, replied. That text is returned, labelled as such.
 */
async awaitAnswer(input: { targetId: string; fromSeq: number; run: ActiveRun; answer: { text: string | null };
  deadline: number; pollMs: number }): Promise<SettledAsk>

export type SettledAsk = {
  outcome: "answered" | "replied" | "cancelled" | "timeout" | "failed" | "gone";
  answer: string | null; lastStatus: string | null;
};
```

Ordering inside the loop, and each clause is a mutant: **cancelled first** (same reason as `drain`'s cancelled-wins — a peer that answers in the same poll window as A's interrupt must report cancelled, because nobody is listening); then `answer.text !== null` → `answered`; then settled-idle-with-text → `replied`; then `error`/`ended` → `failed`; then deadline → `timeout` **with no interrupt**.

### 4.2 `apps/server/src/sessions/service.ts` — one new public method

Do **not** route the injected question through `send` (L144). `send` does three things that are wrong for an interjection, and each is a real defect:

- `checkpointTurn` (L152, L434) would capture a git checkpoint **mid-edit** — B may be halfway through writing files. That is precisely the race the method's own comment says it awaits to avoid ("a capture racing the agent's first write would record a tree that never existed"), and it would litter the environment's checkpoint list with one entry per question.
- `maybeTitleFrom` (L154, L407) would rename an untitled session after the *question* — the title-hijack mutant (mostly blocked by the never-ran guard, but not by construction).
- `user_message` would be emitted unlabelled, so the user's pane would show the question as something they typed.

New method, next to `interrupt`:

```ts
/**
 * Deliver a message into a session from ANOTHER session (Plan 20), interrupting its turn first when
 * its agent kind has no mid-turn injection route (AGENT_MIDTURN_DELIVERY). NOT `send`: no checkpoint
 * (a capture mid-edit records a tree that never existed), no auto-title, and the transcript event
 * carries `from` so the pane never shows another agent's words as the user's.
 *
 * `interrupt` here is the HANDLE's, not this class's: SessionService.interrupt also fires
 * `parentInterrupted`, which would cancel the target's own delegated run. Callers refuse a target with
 * a run in flight, so this is belt and braces — but the two must not be the same call.
 *
 * Returns whether an interrupt actually happened, so the caller can say so truthfully rather than
 * assuming: a session that was not live had no turn to stop.
 */
async deliverInterjection(id: string, msg: { text: string; from: { sessionId: string; title: string } },
  opts: { interruptFirst: boolean }): Promise<{ interrupted: boolean }> {
  const wasLive = this.live.has(id);
  await this.ensurePorts(id);
  const handle = this.ensureLive(id);
  const interrupted = wasLive && opts.interruptFirst;
  if (interrupted) await handle.interrupt();
  this.onEvent(id, sessionEvent("user_message", { text: msg.text, attachments: [], from: msg.from }));
  await handle.send({ text: msg.text, attachments: [] });
  return { interrupted };
}
```

`wasLive` is read **before** `ensureLive`: a session whose row says `running` but whose handle died has nothing to interrupt, and interrupting a handle we just started would abort a turn that never began.

No other change here. The `browserAgents` hook bag (L78) already fans `release` across registries in `app.ts`; the ask service joins that fan-out there.

### 4.3 `apps/server/src/delegation/ask.ts` — NEW, the whole feature

Modelled on `review.ts` (small, one flow, its own pending map, engine for the wait). Class doc comment must state: this is `agent_run`'s sibling that targets a peer; the three things it must never do (create the target, kill the target, summarise the target's work); and the cycle proof.

```ts
export const AGENT_ASK_TOOL_NAME = "agent_ask";
export const AGENT_ANSWER_TOOL_NAME = "agent_answer";
export const AGENT_PEERS_TOOL_NAME = "agent_peers";

const DEFAULT_TIMEOUTS = { budgetMs: 300_000, pollMs: 250 };
const AskArgs = z.object({ sessionId: z.string().min(1), question: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(5_000).max(900_000).optional() });
const AnswerArgs = z.object({ requestId: z.string().min(1), answer: z.string().min(1).max(8000) });

type Pending = { askerId: string; targetId: string; box: { text: string | null } };

export class AskService {
  /** Outstanding questions by requestId — IN MEMORY, exactly like the engine's registry and for the
   *  same reason: a blocked MCP call cannot outlive the process. Nothing is persisted; there is no
   *  child record here because there is no child. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: {
    sessions: Pick<SessionService, "get" | "list" | "events" | "deliverInterjection">;
    engine: DelegationEngine;
    /** The three delegation registries — a delegated child of ANY kind is neither a valid asker nor a
     *  valid target (see the class doc comment: its parent is blocked inside an MCP call). */
    delegated: { isChild(sessionId: string): boolean };
    /** Realm's normal permission prompt, raised on the ASKER. Optional so an older harness behaves
     *  as before; production always wires it. */
    permissions?: { gate(sessionId: string, toolKey: string, title: string,
      input: Record<string, unknown>, toolName?: string): Promise<GateResult> };
    timeouts?: { budgetMs: number; pollMs: number };
  }) {}

  peers(ctx: ProviderCallContext): CallToolResult      // read-only listing
  async ask(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult>
  answer(ctx: ProviderCallContext, raw: unknown): CallToolResult
  /** A session was deleted: cancel its outstanding ask (engine-owned), and drop any question it was
   *  ASKED — the asker's wait then reports `gone` off the engine, not off a stale entry here. */
  release(sessionId: string): void
}
```

`ask()`'s order — every step is a named guard, and the order matters because a refusal must never have a side effect behind it:

1. parse args
2. caller is a delegated child → refuse
3. `engine.hasRun(ctx.sessionId)` → refuse
4. `sessionId === ctx.sessionId` → refuse
5. `sessions.get(target)` → not found → refuse
6. `target.spaceId !== ctx.spaceId` → refuse
7. `delegated.isChild(target.id)` → refuse
8. **`engine.hasRun(target.id)` → refuse (the cycle guard)**
9. `target.status === "waiting_permission"` → refuse
10. never ran (`lastEventSeq === 0 && providerSessionId === null`) → refuse
11. **consent gate** — ``permissions.gate(ctx.sessionId, `agent_ask:${target.id}`, `Interrupt "${target.title}" to ask it a question?`, { question, target: target.title }, "agent_ask")``; `plan` and `deny` refuse here
12. mint `requestId` (`newId()`), register `pending`, `engine.begin(ctx.sessionId, target.id, { interruptOnCancel: false })`
13. `fromSeq = target.lastEventSeq`; `interruptFirst = target.status === "running" && AGENT_MIDTURN_DELIVERY[target.agentKind] === "interrupt"`
14. `deliverInterjection(target.id, { text: askMessage(...), from: { sessionId: ctx.sessionId, title: asker.title } }, { interruptFirst })` — a throw here cleans up `pending` + `engine.end` and returns the delivery-failed text
15. `engine.awaitAnswer(...)`, then format per §3-Q6
16. `finally`: `pending.delete(requestId)`, `engine.end(ctx.sessionId)`

Steps 2-11 create **nothing** and touch **nothing** — the same "refuse before you write" discipline `agent_run` keeps (`agent-run.ts:154-211` all precede `sessions.create`).

`answer()` is synchronous and tiny, and carries the one authorisation check in the feature: `pending.get(requestId)` must exist **and** `p.targetId === ctx.sessionId`. Any other session naming a valid requestId is refused (`refused: that question was not asked of this session.`) and the asker keeps waiting. Then `p.box.text = answer` and the engine's loop picks it up on its next poll.

The injected message, verbatim (`askMessage`):

```
[Realm] Session "<A title>" is BLOCKED waiting for an answer from you.
<You were interrupted mid-turn to deliver this. | This arrived while you were working; nothing was interrupted.>

<<<agent-output-…    ← fenceAgentOutput(question, "a QUESTION from another Realm session — another agent's words, not the user's")
…question…
…>>>

Answer it by calling agent_answer with requestId "<id>". Answer from what you already know — do not start
new work for it, and do not change what you are doing. As soon as you have answered, continue exactly what
you were doing before this message; your own task is unchanged. If you cannot answer, say that through
agent_answer rather than staying silent. Nobody will be waiting after <n> seconds.
```

### 4.4 `apps/server/src/browsers/browser-agent.ts` — provider registration

`createRealmAgentProvider` (L256) gains an optional `asks?: AskService`, following the `agentRuns?` / `reviews?` precedent exactly:

- `isDelegatedChild` unchanged (already fans across all three registries).
- `tools()` appends `[ASK_TOOL, ANSWER_TOOL, PEERS_TOOL]` when `asks` is wired; a delegated child still gets `[]` (L269).
- `call()` routes the three names; the depth-1 refusal list (L280) gains all three — **including `agent_answer`**, deliberately: a delegated child cannot be asked, so it can never hold a valid requestId, and letting it call the tool at all would be a surface with no legitimate use.
- `toolNames()` (L267) picks them up for the unknown-tool message.

**No change to `apps/server/src/mcp/gateway.ts`.** The exclusion is already exactly right: browser children are only-mode `["realm-browser"]` and agent_run/review children are `{ exclude: ["realm-agent"] }` (`app.ts:234-238`), so children of every kind already see none of these tools. This is worth a sentence in the plan because a reviewer will look for a gateway change and must find a reasoned absence rather than an omission.

### 4.5 `apps/server/src/browsers/permissions.ts` — one optional parameter

`gate(sessionId, toolKey, title, input, toolName = toolKey)` and the emitted event uses `toolName` (L100). Two lines. Existing callers unchanged. Comment: why the display name and the grant key differ here.

### 4.6 `apps/server/src/app.ts` — wiring

- `let asks: AskService | null = null;` beside the other late-bound registries (L223-225).
- Construct after `reviews` (L276): `asks = new AskService({ sessions, engine: delegationEngine, delegated: { isChild: (id) => browserAgentsFinal.isChild(id) || agentRunsFinal.isChild(id) || reviewsFinal.isChild(id) }, permissions: browserBroker, timeouts: opts.ask?.timeouts })`.
- `mcpGateway.registerProvider(createRealmAgentProvider(browserAgents, mcp, agentRuns, reviews, asks))` (L278).
- `release` fan-out (L257) gains `asks?.release(id)`.
- `App` type (L54) gains `asks: AskService`, and `createApp` opts gain `ask?: { timeouts?: { budgetMs: number; pollMs: number } }` — the behaviour suite needs sub-second budgets, exactly as `agentRun`/`review` do.
- `sessionToolset` (L234): **unchanged**, and the plan says so.

### 4.7 `packages/contracts/`

- **`presets.ts`** — `AGENT_MIDTURN_DELIVERY` (§2.5) with the evidence in its doc comment.
- **`session-events.ts:4`** — `user_message` payload gains `from: z.object({ sessionId: z.string(), title: z.string() }).optional()`. Optional means every stored row ever written still parses; no migration, no backfill. Doc comment: *present only when another session delivered this message; absent means the user typed it, and absence is the ordinary case (the same polarity `dispatchedBy` uses).*
- **`entities.ts:176` `DispatchKindSchema` — deliberately UNCHANGED.** `DispatchKind` records *how a session came to exist*. An interjection creates no session; both ends already existed and their origins are already recorded. Adding an `ask` member would put a value on the enum that no row can ever hold. Stated here because the absence looks like an oversight otherwise.
- **`rpc.ts` — unchanged.** No new method (the tools are the surface, `sessions.respondPermission` already carries consent) and no new event (`session.event` already broadcasts the labelled `user_message`).
- **`notifications.ts` — unchanged.** See §7 for the one wart this leaves.
- **`delegation.ts` — unchanged.** The ask's args are local zod in `ask.ts`, matching `review.ts:28`; `AgentRunConstraintsSchema` is in contracts only because the *renderer* would need it.

### 4.8 Renderer

- **`panes/session/transcript-model.ts:6`** — the `user` block gains `from?: { sessionId: string; title: string }`; the `user_message` case (L37) copies it through. Pure reducer, one line each.
- **`panes/session/Transcript.tsx:77`** — when `b.from` is present, render an attribution line above the bubble: `Asked by {b.from.title}`, class `msg-user-from`, and `data-from` on the row so the bubble can be styled apart from a real user message. The bubble text itself is unchanged (the fence is part of the text and is *meant* to be visible — the user should see exactly what the peer was handed).
- **`styles.css`** — `.msg-user-row[data-from] .msg-user` (muted border/tint) and `.msg-user-from` (small, muted, right-aligned with the bubble).
- Nothing else. `state/store.ts` needs no change: the event type is unchanged, only its payload grew.

### 4.9 Scripts

- **`apps/server/scripts/live-interjection-check.ts`** — NEW, modelled on `live-agent-run-check.ts`. This is the only place the §2 verdicts become facts. See §5.

---

## 5. Tests — behaviour, and the mutation each one kills

House rule in force: *a passing test proves little unless a one-line mutation would break it.* Each row names the mutation.

### `apps/server/src/delegation/ask.test.ts` (NEW — behaviour suite through the real `createApp` + `FakeAdapter`, the way `agent-run.test.ts` does)

The harness needs one addition over `agent-run.test.ts`'s `CaptureFake`: an **`InterruptCountingFake`** that increments a per-session counter in `interrupt()` and exposes it. Several mutants are only observable there.

| Behaviour | Mutation it kills |
|---|---|
| A running peer is interrupted exactly once, gets the labelled question, answers via `agent_answer`, and A's result carries the fenced answer + `"answeredVia":"agent_answer"` | the whole happy path; also `interrupted: true` reported when no interrupt happened |
| An **idle** peer is asked with **zero** interrupts (`counter === 0`) and still answers | `interruptFirst` hard-coded true — interrupting a session with no turn |
| A peer whose kind maps to `steer` (register the fake under the `codex` adapter key) is **never** interrupted even while `running` | ignoring `AGENT_MIDTURN_DELIVERY`; also a table typo flipping codex to `interrupt` |
| **Cycle:** B is mid-`agent_ask` (registered in the engine); A's ask at B is refused with "would cancel that run", and A creates nothing | dropping the `engine.hasRun(target)` guard — the deadlock |
| **3-cycle:** A→B, B→C in flight; C's ask at A is refused | same guard, at the length that a naive pair-check would miss |
| A peer mid-`agent_run` cannot be asked, and its child session is still alive afterwards | same guard, in the variant where the damage is a killed grandchild |
| **A is interrupted while waiting:** A's call returns "was not stopped", B's interrupt counter is **unchanged**, and B reaches idle on its own | `interruptOnCancel` left at its default `true` — A's stop killing B's unrelated work. *The single most valuable test here.* |
| **Timeout:** budget expires; A gets the timeout text; B's interrupt counter is unchanged and B still settles normally | copying `drain`'s interrupt-on-timeout into `awaitAnswer` |
| A late `agent_answer` after a timeout is refused with "no question is outstanding", and nothing crashes | leaving stale pending entries; resolving a promise nobody holds |
| **Wrong answerer:** a third session calls `agent_answer` with a valid requestId → refused, and A is still waiting afterwards | dropping `p.targetId === ctx.sessionId` — any session answering any question |
| Peer in `waiting_permission` is refused **and its pending permission is still pending** (no `permission_response` deny appears in its transcript) | dropping the guard; the assertion is on the *absence of a deny*, which is what makes it bite |
| A peer that never ran is refused, and its title is unchanged afterwards | dropping the guard (title hijack via `maybeTitleFrom`, if `send` were ever reintroduced) |
| Cross-space peer refused, creating nothing; self-ask refused | the two cheapest guards, each one line |
| A delegated child can neither call `agent_ask` nor appear in `agent_peers`; the provider lists none of the three tools for it and refuses all three on call | the depth-1 belt, per tool name (a partial list is the realistic mutant) |
| **No checkpoint is taken** for the injected message: the environment's checkpoint count is identical before and after an ask | routing delivery through `SessionService.send` |
| The peer's `user_message` carries `from` with A's id **and title**, and its text contains the random `agent-output-` fence | unlabelled delivery; unfenced question (prompt-injection surface) |
| A's tool result fences the answer and names the peer's id + title | unfenced answer coming back |
| **Fallback:** peer emits a final `assistant_text` and settles without calling `agent_answer` → A gets that text with `"answeredVia":"final-message"` | dropping the fallback (silent 5-minute hang on any peer that replies in prose) |
| Peer deleted mid-wait → `"was deleted before it answered"`; peer errors → `"ended with status \"error\""` | collapsing every non-answer into a generic timeout |
| Question over 2000 chars refused before any delivery | the cap, which is the only bound on context pollution |

### Consent (same file, its own `describe`)

| Behaviour | Mutation |
|---|---|
| Default mode raises a `permission_request` **on A** naming the peer's title; `deny` → refusal text and B has **no** `user_message` | the gate skipped entirely — an agent interrupting another with no consent |
| `bypassPermissions` on A: no card at all | gate parity lost |
| `plan` on A: refused without a card | plan treated as promptable |
| `allow_always` then a second ask **to the same peer** → no second card; an ask **to a different peer** → a card | grant keyed on session only, so one approval silently licenses interrupting every session in the space |
| The card's `toolName` reads `agent_ask` (not `agent_ask:<id>`) | the display-name parameter dropped — cosmetic, but it is the difference between a readable card and a ULID |

### `apps/server/src/delegation/structure.test.ts` (extend)

| Assertion | Mutation |
|---|---|
| `delegation/ask.ts` imports the engine, calls `engine.awaitAnswer(`, and contains **no `setTimeout`** | a private poll loop in the ask service — the exact fork the file exists to prevent |
| the existing three needles still resolve to `["delegation/engine.ts"]` after the `scan` extraction | the extraction accidentally moving the settle condition |
| `delegation/ask.ts` never mentions `sessions.create` or `environments` | scope creep turning the ask into a spawner |

### `packages/contracts` (`presets.test.ts` / `session-events.test.ts`)

| Assertion | Mutation |
|---|---|
| `AGENT_MIDTURN_DELIVERY` has an entry per `AgentKind` (compile-time via `satisfies`, plus a runtime key check) and both ACP kinds are `"interrupt"` | an ACP kind flipped to `steer` — which would fire two concurrent `session/prompt`s at Cursor |
| a `user_message` with `from` round-trips the schema, and one **without** `from` still parses | making `from` required — every stored row in every existing DB stops parsing |

### `apps/server/src/mcp/gateway.test.ts` (extend the existing exclude-mode case)

A delegated child's real `tools/list` contains none of `agent_ask` / `agent_answer` / `agent_peers`, and a direct gateway call to `realm-agent__agent_ask` returns the gateway's own `"not available to this delegated session"` — distinguishable from the provider's `"depth-1"` wording, so a lost `app.ts` closure is visible.

### Renderer (`transcript-model.test.ts`, `session-pane.test.tsx`)

| Assertion | Mutation |
|---|---|
| a `user_message` with `from` reduces to a `user` block carrying `from`; one without leaves it undefined | the reducer dropping the field, which silently un-labels every injected message |
| the pane renders "Asked by <title>" for that block and **not** for an ordinary user message | rendering it always (every user message attributed to a session) or never |

### `apps/server/scripts/live-interjection-check.ts` — the verdicts, against real CLIs

Not a unit test; the gate on §2 being true. Legs:

1. **Claude peer, running:** start a long turn, ask it, assert — an interrupt landed, the question arrived, `agent_answer` came back, and the peer's **next** messages continue its original task (this is the "resumes its own way" claim, and it is only ever a claim until this leg passes).
2. **Codex peer, running:** same, asserting **no** `turn/interrupt` was sent (adapter `onLog` + counter) and that the peer's turn never went idle between question and answer.
3. **`acp:cursor` peer, running:** same as (1), and record whether `stopReason: "cancelled"` actually arrives — the doc marks that unverified.
4. **Consent leg:** the card appears on the asker, and denying it leaves the peer's transcript untouched.
5. **The negative leg:** ask a peer that is mid-`agent_run`; assert the refusal and that the grandchild session is still alive.

If leg 1 or 3 fails, the honest fallback is in §7.

---

## 6. Work breakdown, ordered

**W1 — Contracts + engine (no behaviour yet).** `AGENT_MIDTURN_DELIVERY`; `user_message.from`; `ActiveRun.interruptOnCancel` + `begin` opts + `parentInterrupted` honouring it; `scan` extraction; `awaitAnswer` + `SettledAsk`. Green: every existing delegation suite, unchanged. *Ship this alone and nothing behaves differently — that is the point.*

**W2 — `SessionService.deliverInterjection`.** With its own tests: no checkpoint, no retitle, `from` on the event, `interrupted` reported honestly for live/not-live and running/idle.

**W3 — `ask.ts` + the three tools + provider wiring + `app.ts`.** The behaviour suite (§5 rows 1-20) lands here. No consent gate yet — every ask runs free, which makes the next week's tests bite.

**W4 — Consent.** Broker display-name parameter; the gate call; the consent `describe`. Ship only after W3 is green, so the tests that assert "the gate refused before anything happened" are demonstrably new-failing before they pass.

**W5 — Renderer labelling.** Reducer, `Transcript.tsx`, CSS, their tests.

**W6 — Live pass.** `live-interjection-check.ts`, all five legs, one per real kind. **Any §2 verdict this contradicts gets rewritten in `AGENT_MIDTURN_DELIVERY`'s doc comment and in the tool description before merge — the tool text must never promise behaviour the live check disproved.**

---

## 7. Risks and unknowns

1. **Claude: send-immediately-after-interrupt is unproven.** The unit test stops at the deny; nothing on disk shows a new turn starting cleanly after `q.interrupt()`. If it races, the mitigation is a bounded wait for the peer's status to leave `running` before delivering — which belongs in the engine (the one place that waits), not in `ask.ts`. Do not build that wait speculatively; W6 leg 1 decides.
2. **Codex steer is verified to exist, not verified in what it means to the model.** The `{turnId}` in the response is consistent with a turn hand-off rather than true injection. Either is acceptable (the peer is not stopped and keeps its context), but the tool description must not say "injected into the same turn" unless leg 2 shows it.
3. **ACP `cancelled` is unverified against both agents** (`acp-protocol.md:311`). If Cursor never resolves the cancelled prompt, the peer's status never returns to idle and the delivery `send` fires a second `session/prompt` into an unresolved one. **Honest fallback if leg 3 fails:** flip `acp:cursor` in the table to a third value — `"unsupported"` — and have `agent_ask` refuse an ACP target outright with *"session <id> runs on <agent>, which Realm cannot interrupt and re-prompt safely; ask a Claude or Codex session, or delegate with agent_run."* Better a refused kind than a wedged session. The table exists precisely so this is a one-line change.
4. **Notification noise.** An interrupt on a Claude/ACP peer drives `running → idle → running`, and `NotificationsService.handleSessionEvent` (`notifications/service.ts:110`) writes a `session_done` row for the `idle`. Dedup (terminal categories reuse an unread row) keeps it to one row, but it is a row saying "settled" about a session that did not settle. Suppressing it needs lookahead the service does not have. **Accepted, documented, not fixed.** If it becomes annoying, the honest fix is a new `session_asked` category, not a suppression hack.
5. **Context pollution is permanent and compounding.** Every question durably changes B's future behaviour. The 2000-char cap and the fence bound the blast radius; they do not eliminate it. A coordinator that asks one peer thirty times has meaningfully rewritten that peer's context, and no test can catch that. This is the feature's real cost and the tool description says so ("delegate work with `agent_run` instead").
6. **`waiting_permission` is racy.** The guard reads the row; B can enter `waiting_permission` between the check and the interrupt, and then the interrupt denies the user's card. Narrow (milliseconds) but real, and unfixable without an adapter-level "interrupt unless prompting" verb that no provider offers. State it in the `agent_ask` description's honest-limits sentence.
7. **`agent_peers` leaks titles across a space.** Every session in the space is enumerable by any non-child session in it. That matches the existing posture (`sessions.list` is space-scoped and any agent in the space already shares its environments and MCP servers), but it is a new read surface and should be named as one.
8. **`browserPermissions` is now load-bearing for a non-browser feature.** The name is wrong and the rename is deferred (§3-Q4). Left un-renamed, the next reader will reasonably assume the gate is browser-specific and duplicate it. The mitigating comment at the call site is not optional.
9. **The fallback answer is a guess.** A peer that settles with prose might have been answering the question — or might have been finishing its own sentence. `"answeredVia":"final-message"` tells A which case it is in, and A is expected to weigh it. There is no way to do better without a structured turn boundary the providers do not give us.
