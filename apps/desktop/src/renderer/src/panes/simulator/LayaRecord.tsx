import type { LayaRecording } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useState, type ReactNode } from "react";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";

/**
 * Laya learning the app in front from the person using it (`laya/recorder.ts`), under the device.
 *
 * A row of its own under the device, the counterpart of the device's toolbar over it and in the same
 * pill — not a glyph in the pane bar: what it records is the person's own use of the app on the phone
 * in front of them, and a ring among the bar's icons said none of that — one click on it and Realm
 * was recording. The bar is for what the pane does, and it shares its width with the side pane's
 * tabs, which keep it. Here the control can say in words what it does, and a click asks first: the
 * sheet says what is kept, what is not, where it goes and how it ends, and only its Start records
 * anything.
 *
 * While this device records, the row IS the recording: a live mark, what is being kept and how much,
 * and Stop. It stays after the stream has gone — a phone that locked, a stream stopped — because the
 * recording outlives what it reads, and the control that ends it stays where it was started. One
 * recording at a time, so another device's makes this one's Record unavailable, with the reason.
 */
export function LayaRecordRow({ simulatorId }: { simulatorId: string }) {
  const recording = useApp((s) => s.laya?.recording ?? null);
  const stopLayaRecording = useApp((s) => s.stopLayaRecording);
  const run = useApp((s) => s.run);
  const [asking, setAsking] = useState(false);

  if (recording?.simulatorId === simulatorId) {
    const what = recordingWhat(recording);
    return (
      <div className="sim-record">
        <div className="sim-recording" role="group" aria-label={`Recording ${what} for Laya`}>
          <span className="status-dot" data-status="recording" aria-hidden="true" />
          <span className="sim-recording-what">Recording {what} for Laya</span>
          <span className="sim-recording-count">{screensKept(recording.screens)}</span>
          <button type="button" className="btn sim-recording-stop" aria-label={`Stop recording ${what} for Laya`}
            onClick={() => run(() => stopLayaRecording())}>Stop</button>
        </div>
        {/* The device's own words for why nothing is being kept — a locked phone says so. */}
        {recording.lastError && <p className="sim-record-note">Not reading the device: {recording.lastError}</p>}
      </div>
    );
  }
  return (
    <div className="sim-record">
      <button type="button" className="sim-record-start" disabled={recording !== null}
        title={recording
          ? `Laya is already recording ${recording.device}. Stop that first.`
          : "Keep each new screen of the app in front while you use it, for Laya to learn from. Shows what is kept before anything starts."}
        onClick={() => setAsking(true)}>
        <Icon name="record" size={14} />
        Record my use of this app…
      </button>
      {asking && <LayaRecordSheet simulatorId={simulatorId} onClose={() => setAsking(false)} />}
    </div>
  );
}

/** What a recording is keeping, by the name each app calls itself. */
export const recordingWhat = (r: LayaRecording): string => r.apps.join(", ") || "the app in front";
export const screensKept = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "screen" : "screens"} kept`;

/** Where the recorder keeps what it reads: `<REALM_HOME>/laya/recordings` (server `app.ts`). */
const recordingsDir = (): string | null => (window.realm?.home ? `${window.realm.home}/laya/recordings` : null);

/**
 * What a recording keeps and what it leaves out, said before it starts.
 *
 * Every line is what `laya/recorder.ts` does, and if that changes, this changes with it: each screen
 * is the elements of its accessibility tree — a role, a name clipped at 60 characters, a frame, a
 * switch's on or off — read every 1.2 s or so and kept only when it is less than 85% like one already
 * kept; no field's contents and no read-only text past 60 characters; only the app named at the
 * start; 2,000 screens and it ends itself; nothing tapped. A screen is a few kilobytes (the benchmark's
 * screens, in the recorder's own form, measure about 2 KB). Saying less than that would be asking for
 * consent to something unnamed; saying more would be a claim the recorder does not keep.
 *
 * Start is the only control here that records. A refusal stays in the sheet, in the server's own
 * words, because the commonest one — the home screen is in front — is fixed on the device and then
 * answered by pressing Start again, which a toast across the window would have closed the sheet on.
 */
export function LayaRecordSheet({ simulatorId, onClose }: { simulatorId: string; onClose: () => void }) {
  const recordLaya = useApp((s) => s.recordLaya);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const dir = recordingsDir();

  const start = async () => {
    setStarting(true);
    setRefused(null);
    try {
      // No app named: the server keeps the one in front as it starts, and only that one — which is
      // what makes it work for an App Store app on a phone, whose app list names only what Xcode
      // installed.
      await recordLaya(simulatorId, []);
      onClose();
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <Sheet title="Record your use of this app" onClose={onClose} width={500}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={starting} onClick={() => void start()}>
          {starting ? <><Spinner size={14} /> Starting…</> : "Start recording"}
        </button>
      </>}>
      <p className="sheet-lede">
        While you use the app in front on this device, Realm reads each new screen it shows and keeps a description of it on this Mac, for Laya to learn from. Realm taps nothing: every tap is yours.
      </p>
      <ul className="laya-record-facts">
        <Fact icon="layout" title="What is kept">
          What each thing on the screen is — a button, a heading, a switch and whether it is on — what it is called and where it sits, as the app describes them to VoiceOver. Realm looks about once a second and keeps a screen only when it is new.
        </Fact>
        <Fact icon="shield" title="What is left out">
          Pictures of the screen, your taps and keystrokes, anything typed into a field, and every app but the one in front when you start. A caption, comment or message over 60 characters is dropped and any other name is cut there; shorter text is kept as it reads, so names and short messages on a screen are kept too.
        </Fact>
        <Fact icon="folder" title="Where it goes">
          {dir ? <code>{dir}</code> : "Realm's folder"}, on this Mac. Nothing is uploaded. A screen takes a few kilobytes, and a recording stops itself at 2,000 screens.
        </Fact>
        <Fact icon="cpu" title="What it is for">
          Train, in Settings ▸ Laya, makes a new checkpoint on this Mac from your recordings, the screens Realm ships and your decision log, and keeps it only if it scores better.
        </Fact>
        <Fact icon="stop" title="How it ends">
          Stop, under the device or at the foot of the rail, whenever you like. Delete recordings in Settings ▸ Laya removes everything it kept.
        </Fact>
      </ul>
      {refused && <p className="laya-record-refused" role="alert">{refused}</p>}
    </Sheet>
  );
}

function Fact({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="laya-record-fact">
      <Icon name={icon} size={16} />
      <div>
        <span className="laya-record-fact-title">{title}</span>
        <p className="laya-record-fact-body">{children}</p>
      </div>
    </li>
  );
}
