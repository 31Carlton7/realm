import { useEffect, useRef, useState } from "react";
import type { DictationCleanResult } from "@realm/contracts";
import { WebVoiceAudio } from "./audio-io";
import { Dictation, type DictationEvents } from "./dictation";
import { desktopSpeechHelper } from "./protocol";
import { placeDictation, restoreRaw, type CleanedRecord } from "./dictation-draft";

export type DictationControl = { start(): Promise<void>; stop(): void; cancel(): void };

/** What the prompter needs to dictate: a way to listen, and the clean-up step. The tests hand in a fake. */
export type DictationPort = {
  open(events: DictationEvents): DictationControl;
  /** Answers `off`, without asking anything, while Clean up dictation is off. */
  clean(raw: string): Promise<DictationCleanResult>;
};

/** Words being dictated: where they go, what has been heard so far, and how much of it is final.
 *  `fetching` while this Mac's speech model is still being downloaded, before anything is heard. */
type LiveDictation = { at: number; words: string; settled: number; cleaning: boolean; fetching?: { progress: number | null } };

/** Words that have just landed, `start`–`end` in `draft`, the first `from` of them already in the
 *  typed ink. The prompter eases the rest into it. */
type LandedDictation = { draft: string; start: number; end: number; from: number };

export type DictationNote =
  | { kind: "cleaned" }
  | { kind: "kept"; text: string }
  | { kind: "problem"; text: string };

const keptText = (reason: string | undefined) => reason === "drifted"
  ? "Kept as heard: the clean-up changed too much"
  : "Kept as heard: the clean-up did not answer";

/**
 * Dictation in the prompter. The words being heard are not in the draft until dictation stops; the
 * prompter draws them at the caret meanwhile. Then the words, cleaned if that is on, land at the
 * caret, and a clean-up can be taken back to exactly what was heard for as long as the draft is the
 * one it landed in: typing or sending ends that, and the note with it.
 */
export function useDictation({ port, draft, onDraftChange, caret, select, level }: {
  port: DictationPort | null;
  draft: string;
  onDraftChange(text: string): void;
  /** Where the words go: the caret, never inside a chip. */
  caret(): number;
  /** Put the caret here once the draft has been painted. */
  select(at: number): void;
  /** The microphone's level each frame, 0–1 RMS. */
  level?(rms: number): void;
}) {
  const [live, setLive] = useState<LiveDictation | null>(null);
  const [cleaned, setCleaned] = useState<CleanedRecord | null>(null);
  const [note, setNote] = useState<DictationNote | null>(null);
  const [landed, setLanded] = useState<LandedDictation | null>(null);
  const settledNow = useRef(0);
  const levelNow = useRef(level);
  levelNow.current = level;
  const control = useRef<DictationControl | null>(null);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  /** The draft the note was written about. */
  const noted = useRef<string | null>(null);

  useEffect(() => () => control.current?.cancel(), []);
  useEffect(() => {
    if (noted.current !== null && draft !== noted.current) { noted.current = null; setNote(null); setCleaned(null); }
    setLanded((l) => (l && l.draft !== draft ? null : l));
  }, [draft]);

  const show = (next: DictationNote, about: string) => { noted.current = about; setNote(next); };
  const dismiss = () => { noted.current = null; setNote(null); setCleaned(null); };

  const finish = async (at: number, raw: string) => {
    control.current = null;
    if (!raw || !port) { setLive(null); return; }
    setLive({ at, words: raw, settled: settledNow.current, cleaning: true });
    const result = await port.clean(raw).catch((): DictationCleanResult => ({ outcome: "failed", text: raw }));
    const placed = placeDictation(draftNow.current, at, result.text);
    setLive(null);
    // Cleaned words are new words: all of them settle. Raw ones keep what was already final.
    setLanded({ draft: placed.text, start: placed.start, end: placed.end, from: result.text === raw ? Math.min(settledNow.current, raw.length) : 0 });
    onDraftChange(placed.text);
    select(placed.end);
    if (result.outcome === "cleaned" && result.text !== raw) {
      setCleaned({ draft: placed.text, start: placed.start, cleaned: result.text, raw });
      show({ kind: "cleaned" }, placed.text);
    } else if (result.outcome === "kept" || result.outcome === "failed") {
      show({ kind: "kept", text: keptText(result.reason) }, placed.text);
    }
  };

  const start = () => {
    if (!port || control.current) return;
    const at = caret();
    dismiss();
    setLanded(null);
    settledNow.current = 0;
    setLive({ at, words: "", settled: 0, cleaning: false });
    const c = port.open({
      partial: (words, settled) => {
        settledNow.current = settled;
        setLive((l) => (l && !l.cleaning ? { at: l.at, words, settled, cleaning: false } : l));
      },
      fetching: (progress) => setLive((l) => (l && !l.cleaning ? { ...l, fetching: { progress } } : l)),
      level: (rms) => levelNow.current?.(rms),
      done: (raw) => void finish(at, raw),
      problem: (message) => { control.current = null; setLive(null); show({ kind: "problem", text: message }, draftNow.current); },
    });
    control.current = c;
    void c.start();
  };

  const stop = () => control.current?.stop();

  /** Swap the cleaned words back for what was heard. False when there is nothing to take back. */
  const undo = (): boolean => {
    if (!cleaned) return false;
    const back = restoreRaw(cleaned);
    dismiss();
    onDraftChange(back.text);
    select(back.end);
    return true;
  };

  return { live, landed, note, start, stop, undo, dismiss };
}

/** Dictation through this Mac's own recogniser, where this build has it. */
export function desktopDictation(deps: { clean: DictationPort["clean"]; microphone(): string | null }): DictationPort | null {
  const helper = desktopSpeechHelper();
  if (!helper) return null;
  return { open: (events) => new Dictation({ helper, audio: new WebVoiceAudio(deps.microphone()), events }), clean: deps.clean };
}

/** The RMS a voice close to the microphone reaches: the mic's ring is at its full size here. */
const FULL_RMS = 0.2;

/**
 * The mic ring's size for this frame, 0–1, from the last one and the microphone's RMS: up at once
 * when the voice rises, down over a few frames when it falls, so the ring follows syllables without
 * flickering between them. The square root spreads a speaking voice's range across the ring.
 */
export function nextMicLevel(shown: number, rms: number): number {
  const target = Math.min(1, Math.sqrt(Math.max(0, rms) / FULL_RMS));
  return target >= shown ? target : shown + (target - shown) * 0.25;
}
