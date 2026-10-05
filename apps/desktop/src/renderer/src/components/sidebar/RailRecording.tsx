import { useApp } from "../../state/store";
import { recordingWhat, screensKept } from "../../panes/simulator/LayaRecord";

/**
 * A recording for Laya under way, at the foot of the rail — and nothing at all otherwise.
 *
 * A recording goes on while its device is out of sight: in another space, behind a page, under a side
 * pane's other tab. The rail is the one strip on screen through all of those, so the way to end it is
 * here as well as under the device, and like the update beside it the control wears the state: a red
 * disc with a stop in it, which is the recording and its Stop in one. It does not pulse. The device's
 * own row does, and one fact told by two moving marks is the sidebar dots' mistake (styles.css).
 */
export function RailRecording() {
  const recording = useApp((s) => s.laya?.recording ?? null);
  const stopLayaRecording = useApp((s) => s.stopLayaRecording);
  const run = useApp((s) => s.run);
  if (!recording) return null;
  const what = recordingWhat(recording);
  return (
    <button type="button" className="rail-btn rail-recording" aria-label={`Stop recording ${what} for Laya`}
      title={`Recording ${what} for Laya on ${recording.device}: ${screensKept(recording.screens)}. Click to stop.`}
      onClick={() => run(() => stopLayaRecording())}>
      <span className="rail-recording-disc" aria-hidden="true"><span className="rail-recording-stop" /></span>
    </button>
  );
}
