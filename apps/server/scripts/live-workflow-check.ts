/**
 * Live check of a workflow run that outlives its launching turn, against the REAL `claude`.
 *
 * Claude Code's `Workflow` tool returns at once and the run goes on as a task of its own. Its agents
 * ask for tools after the turn has ended, and when it finishes Claude Code starts a turn nobody
 * sent, to report on it. Realm follows all of that from what the binary puts on the wire: which
 * message says a run began, when a card arrives, which `result` ends a turn and whose turn it was.
 * The unit tests hold Realm to those messages as they were recorded once. What no unit test can hold
 * up is that the binary still sends them, in that order, and that the whole server makes of the live
 * stream what it makes of the recorded one. So this is the check to run again when the Agent SDK
 * is bumped.
 *
 * It uses no account and nothing is billed. The `claude` is the one the Agent SDK carries, which is
 * the one every Realm session runs, and its environment points it at a stand-in for the Anthropic
 * API on a loopback port (`stand-in-anthropic.ts`). The stand-in's model launches a two-agent
 * workflow when the check's message asks for one, and answers for the agents. Its delays are what
 * order a scenario. How long an agent takes decides whether its card arrives during the launching
 * turn or after it.
 *
 * The real server (`createApp`) runs on a scratch Realm home and is driven over its socket, so
 * `session.status` and `notifications.changed` are read as a window reads them. Each scenario is a
 * session of its own:
 *
 *    1. A run whose agent asks during the launching turn: the turn settles once, when the card is
 *       answered, and the report turn settles as `unprompted`.
 *    2. A card raised between turns: its wait and its idle are no turn ending.
 *    3. A message sent under that card is delivered at once, and answered with the card still open.
 *    4. Stop under that card denies it and stops the run, and the next turn is not marked as stopped.
 *    5. `sessions.stopTask` stops one run and nothing else.
 *    6. Stop with nothing in flight stops the run, and the next turn is not marked as stopped.
 *    7. A message queued during the launching turn is sent at its settle, and the run still reports.
 *    8. An agent process that ends with a run alive: Realm closes the run, and the next message's
 *       turn settles once, after its answer.
 *    9. A report turn that fails is marked `unprompted`, and the launching message is not sent again.
 *   10. A goal continues once for a run's step, whether the run ends after its launching turn or
 *       inside it.
 *   11. A message sent before the report's first word is answered in a turn of its own after the
 *       report: the two settle once, after the message's answer, and not as `unprompted`.
 *   12. A message folded into a report turn: sent at that same moment to a report turn that runs a
 *       shell command, it is taken into the turn when the command returns, the model answers it
 *       there, and the one settle is not marked `unprompted`.
 *
 * It writes nothing outside its own temp folders. The Realm home, the home and config folder
 * `claude` is given and Claude Code's own temp files sit in one folder under the system temp
 * folder, removed at the end. It refuses to run when that folder is inside your home folder,
 * because Claude Code reads `CLAUDE.md` from every folder above the one it works in and would take
 * your own for project instructions.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-workflow-check.ts
 *
 * While `tsx` stops at the app's import of `@xterm/headless`, vite-node, which vitest brings, runs
 * it from `apps/server`. `VITE_NODE` is its folder under `node_modules/.pnpm`:
 *
 *   node ../../node_modules/.pnpm/VITE_NODE/node_modules/vite-node/vite-node.mjs scripts/live-workflow-check.ts
 *
 * Exits non-zero if a check fails. A scenario with a failed check prints what its window saw. Needs
 * the `claude` that comes with the Agent SDK, or the one `REALM_CLAUDE_BIN` names.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { WebSocket } from "ws";
import { ClaudeAdapter, bundledClaude, probeClaude } from "@realm/adapters";
import { classifyFailure, isRetryable, parseWireMessage, type EventPayload, type MethodName, type MethodParams, type MethodResult, type NotificationCategory, type SessionEvent, type SessionStatus } from "@realm/contracts";
import { createApp, type App } from "../src/app";
import { finish, ok as report } from "./harness";
import { CUE, SAID, startStandIn, workflowModel, type Asker, type RunPlan } from "./stand-in-anthropic";

/** How long a scenario waits for any one thing before it gives up and says what it was waiting for.
 *  The longest wait that is meant to happen is the eight seconds a stand-in agent takes to answer. */
const WAIT_MS = 30_000;

/** What Claude Code would use in place of the address and the key this check hands it: a switch to
 *  another provider, which never asks `ANTHROPIC_BASE_URL`, and the one credential that outranks an
 *  API key. Each is taken out of the environment, so a shell set up for a real account still runs
 *  the check on none. */
const OUTRANKS_THE_STAND_IN = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The message that has the stand-in launch its workflow, and a goal's objective that does the same. */
const LAUNCH = `${CUE.launch} run it`;

/** One thing a window is told about a session, or one request the stand-in gets on its behalf. A
 *  session event keeps its own shape. `row` is `session.status`, `queue` is `session.queue`, `feed`
 *  is a row of `notifications.changed`, and `asked` is who has just put a request to the model. */
type Seen = SessionEvent
  | { type: "row"; status: SessionStatus }
  | { type: "queue"; queued: number }
  | { type: "feed"; category: NotificationCategory }
  | { type: "asked"; by: Asker };
/** A `Seen` with its place in the order of arrival, and its time since the scenario began in ms. */
type Line = Seen & { i: number; at: number };
type LineOf<T extends Line["type"]> = Extract<Line, { type: T }>;

type Call = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;

/** A session under test: what its window has seen, and what a person at that window can do. */
type Session = ReturnType<typeof watch> & {
  call: Call;
  app: App;
  send(text: string): Promise<unknown>;
  answer(card: LineOf<"permission_request">, decision: "allow" | "deny"): Promise<unknown>;
};

type Scenario = { name: string; title: string; plan: RunPlan; run(s: Session): Promise<void> };

/** Whether a check has failed in the scenario in hand, which then prints what its window saw. */
let failed = false;

/** `ok` from the harness, which also notes a failure for the scenario in hand. */
function ok(label: string, cond: boolean, detail = ""): void {
  report(label, cond, detail);
  if (!cond) failed = true;
}

/** A test for one kind of line, which also tells TypeScript the kind. */
const is = <T extends Line["type"]>(type: T, test: (l: LineOf<T>) => boolean = () => true) =>
  (l: Line): l is LineOf<T> => l.type === type && test(l as LineOf<T>);

/** A test for a line that passes either of two tests, for a wait that two different lines can end. */
const either = <A extends Line, B extends Line>(a: (l: Line) => l is A, b: (l: Line) => l is B) =>
  (l: Line): l is A | B => a(l) || b(l);

/** A turn ending: `idle`, and not the one that only closes a card raised between turns. */
const settle = is("status", (l) => l.payload.status === "idle" && l.payload.betweenTurns !== true);
const idle = is("status", (l) => l.payload.status === "idle");
const running = is("status", (l) => l.payload.status === "running");
const stopped = is("background_task", (l) => l.payload.status === "stopped");
const agentCard = is("permission_request", (l) => l.payload.toolName !== "Workflow");
const agentB = is("asked", (l) => l.by === "agent-b");
const sessionAsks = is("asked", (l) => l.by === "session");
const shell = is("tool_call", (l) => l.payload.name === "Bash");
const shellCard = is("permission_request", (l) => l.payload.toolName === "Bash");
const resultOf = (call: LineOf<"tool_call">) => is("tool_result", (l) => l.payload.toolUseId === call.payload.toolUseId);
const queued = is("queue", (l) => l.queued > 0);
const finishedTurn = is("feed", (l) => l.category === "session_done");
const continuation = is("user_message", (l) => l.payload.goal === "continuation");
const plain = is("user_message", (l) => l.payload.text.includes(CUE.plain));
const said = (text: string) => is("assistant_text", (l) => l.payload.text.includes(text));
const answerTo = (card: LineOf<"permission_request">) => is("permission_response", (l) => l.payload.requestId === card.payload.requestId);
/** A turn's `result` as it reaches the log: the `usage` it carries, and not the copy that restates
 *  it a moment later with the context reading. */
const result = is("usage", (l) => l.payload.contextTokens === undefined);

/**
 * One session as its window sees it: every line in the order it arrived, and a way to wait for the
 * next one of a kind.
 *
 * `until` looks at what has arrived after `after`, then at each line as it comes, and when `WAIT_MS`
 * has passed it gives up with a sentence that names what it waited for. Nothing here sleeps. A
 * scenario moves when the server or the stand-in says something.
 */
function watch(id: string) {
  const began = performance.now();
  const lines: Line[] = [];
  const waiting = new Set<() => void>();
  return {
    id,
    lines,
    add(seen: Seen): void {
      lines.push({ ...seen, i: lines.length, at: Math.round(performance.now() - began) } as Line);
      for (const look of [...waiting]) look();
    },
    until<T extends Line>(what: string, match: (l: Line) => l is T, after?: Line): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let next = after ? after.i + 1 : 0;
        const done = (): void => { clearTimeout(timer); waiting.delete(look); };
        const look = (): void => {
          for (; next < lines.length; next++) {
            const line = lines[next];
            if (line && match(line)) { done(); resolve(line); return; }
          }
        };
        const timer = setTimeout(() => { done(); reject(new Error(`waited ${WAIT_MS / 1000} s for ${what}`)); }, WAIT_MS);
        waiting.add(look);
        look();
      });
    },
  };
}

/** One line of what a window saw, short enough to read down a column. */
function brief(l: Line): string {
  if (l.type === "row") return `row ${l.status}`;
  if (l.type === "queue") return `queue ${l.queued}`;
  if (l.type === "feed") return `feed ${l.category}`;
  if (l.type === "asked") return `asked by ${l.by}`;
  return `${l.type} ${JSON.stringify(l.payload).slice(0, 110)}`;
}

/** The statuses a window showed for the session while a card was open, other than the wait itself. */
function straysUnderCards(lines: readonly Line[]): string[] {
  const open = new Set<string>();
  const strays: string[] = [];
  for (const l of lines) {
    if (l.type === "permission_request") open.add(l.payload.requestId);
    else if (l.type === "permission_response") open.delete(l.payload.requestId);
    else if (l.type === "row" && open.size > 0 && l.status !== "waiting_permission") strays.push(l.status);
  }
  return strays;
}

/** A window's end of the socket: `call` is answered by id, and every broadcast goes to `hear`. */
async function openWindow(port: number, hear: (event: string, payload: unknown) => void): Promise<{ call: Call; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let calls = 0;
  ws.on("message", (raw) => {
    const wire = parseWireMessage(String(raw));
    if (wire.kind === "event") { hear(wire.msg.event, wire.msg.payload); return; }
    if (wire.kind !== "response") return;
    const asked = pending.get(wire.msg.id);
    pending.delete(wire.msg.id);
    if (wire.msg.ok) asked?.resolve(wire.msg.result);
    else asked?.reject(new Error(`${wire.msg.error.code}: ${wire.msg.error.message}`));
  });
  const call = <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => new Promise((resolve, reject) => {
    const id = `w${++calls}`;
    pending.set(id, { resolve: (v) => resolve(v as MethodResult<M>), reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

/** Sends the message that has the stand-in launch its workflow, or starts a goal with it, allows the
 *  launch's own card, and returns once Realm has marked the call as a run in the background. */
async function launch(s: Session, how: "message" | "goal" = "message") {
  if (how === "goal") await s.call("goals.start", { sessionId: s.id, objective: LAUNCH });
  else await s.send(LAUNCH);
  const card = await s.until("the launch's own card", is("permission_request", (l) => l.payload.toolName === "Workflow"));
  await s.answer(card, "allow");
  const run = await s.until("the launch to be marked as a background run", is("background_task", (l) => l.payload.status === "running"), card);
  return { card, run };
}

/** `launch`, and then the launching turn's settle and a card from one of the run's agents after it.
 *  The plan holds agent A's first reply back, so its card opens once that turn has settled. */
async function cardAfterTheTurn(s: Session) {
  const { run } = await launch(s);
  const settled = await s.until("the launching turn to settle", settle, run);
  const card = await s.until("an agent's card", agentCard, settled);
  const wait = s.lines.slice(settled.i, card.i).filter(is("status")).at(-1);
  return { settled, card, wait };
}

/** `launch`, and then the launching turn's settle with the run at work behind it: its first agent
 *  has answered and its second is waiting on the model, where the plan keeps it for longer than the
 *  scenario lasts. */
async function runAtWork(s: Session) {
  const { run } = await launch(s);
  const settled = await s.until("the launching turn to settle", settle, run);
  await s.until("the run's second agent to ask the model", agentB);
  return { run, settled };
}

/** Types one more message and waits for its turn: the message in the log, an answer to it, and the
 *  settle after the answer. */
async function nextTurn(s: Session, about: string, answer: (l: Line) => l is LineOf<"assistant_text"> = said(SAID.plain)) {
  const before = s.lines.at(-1);
  await s.send(`${CUE.plain} ${about}`);
  const typed = await s.until("the next message to reach the log", plain, before);
  const spoke = await s.until("an answer to the next message", answer, typed);
  const settled = await s.until("the next message's turn to settle", settle, spoke);
  return { typed, spoke, settled, settles: s.lines.slice(typed.i, settled.i + 1).filter(settle).length };
}

/** Pauses the goal while its continuation's turn is in flight, since an active goal sends another at
 *  every settle, and counts what the goal had sent or left queued by the time that turn settled. The
 *  plan has the continuation take long enough for the pause to land first. */
async function continuationsUntilSettled(s: Session, step: LineOf<"user_message">) {
  await s.call("goals.set", { sessionId: s.id, status: "paused" });
  const spoke = await s.until("the continuation's answer", said(SAID.step), step);
  const settled = await s.until("the continuation's turn to settle", settle, spoke);
  const upTo = s.lines.slice(0, settled.i + 1);
  return { sent: upTo.filter(continuation).length, queued: upTo.filter(queued).length };
}

/** 1. The plan has agent A ask at once and holds the session's last word back, so the card opens with
 *  the launching turn in flight and that turn's `result` arrives under it. The card is answered only
 *  when the `result` is in. */
async function agentAsksInTurn(s: Session): Promise<void> {
  const { card, run } = await launch(s);
  const launching = s.lines.find(is("tool_call", (l) => l.payload.name === "Workflow"));
  ok("the launch's own card carries once", card.payload.once === true);
  ok("the launching call is marked as a background run", run.payload.toolUseId === launching?.payload.toolUseId, run.payload.toolUseId);
  const asks = await s.until("an agent's card", agentCard, run);
  const wait = s.lines.slice(0, asks.i).filter(is("status")).at(-1);
  ok("the agent asks with the launching turn still in flight", wait?.payload.status === "waiting_permission" && wait.payload.betweenTurns !== true);
  const lastWord = await s.until("the launching turn's last word", said(SAID.launched), asks);
  const ended = await s.until("the launching turn's result", result, lastWord);
  await s.answer(asks, "allow");
  const settled = await s.until("the launching turn to settle", settle, ended);
  const answered = s.lines.find(answerTo(asks));
  ok("the turn settles when the card is answered, once", answered !== undefined && answered.i < settled.i && s.lines.slice(0, settled.i + 1).filter(settle).length === 1);
  const info = await s.call("daemon.info", {});
  ok("with the turn settled and the run at work, daemon.info counts the session as working", info.working === 1 && !s.lines.some(stopped), `working ${info.working}`);
  const stop = await s.until("the run to stop", stopped, settled);
  ok("the run stops with outcome completed", stop.payload.outcome === "completed", String(stop.payload.outcome));
  const reported = await s.until("the report turn to settle", settle, stop);
  ok("the report turn says running and then settles with unprompted", s.lines.slice(stop.i, reported.i).some(running) && reported.payload.unprompted === true);
  const strays = straysUnderCards(s.lines);
  ok("while a card is open the session reads waiting_permission and nothing else", strays.length === 0, strays.join(", "));
  const rows = s.lines.filter(finishedTurn).length;
  const turns = s.lines.filter(settle).length;
  ok("the feed has one finished-turn row per settled turn", rows === turns && turns === 2, `${rows} rows for ${turns} settled turns`);
}

/** 2. The card is answered as soon as it opens, and the run goes on to finish and report. */
async function cardRaisedBetweenTurns(s: Session): Promise<void> {
  const { settled, card, wait } = await cardAfterTheTurn(s);
  ok("the wait for a card raised between turns carries betweenTurns", wait?.payload.status === "waiting_permission" && wait.payload.betweenTurns === true);
  await s.answer(card, "allow");
  const rest = await s.until("the idle after the card's answer", idle, card);
  ok("the idle after its answer carries betweenTurns", rest.payload.betweenTurns === true);
  const stop = await s.until("the run to stop", stopped, rest);
  await s.until("the report turn to settle", settle, stop);
  const rows = s.lines.filter(finishedTurn);
  const turns = s.lines.filter(settle).length;
  ok("no finished-turn row is written for the wait or its idle", rows.length === turns && turns === 2 && !rows.some((l) => l.i > settled.i && l.i < stop.i), `${rows.length} rows for ${turns} settled turns`);
}

/** 3. A message is typed under the open card, and the card is answered only when that message's
 *  turn has had its `result`, so the turn ends under the card. */
async function messageUnderCard(s: Session): Promise<void> {
  const { card, wait } = await cardAfterTheTurn(s);
  ok("the card is raised between turns", wait?.payload.betweenTurns === true);
  await s.send(`${CUE.plain} a question typed under the open card`);
  const typed = await s.until("the message to reach the log", plain, card);
  const waits = await s.until("the session's status once the message is in", is("status"), typed);
  ok("a message sent under the card is delivered at once", !s.lines.some(queued));
  ok("the wait loses its betweenTurns mark", waits.payload.status === "waiting_permission" && waits.payload.betweenTurns !== true, waits.payload.status);
  const spoke = await s.until("the answer to the message", said(SAID.plain), typed);
  const ended = await s.until("the result of the message's turn", result, spoke);
  ok("its answer arrives with the card still open", !s.lines.slice(0, ended.i).some(answerTo(card)) && !s.lines.slice(typed.i, ended.i).some(idle));
  await s.answer(card, "allow");
  const settled = await s.until("the message's turn to settle", settle, ended);
  const answered = s.lines.find(answerTo(card));
  ok("the turn settles when the card is answered", answered !== undefined && answered.i < settled.i && s.lines.slice(typed.i, settled.i + 1).filter(settle).length === 1);
  const strays = straysUnderCards(s.lines);
  ok("the session reads waiting_permission for as long as the card is open", strays.length === 0, strays.join(", "));
}

/** 4. Stop is pressed under the open card, with no turn in flight, and a message follows it. */
async function stopUnderCard(s: Session): Promise<void> {
  const { card, wait } = await cardAfterTheTurn(s);
  ok("the card is raised between turns", wait?.payload.betweenTurns === true);
  await s.call("sessions.interrupt", { id: s.id });
  const answered = await s.until("the card's answer", answerTo(card), card);
  ok("Stop denies the card", answered.payload.decision === "deny", answered.payload.decision);
  const rest = await s.until("the idle that closes the card", idle, card);
  ok("the idle carries interrupted and betweenTurns", rest.payload.interrupted === true && rest.payload.betweenTurns === true);
  const stop = await s.until("the run to stop", stopped, card);
  ok("the run stops with outcome stopped", stop.payload.outcome === "stopped", String(stop.payload.outcome));
  const next = await nextTurn(s, "a question after the stop");
  ok("the next turn settles once, and is not marked as stopped", next.settles === 1 && next.settled.payload.interrupted !== true);
}

/** 5. The run is stopped by the call that launched it, with the session at rest, and a message
 *  follows it. */
async function stopOneRun(s: Session): Promise<void> {
  const { run, settled } = await runAtWork(s);
  await s.call("sessions.stopTask", { id: s.id, toolUseId: run.payload.toolUseId });
  const stop = await s.until("the run to stop", stopped, settled);
  ok("stopTask stops the run, with outcome stopped", stop.payload.outcome === "stopped", String(stop.payload.outcome));
  const next = await nextTurn(s, "a question after the stop");
  const meanwhile = s.lines.slice(settled.i + 1, next.typed.i);
  ok("the session's status does not move", !meanwhile.some(is("status")) && meanwhile.filter(is("row")).every((l) => l.status === "idle"));
  ok("the next turn settles once, and is not marked as stopped", next.settles === 1 && next.settled.payload.interrupted !== true);
}

/** 6. Stop is pressed with the session at rest and the run at work, and a message follows it. */
async function stopWithNothingInFlight(s: Session): Promise<void> {
  const { settled } = await runAtWork(s);
  await s.call("sessions.interrupt", { id: s.id });
  const stop = await s.until("the run to stop", stopped, settled);
  ok("Stop with no turn in flight stops the run", stop.payload.outcome === "stopped", String(stop.payload.outcome));
  const next = await nextTurn(s, "a question after the stop");
  ok("the next turn settles once, and is not marked as stopped", next.settles === 1 && next.settled.payload.interrupted !== true);
}

/** 7. The plan holds the session's last word back, which leaves the launching turn in flight for a
 *  second message, and keeps agent B long enough for the run to outlast that message's turn. */
async function messageQueuedInTurn(s: Session): Promise<void> {
  const { run } = await launch(s);
  await s.send(`${CUE.plain} typed while the launching turn is in flight`);
  const held = await s.until("the message to be queued", queued, run);
  const settled = await s.until("the launching turn to settle", settle, run);
  ok("a message sent during the launching turn waits in the queue", held.i < settled.i && !s.lines.slice(0, settled.i).some(plain));
  const typed = await s.until("the queued message to be sent", plain, settled);
  const spoke = await s.until("the answer to the queued message", said(SAID.plain), typed);
  const second = await s.until("the queued message's turn to settle", settle, spoke);
  ok("it is sent at that turn's settle, once", s.lines.filter(plain).length === 1 && s.lines.slice(settled.i + 1, second.i + 1).filter(settle).length === 1);
  const stop = await s.until("the run to stop", stopped, second);
  const reported = await s.until("the report turn to settle", settle, stop);
  ok("the run still reports afterwards", stop.payload.outcome === "completed" && s.lines.slice(stop.i, reported.i).some(said(SAID.report)) && reported.payload.unprompted === true, String(stop.payload.outcome));
}

/** 8. The agent process is stopped with the run at work, as Stop all agents does. The message that
 *  follows starts a new process, which resumes the conversation and has a dead run to report first. */
async function processEndsWithRunAlive(s: Session): Promise<void> {
  const { run, settled } = await runAtWork(s);
  const before = await s.call("daemon.info", {});
  await s.app.sessions.stopAll();
  const closed = await s.until("the run to be closed in the log", stopped, settled);
  ok("Realm closes the run in the log as stopped", closed.payload.outcome === "stopped" && closed.payload.toolUseId === run.payload.toolUseId, String(closed.payload.outcome));
  const after = await s.call("daemon.info", {});
  ok("the working count returns to zero", before.working === 1 && after.working === 0, `${before.working} with the run at work, ${after.working} with the process gone`);
  const next = await nextTurn(s, "a question after the process ended", is("assistant_text"));
  ok("the next message's turn settles once, after its answer", next.settles === 1, `settles: ${next.settles}`);
}

/** 9. The plan has the API refuse the report turn's request, with a failure that failover would
 *  retry had somebody sent the turn. A retry is announced before the error it answers, so its
 *  absence can be read as soon as the error is in. */
async function reportTurnFails(s: Session): Promise<void> {
  const { run } = await launch(s);
  const stop = await s.until("the run to stop", stopped, run);
  const error = await s.until("the report turn's error", is("error"), stop);
  await s.until("the report turn to settle", settle, error);
  const message = error.payload.message.split("\n")[0] ?? "";
  ok("the report turn's error carries unprompted", error.payload.unprompted === true, message);
  const kind = classifyFailure(error.payload.message);
  ok("Realm retries a failure of this kind in a turn somebody sent", isRetryable(kind), kind);
  const launches = s.lines.filter(is("tool_call", (l) => l.payload.name === "Workflow")).length;
  ok("the launching message is not sent again", !s.lines.some(is("retrying")) && launches === 1, `launches: ${launches}`);
}

/** 10. A goal whose run is still at work when the launching turn settles. */
async function goalWaitsForItsRun(s: Session): Promise<void> {
  const { run } = await launch(s, "goal");
  const settled = await s.until("the launching turn to settle", settle, run);
  const stop = await s.until("the run to stop", stopped, run);
  const reported = await s.until("the report turn to settle", is("status", (l) => l.payload.status === "idle" && l.payload.unprompted === true), stop);
  const step = await s.until("the goal's continuation", continuation);
  ok("the run is alive when the launching turn settles", stop.i > settled.i);
  ok("the goal sends no continuation until the report turn has settled", step.i > reported.i);
  const { sent, queued: behind } = await continuationsUntilSettled(s, step);
  ok("and then one", sent === 1 && behind === 0, `${sent} sent, ${behind} queued behind it`);
}

/** 10, again. The plan holds the session's last word back until the run has ended, so the run's
 *  report comes after a turn the goal has already continued from. The continuation races the report
 *  turn, and neither wait assumes an order. Sent after the report's result, the continuation follows
 *  the report's own settle. Sent ahead of it, it is the message the session is waiting on, and the
 *  report settles nothing by itself. So the report is waited for by its words. */
async function goalWhoseRunEndsInTurn(s: Session): Promise<void> {
  const { run } = await launch(s, "goal");
  const stop = await s.until("the run to stop", stopped, run);
  const settled = await s.until("the launching turn to settle", settle, run);
  ok("the run ends during its launching turn", stop.i < settled.i);
  await s.until("the report", said(SAID.report), settled);
  const step = await s.until("the goal's continuation", continuation, settled);
  const { sent, queued: behind } = await continuationsUntilSettled(s, step);
  ok("the goal sends one continuation for that step, not two", sent === 1 && behind === 0, `${sent} sent, ${behind} queued behind it`);
}

/** `launch`, and then the launching turn's settle and the report turn's request reaching the model,
 *  where a message is typed. The plan holds the model's reply back, so the session still reads idle
 *  and the server delivers the message at once, ahead of the report's first word. Sent any later,
 *  with the report turn in flight, it would wait in the server's queue for that turn's settle. */
async function typeBeforeTheReport(s: Session, about: string) {
  const { run } = await launch(s);
  const settled = await s.until("the launching turn to settle", settle, run);
  const asked = await s.until("the report turn's request to reach the model", sessionAsks, settled);
  await s.send(`${CUE.plain} ${about}`);
  const typed = await s.until("the message to reach the log", plain, asked);
  return { settled, typed };
}

/** 11. The report turn calls no tool, so Claude Code has nowhere to take the waiting message in, and
 *  answers it in a turn of its own after the report. */
async function messageBeforeTheReport(s: Session): Promise<void> {
  const { settled, typed } = await typeBeforeTheReport(s, "typed before the report's first word");
  const reported = await s.until("the report", said(SAID.report), settled);
  ok("the message is delivered at once, ahead of the report's first word", typed.i < reported.i && !s.lines.some(queued));
  const spoke = await s.until("the answer to the message", said(SAID.plain), reported);
  const done = await s.until("the settle after the answer", settle, spoke);
  const settles = s.lines.slice(settled.i + 1, done.i + 1).filter(settle).length;
  ok("the report turn and the message settle once, after the message's answer", settles === 1, `settles: ${settles}`);
  ok("that settle is not marked unprompted", done.payload.unprompted !== true);
}

/** 12. The plan has the report turn run a shell command, which is allowed if Claude Code asks about
 *  it. The message is waiting when the command returns, and Claude Code takes it into the report
 *  turn there, so the model's next word is the report and the answer in one. */
async function messageFoldedIntoTheReport(s: Session): Promise<void> {
  const { settled, typed } = await typeBeforeTheReport(s, "typed before the report turn runs its command");
  const called = await s.until("the report turn's shell command", shell, typed);
  ok("the message is delivered at once, ahead of the report turn's command", !s.lines.slice(0, called.i).some(queued));
  const next = await s.until("the command's card or its result", either(shellCard, resultOf(called)), called);
  if (next.type === "permission_request") await s.answer(next, "allow");
  const returned = await s.until("the command's result", resultOf(called), called);
  const spoke = await s.until("the report turn's last word", is("assistant_text"), returned);
  ok("the model sees the message in the report turn", spoke.payload.text.includes(SAID.folded), spoke.payload.text);
  const done = await s.until("the report turn to settle", settle, spoke);
  const upTo = s.lines.slice(settled.i + 1, done.i + 1);
  const settles = upTo.filter(settle).length;
  ok("the report turn and the message settle once, with no turn of the message's own", settles === 1 && !upTo.some(said(SAID.plain)), `settles: ${settles}`);
  ok("that settle is not marked unprompted", done.payload.unprompted !== true);
}

/** Every scenario, in the order the header lists them. `name` is the session's title and its space's
 *  folder. A plan's times are the stand-in's delays, which are what order the scenario (`RunPlan`). */
const SCENARIOS: Scenario[] = [
  { name: "agent-asks", title: "a run whose agent asks during the launching turn", plan: { agentAsks: true, launchMs: 1_000, agentBMs: 1_500 }, run: agentAsksInTurn },
  { name: "card-between", title: "a card raised between turns", plan: { agentAsks: true, agentAMs: 1_200, agentBMs: 1_500 }, run: cardRaisedBetweenTurns },
  { name: "send-under-card", title: "a message sent under that card", plan: { agentAsks: true, agentAMs: 1_200, agentBMs: 1_500 }, run: messageUnderCard },
  { name: "stop-under-card", title: "Stop under that card", plan: { agentAsks: true, agentAMs: 1_200, agentBMs: 1_500 }, run: stopUnderCard },
  { name: "stop-one", title: "stopping one run", plan: { agentBMs: 8_000 }, run: stopOneRun },
  { name: "stop-idle", title: "Stop with nothing in flight", plan: { agentBMs: 8_000 }, run: stopWithNothingInFlight },
  { name: "queue-in-turn", title: "a message queued during the launching turn", plan: { launchMs: 1_500, agentBMs: 8_000 }, run: messageQueuedInTurn },
  { name: "process-dies", title: "an agent process that ends with a run alive", plan: { agentBMs: 8_000 }, run: processEndsWithRunAlive },
  { name: "report-error", title: "a report turn that fails", plan: { agentBMs: 1_500, reportFails: true }, run: reportTurnFails },
  { name: "goal-waits", title: "a goal whose run is alive when the launching turn settles", plan: { agentBMs: 1_500, stepMs: 2_500 }, run: goalWaitsForItsRun },
  { name: "goal-ends-in-turn", title: "a goal whose run ends during its launching turn", plan: { agentBMs: 300, launchMs: 3_000, stepMs: 2_500 }, run: goalWhoseRunEndsInTurn },
  { name: "send-at-report", title: "a message sent before the report's first word", plan: { agentBMs: 1_500, reportMs: 2_000 }, run: messageBeforeTheReport },
  { name: "fold-at-report", title: "a message folded into a report turn", plan: { agentBMs: 1_500, reportMs: 2_000, reportCalls: true }, run: messageFoldedIntoTheReport },
];

/** Puts what the socket broadcasts about one session onto that session's lines. Deltas are left out,
 *  since the text they spell arrives whole. */
function record(seen: ReturnType<typeof watch>, event: string, payload: unknown): void {
  if (event === "session.event") {
    const p = payload as EventPayload<"session.event">;
    if (p.sessionId === seen.id && p.event.type !== "assistant_delta") seen.add(p.event);
  } else if (event === "session.status") {
    const p = payload as EventPayload<"session.status">;
    if (p.sessionId === seen.id) seen.add({ type: "row", status: p.status });
  } else if (event === "session.queue") {
    const p = payload as EventPayload<"session.queue">;
    if (p.sessionId === seen.id) seen.add({ type: "queue", queued: p.queued.length });
  } else if (event === "notifications.changed") {
    const row = (payload as EventPayload<"notifications.changed">).notification;
    if (row?.sessionId === seen.id) seen.add({ type: "feed", category: row.category });
  }
}

async function main(): Promise<void> {
  const tmp = realpathSync(tmpdir());
  const ownHome = realpathSync(homedir());
  if (`${tmp}${sep}`.startsWith(`${ownHome}${sep}`)) {
    ok("the temp folder is outside the home folder", false, `${tmp} is inside ${ownHome}, where Claude Code would read your own CLAUDE.md as project instructions. Set TMPDIR to a folder outside it, then run the check again.`);
    finish();
  }
  const undo: (() => unknown)[] = [];
  try {
    const root = mkdtempSync(join(tmp, "realm-workflow-live-"));
    undo.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const dirs = { realm: join(root, "realm"), home: join(root, "home"), config: join(root, "config"), tmp: join(root, "tmp") };
    for (const dir of Object.values(dirs)) mkdirSync(dir);
    const standIn = await startStandIn();
    undo.push(() => standIn.close());
    for (const name of OUTRANKS_THE_STAND_IN) delete process.env[name];
    Object.assign(process.env, {
      HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, CLAUDE_CODE_TMPDIR: dirs.tmp, ANTHROPIC_BASE_URL: standIn.url, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const app = await createApp({ home: dirs.realm, port: 0, userHome: dirs.home, claudeDir: dirs.config, adapters: { claude: new ClaudeAdapter() } });
    undo.push(() => app.close());
    let watching: ReturnType<typeof watch> | null = null;
    const win = await openWindow(app.port, (event, payload) => { if (watching) record(watching, event, payload); });
    undo.push(() => win.close());
    console.log(`server up on :${app.port}`);
    const bin = process.env.REALM_CLAUDE_BIN?.trim() || bundledClaude();
    const claude = bin ? await probeClaude(bin) : null;
    ok("Realm has a claude it can run", claude?.available === true, claude ? claude.version ?? claude.reason ?? "" : "the Agent SDK's package for this machine is not installed");
    const profile = await win.call("profiles.create", { name: "Workflow check" });
    const scenarios = claude?.available ? SCENARIOS : [];
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario.title} ==`);
      failed = false;
      const space = await win.call("spaces.create", { profileId: profile.id, name: scenario.name });
      const { session } = await win.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "default", title: scenario.name });
      const seen = watch(session.id);
      watching = seen;
      standIn.answerWith(workflowModel(scenario.plan, (by) => seen.add({ type: "asked", by })));
      const s: Session = {
        ...seen, call: win.call, app,
        send: (text) => win.call("sessions.send", { id: session.id, text }),
        answer: (card, decision) => win.call("sessions.respondPermission", { id: session.id, requestId: card.payload.requestId, decision }),
      };
      try { await scenario.run(s); }
      catch (e) { ok("everything the scenario waits for arrives", false, e instanceof Error ? e.message : String(e)); }
      if (failed) for (const l of seen.lines) console.log(`        ${String(l.at).padStart(6)} ms  ${brief(l)}`);
      await win.call("sessions.delete", { id: session.id }).catch((e: Error) => ok("the scenario's session is deleted", false, e.message));
    }
    if (scenarios.length > 0) {
      console.log("\n== the scratch folder ==");
      const kept = readdirSync(dirs.tmp);
      ok("Claude Code kept its own temp files inside it", kept.length > 0, kept.join(", "));
    }
  } finally {
    for (const step of undo.reverse()) await step();
  }
  finish();
}

main().catch((e: unknown) => {
  console.error(e);
  report("the check ran to its end", false, e instanceof Error ? e.message : String(e));
  finish();
});
