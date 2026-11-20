import {
  QUICK_CHAT_HIDE_FROM_SHARING_KEY, QUICK_CHAT_SHORTCUT_KEY, acceleratorForChord, chordFromEvent, displayKeyChord,
  type QuickChatShortcutState,
} from "@realm/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";

/**
 * The quick chat panel's two settings: the key that opens it from any app, and whether it is left
 * out of screen shares (main/quick-chat-panel.ts).
 *
 * The key is recorded here rather than written in keybindings.json, because main registers it with
 * the system and the answer can be no. What the system did with it is asked of main, never assumed
 * from the stored chord: a chord that was refused is drawn with the sentence that says so.
 */
export function QuickChatPanelSettings() {
  const run = useApp((s) => s.run);
  const panel = window.realm?.quickChatPanel;
  const [shortcut, setShortcut] = useState<QuickChatShortcutState | null>(null);
  const [hidden, setHidden] = useState(true);
  const [recording, setRecording] = useState(false);
  /** A press that cannot be a system-wide key, said under the recorder until the next press. */
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void panel?.shortcut().then((s) => { if (alive) setShortcut(s); }).catch(() => {});
    void rpc().call("settings.get", { key: QUICK_CHAT_HIDE_FROM_SHARING_KEY })
      .then(({ value }) => { if (alive) setHidden(value !== false); }).catch(() => {});
    return () => { alive = false; };
  }, [panel]);

  /** Register first, then keep: the stored chord is what main registers on the next launch. */
  const record = (chord: string | null) => run(async () => {
    if (!panel) return;
    setShortcut(await panel.setShortcut(chord));
    await rpc().call("settings.set", { key: QUICK_CHAT_SHORTCUT_KEY, value: chord ?? "" });
  });

  const onRecorderKey = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setRecording(false); setRefused(null); return; }
    const chord = chordFromEvent(e.nativeEvent, window.realm?.platform);
    if (chord === null) return; // a modifier on its own: the chord is still being pressed
    if (chord === "backspace" || chord === "delete") { setRecording(false); setRefused(null); record(null); return; }
    if (acceleratorForChord(chord, window.realm?.platform) === null) { setRefused(displayKeyChord(chord)); return; }
    setRecording(false);
    setRefused(null);
    record(chord);
  };

  const toggleHidden = (on: boolean) => run(async () => {
    setHidden(on);
    panel?.setHideFromSharing(on);
    await rpc().call("settings.set", { key: QUICK_CHAT_HIDE_FROM_SHARING_KEY, value: on });
  });

  const chord = shortcut?.chord ?? null;
  return (
    <div className="field">
      <span>Quick chat</span>
      <ul className="settings-list">
        <li className="settings-row" data-setting="quick-chat-shortcut"
          title="Works while another app is in front, and with no Realm window open. Press it again, or Escape, to put the quick chat away.">
          <div className="settings-row-main">
            <span className="settings-row-name">Open the quick chat from any app</span>
            {recording
              ? <span className="settings-row-detail">{refused ? `${refused} needs ⌘, ⌃ or ⌥ with it. ` : ""}Press the shortcut. Delete clears it, Escape cancels.</span>
              : chord !== null && shortcut?.registered === false
                ? <span className="settings-row-detail" role="alert">macOS did not give Realm {displayKeyChord(chord)}, so it opens nothing. Another app may hold it. Record a different one.</span>
                : chord === null && shortcut !== null
                  ? <span className="settings-row-detail">No shortcut</span>
                  : null}
          </div>
          <button type="button" className="btn btn-quiet" aria-label="Quick chat shortcut" aria-pressed={recording}
            disabled={!panel || shortcut === null}
            onClick={() => { setRecording((r) => !r); setRefused(null); }} onKeyDown={onRecorderKey} onBlur={() => { setRecording(false); setRefused(null); }}>
            {recording ? "Recording…" : chord === null ? "Record shortcut" : <kbd className="settings-chip">{displayKeyChord(chord)}</kbd>}
          </button>
        </li>
        <li className="settings-row" data-setting="quick-chat-hide"
          title="macOS leaves a window marked this way out of what it captures. Measured on macOS 27 for screenshots and for screen capture through ScreenCaptureKit. The window is still listed, without a name, to an app that captures the screen. A share seen from the other side of a meeting was not checked.">
          <div className="settings-row-main">
            <span className="settings-row-name">Hide the quick chat from screen sharing</span>
            <span className="settings-row-detail">Left out of screenshots, recordings and shares that macOS captures. Check your meeting app before you rely on it</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Hide the quick chat from screen sharing"
            checked={hidden} onChange={(e) => toggleHidden(e.target.checked)} />
        </li>
      </ul>
    </div>
  );
}
