/**
 * A stand-in for the Anthropic Messages API on a loopback port, and the model that answers on it.
 *
 * `live-workflow-check.ts` points the REAL `claude` at it, so the binary runs whole turns, launches a
 * workflow and reports on it with no account and nothing billed. It speaks as much of the API as
 * that takes: `POST /v1/messages`, streamed or whole, and `count_tokens`. Everything else gets a
 * 404, and Claude Code carries on.
 *
 * What the model says is fixed. `workflowModel` reads who is asking off each request, the session's
 * own loop or one of the two agents of the run it launched, and answers as a `RunPlan` has that one
 * answer, after the delay the plan gives it. The delays are what put a scenario's events in order.
 * How long an agent takes decides whether its card reaches Realm during the launching turn or after
 * it, and whether a run is still at work when something is done to it.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sleep } from "./harness";

/** One block of a message's content, as much of it as the stand-in reads. */
type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown };
type Message = { role: string; content: string | Block[] };
/** A Messages API request, as much of it as the stand-in reads. */
export type MessagesRequest = { model?: string; stream?: boolean; system?: string | { text?: string }[]; messages?: Message[] };

/** What the model says to one request: some text, a call to one tool, or the API's own refusal in
 *  place of an answer. */
export type Said =
  | { text: string }
  | { tool: { name: string; input: Record<string, unknown> } }
  | { refusal: { status: number; type: string; message: string } };
export type Model = (body: MessagesRequest) => Said | Promise<Said>;

export type StandIn = {
  /** What `ANTHROPIC_BASE_URL` is set to. */
  url: string;
  /** The model that answers from the next request on. A request already being answered keeps the
   *  model it arrived under, so one scenario's slow answer is never given under the next one's plan. */
  answerWith(model: Model): void;
  close(): Promise<void>;
};

/** Who is asking: the session's own loop, or the first or second agent of the run it launched. */
export type Asker = "session" | "agent-a" | "agent-b";

/**
 * How one scenario's run goes. Every time is in milliseconds, and one left out is no wait at all.
 */
export type RunPlan = {
  /** Agent A asks to run a shell command before it answers, which puts a card in front of the person. */
  agentAsks?: boolean;
  /** How long agent A takes over its first reply, which decides whether its card lands in the
   *  launching turn or after it. */
  agentAMs?: number;
  /** How long agent B, the second and last, takes to answer, which is how long the run stays at work. */
  agentBMs?: number;
  /** How long the session takes over its last word on the launch, which is how long the launching
   *  turn lasts. */
  launchMs?: number;
  /** How long the session takes over a goal's continuation. */
  stepMs?: number;
  /** The API refuses the request of the turn that reports on the run. */
  reportFails?: boolean;
  /** How long the session takes over the first reply of the turn that reports on the run, which is
   *  how long a message has to reach Claude Code ahead of that turn's first word. */
  reportMs?: number;
  /** The session runs a shell command in the turn that reports on the run, before it says the
   *  report. A message that is waiting when the command returns is taken into that turn. */
  reportCalls?: boolean;
};

/** The words a check types for the model to act on: one has it launch the workflow, and one gets a
 *  plain answer. The rest of a message is for whoever reads the log. */
export const CUE = { launch: "PROBE-MAIN", plain: "PROBE-SECOND" } as const;

/** What the model says as the session, one phrase for each kind of turn, so a check can tell which
 *  turn it is reading. A report turn has a second phrase, `folded`, for when a typed message came in
 *  with the result of its shell command, so a check can tell that the model read it there. */
export const SAID = { launched: "Started the run.", report: "The run finished. REPORT.", folded: "The run finished, and I read the message sent meanwhile.", plain: "second answer", step: "goal step" } as const;

/** The workflow the model launches: two agents, one after the other, so the run lasts for as long
 *  as the second takes to answer. */
const SCRIPT = [
  "export const meta = { name: 'probe-run', description: 'Probe run with two agents', phases: [{ title: 'Work' }] }",
  "phase('Work')",
  "const a = await agent('PROBE-AGENT-A say alpha', { label: 'a' })",
  "const b = await agent('PROBE-AGENT-B say beta', { label: 'b' })",
  "return { a, b }",
].join("\n");

/** How the API refuses the report when a plan has it fail. The status is one Claude Code does not
 *  retry, so the turn fails at once. The message is one Realm's failover retries a sent turn for
 *  (`classifyFailure`), so a check that nothing is sent again is a check that can fail. */
const REFUSAL = { status: 400, type: "invalid_request_error", message: "the stand-in refuses the report: service unavailable" };

/** The shell command the session runs in a report turn when a plan has it call a tool. It changes
 *  nothing, and what matters is that it returns: between a tool's result and the model's next
 *  request is where Claude Code takes a waiting message into the turn in flight. */
const REPORT_COMMAND = { name: "Bash", input: { command: "sleep 2", description: "Wait two seconds" } };

/** Whether a message is the model calling this tool. */
function calls(message: Message | undefined, name: string): boolean {
  const content = message?.content;
  return Array.isArray(content) && content.some((b) => b.type === "tool_use" && b.name === name);
}

/** Every piece of text in these messages, in order: what was typed, what was said, a tool call as
 *  JSON and a tool's result. */
function textsOf(messages: readonly Message[]): string[] {
  return messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((b) => {
    if (b.type === "text") return b.text ?? "";
    if (b.type === "tool_result") return typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
    return b.type === "tool_use" ? JSON.stringify({ name: b.name, input: b.input }) : "";
  })));
}

/** The request's system prompt as one string. */
function systemOf(body: MessagesRequest): string {
  return typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
}

/** Who a request comes from. Claude Code tells a workflow's agent what it is in its system prompt,
 *  and the two agents are told apart by the prompt the script gave each. */
function askerOf(body: MessagesRequest): Asker {
  if (!/subagent spawned by a workflow/.test(systemOf(body))) return "session";
  return textsOf(body.messages ?? []).join("\n").includes("PROBE-AGENT-A") ? "agent-a" : "agent-b";
}

/**
 * The model for a session that launches one workflow: what it says, by who is asking.
 *
 * An agent says its one word, after the wait the plan gives it, and agent A first asks for a shell
 * command when the plan has it ask. The session is read by what came in since it last spoke: a
 * task notification is the report turn, a tool result is the launch coming back, and after those
 * the goal's continuation, the plain cue and the launch cue, in that order, because a continuation
 * quotes the objective and the objective is the launch cue. One reading comes ahead of those. Where
 * the session last called the report turn's own shell command, what came in is that command's
 * result, and the report follows it, in the words that say whether a typed message came in too.
 *
 * `heard` is told who asked as each request arrives, before any wait, which is how a check learns
 * that an agent has reached the model.
 */
export function workflowModel(plan: RunPlan, heard: (who: Asker) => void = () => {}): Model {
  return async (body) => {
    const who = askerOf(body);
    heard(who);
    const messages = body.messages ?? [];
    const spoken = messages.filter((m) => m.role === "assistant").length;
    if (who === "agent-a") {
      if (spoken > 0) return { text: "alpha" };
      await sleep(plan.agentAMs ?? 0);
      return plan.agentAsks ? { tool: { name: "Bash", input: { command: "touch probe-made-by-agent.txt", description: "Make a file" } } } : { text: "alpha" };
    }
    if (who === "agent-b") {
      await sleep(plan.agentBMs ?? 0);
      return { text: "beta" };
    }
    const last = messages.map((m) => m.role).lastIndexOf("assistant");
    const since = messages.slice(last + 1);
    const typed = textsOf(since).join("\n");
    if (calls(messages[last], REPORT_COMMAND.name)) return { text: typed.includes(CUE.plain) ? SAID.folded : SAID.report };
    if (/SYSTEM NOTIFICATION|task-notification/i.test(typed)) {
      await sleep(plan.reportMs ?? 0);
      if (plan.reportFails) return { refusal: REFUSAL };
      return plan.reportCalls ? { tool: REPORT_COMMAND } : { text: SAID.report };
    }
    if (since.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))) {
      await sleep(plan.launchMs ?? 0);
      return { text: SAID.launched };
    }
    if (typed.includes("Continue working towards this objective")) {
      await sleep(plan.stepMs ?? 0);
      return { text: SAID.step };
    }
    if (typed.includes(CUE.plain)) return { text: SAID.plain };
    if (typed.includes(CUE.launch)) return { tool: { name: "Workflow", input: { script: SCRIPT } } };
    return { text: "ok" };
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** An error in the shape the API gives one. */
const refused = (type: string, message: string): unknown => ({ type: "error", error: { type, message } });

/**
 * One request, answered. A reply is a single block, text or a tool call, written whole or as the
 * events the API streams it in, whichever the request asked for.
 *
 * A model that throws is answered as a refusal that says so, so the turn fails where it can be read
 * and Claude Code does not sit retrying. An answer for a caller that has gone is dropped: a
 * stopped run leaves its agent's request waiting out its delay here.
 */
async function answer(res: ServerResponse, method: string, url: string, raw: string, n: number, model: Model): Promise<void> {
  const path = url.split("?")[0] ?? "";
  if (method === "POST" && path === "/v1/messages/count_tokens") return json(res, 200, { input_tokens: 42 });
  if (method !== "POST" || path !== "/v1/messages") return json(res, 404, refused("not_found_error", `nothing at ${path}`));
  let body: MessagesRequest = {};
  let said: Said;
  try {
    body = JSON.parse(raw) as MessagesRequest;
    said = await model(body);
  } catch (e) {
    said = { refusal: { status: 400, type: "invalid_request_error", message: `the stand-in could not answer: ${e instanceof Error ? e.message : String(e)}` } };
  }
  if (res.destroyed) return;
  if ("refusal" in said) return json(res, said.refusal.status, refused(said.refusal.type, said.refusal.message));
  const stop = "tool" in said ? "tool_use" : "end_turn";
  const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: `msg_standin_${n}`, type: "message", role: "assistant", model: body.model ?? "stand-in", content: [], stop_reason: null, stop_sequence: null, usage };
  const block = "tool" in said ? { type: "tool_use", id: `toolu_standin_${n}`, name: said.tool.name, input: said.tool.input } : { type: "text", text: said.text };
  if (!body.stream) return json(res, 200, { ...message, content: [block], stop_reason: stop, usage: { ...usage, output_tokens: 5 } });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: Record<string, unknown>): void => { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
  send("message_start", { message });
  send("content_block_start", { index: 0, content_block: "tool" in said ? { ...block, input: {} } : { ...block, text: "" } });
  send("content_block_delta", { index: 0, delta: "tool" in said ? { type: "input_json_delta", partial_json: JSON.stringify(said.tool.input) } : { type: "text_delta", text: said.text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

/** Starts the stand-in on a free loopback port. Until `answerWith` names a model, it says "ok". */
export async function startStandIn(): Promise<StandIn> {
  let model: Model = () => ({ text: "ok" });
  let asked = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => { void answer(res, req.method ?? "", req.url ?? "", Buffer.concat(chunks).toString("utf8"), ++asked, model); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    answerWith: (next) => { model = next; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
