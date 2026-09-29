import { LAYA_MODES, type LayaMode, type LayaStatus } from "@realm/contracts";
import { useEffect, useState } from "react";
import { CommandCopy } from "../../components/CommandCopy";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";

/**
 * Laya (local decisions): the local model Realm can ask about every computer step, and the log of
 * what it said (docs/superpowers/specs/2026-09-29-laya-local-decisions.md).
 *
 * Four rows. The first says what the runtime is actually doing and offers the one action that moves
 * it on — Install, or Try again. The second is the request, Off, Shadow or Assist; it is a request
 * because the two can differ (Shadow while the checkpoint loads, Shadow after a start that failed),
 * which is why the first row exists at all. The third is the active checkpoint's evaluation — what
 * Assist is earned by — and the one action that can change it, Train. The fourth is the log.
 *
 * Every state is the server's. Nothing here decides whether an install may start or whether Shadow is
 * allowed; a click that the server would refuse is simply not offered.
 */

const MODE_LABEL: Record<LayaMode, string> = { off: "Off", shadow: "Shadow", assist: "Assist" };

/** The checkpoint's size in MB, for the one step with a real denominator. `LAYA_CHECKPOINT_BYTES`. */
const CHECKPOINT_MB = 846;

export function LayaSection() {
  const laya = useApp((s) => s.laya);
  const loadLaya = useApp((s) => s.loadLaya);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => loadLaya()); }, [run, loadLaya]);
  // Null is "not read yet": a row drawn "Not installed" against an unread status would lie for a frame.
  if (!laya) return <p className="env-empty">Checking…</p>;
  return (
    <>
      <ul className="settings-list laya-section">
        <StateRow laya={laya} />
        <ModeRow laya={laya} />
        <EvaluationRow laya={laya} />
        <LogRow laya={laya} />
      </ul>
      {/* The one sentence the section owes: what the log holds, where, and that it stays. */}
      <p className="settings-hint">
        The log holds the labels of what was on screen at each step. It is kept in {laya.dir || "Realm's folder"} and never leaves this Mac.
      </p>
    </>
  );
}

function StateRow({ laya }: { laya: LayaStatus }) {
  const installLaya = useApp((s) => s.installLaya);
  const loadLaya = useApp((s) => s.loadLaya);
  const setLayaMode = useApp((s) => s.setLayaMode);
  const run = useApp((s) => s.run);
  const r = laya.runtime;
  const name = {
    unavailable: "Not available", "needs-python": "Needs Python", "not-installed": "Not installed", installing: "Installing",
    off: "Installed, not running", starting: "Starting", ready: "Running",
    failed: r.state === "failed" && r.during === "install" ? "Install failed" : "Stopped after failing to start",
  }[r.state];
  return (
    <li className="settings-row laya-state" data-state={r.state} aria-label={`Laya: ${name}`}>
      <div className="settings-row-main">
        <span className="settings-row-name">{name}</span>
        {r.state === "unavailable" && <span className="settings-row-desc">{r.reason}</span>}
        {r.state === "needs-python" && (
          <>
            <span className="settings-row-desc">
              Laya runs under Python 3.10 to 3.14 built for Apple silicon, and Realm found none it can use.
              {r.rejected.length > 0 && ` Turned down: ${r.rejected.map((x) => `${x.path} (${x.why})`).join("; ")}.`}
            </span>
            <CommandCopy command="brew install python@3.13" />
          </>
        )}
        {r.state === "not-installed" && (
          <span className="settings-row-desc">
            Downloads about 1 GB of PyTorch and 0.8 GB of model weights into {laya.dir}, with Python {r.python.version}.
          </span>
        )}
        {r.state === "installing" && (
          <>
            <span className="settings-row-desc laya-facts">
              {r.step === "model" && r.fraction !== null ? `Downloading the checkpoint: ${Math.round(r.fraction * CHECKPOINT_MB)} of ${CHECKPOINT_MB} MB` : r.detail}
            </span>
            {/* Drawn only where a denominator exists. The other steps are a line of text, because an
                empty meter would be a claim about progress nobody measured. */}
            {r.step === "model" && r.fraction !== null && (
              <div className="machine-meter laya-meter" role="progressbar" aria-label="Checkpoint download"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.fraction * 100)}>
                <div className="machine-meter-fill" style={{ width: `${Math.round(r.fraction * 100)}%` }} />
              </div>
            )}
          </>
        )}
        {r.state === "starting" && <span className="settings-row-desc">Loading the checkpoint.</span>}
        {r.state === "ready" && (
          <span className="settings-row-desc laya-facts" title="Where the checkpoint computes (mps is this Mac's GPU; cpu means it fell back), the median round trip of the recent questions, and the checkpoint every logged row names.">
            <code>{r.device}</code> · {r.p50Ms === null ? "no steps asked yet" : `p50 ${r.p50Ms} ms`} · <code>{r.checkpoint}</code>
          </span>
        )}
        {r.state === "failed" && (
          <>
            {/* The process's or the installer's own last line, verbatim — the words that go into a search. */}
            <span className="settings-row-desc laya-reason">{r.reason}</span>
            {r.detail && (
              <details className="laya-output">
                <summary>Output</summary>
                <pre className="cli-job-output">{r.detail}</pre>
              </details>
            )}
          </>
        )}
      </div>
      {r.state === "not-installed" && (
        <button type="button" className="btn primary" onClick={() => run(() => installLaya())}>Install</button>
      )}
      {r.state === "installing" && <Spinner size={14} />}
      {r.state === "failed" && r.during === "install" && (
        <button type="button" className="btn" onClick={() => run(() => installLaya())}>Install again</button>
      )}
      {r.state === "failed" && r.during === "start" && (
        <button type="button" className="btn" onClick={() => run(() => setLayaMode("shadow"))}>Try again</button>
      )}
      {r.state === "needs-python" && (
        <button type="button" className="btn" onClick={() => run(() => loadLaya())}>Check again</button>
      )}
    </li>
  );
}

function ModeRow({ laya }: { laya: LayaStatus }) {
  const setLayaMode = useApp((s) => s.setLayaMode);
  const run = useApp((s) => s.run);
  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Ask Laya about each step</span>
        {/* What the switch does beyond its label, and the fact that decides whether anyone turns it
            on: nothing changes for the agent. */}
        <span className="settings-row-desc">
          Shadow asks it on every computer step and logs the answer beside what the agent did. Nothing it says reaches the agent, a permission card or the transcript.
          Assist also lets an agent name an element in words and uses Laya's pick when it is sure — never for a purchase, a deletion, a message or a password.
        </span>
        {/* Why Assist is locked, where the locked option can be seen: earned by a measurement, never
            chosen, and the sentence says which measurement. */}
        {!laya.assist.available && <span className="settings-row-desc laya-assist-lock">{laya.assist.reason}</span>}
      </div>
      <fieldset className="settings-tabs" aria-label="Laya" disabled={!laya.installed}
        title={laya.installed ? undefined : "Install Laya first."}>
        {LAYA_MODES.map((m) => {
          // Assist stays selectable only while it is already on or the gate is open; the server
          // refuses it otherwise with the same reason shown above.
          const locked = m === "assist" && !laya.assist.available && laya.mode !== "assist";
          return (
            <label key={m} className="settings-tab" data-selected={laya.mode === m || undefined}
              title={locked ? laya.assist.reason ?? undefined : undefined}>
              <input type="radio" name="settings-laya-mode" value={m} checked={laya.mode === m} disabled={locked}
                onChange={() => run(() => setLayaMode(m))} />
              {MODE_LABEL[m]}
            </label>
          );
        })}
      </fieldset>
    </li>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The active checkpoint's held-out evaluation in the three numbers that say what it is good for, and
 * Train. A run replaces the active checkpoint only when it scores better, so the row says afterwards
 * which way it went and why — a run that did not win is a result, not a failure.
 */
function EvaluationRow({ laya }: { laya: LayaStatus }) {
  const trainLaya = useApp((s) => s.trainLaya);
  const cancelLayaTraining = useApp((s) => s.cancelLayaTraining);
  const run = useApp((s) => s.run);
  const e = laya.evaluation ?? null;
  const t = laya.training ?? { state: "idle" as const };
  return (
    <li className="settings-row laya-evaluation" data-training={t.state}>
      <div className="settings-row-main">
        <span className="settings-row-name">Evaluation</span>
        {e ? (
          <span className="settings-row-desc laya-facts" title={`Scored on ${e.benchmark}: iOS screens and steps this checkpoint never trained on, some of them in apps it never saw.`}>
            Picks the right element {pct(e.targetAccuracy)}{e.targetNotCopying !== null && ` (${pct(e.targetNotCopying)} when the words differ from its label)`} · flags {pct(e.sensitiveRecall)} of sensitive steps · judges {pct(e.verifyAccuracy)} of steps right · <code>{e.checkpoint}</code>
          </span>
        ) : (
          <span className="settings-row-desc">The active checkpoint has not been scored.</span>
        )}
        {t.state === "idle" && (
          <span className="settings-row-desc">
            Train makes a new checkpoint on this Mac from the screens Realm ships and your decision log — half an hour to an hour on its GPU, with Laya paused — and keeps it only if it scores better.
          </span>
        )}
        {t.state === "running" && (
          <>
            <span className="settings-row-desc laya-facts">{t.detail}</span>
            {t.fraction !== null && (
              <div className="machine-meter laya-meter" role="progressbar" aria-label="Training"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.fraction * 100)}>
                <div className="machine-meter-fill" style={{ width: `${Math.round(t.fraction * 100)}%` }} />
              </div>
            )}
          </>
        )}
        {t.state === "done" && (
          <span className="settings-row-desc laya-train-result">
            {t.activated ? `Now running ${t.checkpoint}. ` : `Kept the checkpoint Laya was running; ${t.checkpoint} was discarded. `}{t.reason}
          </span>
        )}
        {t.state === "failed" && (
          <>
            <span className="settings-row-desc laya-reason">Training failed: {t.reason}</span>
            {t.detail && (
              <details className="laya-output">
                <summary>Output</summary>
                <pre className="cli-job-output">{t.detail}</pre>
              </details>
            )}
          </>
        )}
        {t.state === "cancelled" && <span className="settings-row-desc">Training stopped. Nothing it made was kept.</span>}
      </div>
      {t.state === "running"
        ? <button type="button" className="btn" onClick={() => run(() => cancelLayaTraining())}>Stop</button>
        : <button type="button" className="btn" disabled={!laya.installed} title={laya.installed ? undefined : "Install Laya first."}
            onClick={() => run(() => trainLaya())}>Train</button>}
    </li>
  );
}

function LogRow({ laya }: { laya: LayaStatus }) {
  const deleteLayaLog = useApp((s) => s.deleteLayaLog);
  const confirmDelete = useApp((s) => s.confirmDelete);
  const run = useApp((s) => s.run);
  // Two steps, the pattern the schedules page and the sidebar use: this is the training set, and a
  // stray click would cost every step logged so far.
  const [confirming, setConfirming] = useState(false);
  const n = laya.stepsLogged;
  const steps = `${n.toLocaleString()} ${n === 1 ? "step" : "steps"}`;
  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Decision log</span>
        <span className="settings-row-desc laya-facts">{n === 0 ? "No steps logged" : `${steps} logged`}</span>
      </div>
      {confirming
        ? <button type="button" className="btn-quiet danger" autoFocus onBlur={() => setConfirming(false)}
            onClick={() => { setConfirming(false); void run(() => deleteLayaLog()); }}>Delete {steps}</button>
        : <button type="button" className="btn-quiet danger" disabled={n === 0}
            onClick={() => (confirmDelete ? setConfirming(true) : run(() => deleteLayaLog()))}>Delete log</button>}
    </li>
  );
}
