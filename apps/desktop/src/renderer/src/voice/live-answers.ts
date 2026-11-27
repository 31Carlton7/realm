import type { LiveAnswerEvent, LiveAnswerTrigger, ScreenPicture } from "@realm/contracts";
import { answerWindow, questionForMe } from "@realm/view";
import { rpc } from "../rpc/client";
import type { TranscriptLine } from "./transcript";

/** The server's live answers, by way of the socket. A seam: the tests hand in a fake. */
export interface LiveAnswersApi {
  answer(input: { lines: TranscriptLine[]; customInfo: string; trigger: LiveAnswerTrigger; question?: string; screen?: ScreenPicture }): Promise<{ answerId: string }>;
  cancel(): Promise<unknown>;
  prepare(): Promise<unknown>;
  /** The meeting is over: the server cancels the answer in flight and lets its engine go. */
  stop(): Promise<unknown>;
  /** Every step of every answer this window asked for; the server sends them to no other. */
  onEvent(cb: (e: LiveAnswerEvent) => void): () => void;
}

export const desktopLiveAnswers = (): LiveAnswersApi => ({
  answer: (input) => rpc().call("meetings.answer", input),
  cancel: () => rpc().call("meetings.cancelAnswer", {}),
  prepare: () => rpc().call("meetings.prepareAnswers", {}),
  stop: () => rpc().call("meetings.stopAnswers", {}),
  onEvent: (cb) => rpc().on("meetings.answer", cb),
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

  /** The answer key: answer what was just asked, or say what to say next. With `question`, the one
   *  the person typed, for this ask only. */
  askNow(question?: string): Promise<void> { return this.ask("key", question); }

  /** The screen key: answer from the picture of the person's screen, with `question` if they typed
   *  one. The picture is sent with this ask and kept by neither side. */
  askScreen(screen: ScreenPicture, question?: string): Promise<void> { return this.ask("screen", question, screen); }

  cancel(): Promise<void> { return this.deps.api.cancel().then(() => {}, () => {}); }

  /** Stop: the answer in flight is cancelled, the engine started for the next one goes, and nothing
   *  more is heard. */
  async stop(): Promise<void> {
    await this.deps.api.stop().catch(() => {});
    this.off?.();
    this.off = null;
    this.lines = [];
  }

  private async ask(trigger: LiveAnswerTrigger, question?: string, screen?: ScreenPicture): Promise<void> {
    try {
      await this.deps.api.answer({ lines: this.lines, customInfo: this.deps.customInfo(), trigger, question, ...(screen ? { screen } : {}) });
    } catch (e) {
      this.deps.onEvent({ answerId: "", t: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
