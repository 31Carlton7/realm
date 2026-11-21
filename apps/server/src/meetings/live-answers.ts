import { newId, type LiveAnswerEvent, type LiveAnswerTrigger, type MeetingTranscriptLine } from "@realm/contracts";
import { liveAnswerPrompt, type LiveAnswerModel } from "@realm/adapters";
import { LIVE_ANSWER_WINDOW_MS, answerWindow, type QuickChatModel } from "@realm/view";

type Asked = { id: string; abort: AbortController; send: (e: LiveAnswerEvent) => void };

/**
 * A meeting's live answers: the transcript's last few minutes and the prompter's custom info, sent to
 * the model the Quick chat model setting names, streamed back to the window that asked.
 *
 * One answer at a time. A newer ask, a detected question or the answer key alike, cancels the one in
 * flight, since by then it answers a question the call has moved past. The window is cut here, where
 * the words leave for the model, so no caller can send it more of the meeting than that.
 *
 * Claude only for now: the answer is one turn with no tools on the person's Claude login. A setting
 * that names another agent is said back as an error, rather than answered on a model nobody chose.
 */
export class LiveAnswers {
  private asked: Asked | null = null;

  constructor(private readonly d: { model(): QuickChatModel; engine: LiveAnswerModel | null; windowMs?: number }) {}

  ask(input: { lines: readonly MeetingTranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger }, send: (e: LiveAnswerEvent) => void): { answerId: string } {
    this.cancel();
    const asked: Asked = { id: newId(), abort: new AbortController(), send };
    this.asked = asked;
    // After the reply that names the answer, so its window knows the id before the first event.
    setImmediate(() => { void this.run(asked, input); });
    return { answerId: asked.id };
  }

  cancel(): void {
    const asked = this.asked;
    if (!asked) return;
    this.asked = null;
    asked.abort.abort();
    asked.send({ answerId: asked.id, t: "cancelled" });
  }

  /** Start the engine for the first answer. Sends nothing to the model. */
  prepare(): void {
    const m = this.d.model();
    if (m.agentKind === "claude") this.d.engine?.prepare(m.model);
  }

  /** The meeting is over: cancel the answer in flight and let the started engine go. */
  stop(): void {
    this.cancel();
    this.d.engine?.release();
  }

  close(): void {
    this.cancel();
    this.d.engine?.close();
  }

  private async run(asked: Asked, input: { lines: readonly MeetingTranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger }): Promise<void> {
    if (this.asked !== asked) return;
    const id = asked.id;
    const m = this.d.model();
    if (m.agentKind !== "claude" || !this.d.engine) {
      this.finish(asked, { answerId: id, t: "error", message: m.agentKind !== "claude"
        ? `Live answers run on Claude, and the Quick chat model is set to ${m.agentKind}.` : "Live answers are not available in this build." });
      return;
    }
    asked.send({ answerId: id, t: "start", trigger: input.trigger, model: m.model });
    const lines = answerWindow(input.lines, this.d.windowMs ?? LIVE_ANSWER_WINDOW_MS);
    try {
      const text = await this.d.engine.answer({
        model: m.model,
        prompt: liveAnswerPrompt({ lines, customInfo: input.customInfo, trigger: input.trigger }),
        signal: asked.abort.signal,
        onText: (delta) => { if (this.asked === asked) asked.send({ answerId: id, t: "delta", text: delta }); },
      });
      this.finish(asked, { answerId: id, t: "done", text });
    } catch (e) {
      this.finish(asked, { answerId: id, t: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The answer's last event, unless it was cancelled, which already said so. */
  private finish(asked: Asked, last: LiveAnswerEvent): void {
    if (this.asked !== asked) return;
    this.asked = null;
    asked.send(last);
  }
}
