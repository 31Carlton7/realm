import { useEffect, useState } from "react";
import type { Lecture } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";

/**
 * Start a lecture (Plan 22 W3). One field — the topic — because everything else is derived: the
 * course is the space, the date is today, the file name follows from both. Enter starts it.
 */
export function NewLectureSheet() {
  const closeSheet = useApp((s) => s.closeSheet);
  const startLecture = useApp((s) => s.startLecture);
  const run = useApp((s) => s.run);
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (busy) return;
    setBusy(true);
    run(async () => {
      try { await startLecture(title); closeSheet(); } finally { setBusy(false); }
    });
  };
  return (
    <Sheet title="New lecture" onClose={closeSheet} width={440}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="sheet-lede">
          A dated notes file under <code>lectures/</code> in {space ? <strong>{space.name}</strong> : "this space"}, open beside a
          session you can ask things during class. Wrap it up afterwards from the palette.
        </p>
        <label className="field">
          <span>Topic (optional)</span>
          <input value={title} placeholder="Pipelining hazards" aria-label="Lecture topic"
            onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Starting…" : "Start lecture"}</button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * Wrap a lecture up: pick which of this space's lecture files, and a fresh session gets the
 * wrap-up prompt (see `lectureWrapUpPrompt`). Newest first, transcripts marked — the one you just
 * imported from Plynn is almost always the one you mean.
 */
export function WrapUpLectureSheet() {
  const closeSheet = useApp((s) => s.closeSheet);
  const listLectures = useApp((s) => s.listLectures);
  const wrapUpLecture = useApp((s) => s.wrapUpLecture);
  const run = useApp((s) => s.run);
  const [lectures, setLectures] = useState<Lecture[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listLectures().then((l) => { if (!cancelled) setLectures(l); }).catch(() => { if (!cancelled) setLectures([]); });
    return () => { cancelled = true; };
  }, [listLectures]);
  const pick = (l: Lecture) => {
    if (busy) return;
    setBusy(l.path);
    run(async () => {
      try { await wrapUpLecture(l); closeSheet(); } finally { setBusy(null); }
    });
  };
  return (
    <Sheet title="Wrap up a lecture" onClose={closeSheet} width={520}>
      <div className="form">
        <p className="sheet-lede">
          A new session reads the notes (and the transcript, if there is one), cleans them up, answers your questions,
          adds flashcards, and builds or extends the study guide.
        </p>
        {lectures === null && <p className="muted">Looking for lectures…</p>}
        {lectures !== null && lectures.length === 0 && (
          <p className="muted">No lecture files yet. Start one with “New lecture”, or import a recording from Plynn.</p>
        )}
        {lectures !== null && lectures.length > 0 && (
          <ul className="lecture-list" aria-label="Lectures">
            {lectures.map((l) => (
              <li key={l.path}>
                <button type="button" className="lecture-row" disabled={busy !== null} onClick={() => pick(l)}>
                  <Icon name={l.hasTranscript ? "mic" : "documents"} size={14} />
                  <span className="lecture-title">{l.title}</span>
                  <span className="lecture-meta muted">{l.date ?? "undated"}{l.hasTranscript ? " · transcript" : ""}</span>
                  <span className="lecture-action">{busy === l.path ? "Starting…" : "Wrap up"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>Close</button>
        </div>
      </div>
    </Sheet>
  );
}
