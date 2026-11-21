import {
  MEETING_DEFAULT_TITLE, type LiveAnswerEvent, type LiveAnswerTrigger, type MeetingNotesProgress, type MeetingSummaryOutcome,
  type MeetingTranscriptLine, type SaveMeetingNotesParams, type SaveMeetingNotesResult,
} from "@realm/contracts";
import { MeetingAnswers, type LiveAnswersApi } from "../voice/live-answers";
import type { SystemAudioState, TranscriptEvents, TranscriptSource } from "../voice/transcript";

/** One listening run's transcript, started and stopped (voice/transcript.ts's MeetingTranscript). */
export type Listener = { start(): Promise<void>; stop(): Promise<void> };

/** Where Stop's notes go: `meetings.saveNotes`, its progress and its cancel. */
export interface MeetingNotesApi {
  save(params: SaveMeetingNotesParams): Promise<SaveMeetingNotesResult>;
  cancel(meetingId: string): Promise<unknown>;
  onProgress(cb: (p: MeetingNotesProgress) => void): () => void;
}

export type AssistantDeps = {
  listen: (events: TranscriptEvents) => Listener;
  /** The first-run sheet's answer, kept as a setting (`MEETING_CONSENT_KEY`). */
  consent: { read(): Promise<boolean>; accept(): Promise<void> };
  /** Draws the red mark in the menu bar while this is true. */
  setListening: (on: boolean) => void;
  answers: LiveAnswersApi;
  notes: MeetingNotesApi;
  /** The space a meeting's notes are saved in, read at Stop. */
  spaceId: () => string | null;
  /** Shows a saved meeting's file in a Realm window. */
  openFile: (spaceId: string, path: string) => void;
  now: () => number;
  newId: () => string;
};

/** Live answers start on their own when the other side asks a question. Its switch is M3b's. */
const AUTO_ANSWERS = true;

/** Past this many characters of custom info the prompter says that every answer sends all of it. */
export const LONG_CUSTOM_INFO = 20_000;

/** The custom info as one string, in the order it was given. */
export function customInfoText(info: readonly string[]): string {
  return info.join("\n");
}

/** "idle" before the first Start and after each Stop. */
export type AssistantPhase = "idle" | "starting" | "listening" | "stopping";

/** A question typed into the assistant. */
export type AskedQuestion = { id: number; text: string; at: number };

/** The live answer on screen: the one whose `start` came last. */
export type LiveAnswer = { id: string; trigger: LiveAnswerTrigger | null; text: string; state: "streaming" | "done" | "failed"; error?: string };

/** A stopped meeting's notes file: `path` once the server has named it. */
export type MeetingNotesState = {
  meetingId: string; spaceId: string; path: string | null;
  stage: "saving" | MeetingNotesProgress["stage"]; summary: MeetingSummaryOutcome | null;
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
  lines: readonly MeetingTranscriptLine[];
  partial: Readonly<Partial<Record<TranscriptSource, string>>>;
  customInfo: readonly string[];
  asked: readonly AskedQuestion[];
  answer: LiveAnswer | null;
  notes: MeetingNotesState | null;
  systemAudio: SystemAudioState | null;
  problem: string | null;
};

const INITIAL: AssistantState = {
  consented: null, sheet: false, phase: "idle", startedAt: null, stoppedAt: null,
  lines: [], partial: {}, customInfo: [], asked: [], answer: null, notes: null, systemAudio: null, problem: null,
};

/** The meeting assistant in the quick chat panel: one per panel page, so a run outlives the chat. */
export class MeetingAssistant {
  private state = INITIAL;
  private listeners = new Set<() => void>();
  private run: Listener | null = null;
  private nextId = 1;
  private readonly answers: MeetingAnswers;
  /** Answers that have started, so an `error` for one that never started is still shown. */
  private started = new Set<string>();
  private wrapUp: Promise<void> = Promise.resolve();
  /** The run that got as far as listening. One that never did is no meeting: it saves and clears nothing. */
  private heard: Listener | null = null;

  constructor(private readonly deps: AssistantDeps) {
    this.answers = new MeetingAnswers({
      api: deps.answers, auto: AUTO_ANSWERS, onEvent: (e) => this.onAnswer(e),
      customInfo: () => customInfoText(this.state.customInfo),
    });
  }

  /** Hear how Stop's notes are coming along; the returned function stops hearing. */
  watchNotes(): () => void {
    return this.deps.notes.onProgress((p) => {
      const n = this.state.notes;
      if (n?.meetingId === p.meetingId && n.stage !== "saved") this.set({ notes: { ...n, path: p.path, stage: p.stage } });
    });
  }

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

  /** Stop: the mark comes down, the live answers end, and the notes are saved. */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run || this.state.phase === "stopping") return;
    this.set({ phase: "stopping" });
    await run.stop();
    this.finish(run);
    await this.wrapUp;
  }

  addContext(text: string): void {
    const info = text.trim();
    if (info) this.set({ customInfo: [...this.state.customInfo, info] });
  }

  /** A typed question: answered through the answer key, which takes it for that answer alone. */
  ask(text: string): void {
    const question = text.trim();
    if (!question) return;
    this.set({ asked: [...this.state.asked, { id: this.nextId++, text: question, at: this.deps.now() }] });
    // Before a Start, or after a Stop, nothing is subscribed to the answers yet.
    if (this.state.phase === "idle") this.answers.start();
    void this.answers.askNow(question);
  }

  /** The answer's ×: one still streaming is cancelled, and either way it leaves the panel. */
  dismissAnswer(): void {
    if (this.state.answer?.state === "streaming") void this.answers.cancel();
    this.set({ answer: null });
  }

  cancelSummary(): void {
    const n = this.state.notes;
    if (n && n.stage !== "saved") void this.deps.notes.cancel(n.meetingId).catch(() => {});
  }

  openNotes(): void {
    const n = this.state.notes;
    if (n?.path) this.deps.openFile(n.spaceId, n.path);
  }

  /** The panel's page is going: nothing is left listening. */
  dispose(): void {
    void this.answers.stop();
    void this.run?.stop();
    if (this.run) this.deps.setListening(false);
    this.run = null;
    this.listeners.clear();
  }

  private async begin(): Promise<void> {
    if (this.state.phase !== "idle") return;
    const startedAt = this.deps.now();
    this.set({ phase: "starting", partial: {}, systemAudio: null, problem: null });
    // The mark goes up before the microphone opens, so there is no moment it is heard without it.
    this.deps.setListening(true);
    this.answers.start();
    const run = this.deps.listen({
      line: (line) => {
        if (this.run !== run) return;
        const partial = { ...this.state.partial };
        delete partial[line.source];
        this.set({ lines: [...this.state.lines, line], partial });
        this.answers.line(line);
      },
      partial: (source, text) => { if (this.run === run) this.set({ partial: { ...this.state.partial, [source]: text } }); },
      systemAudio: (systemAudio) => { if (this.run === run) this.set({ systemAudio }); },
      problem: (problem) => { if (this.run === run) this.set({ problem }); },
      ended: () => this.finish(run),
    });
    this.run = run;
    await run.start();
    if (this.run !== run || this.getState().phase !== "starting") return;
    this.heard = run;
    // A Start after a Stop is a new meeting, which keeps only what was typed since this Start, and its
    // answer. What was typed before the first Start belongs to the first meeting.
    const asked = this.state.asked.filter((q) => q.at >= startedAt);
    const fresh = this.state.stoppedAt !== null ? { lines: [], asked, ...(asked.length === 0 ? { answer: null } : {}) } : {};
    this.set({ ...fresh, notes: null, phase: "listening", startedAt, stoppedAt: null });
  }

  /** The run is over, by Stop or on its own: the mark comes down, the answers end, the notes are saved. */
  private finish(run: Listener): void {
    if (this.run !== run) return;
    this.run = null;
    this.deps.setListening(false);
    if (this.heard !== run) {
      this.set({ phase: "idle", partial: {} });
      this.wrapUp = this.answers.stop();
      return;
    }
    this.heard = null;
    this.set({ phase: "idle", stoppedAt: this.deps.now(), partial: {} });
    const { lines, asked, customInfo, startedAt, stoppedAt } = this.state;
    this.wrapUp = this.answers.stop().then(() => {
      // The notes file holds the lines and the questions; custom info alone would make an empty one.
      if (lines.length === 0 && asked.length === 0) return;
      return this.save({
        title: MEETING_DEFAULT_TITLE, startedAt: startedAt ?? stoppedAt!, endedAt: stoppedAt!, lines: [...lines],
        notes: asked.map((q) => `- Asked the assistant: ${q.text}`).join("\n"), customInfo: customInfoText(customInfo),
      });
    });
  }

  private async save(meeting: Omit<SaveMeetingNotesParams, "meetingId" | "spaceId">): Promise<void> {
    const spaceId = this.deps.spaceId();
    if (!spaceId) { this.set({ problem: "Realm could not save the notes: no space is open." }); return; }
    const meetingId = this.deps.newId();
    this.set({ notes: { meetingId, spaceId, path: null, stage: "saving", summary: null } });
    try {
      const { path, summary } = await this.deps.notes.save({ meetingId, spaceId, ...meeting });
      const n = this.state.notes;
      if (n?.meetingId === meetingId) this.set({ notes: { ...n, path, stage: "saved", summary } });
    } catch (e) {
      if (this.state.notes?.meetingId === meetingId) this.set({ notes: null, problem: `Realm could not save the notes: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private onAnswer(e: LiveAnswerEvent): void {
    const current = this.state.answer;
    if (e.t === "start") {
      this.started.add(e.answerId);
      this.set({ answer: { id: e.answerId, trigger: e.trigger, text: "", state: "streaming" } });
    } else if (e.t === "error" && !this.started.has(e.answerId)) {
      // An answer that could not begin, or an ask the server refused: the newest ask, so it is shown.
      this.set({ answer: { id: e.answerId, trigger: null, text: "", state: "failed", error: e.message } });
    } else if (current?.id === e.answerId) {
      if (e.t === "delta") this.set({ answer: { ...current, text: current.text + e.text } });
      else if (e.t === "done") this.set({ answer: { ...current, text: e.text, state: "done" } });
      else if (e.t === "error") this.set({ answer: { ...current, state: "failed", error: e.message } });
      else this.set({ answer: null });
    }
  }

  private set(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
