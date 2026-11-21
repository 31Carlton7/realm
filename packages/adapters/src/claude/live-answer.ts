import { query as sdkQuery, startup as sdkStartup, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { fenceUntrusted, type LiveAnswerTrigger, type MeetingTranscriptLine } from "@realm/contracts";

/** How long a started engine waits for the next live answer before it is stopped, as the quick
 *  chat's spare waits (`QUICK_CHAT_WARM_MS`). */
export const LIVE_ANSWER_WARM_MS = 5 * 60_000;

const SYSTEM = [
  "You help a person during a live call by drafting what they could say next.",
  "Reply in their voice, first person, in at most three short sentences of plain text: no preamble, no markdown, no options to choose from.",
  "If you do not know a fact they would need, say what they could say instead of inventing it.",
].join(" ");

const who = { me: "Me", them: "Them" } as const;

/**
 * The one message a live answer sends: the person's custom info and the transcript, each fenced as
 * untrusted data, then the question they typed, if any, and what to answer. The typed question is
 * the person's own request, so it is not fenced: the fence would tell the model not to follow it. The
 * lines are the window the server already cut.
 */
export function liveAnswerPrompt(input: { lines: readonly MeetingTranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger; question?: string }): string {
  const transcript = input.lines.map((l) => `${who[l.source]}: ${l.text.trim()}`).join("\n");
  const info = input.customInfo.trim();
  const question = input.question?.trim();
  return [
    info ? fenceUntrusted(info, "WHAT THE PERSON TOLD YOU BEFORE OR DURING THE CALL") : "The person told you nothing about this call.",
    fenceUntrusted(transcript || "(nothing said yet)", "THE LAST FEW MINUTES OF THE CALL'S TRANSCRIPT, \"Me\" being the person"),
    ...(question
      ? [`THE PERSON TYPED THIS TO YOU DURING THE CALL:\n${question}`, "Answer what they typed, using the transcript and what they told you."]
      : [input.trigger === "question"
        ? "They were just asked the last question in the transcript. Draft their answer to it."
        : "They asked you for help now. Draft what they should say next, answering the latest question put to them if there is one."]),
  ].join("\n\n");
}

export type LiveAnswerRequest = { model: string | null; prompt: string; signal: AbortSignal; onText(delta: string): void };

/** What the server asks a live answer of. A seam: the tests hand in a fake. */
export interface LiveAnswerModel {
  /** Start an engine for `model` (null: the CLI's default) so the next answer does not wait on a cold start. */
  prepare(model: string | null): void;
  /** Stream one answer; resolves with its whole text, rejects when it fails or `signal` aborts. */
  answer(req: LiveAnswerRequest): Promise<string>;
  /** The meeting is over: stop the started engine, and start no next one until `prepare` or `answer`. */
  release(): void;
  /** For good: nothing starts after this. */
  close(): void;
}

type Spare = { model: string | null; abort: AbortController; warm: Promise<WarmQuery>; timer: ReturnType<typeof setTimeout> | null };

/**
 * Live answers on the person's own Claude login: one turn, no tools, no settings, no thinking, not
 * saved as a session, so the words reach the model and nothing else on the way. Each answer runs on
 * a Claude Code process started ahead of it (`startup()`), and the next one is started as it ends.
 * A process is used once, so no answer carries the conversation of the one before.
 */
export class ClaudeLiveAnswers implements LiveAnswerModel {
  private spare: Spare | null = null;
  /** Whether an answer that ends should start the next engine: from `prepare` or `answer` until
   *  `release`, so an answer Stop cancelled does not start one as it unwinds. */
  private listening = false;
  private closed = false;

  constructor(private readonly deps: { startup?: typeof sdkStartup; query?: typeof sdkQuery; warmMs?: number } = {}) {}

  prepare(model: string | null): void {
    if (this.closed) return;
    this.listening = true;
    if (this.spare?.model === model) { this.idleOut(this.spare); return; }
    this.drop();
    this.spare = this.start(model);
    this.idleOut(this.spare);
  }

  async answer(req: LiveAnswerRequest): Promise<string> {
    if (this.closed) throw new Error("live answers are closed");
    this.listening = true;
    const engine = this.take(req.model) ?? this.start(req.model);
    const stop = () => engine.abort.abort();
    if (req.signal.aborted) stop();
    req.signal.addEventListener("abort", stop, { once: true });
    try {
      const warm = await engine.warm.catch(() => null);
      if (req.signal.aborted) throw new Error("cancelled");
      // A spare that died while parked costs one cold start, not the answer.
      const q = warm ? warm.query(req.prompt) : (this.deps.query ?? sdkQuery)({ prompt: req.prompt, options: this.options(req.model, engine.abort) });
      let text = "";
      for await (const msg of q) {
        if (msg.type === "stream_event" && msg.event.type === "content_block_delta" && msg.event.delta.type === "text_delta") {
          text += msg.event.delta.text;
          req.onText(msg.event.delta.text);
        } else if (msg.type === "result") {
          if (req.signal.aborted) throw new Error("cancelled");
          if (msg.subtype !== "success") throw new Error(`the model did not answer: ${msg.subtype}`);
          return text || msg.result;
        }
      }
      throw new Error(req.signal.aborted ? "cancelled" : "the model stopped without an answer");
    } finally {
      req.signal.removeEventListener("abort", stop);
      stop();
      if (this.listening) this.prepare(req.model);
    }
  }

  release(): void {
    this.listening = false;
    this.drop();
  }

  close(): void {
    this.closed = true;
    this.release();
  }

  private options(model: string | null, abortController: AbortController): Options {
    return {
      ...(model ? { model } : {}),
      maxTurns: 1,
      // No tools at all: their definitions alone are thousands of tokens on every answer, and a tool is
      // a way for the transcript to go somewhere other than the model.
      tools: [],
      // Nor MCP servers: `tools` covers the built-in ones only, so without these the servers in his
      // own config would be offered to a turn that reads other people's speech.
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      // The CLI sends adaptive thinking to Haiku 5.5 whatever `thinking` or `maxThinkingTokens` say
      // (measured on the wire, SDK 0.3.322); only this variable leaves it out. `env` replaces the
      // child's environment, so the rest is passed on.
      env: { ...process.env, CLAUDE_CODE_DISABLE_THINKING: "1" },
      effort: "low",
      persistSession: false,
      includePartialMessages: true,
      systemPrompt: SYSTEM,
      abortController,
    };
  }

  private start(model: string | null): Spare {
    const abort = new AbortController();
    const warm = (this.deps.startup ?? sdkStartup)({ options: this.options(model, abort) });
    warm.catch(() => {});
    return { model, abort, warm, timer: null };
  }

  private idleOut(spare: Spare): void {
    if (spare.timer) clearTimeout(spare.timer);
    spare.timer = setTimeout(() => { if (this.spare === spare) this.drop(); }, this.deps.warmMs ?? LIVE_ANSWER_WARM_MS);
    spare.timer.unref?.();
  }

  private take(model: string | null): Spare | null {
    const spare = this.spare;
    if (spare?.model !== model) return null;
    if (spare.timer) clearTimeout(spare.timer);
    this.spare = null;
    return spare;
  }

  private drop(): void {
    const spare = this.spare;
    if (!spare) return;
    this.spare = null;
    if (spare.timer) clearTimeout(spare.timer);
    spare.abort.abort();
    void spare.warm.then((w) => w.close(), () => {});
  }
}
