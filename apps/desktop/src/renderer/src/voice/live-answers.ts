import type { LiveAnswerEvent, LiveAnswerTrigger } from "@realm/contracts";
import { answerWindow, questionForMe } from "@realm/view";
import { rpc } from "../rpc/client";
import type { TranscriptLine } from "./transcript";

/** The server's live answers, by way of the socket. A seam: the tests hand in a fake. */
export interface LiveAnswersApi {
  answer(input: { lines: TranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger }): Promise<{ answerId: string }>;
  cancel(): Promise<unknown>;
  prepare(): Promise<unknown>;
  /** Every step of every answer this window asked for; the server sends them to no other. */
  onEvent(cb: (e: LiveAnswerEvent) => void): () => void;
}

export const desktopLiveAnswers = (): LiveAnswersApi => ({
  answer: (input) => rpc().call("meeting.answer", input),
  cancel: () => rpc().call("meeting.cancelAnswer", {}),
  prepare: () => rpc().call("meeting.prepareAnswers", {}),
  onEvent: (cb) => rpc().on("meeting.answer", cb),
});

/**
 * A meeting's live answers, from Start to Stop: hand it each transcript line as it lands, and it asks
 * for an answer when the other side asks a question (with `auto` on), or when `askNow` is called (the
 * answer key). Each step of the answer comes back through `onEvent`; a newer ask cancels the older.
 *
 * It keeps only the lines an answer reads, so an hour-long call holds a few minutes of words.
 */
export class MeetingAnswers {
  private lines: TranscriptLine[] = [];
  /** Where the question last answered on its own ended, so a question is answered once. */
  private answeredEnd: number | null = null;
  private off: (() => void) | null = null;
  private auto: boolean;

  constructor(private readonly deps: {
    api: LiveAnswersApi;
    /** Answer the other side's questions as they are asked. */
    auto: boolean;
    /** The prompter's custom info, read at each ask, so an edit mid-call reaches the next answer. */
    customInfo: () => string;
    onEvent: (e: LiveAnswerEvent) => void;
  }) { this.auto = deps.auto; }

  /** As listening starts: subscribe, and start the model's engine so the first answer is not cold. */
  start(): void {
    this.off ??= this.deps.api.onEvent((e) => this.deps.onEvent(e));
    void this.deps.api.prepare().catch(() => {});
  }

  line(line: TranscriptLine): void {
    this.lines = answerWindow([...this.lines, line]);
    if (!this.auto) return;
    const asked = questionForMe(this.lines);
    if (!asked || asked.end === this.answeredEnd) return;
    this.answeredEnd = asked.end;
    void this.ask("question");
  }

  setAuto(on: boolean): void { this.auto = on; }

  /** The answer key: answer what was just asked, or say what to say next. */
  askNow(): Promise<void> { return this.ask("key"); }

  cancel(): Promise<void> { return this.deps.api.cancel().then(() => {}, () => {}); }

  /** Stop: the answer in flight is cancelled, and nothing more is heard. */
  async stop(): Promise<void> {
    await this.cancel();
    this.off?.();
    this.off = null;
    this.lines = [];
  }

  private async ask(trigger: LiveAnswerTrigger): Promise<void> {
    try {
      await this.deps.api.answer({ lines: this.lines, customInfo: this.deps.customInfo(), trigger });
    } catch (e) {
      this.deps.onEvent({ answerId: "", t: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
