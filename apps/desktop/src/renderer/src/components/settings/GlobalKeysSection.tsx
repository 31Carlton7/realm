import {
  HOLD_KEYS, HOLD_KEY_DEFAULT, HOLD_KEY_LABEL, KEYS_DOUBLE_TAP_DEFAULT, KEYS_DOUBLE_TAP_KEY, KEYS_HOLD_KEY, isHoldKey,
  type GlobalKeysState, type HoldKey,
} from "@realm/contracts";
import { useEffect, useState } from "react";
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
 * The line about Accessibility appears only when macOS is holding something back, and its button
 * opens the pane. Realm never raises that prompt itself.
 */
export function GlobalKeysSection() {
  const run = useApp((s) => s.run);
  const openTccPane = useApp((s) => s.openTccPane);
  const [doubleTap, setDoubleTap] = useState(KEYS_DOUBLE_TAP_DEFAULT);
  const [hold, setHold] = useState<HoldKey>(HOLD_KEY_DEFAULT);
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

  const holdName = HOLD_KEY_LABEL[hold];
  const blind = state === "denied" || state === "missing";
  return (
    <div className="field">
      <span>From anywhere</span>
      <ul className="settings-list">
        <li className="settings-row" data-setting="double-tap-command"
          title="Tap either Command key twice, quickly, in any app. A tap that turns into a shortcut, a click or a scroll does not count.">
          <div className="settings-row-main"><span className="settings-row-name">Double-tap Command opens the quick chat</span></div>
          <input type="checkbox" role="switch" className="switch" aria-label="Double-tap Command opens the quick chat"
            checked={doubleTap} onChange={(e) => changeDoubleTap(e.target.checked)} />
        </li>
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
      </ul>
    </div>
  );
}
