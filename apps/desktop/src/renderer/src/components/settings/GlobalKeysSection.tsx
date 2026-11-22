import {
  ASSISTANT_CHORDS, HOLD_KEYS, HOLD_KEY_DEFAULT, HOLD_KEY_LABEL, KEYS_ASSISTANT_DEFAULT, KEYS_ASSISTANT_KEY, KEYS_DOUBLE_TAP_DEFAULT,
  KEYS_DOUBLE_TAP_KEY, KEYS_HOLD_KEY, MEETING_CONSENT_KEY, isHoldKey, meetingConsentAccepted,
  type GlobalKeysState, type HoldKey,
} from "@realm/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";

/** How long a key chip stays lit after a double-tap is seen. A double-tap has no "held" to show. */
const DOUBLE_TAP_LIT_MS = 1200;

/**
 * Settings ▸ Keys ▸ From anywhere: the keys Realm answers while another app is in front.
 *
 * Main owns the helper that sees them and this page only reports it. While the page is up it watches,
 * so "Try it" can show a double-tap and the held key arriving: a keyboard that handles Fn itself
 * sends the Mac nothing, and pressing it here is the only way to find out.
 *
 * The line about Accessibility or Input Monitoring appears only when macOS is holding something
 * back, and its button opens that pane. Realm never raises either prompt itself.
 *
 * `afterDoubleTap` is drawn under the double-tap row, so the quick chat's own rows stay together
 * ahead of the assistant's.
 */
export function GlobalKeysRows({ afterDoubleTap }: { afterDoubleTap?: ReactNode }) {
  const run = useApp((s) => s.run);
  const openTccPane = useApp((s) => s.openTccPane);
  const [doubleTap, setDoubleTap] = useState(KEYS_DOUBLE_TAP_DEFAULT);
  const [hold, setHold] = useState<HoldKey>(HOLD_KEY_DEFAULT);
  const [chords, setChords] = useState(KEYS_ASSISTANT_DEFAULT);
  /** Null until read. Main registers the chords only once the assistant's first-run sheet was accepted. */
  const [consented, setConsented] = useState<boolean | null>(null);
  const [state, setState] = useState<GlobalKeysState | null>(null);
  const [doubleTapSeen, setDoubleTapSeen] = useState(false);
  const [doubleTapLit, setDoubleTapLit] = useState(false);
  const [holdSeen, setHoldSeen] = useState(false);
  const [holdDown, setHoldDown] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      const client = rpc();
      void client.call("settings.get", { key: KEYS_DOUBLE_TAP_KEY }).then((s) => { if (alive && typeof s.value === "boolean") setDoubleTap(s.value); }).catch(() => {});
      void client.call("settings.get", { key: KEYS_HOLD_KEY }).then((s) => { if (alive && isHoldKey(s.value)) setHold(s.value); }).catch(() => {});
      void client.call("settings.get", { key: KEYS_ASSISTANT_KEY }).then((s) => { if (alive && typeof s.value === "boolean") setChords(s.value); }).catch(() => {});
      void client.call("settings.get", { key: MEETING_CONSENT_KEY }).then((s) => { if (alive) setConsented(meetingConsentAccepted(s.value)); }).catch(() => {});
    } catch {
      // No socket in this host: the rows show the defaults, as the shortcuts list shows its loading state.
    }
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const keys = window.realm?.keys;
    if (!keys) return;
    let alive = true;
    let unlight: ReturnType<typeof setTimeout> | undefined;
    const offState = keys.onState(setState);
    const offEvent = keys.onEvent((event) => {
      if (event.t === "hold") { setHoldDown(event.down); setHoldSeen(true); return; }
      setDoubleTapSeen(true);
      setDoubleTapLit(true);
      clearTimeout(unlight);
      unlight = setTimeout(() => setDoubleTapLit(false), DOUBLE_TAP_LIT_MS);
    });
    keys.watch(true);
    void keys.state().then((s) => { if (alive) setState(s); });
    // Back from System Settings: main looks again at what macOS grants.
    const recheck = () => keys.watch(true);
    window.addEventListener("focus", recheck);
    return () => {
      alive = false;
      clearTimeout(unlight);
      window.removeEventListener("focus", recheck);
      keys.watch(false);
      offState();
      offEvent();
    };
  }, []);

  const changeDoubleTap = (on: boolean) => run(async () => {
    setDoubleTap(on);
    await Promise.all([rpc().call("settings.set", { key: KEYS_DOUBLE_TAP_KEY, value: on }), window.realm?.keys?.setDoubleTap(on)]);
  });
  const changeHold = (key: HoldKey) => run(async () => {
    setHold(key);
    setHoldSeen(false);
    setHoldDown(false);
    await Promise.all([rpc().call("settings.set", { key: KEYS_HOLD_KEY, value: key }), window.realm?.keys?.setHold(key)]);
  });

  const changeChords = (on: boolean) => run(async () => {
    setChords(on);
    await Promise.all([rpc().call("settings.set", { key: KEYS_ASSISTANT_KEY, value: on }), window.realm?.keys?.setAssistant(on)]);
  });

  const holdName = HOLD_KEY_LABEL[hold];
  const blind = state === "denied" || state === "needsInputMonitoring" || state === "missing";
  return (
    <>
      <li className="settings-row" data-setting="double-tap-command"
        title="Tap either Command key twice, quickly, in any app. A tap that turns into a shortcut, a click or a scroll does not count.">
        <div className="settings-row-main">
          <span className="settings-row-name">Double-tap Command opens the quick chat</span>
          <span className="settings-row-desc">macOS uses the same keys for Siri when Siri is on. One of the two can be changed.</span>
        </div>
        <input type="checkbox" role="switch" className="switch" aria-label="Double-tap Command opens the quick chat"
          checked={doubleTap} onChange={(e) => changeDoubleTap(e.target.checked)} />
      </li>
      {afterDoubleTap}
      <li className="settings-row" data-setting="assistant-hold-key"
        title="The assistant's shortcuts are this key held with one other key. Some keyboards handle Fn themselves and never send it to the Mac, so pick another if Try it does not see yours.">
        <div className="settings-row-main"><span className="settings-row-name">Hold for assistant shortcuts</span></div>
        <fieldset className="settings-tabs" aria-label="Hold for assistant shortcuts">
          {HOLD_KEYS.map((key) => (
            <label key={key} className="settings-tab" data-selected={hold === key || undefined}>
              <input type="radio" name="settings-assistant-hold-key" value={key} checked={hold === key} onChange={() => changeHold(key)} />
              {HOLD_KEY_LABEL[key]}
            </label>
          ))}
        </fieldset>
      </li>
      <li className="settings-row" data-setting="assistant-chords"
        title="While this is on, each of these keys pressed with the held key goes to the meeting assistant and not to the app in front.">
        <div className="settings-row-main">
          <span className="settings-row-name">Assistant shortcuts</span>
          {chords && consented === false && (
            <span className="settings-row-desc">They start working after your first Start in the meeting assistant.</span>
          )}
        </div>
        <input type="checkbox" role="switch" className="switch" aria-label="Assistant shortcuts"
          checked={chords} onChange={(e) => changeChords(e.target.checked)} />
      </li>
      {chords && ASSISTANT_CHORDS.map(({ key, label }) => (
        <li key={key} className="settings-row" data-setting={`assistant-chord:${key}`}>
          <div className="settings-row-main">
            <span className="settings-row-name">{label}</span>
            <kbd className="settings-chip">{holdName} {key}</kbd>
          </div>
        </li>
      ))}
      {(state === "denied" || state === "listening") && (
        <li className="settings-row" data-setting="keys-access">
          <div className="settings-row-main">
            <span className="settings-row-name">Realm needs Accessibility</span>
            <span className="settings-row-desc">
              {state === "denied"
                ? "Without it Realm cannot see a key pressed in another app, so neither of these works."
                : "Without it an assistant shortcut also types its key into the app in front. Double-tap Command works as it is."}
            </span>
          </div>
          <button type="button" className="btn-quiet" onClick={() => run(() => openTccPane("accessibility"))}>Open System Settings</button>
        </li>
      )}
      {state === "needsInputMonitoring" && (
        <li className="settings-row" data-setting="keys-access">
          <div className="settings-row-main">
            <span className="settings-row-name">Realm needs Input Monitoring</span>
            <span className="settings-row-desc">Without it Realm cannot see Command tapped in another app, so the double-tap does nothing.</span>
          </div>
          <button type="button" className="btn-quiet" onClick={() => run(() => openTccPane("inputMonitoring"))}>Open System Settings</button>
        </li>
      )}
      <li className="settings-row" data-setting="keys-try">
        <div className="settings-row-main">
          <span className="settings-row-name">Try it</span>
          <span className="settings-row-desc">
            {blind ? "Realm is not seeing keys right now." : `Double-tap Command, or hold ${holdName}, and it shows here.`}
          </span>
        </div>
        {!blind && (
          <div className="keys-try" aria-live="polite">
            <span className="keys-try-key" data-lit={doubleTapLit || undefined}>
              <kbd>⌘⌘</kbd>{doubleTapSeen ? "Seen" : "Not seen yet"}
            </span>
            <span className="keys-try-key" data-lit={holdDown || undefined}>
              <kbd>{holdName}</kbd>{holdDown ? "Held" : holdSeen ? "Seen" : "Not seen yet"}
            </span>
          </div>
        )}
      </li>
    </>
  );
}
