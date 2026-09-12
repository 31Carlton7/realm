import { AGENT_META, SELECTABLE_AGENT_KINDS, SPACE_COLORS, pickSpaceColor, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_AGENT, folderName, useApp } from "../state/store";
import { agentAvailability, type AgentAvailability } from "../state/agent-availability";
import { Spinner } from "./Spinner";
import { useFileDrop } from "./use-file-drop";
import { IconPicker } from "./IconPicker";

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
/** What the space wears until the user says otherwise. These used to be written into `createSpace`
 *  at the call site, which meant the first screen decided a space's identity and never showed it. */
export const DEFAULT_SPACE_ICON = "folder";
export const DEFAULT_SPACE_COLOR = pickSpaceColor(0);

/**
 * First run: no spaces exist, so there is nothing to show and nothing to do. One centered sheet does
 * what a first launch actually needs, and does it in two columns, because two different things are
 * being decided and they are not the same kind of thing:
 *
 *   - **Left, the agent.** An inventory to scan: which of the CLIs on this Mac should answer.
 *   - **Right, the space.** A short form to fill: its name, where its code is, and what it looks
 *     like in the sidebar.
 *
 * Stacked, those two ran into each other. The one field anybody types sat below a dozen radios with
 * the folder step wedged between, so the screen read as a list of agents that happened to have a
 * form at the bottom. Side by side each half is scannable on its own and the whole thing fits above
 * the fold.
 *
 * Nothing here is required. The agent is preselected (a previous run's, else the first that works),
 * the folder is optional, the name defaults to the folder's or to "Home", and the icon and colour
 * have defaults — so the primary action is live from the first frame and Enter finishes the whole
 * thing.
 *
 * The icon and the colour are here because the space was getting them anyway. `completeOnboarding`
 * used to write a folder glyph and the first palette colour into `createSpace` at the call site: the
 * first screen was already deciding a space's identity, it just never showed anyone what it picked.
 * They use the same picker and the same swatches the space's own settings do, so the control someone
 * meets on their first screen is the control they meet again.
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
 * Keyboard-complete: the name field takes focus on mount, arrows move between agent radios and
 * between colour swatches, Enter (or Tab to the button) starts. Focus lands in the RIGHT column
 * although the left one comes first in the source, and that is deliberate — reading order is left to
 * right, but the agent already has an answer and the name is the only thing anyone has to type.
 * There is no dismiss — with zero spaces there is nothing behind it. It never returns: `Main`
 * renders it only while `booted && spaces.length === 0`.
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
  const [icon, setIcon] = useState(DEFAULT_SPACE_ICON);
  const [color, setColor] = useState<string>(DEFAULT_SPACE_COLOR);
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
  /* The picker's upload tab files an image under a profile. The server seeds "Personal" on first
     boot, so there is one here before this sheet ever renders; the fallback keeps the BUILT-IN icons
     working on the one path where there is not, rather than refusing to draw the control. */
  const profileId = useApp((s) => s.profiles[0]?.id ?? "");
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
      try {
        await completeOnboarding({ name: name.trim() || suggested, agentKind: agent, folder, icon, color });
      } finally { setBusy(false); }
    });
  };

  return (
    <div className="onboarding-stage">
      {/* Plain. The card wore the decorative wash — an accent field anchored in its top band, with a
          drifting grain over it — and it was the last surface in the app still wearing one: Settings
          lost it because a tint over a form reads as bleed into the controls, Notifications because a
          decorated ground under things asking for your attention competes with the attention. A first
          run is the same case again and the sharpest of the three. It is the only screen in Realm
          where nothing is familiar yet, so every gradient on it is one more thing to work out before
          the two decisions it actually asks for. */}
      <section className="sheet onboarding" aria-labelledby="onboarding-title">
        <form className="onboarding-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="sheet-head"><h3 id="onboarding-title">Welcome to Realm</h3></div>
          <div className="sheet-body onboarding-body">
            <p className="muted onboarding-lead">
              Realm runs the agent CLIs already on this Mac. Everything here can be changed later.
            </p>
            {/* Two things are being set up here and they are not the same thing: WHICH agent answers,
                and WHAT the space is. Side by side they read as the two halves they are — an
                inventory to scan on the left, a short form to fill on the right — where stacked, the
                one field you actually type sat under a dozen radios and the folder step in between.

                A grid that folds on its own rather than at a breakpoint: the sheet is centred in the
                window and can be narrowed to anything, and `auto-fit` puts the columns back into one
                without a number here having to guess where. Source order is the reading order either
                way, which is what makes the stacked case still make sense. */}
            <div className="onboarding-cols">
              {/* Native radios, not buttons with role="radio": arrow-key movement, one tab stop and the
                  checked state all come for free, which is most of "completable with a keyboard alone". */}
              <fieldset className="field cli-field onboarding-col" aria-busy={!probed || undefined}>
                <legend>Agent</legend>
                {/* The line said the right thing and looked like a caption: a static grey sentence over
                    a list of thirteen agents that was already drawn, so the screen read as finished
                    and wrong rather than as busy. The orb is the app's one loading indicator and the
                    only thing here that MOVES, which is what separates "we are still looking" from
                    "this is the answer". `aria-busy` says the same to a reader that cannot see it
                    move, and it goes on the fieldset because the rows are what is provisional. */}
                {!probed && (
                  <p className="onboarding-note" data-busy aria-live="polite">
                    <Spinner size={12} />Checking which agents are installed…
                  </p>
                )}
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

              {/* The space, whole. Name leads because it is the field that takes focus and the only
                  one anybody has to type; the folder sits under it because picking one is what fills
                  the name's placeholder, and the two reading adjacent is the whole of that story. */}
              <fieldset className="cli-field onboarding-col onboarding-space">
                <legend>Space</legend>
                <label className="field">
                  <span>Name</span>
                  <input ref={nameRef} aria-label="Space name" value={name} placeholder={suggested}
                    onChange={(e) => setName(e.target.value)} />
                </label>

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

                {/* The same picker the space's own settings use, so the control someone meets first is
                    the control they meet again. */}
                <div className="field">
                  <span>Icon</span>
                  <IconPicker icon={icon} profileId={profileId} onPick={setIcon} />
                </div>

                {/* Swatches alone — settings keeps a hex field beside them for anyone who has a colour
                    in mind, and a first run does not. Ten is a choice; a text field is a task. */}
                <div className="field">
                  <span>Color</span>
                  <div className="swatches" role="radiogroup" aria-label="Color">
                    {SPACE_COLORS.map((c) => (
                      <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Color ${c}`}
                        className="swatch" data-selected={color === c || undefined}
                        style={{ background: c }} onClick={() => setColor(c)} />
                    ))}
                  </div>
                </div>
              </fieldset>
            </div>
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
