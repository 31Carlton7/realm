import type { SystemAudioState, TranscriptEvents, TranscriptLine, TranscriptSource } from "../voice/transcript";
import type { AnswerEngine, MeetingNote, MeetingSummaryHook } from "./seams";

/** One listening run's transcript, started and stopped (voice/transcript.ts's MeetingTranscript). */
export type Listener = { start(): Promise<void>; stop(): Promise<void> };

export type AssistantDeps = {
  listen: (events: TranscriptEvents) => Listener;
  /** The first-run sheet's answer, kept as a setting (`MEETING_CONSENT_KEY`). */
  consent: { read(): Promise<boolean>; accept(): Promise<void> };
  /** Draws the red mark in the menu bar while this is true. */
  setListening: (on: boolean) => void;
  summary: MeetingSummaryHook;
  answers: AnswerEngine | null;
  now: () => number;
};

/** "idle" before the first Start and after each Stop. */
export type AssistantPhase = "idle" | "starting" | "listening" | "stopping";

export type AssistantQuestion = MeetingNote & {
  id: number;
  /** "unanswered" when no answer engine is plugged in. */
  state: "streaming" | "done" | "failed" | "unanswered";
  error?: string;
};

export type AssistantState = {
  /** Null until the setting has been read. */
  consented: boolean | null;
  /** The first-run sheet is up, asked for by a Start. */
  sheet: boolean;
  phase: AssistantPhase;
  /** When the run on screen started and stopped, in epoch milliseconds. */
  startedAt: number | null;
  stoppedAt: number | null;
  lines: readonly TranscriptLine[];
  partial: Readonly<Partial<Record<TranscriptSource, string>>>;
  customInfo: readonly string[];
  questions: readonly AssistantQuestion[];
  systemAudio: SystemAudioState | null;
  problem: string | null;
};

const INITIAL: AssistantState = {
  consented: null, sheet: false, phase: "idle", startedAt: null, stoppedAt: null,
  lines: [], partial: {}, customInfo: [], questions: [], systemAudio: null, problem: null,
};

/** The meeting assistant in the quick chat panel: one per panel page, so a run outlives the chat. */
export class MeetingAssistant {
  private state = INITIAL;
  private listeners = new Set<() => void>();
  private run: Listener | null = null;
  private nextId = 1;
  private cancels = new Map<number, () => void>();

  constructor(private readonly deps: AssistantDeps) {}

  getState = (): AssistantState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    const consented = await this.deps.consent.read().catch(() => false);
    this.set({ consented });
  }

  /** Start listening, or put up the first-run sheet when it has not been accepted. */
  async start(): Promise<void> {
    if (this.state.phase !== "idle") return;
    if (this.state.consented === null) await this.load();
    if (!this.state.consented) { this.set({ sheet: true }); return; }
    await this.begin();
  }

  /** The sheet's button: kept once, then the Start that asked for it goes ahead. */
  async accept(): Promise<void> {
    await this.deps.consent.accept();
    this.set({ consented: true, sheet: false });
    await this.begin();
  }

  dismissSheet(): void {
    this.set({ sheet: false });
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run || this.state.phase === "stopping") return;
    this.set({ phase: "stopping" });
    await run.stop();
    this.finish(run);
  }

  addContext(text: string): void {
    const info = text.trim();
    if (info) this.set({ customInfo: [...this.state.customInfo, info] });
  }

  ask(text: string): void {
    const question = text.trim();
    if (!question) return;
    const id = this.nextId++;
    const engine = this.deps.answers;
    this.set({ questions: [...this.state.questions, { id, question, answer: "", at: this.deps.now(), state: engine ? "streaming" : "unanswered" }] });
    if (!engine) return;
    const cancel = engine.answer({ question, transcript: this.state.lines, customInfo: this.state.customInfo }, (e) => {
      if (e.t === "text") this.patchQuestion(id, (q) => ({ answer: q.answer + e.text }));
      else {
        this.cancels.delete(id);
        this.patchQuestion(id, () => (e.t === "done" ? { state: "done" } : { state: "failed", error: e.message }));
      }
    });
    if (this.questionOf(id)?.state === "streaming") this.cancels.set(id, cancel);
  }

  /** The panel's page is going: nothing is left listening. */
  dispose(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    void this.run?.stop();
    if (this.run) this.deps.setListening(false);
    this.run = null;
    this.listeners.clear();
  }

  private async begin(): Promise<void> {
    if (this.state.phase !== "idle") return;
    // A Start after a Stop is a new meeting; what was typed before the first Start belongs to this one.
    const fresh = this.state.stoppedAt !== null ? { lines: [], questions: [] } : {};
    this.set({ ...fresh, phase: "starting", startedAt: this.deps.now(), stoppedAt: null, partial: {}, systemAudio: null, problem: null });
    // The mark goes up before the microphone opens, so there is no moment it is heard without it.
    this.deps.setListening(true);
    const run = this.deps.listen({
      line: (line) => {
        if (this.run !== run) return;
        const partial = { ...this.state.partial };
        delete partial[line.source];
        this.set({ lines: [...this.state.lines, line], partial });
      },
      partial: (source, text) => { if (this.run === run) this.set({ partial: { ...this.state.partial, [source]: text } }); },
      systemAudio: (systemAudio) => { if (this.run === run) this.set({ systemAudio }); },
      problem: (problem) => { if (this.run === run) this.set({ problem }); },
      ended: () => this.finish(run),
    });
    this.run = run;
    await run.start();
    if (this.run === run && this.getState().phase === "starting") this.set({ phase: "listening" });
  }

  /** The run is over, by Stop or on its own: the mark comes down and the record goes to the hook. */
  private finish(run: Listener): void {
    if (this.run !== run) return;
    this.run = null;
    this.deps.setListening(false);
    this.set({ phase: "idle", stoppedAt: this.deps.now(), partial: {} });
    const { lines, questions, customInfo } = this.state;
    void Promise.resolve(this.deps.summary({
      transcript: lines,
      notes: questions.map(({ question, answer, at }) => ({ question, answer, at })),
      customInfo,
    })).catch(() => {});
  }

  private questionOf(id: number): AssistantQuestion | undefined {
    return this.state.questions.find((q) => q.id === id);
  }

  private patchQuestion(id: number, patch: (q: AssistantQuestion) => Partial<AssistantQuestion>): void {
    this.set({ questions: this.state.questions.map((q) => (q.id === id ? { ...q, ...patch(q) } : q)) });
  }

  private set(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
