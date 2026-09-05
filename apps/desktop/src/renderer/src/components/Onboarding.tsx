import { AGENT_META, SELECTABLE_AGENT_KINDS, pickSpaceColor, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { FALLBACK_AGENT, useApp } from "../state/store";
import { agentAvailability, type AgentAvailability } from "../state/agent-availability";
import { grainVars } from "../theme/grain";

/**
 * Status pill text + tone per §3 (fill = 14% color-mix, text at full strength).
 *
 * "Ready" is the tone that gets no fill. Three saturated success pills annotating the three agents you
 * did nothing wrong with drowned the one decision on this screen; colour belongs on the states that
 * need you — signed out, not installed.
 */
function statusOf(a: AgentAvailability, version: string | null): { label: string; tone: "ready" | "warning" | "muted" } {
  if (a.state === "unknown") return { label: "Checking…", tone: "muted" };
  if (a.state === "missing") return { label: "Not installed", tone: "muted" };
  if (a.state === "logged_out") return { label: "Signed out", tone: "warning" };
  return { label: version ? `Ready · ${version}` : "Ready", tone: "ready" };
}

/**
 * First run: no spaces exist, so there is nothing to show and nothing to do. One centered sheet replaces
 * the old bare "Create a space with the + in the sidebar." placeholder and does the three things a first
 * launch actually needs: say what Realm found on this machine, let the user pick the agent new sessions
 * should use, and make the first space.
 *
 * The detected-CLI list and the default-agent pick are ONE control on purpose: they are the same
 * decision. Every kind stays selectable even when its CLI is missing — picking it lands in the prompter's
 * install card, which carries the exact command, rather than in an inert greyed-out row.
 *
 * Keyboard-complete: the name field takes focus on mount, arrows move between agent radios, Enter (or Tab
 * to the button) creates the space. There is no dismiss — with zero spaces there is nothing behind it.
 * It never returns: `Main` renders it only while `booted && spaces.length === 0`.
 */
export function Onboarding() {
  const profiles = useApp((s) => s.profiles);
  const agentProbe = useApp((s) => s.agentProbe);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const probeAgents = useApp((s) => s.probeAgents);
  const createProfile = useApp((s) => s.createProfile);
  const createSpace = useApp((s) => s.createSpace);
  const setDefaultAgent = useApp((s) => s.setDefaultAgent);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const run = useApp((s) => s.run);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<AgentKind | null>(null);

  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);
  useEffect(() => { nameRef.current?.focus(); }, []);

  // Until the user picks: whatever a previous run remembered, else the first agent that actually works,
  // else Claude. The probe arrives after mount, so this is derived, not seeded into state.
  const firstReady = SELECTABLE_AGENT_KINDS.find((k) => agentAvailability(k, agentProbe).state === "ready");
  const agent: AgentKind = picked ?? lastAgentKind ?? firstReady ?? FALLBACK_AGENT;

  const pick = (k: AgentKind) => { setPicked(k); run(() => setDefaultAgent(k)); };

  const submit = () => {
    const n = name.trim(); if (!n) return;
    run(async () => {
      // app.ts seeds a "Personal" profile on first boot; creating one here is belt-and-braces so the
      // very first screen can never be a dead end (the retired sheet's zero-profile failure mode).
      const profileId = profiles[0]?.id ?? (await createProfile("Personal")).id;
      await setDefaultAgent(agent);
      await createSpace({ name: n, icon: "folder", profileId, color: pickSpaceColor(0) });
      // Land in a prompter, not the empty-state placeholder: onboarding's whole promise is that
      // you finish it ready to type.
      await newSessionInstant();
    });
  };

  return (
    <div className="onboarding-stage">
      <section className="sheet onboarding wash" data-grain style={grainVars("onboarding")} aria-labelledby="onboarding-title">
        <div className="sheet-head"><h3 id="onboarding-title">Welcome to Realm</h3></div>
        <div className="sheet-body">
          <p className="muted onboarding-lead">
            Realm drives the agent CLIs already installed on this machine. Pick the one new sessions should
            start with — you can change it on any prompter later.
          </p>
          <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {/* Native radios, not buttons with role="radio": arrow-key movement, one tab stop and the
                checked state all come for free, which is most of "completable with a keyboard alone". */}
            <fieldset className="field cli-field">
              <legend>Default agent</legend>
              {SELECTABLE_AGENT_KINDS.map((k) => {
                const a = agentAvailability(k, agentProbe);
                const version = agentProbe.find((p) => p.kind === k)?.version ?? null;
                const st = statusOf(a, version);
                return (
                  <label key={k} className="cli-row" data-selected={agent === k || undefined}>
                    <input type="radio" name="default-agent" value={k} checked={agent === k} onChange={() => pick(k)} />
                    <Icon name={AGENT_META[k].icon} size={16} colored />
                    <span className="cli-name">{AGENT_META[k].label}</span>
                    <span className="status-pill" data-tone={st.tone}>{st.label}</span>
                  </label>
                );
              })}
            </fieldset>
            <label className="field">
              <span>Name your first space</span>
              <input ref={nameRef} aria-label="Space name" value={name} placeholder="e.g. Versed"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={!name.trim()}>Create space</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
