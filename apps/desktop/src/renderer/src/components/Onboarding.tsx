import { AGENT_META, SELECTABLE_AGENT_KINDS, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_AGENT, folderName, useApp } from "../state/store";
import { agentAvailability, type AgentAvailability } from "../state/agent-availability";
import { grainVars } from "../theme/grain";
import { useFileDrop } from "./use-file-drop";

/**
 * Status pill text + tone per §3 (fill = 14% color-mix, text at full strength).
 *
 * "Ready" is the tone that gets no fill. Three saturated success pills annotating the three agents you
 * did nothing wrong with drowned the one decision on this screen; colour belongs on the states that
 * need you — signed out, not installed.
 */
function statusOf(a: AgentAvailability, version: string | null): { label: string; tone: "ready" | "warning" | "muted" } {
  if (a.state === "unknown") return { label: "", tone: "muted" };
  if (a.state === "missing") return { label: "Not installed", tone: "muted" };
  if (a.state === "logged_out") return { label: "Signed out", tone: "warning" };
  // Being listed already says "found"; the version is the one fact worth the row's right edge.
  return { label: version ?? "Ready", tone: "ready" };
}

/** The name a space takes when the user types none: the folder's, else a plain word. */
export const DEFAULT_SPACE_NAME = "Home";

/**
 * First run: no spaces exist, so there is nothing to show and nothing to do. One centered sheet does
 * the three things a first launch actually needs, in the order they matter: pick the agent new
 * sessions should use, say where the code is, and name the space — then land in a prompter.
 *
 * Nothing here is required. The agent is preselected (a previous run's, else the first that works),
 * the folder is optional, and the name defaults to the folder's or to "Home", so the primary action
 * is live from the first frame and Enter finishes the whole thing. The screen used to open on twelve
 * equal rows of agents with the one required field and its button below the fold; the decision was
 * buried under the inventory.
 *
 * The inventory is still here, folded. Agents the probe FOUND are listed; the ones it did not are
 * behind one disclosure, and stay pickable when shown — picking one lands in the prompter's install
 * card, which carries the exact command, rather than in an inert greyed-out row. Before the probe
 * lands the list is drawn plain with one line saying so, not thirteen "Checking…" pills.
 *
 * The folder is the step the old sheet never asked. A session opened from onboarding ran in the
 * empty folder Realm allocates for the space, and the first thing every user did was go and find
 * the "+" to add the repo they had in mind. Dropping it here, or choosing it, makes it the space's
 * first project and opens the session in it.
 *
 * Keyboard-complete: the name field takes focus on mount, arrows move between agent radios, Enter
 * (or Tab to the button) starts. There is no dismiss — with zero spaces there is nothing behind it.
 * It never returns: `Main` renders it only while `booted && spaces.length === 0`.
 */
export function Onboarding() {
  const agentProbe = useApp((s) => s.agentProbe);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const probeAgents = useApp((s) => s.probeAgents);
  const setDefaultAgent = useApp((s) => s.setDefaultAgent);
  const pickFolder = useApp((s) => s.pickFolder);
  const completeOnboarding = useApp((s) => s.completeOnboarding);
  const run = useApp((s) => s.run);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const probed = agentProbe.length > 0;
  const rows = useMemo(() => SELECTABLE_AGENT_KINDS.map((k) => {
    const a = agentAvailability(k, agentProbe);
    return { kind: k, a, status: statusOf(a, agentProbe.find((p) => p.kind === k)?.version ?? null) };
  }), [agentProbe]);
  // Found first, signed-out next, and the rest folded: the list is sorted by how close each agent is
  // to answering a prompt, which is the only order that puts the likely pick at the top.
  const found = rows.filter((r) => r.a.state === "ready" || r.a.state === "logged_out")
    .sort((x, y) => Number(y.a.state === "ready") - Number(x.a.state === "ready"));
  const missing = rows.filter((r) => r.a.state === "missing");
  // Before the probe answers every row is unknown; show them all, plainly, rather than nothing.
  const listed = !probed || showAll || found.length === 0 ? rows : found;

  // Until the user picks: whatever a previous run remembered, else the first agent that actually works,
  // else Claude. The probe arrives after mount, so this is derived, not seeded into state.
  const firstReady = found.find((r) => r.a.state === "ready")?.kind;
  const agent: AgentKind = picked ?? lastAgentKind ?? firstReady ?? FALLBACK_AGENT;
  const pick = (k: AgentKind) => { setPicked(k); run(() => setDefaultAgent(k)); };

  // A folder dropped from the Finder. Chromium hands a directory over as a File with an empty type;
  // the server refuses anything that is not a directory when the project is linked, so there is no
  // guessing here — the path is shown, and a wrong one fails at the one step that can tell.
  const pathForFile = useApp((s) => s.pathForFile);
  const drop = useFileDrop((files) => {
    const path = files.map((f) => pathForFile(f)).find(Boolean);
    if (path) setFolder(path);
  }, true);
  const choose = () => run(async () => { const p = await pickFolder(); if (p) setFolder(p); });

  const suggested = folder ? folderName(folder) : DEFAULT_SPACE_NAME;
  const submit = () => {
    if (busy) return;
    setBusy(true);
    run(async () => {
      try { await completeOnboarding({ name: name.trim() || suggested, agentKind: agent, folder }); }
      finally { setBusy(false); }
    });
  };

  return (
    <div className="onboarding-stage">
      <section className="sheet onboarding wash" data-grain style={grainVars("onboarding")} aria-labelledby="onboarding-title">
        <form className="onboarding-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="sheet-head"><h3 id="onboarding-title">Welcome to Realm</h3></div>
          <div className="sheet-body onboarding-body">
            <p className="muted onboarding-lead">
              Realm runs the agent CLIs already on this Mac. Everything here can be changed later.
            </p>
            {/* Native radios, not buttons with role="radio": arrow-key movement, one tab stop and the
                checked state all come for free, which is most of "completable with a keyboard alone". */}
            <fieldset className="field cli-field">
              <legend>Agent</legend>
              {!probed && <p className="onboarding-note" aria-live="polite">Checking which agents are installed…</p>}
              {probed && found.length === 0 && (
                <p className="onboarding-note">None of these is installed yet. Pick one and Realm will show the install command.</p>
              )}
              {listed.map(({ kind: k, status: st }) => (
                <label key={k} className="cli-row" data-selected={agent === k || undefined}>
                  <input type="radio" name="default-agent" value={k} checked={agent === k} onChange={() => pick(k)} />
                  <Icon name={AGENT_META[k].icon} size={16} colored />
                  <span className="cli-name">{AGENT_META[k].label}</span>
                  {st.label && <span className="status-pill" data-tone={st.tone}>{st.label}</span>}
                </label>
              ))}
              {probed && found.length > 0 && missing.length > 0 && (
                <button type="button" className="onboarding-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                  <Icon name="chevronDown" size={12} />
                  {showAll ? "Hide the ones not installed" : `${missing.length} more not installed`}
                </button>
              )}
            </fieldset>

            <div className="field">
              <span>Folder <span className="onboarding-optional">optional</span></span>
              {/* The drop target is the whole field, and it says so only while something is over it. */}
              <div className="onboarding-folder" data-dropping={drop.dropping || undefined} {...drop.handlers}>
                {folder ? (
                  <>
                    <Icon name="folder" size={14} />
                    <span className="onboarding-folder-path" title={folder}>{folder}</span>
                    <button type="button" className="icon-btn" aria-label="Remove folder" onClick={() => setFolder(null)}><Icon name="close" size={12} /></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn" onClick={choose}>Choose folder…</button>
                    <span className="onboarding-note">{drop.dropping ? "Drop to use this folder" : "or drop a repo here"}</span>
                  </>
                )}
              </div>
            </div>

            <label className="field">
              <span>Space name</span>
              <input ref={nameRef} aria-label="Space name" value={name} placeholder={suggested}
                onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          {/* The decision, held outside the scroller so it is never below the fold. */}
          <div className="sheet-foot">
            <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>
              {busy ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
