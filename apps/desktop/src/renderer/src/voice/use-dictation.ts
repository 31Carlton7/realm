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

/** Words being dictated: where they go, and what has been heard so far. */
export type LiveDictation = { at: number; words: string; cleaning: boolean };

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
export function useDictation({ port, draft, onDraftChange, caret, select }: {
  port: DictationPort | null;
  draft: string;
  onDraftChange(text: string): void;
  /** Where the words go: the caret, never inside a chip. */
  caret(): number;
  /** Put the caret here once the draft has been painted. */
  select(at: number): void;
}) {
  const [live, setLive] = useState<LiveDictation | null>(null);
  const [cleaned, setCleaned] = useState<CleanedRecord | null>(null);
  const [note, setNote] = useState<DictationNote | null>(null);
  const control = useRef<DictationControl | null>(null);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  /** The draft the note was written about. */
  const noted = useRef<string | null>(null);

  useEffect(() => () => control.current?.cancel(), []);
  useEffect(() => {
    if (noted.current !== null && draft !== noted.current) { noted.current = null; setNote(null); setCleaned(null); }
  }, [draft]);

  const show = (next: DictationNote, about: string) => { noted.current = about; setNote(next); };
  const dismiss = () => { noted.current = null; setNote(null); setCleaned(null); };

  const finish = async (at: number, raw: string) => {
    control.current = null;
    if (!raw || !port) { setLive(null); return; }
    setLive({ at, words: raw, cleaning: true });
    const result = await port.clean(raw).catch((): DictationCleanResult => ({ outcome: "failed", text: raw }));
    const placed = placeDictation(draftNow.current, at, result.text);
    setLive(null);
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
    setLive({ at, words: "", cleaning: false });
    const c = port.open({
      partial: (words) => setLive((l) => (l && !l.cleaning ? { ...l, words } : l)),
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

  return { live, note, canUndo: cleaned !== null, start, stop, undo, dismiss };
}

/** Dictation through this Mac's own recogniser, where this build has it. */
export function desktopDictation(deps: { clean: DictationPort["clean"]; microphone(): string | null }): DictationPort | null {
  const helper = desktopSpeechHelper();
  if (!helper) return null;
  return { open: (events) => new Dictation({ helper, audio: new WebVoiceAudio(deps.microphone()), events }), clean: deps.clean };
}
