import type { PairRequest, PairedPhone, PairingWindow } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useApp, useAppStore } from "../../state/store";
import { clockLabel, phoneDetail, phoneModelName, qrCode } from "./devices";

/** Re-renders every `ms`, for a label that counts — the code's time left, a phone's "Last seen". */
function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Settings ▸ Devices (Plan 28): the iPhones paired with this Mac, and the one action that adds one.
 *
 * Pair an iPhone opens a window at the relay and a sheet with its QR code. A phone that scans it and
 * proves it holds the code's secret is a REQUEST, held in the store until the owner answers it. The
 * sheet asks it in place of the code; put away unanswered, it is asked again from a row here instead,
 * because a dismissal is never an answer — and a cancelled window would answer it, so putting the
 * question away leaves the window open too. Closing the sheet at any other time closes the window.
 *
 * The relay's state is said only when it changes what a phone can do (offline, locked), and nothing at
 * all when the link is up or has no reason to be.
 */
export function DevicesPanel({ onOpenSetting }: { onOpenSetting: (id: string) => void }) {
  const remote = useApp((s) => s.remote);
  const remoteError = useApp((s) => s.remoteError);
  const request = useApp((s) => s.pairRequest);
  const refreshRemote = useApp((s) => s.refreshRemote);
  const startPairing = useApp((s) => s.startPairing);
  const answerPairRequest = useApp((s) => s.answerPairRequest);
  const run = useApp((s) => s.run);
  const store = useAppStore();
  /** The window this page opened, for as long as its sheet is up. */
  const [shown, setShown] = useState<PairingWindow | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [starting, setStarting] = useState(false);
  /** Which answer is on its way to the server, so neither can be given twice. */
  const [answering, setAnswering] = useState<boolean | null>(null);
  const [removing, setRemoving] = useState<PairedPhone | null>(null);
  // Stable, like `closeSheet`: a sheet re-takes focus whenever its close changes, and this page
  // re-renders on every clock tick and every status broadcast.
  const keepPhone = useCallback(() => setRemoving(null), []);
  const now = useClock(30_000);

  /* Close a window this page opened — unless a phone is waiting on its answer, which a closed window
     would decline, or it is no longer the open one: `remote.pair.cancel` closes whichever window is
     open, and one another Realm window has opened since is not this page's to close. */
  const endWindow = useCallback((windowId: string) => {
    const st = store.getState();
    if (st.pairRequest?.windowId === windowId) return;
    if (st.remote !== null && st.remote.pairing?.windowId !== windowId) return;
    st.run(() => st.cancelPairing());
  }, [store]);
  const closeSheet = useCallback(() => {
    const w = shownRef.current;
    setShown(null);
    if (w) endWindow(w.windowId);
  }, [endWindow]);
  // Leaving the page with the sheet up is closing it.
  useEffect(() => () => { const w = shownRef.current; if (w) endWindow(w.windowId); }, [endWindow]);

  const pair = () => run(async () => {
    setStarting(true);
    try { setShown(await startPairing()); } finally { setStarting(false); }
  });
  const answer = (req: PairRequest, accept: boolean) => run(async () => {
    setAnswering(accept);
    try { await answerPairRequest(req.requestId, accept); } finally { setAnswering(null); }
    // Answered either way, the code has done its job: the sheet goes, and the window with it.
    if (shownRef.current?.windowId === req.windowId) setShown(null);
    endWindow(req.windowId);
  });

  if (remote === null) {
    return (
      <div className="form">
        {remoteError === null ? <p className="env-empty">Loading…</p> : (
          <p className="env-empty">
            Realm Mobile's status could not be read: {remoteError}{" "}
            <button type="button" className="settings-link" onClick={() => void refreshRemote()}>Try again</button>
          </p>
        )}
      </div>
    );
  }

  const phones = remote.phones;
  const many = phones.length > 1;
  // The sheet asks a request for its own window; any other held request is asked here, in a row.
  const asked = request !== null && shown?.windowId === request.windowId ? request : null;
  const waiting = request !== null && asked === null ? request : null;

  return (
    <div className="form">
      {remote.state === "offline" && (
        <p className="settings-hint settings-alert" role="alert">
          {phones.length === 0 ? "Can't reach the relay, so a phone can't pair yet."
            : many ? "Can't reach the relay. Your phones show this Mac as offline."
            : "Can't reach the relay. Your phone shows this Mac as offline."}
        </p>
      )}
      {remote.state === "locked" && (
        <p className="settings-hint settings-alert" role="alert">
          Realm Mobile unlocks once Realm's window has been open since the agent server started.
          {phones.length > 0 && (many ? " Until then, your phones show this Mac as offline." : " Until then, your phone shows this Mac as offline.")}
        </p>
      )}
      <div className="devices-head" data-setting="pair-iphone">
        {/* Locked, the server has no key to open a window with: the line above says why. While a phone
            waits on its answer the question is the page's decision, so this steps down to a plain
            button — still there, because a new code is also how a question nobody wants is let go. */}
        <button type="button" className={waiting ? "btn" : "btn primary"} disabled={starting || remote.state === "locked"} onClick={pair}>
          {starting && <Spinner size={12} />}
          {starting ? "Making a code…" : "Pair an iPhone"}
        </button>
      </div>
      <ul className="settings-list" aria-label="Paired iPhones">
        {waiting && (
          <li className="settings-row device-row" aria-label={`${waiting.name} is waiting to pair`}>
            <span className="device-mark" aria-hidden="true"><Icon name="simulator" size={16} /></span>
            <div className="settings-row-main">
              <span className="settings-row-name">Pair {waiting.name}?</span>
              <span className="settings-row-desc">{phoneModelName(waiting.model)} · It can read every session on this Mac and answer for you.</span>
            </div>
            <div className="device-actions">
              <button type="button" className="btn" disabled={answering !== null} onClick={() => answer(waiting, false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={answering !== null} onClick={() => answer(waiting, true)}>Pair</button>
            </div>
          </li>
        )}
        {phones.map((p) => (
          <li key={p.phoneId} className="settings-row device-row">
            <span className="device-mark" aria-hidden="true"><Icon name="simulator" size={16} /></span>
            <div className="settings-row-main">
              <span className="settings-row-name">{p.name}</span>
              <span className="settings-row-desc">{phoneDetail(p, now)}</span>
            </div>
            <button type="button" className="btn-quiet" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p)}>Remove</button>
          </li>
        ))}
        {/* The card it will fill, holding the one thing to know before filling it. */}
        {phones.length === 0 && waiting === null && (
          <li className="settings-row device-row device-empty">
            <span className="device-mark" aria-hidden="true"><Icon name="simulator" size={16} /></span>
            <div className="settings-row-main">
              <span className="settings-row-name">No iPhone paired yet.</span>
              <span className="settings-row-desc">A paired iPhone can read every session on this Mac and answer for you.</span>
            </div>
          </li>
        )}
      </ul>
      {/* The limit nothing else on the page states, with the one setting that moves it. */}
      <p className="settings-hint">
        {many ? "While this Mac sleeps, your phones can't reach it." : "While this Mac sleeps, your phone can't reach it."}{" "}
        <button type="button" className="settings-link" onClick={() => onOpenSetting("prevent-sleep")}>Keep the Mac awake while agents work</button>
      </p>

      {shown && (
        <PairSheet pairing={shown} request={asked} live={remote.pairing?.windowId === shown.windowId}
          offline={remote.state === "offline"} starting={starting} answering={answering}
          onClose={closeSheet} onRestart={pair} onAnswer={(accept) => { if (asked) answer(asked, accept); }} />
      )}
      {removing && <RemovePhoneSheet phone={removing} onClose={keepPhone} />}
    </div>
  );
}

/** One width for the page's sheets, so the code and the question it turns into are the same sheet. */
const SHEET_WIDTH = 440;

/** The side the code is drawn at, in CSS pixels, before it is snapped to whole pixels per module. */
const CODE_PX = 264;

/** A code's drawn side: a whole number of pixels per module, so every module is the same size. */
function codePixels(size: number): number {
  return size * Math.max(2, Math.round(CODE_PX / size));
}

/**
 * The pairing link as a QR code, dark modules on white with the quiet zone round them, in both faces:
 * a code drawn light on dark is one that not every scanner reads.
 */
function PairingCode({ code }: { code: { size: number; path: string } }) {
  const px = codePixels(code.size);
  return (
    <svg className="pairing-code" role="img" aria-label="Pairing code" width={px} height={px}
      viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges">
      <rect width={code.size} height={code.size} fill="#ffffff" />
      <path d={code.path} fill="#000000" />
    </svg>
  );
}

/**
 * The pairing sheet: the code and its time left, then — once a phone has scanned it — the question,
 * in the same sheet rather than a second one over it. Two sheets both answer Escape in the order they
 * mounted, so the code's sheet would close under the question and take the window with it.
 *
 * The decision sits in the foot, out of the body the sheet focuses into: a question that arrives under
 * the keyboard must not be answered by a Return meant for something else.
 */
function PairSheet({ pairing, request, live, offline, starting, answering, onClose, onRestart, onAnswer }: {
  pairing: PairingWindow; request: PairRequest | null;
  /** The relay still has this window open — not closed, expired or replaced by another code. */
  live: boolean;
  offline: boolean; starting: boolean; answering: boolean | null;
  onClose: () => void; onRestart: () => void; onAnswer: (accept: boolean) => void;
}) {
  const now = useClock(1000);
  const left = pairing.expiresAt - now;
  const usable = live && left > 0;
  const code = useMemo(() => qrCode(pairing.url), [pairing.url]);

  if (request) {
    return (
      <Sheet title={`Pair ${request.name}?`} onClose={onClose} width={SHEET_WIDTH}
        footer={<>
          <button type="button" className="btn" disabled={answering !== null} onClick={() => onAnswer(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={answering !== null} onClick={() => onAnswer(true)}>
            {answering === true && <Spinner size={12} />}
            {answering === true ? "Pairing…" : "Pair"}
          </button>
        </>}>
        <div className="pair-device">
          <Icon name="simulator" size={16} />
          <span>{phoneModelName(request.model)}</span>
        </div>
        <p className="device-consequence">It can read every session on this Mac and answer for you.</p>
      </Sheet>
    );
  }

  return (
    <Sheet title="Pair an iPhone" onClose={onClose} width={SHEET_WIDTH}>
      {/* A code that has run out leaves its footprint and its two lines' room, emptied rather than
          taken away: the sheet holds still, and the new code lands where the button that asked for it
          was. "Scan this" under no code would be a sentence about nothing, so the lines go blank. */}
      <div className="pair-scan" data-gone={usable ? undefined : ""}>
        {usable ? <PairingCode code={code} /> : (
          <div className="pair-code-gone" style={{ width: codePixels(code.size), height: codePixels(code.size) }}>
            <p>{left <= 0 ? "This code has expired." : "This code no longer works."}</p>
            <button type="button" className="btn" disabled={starting} onClick={onRestart}>
              {starting && <Spinner size={12} />}
              {starting ? "Making a code…" : "Show a new code"}
            </button>
          </div>
        )}
        <p className="pair-instruction">Open Realm on your iPhone and scan this.</p>
        <p className="pair-expiry">Expires in {clockLabel(left)}</p>
        {usable && offline && <p className="settings-hint" data-tone="warn">Can't reach the relay, so your iPhone can't use this code yet.</p>}
      </div>
    </Sheet>
  );
}

/** Remove, asked first and named: the phone loses this Mac until it is paired again with a new code. */
function RemovePhoneSheet({ phone, onClose }: { phone: PairedPhone; onClose: () => void }) {
  const removePhone = useApp((s) => s.removePhone);
  const run = useApp((s) => s.run);
  const [busy, setBusy] = useState(false);
  const remove = () => run(async () => {
    setBusy(true);
    try { await removePhone(phone.phoneId); onClose(); } finally { setBusy(false); }
  });
  return (
    <Sheet title={`Remove ${phone.name}?`} onClose={onClose} width={SHEET_WIDTH}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Keep it</button>
        <button type="button" className="btn destructive" disabled={busy} onClick={remove}>Remove</button>
      </>}>
      <p className="device-consequence">It will no longer see or answer sessions on this Mac.</p>
    </Sheet>
  );
}
