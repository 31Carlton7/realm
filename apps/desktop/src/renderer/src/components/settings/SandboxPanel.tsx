import {
  EXECUTION_SANDBOX_COPY, EXECUTION_SANDBOX_SECTION_COPY, ExecutionSandboxPostureSchema,
  type ExecutionSandboxPosture, type SandboxState,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store";

/**
 * A space's execution sandbox: the macOS Seatbelt policy its agents and terminals are spawned under.
 *
 * The panel exists because the feature is otherwise unreachable — the posture lives in the settings
 * KV and ships as `off`, so without a surface it is a security feature nobody can turn on. That also
 * sets what this page owes the reader, and it is more than a switch:
 *
 *  1. **What a posture actually permits, checkably.** `policy.writableRoots` is the only statement of
 *     that which can be verified against the machine, so it is shown rather than summarised away. A
 *     sandbox a person has to take on faith is one they will turn off the first time a build fails.
 *  2. **Where the setting came from.** A space either overrides the default or inherits it, and those
 *     look identical unless the page says so — hence the inherited row and its clear-to-inherit
 *     control, rather than a picker that silently writes an override the moment it is touched.
 *  3. **The two things that will otherwise be discovered as a broken session**: Seatbelt being
 *     unavailable, and Codex refusing to start under any posture but `off`. Both are stated up front,
 *     in Realm's own words, because the alternative is a person debugging a session that will not
 *     start against a page that told them everything was fine.
 *
 * Deliberately not here: the machine-wide default. `sandbox.setDefaults` exists, but a control that
 * changes every space belongs beside the other app-wide settings, not on one space's page where it
 * would read as local. Until that lands, the default is `off` and this page can only override it —
 * which is the safe direction, and the page says which it is doing.
 */
export function SandboxPanel({ spaceId }: { spaceId: string }) {
  const getSandbox = useApp((s) => s.getSandbox);
  const setSandbox = useApp((s) => s.setSandbox);
  const run = useApp((s) => s.run);
  const [state, setState] = useState<SandboxState | null>(null);

  useEffect(() => {
    let live = true;
    /* Fetched here rather than held in the store: nothing outside this page reads it, and a slice
       would have to be kept in step with a policy the server recomputes from the machine's own
       layout on every read. */
    run(async () => { const s = await getSandbox(spaceId); if (live) setState(s); });
    return () => { live = false; };
  }, [spaceId, getSandbox, run]);

  const write = (prefs: SandboxState["prefs"] | null) =>
    run(async () => { setState(await setSandbox(spaceId, prefs)); });

  if (!state) return <div className="form settings-panel"><p className="muted">Loading…</p></div>;
  const { prefs, inherited, policy, available, unavailableReason } = state;

  return (
    <div className="form settings-panel">
      <h3>{EXECUTION_SANDBOX_SECTION_COPY.label}</h3>
      <p className="muted">{EXECUTION_SANDBOX_SECTION_COPY.detail}</p>

      {/* Availability first: with Seatbelt missing, two of the three choices below refuse to start a
          session, and a picker that offered them without saying so would be lying by omission. */}
      {!available && (
        <p className="settings-note danger" role="alert">
          <Icon name="alert" size={14} /> {unavailableReason}
        </p>
      )}

      <div className="field"><span>Posture</span>
        <div className="sandbox-choice" role="radiogroup" aria-label="Sandbox posture">
          {ExecutionSandboxPostureSchema.options.map((posture: ExecutionSandboxPosture) => (
            <label key={posture} className="sandbox-posture" data-selected={prefs.posture === posture || undefined}>
              <input
                type="radio" name={`sandbox-${spaceId}`} value={posture}
                checked={prefs.posture === posture}
                /* Every posture stays selectable when Seatbelt is missing — including the ones that
                   will refuse. Disabling them would hide the choice behind a state whose reason the
                   user cannot see; the alert above says what happens if they pick one. */
                onChange={() => write({ ...prefs, posture })}
              />
              <span className="sandbox-posture-name">{EXECUTION_SANDBOX_COPY[posture].label}</span>
              <span className="sandbox-posture-detail">{EXECUTION_SANDBOX_COPY[posture].detail}</span>
            </label>
          ))}
        </div>
      </div>

      {prefs.posture !== "off" && (
        <div className="field"><span>Network</span>
          <label className="checkbox">
            <input type="checkbox" checked={prefs.network} onChange={(e) => write({ ...prefs, network: e.target.checked })} />
            Allow network access
          </label>
          <p className="muted">
            Off blocks every socket, which most agent CLIs cannot run without — they reach their own API over it.
          </p>
        </div>
      )}

      {/* The claim, in the only form that can be checked against the machine. */}
      {prefs.posture !== "off" && policy.writableRoots.length > 0 && (
        <details className="sandbox-roots">
          <summary>Writable roots ({policy.writableRoots.length})</summary>
          <ul>{policy.writableRoots.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        </details>
      )}

      <p className="settings-note">
        {inherited
          ? <>Inherited from the default. {EXECUTION_SANDBOX_SECTION_COPY.defaultNote}</>
          : <>
              Set for this space.{" "}
              <button type="button" className="btn-quiet" onClick={() => write(null)}>Use the default instead</button>
            </>}
      </p>

      {/* Beside the switch, not in a release note: the alternative is meeting it as a session that
          will not start. Shown only when it applies to what is selected. */}
      {prefs.posture !== "off" && (
        <p className="settings-note"><Icon name="alert" size={14} /> {EXECUTION_SANDBOX_SECTION_COPY.codexNote}</p>
      )}
      <p className="muted settings-note">{EXECUTION_SANDBOX_SECTION_COPY.deprecationNote}</p>
    </div>
  );
}
