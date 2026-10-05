import { AGENT_CLI_COMMANDS, AGENT_META, SELECTABLE_AGENT_KINDS, pickSpaceColor, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FALLBACK_AGENT, folderName, useApp } from "../state/store";
import { agentAvailability, type AgentAvailability } from "../state/agent-availability";
import { Spinner } from "./Spinner";
import { DEFAULT_SPACE_ICON, SpaceFolderField, SpaceIdentityField } from "./space-fields";
import markUrl from "../assets/realm-mark.svg";

/** The name a space takes when the user types none: the folder's, else a plain word. */
export const DEFAULT_SPACE_NAME = "Home";
/** The colour the space wears until the user says otherwise. It and the icon (`DEFAULT_SPACE_ICON`)
 *  used to be written into `createSpace` at the call site, which meant the first screen decided a
 *  space's identity and never showed it. */
export const DEFAULT_SPACE_COLOR = pickSpaceColor(0);

/**
 * The two agents first run leads with, as cards: the ones Realm carries end to end — memory into
 * every session, permission modes, a sign-in it can run and see finish. Everything else is one line
 * under them, and stays one click from being the pick.
 */
export const LEAD_AGENTS = ["claude", "codex"] as const satisfies readonly AgentKind[];
type LeadAgent = (typeof LEAD_AGENTS)[number];
const LEAD_COPY: Record<LeadAgent, { name: string; by: string; signIn: string }> = {
  claude: { name: "Claude", by: "Claude Code, by Anthropic", signIn: "Sign in with Claude" },
  codex: { name: "Codex", by: "ChatGPT's coding agent, by OpenAI", signIn: "Sign in with ChatGPT" },
};
const isLead = (k: AgentKind): k is LeadAgent => (LEAD_AGENTS as readonly AgentKind[]).includes(k);

/**
 * Where an agent stands. Until a probe reports it, it is checking; once a whole probe has answered
 * (`agentsProbed`), an agent it did not report is not on this Mac — a card left on "Checking…" for a
 * kind nobody is going to report is a page that claims to be working forever. Not "any row has
 * arrived": the two lead cards are probed on their own, ahead of the rest, and their rows say nothing
 * about the agents behind the fold.
 */
function standing(kind: AgentKind, probe: Parameters<typeof agentAvailability>[1], probedAll: boolean): AgentAvailability {
  const a = agentAvailability(kind, probe);
  if (a.state !== "unknown" || !probedAll) return a;
  const label = AGENT_META[kind].label;
  return { state: "missing", title: `${label} isn’t installed`, reason: `Realm could not find ${label} on this Mac.`, command: AGENT_CLI_COMMANDS[kind].install };
}

/** One word for where an agent stands, for the folded list. */
function shortState(a: AgentAvailability, loggedIn: boolean | null | undefined): string {
  if (a.state === "unknown") return "";
  if (a.state === "missing") return "Not installed";
  if (a.state === "logged_out") return "Signed out";
  return loggedIn ? "Signed in" : "Installed";
}

/**
 * First run, as one page that reads top to bottom: what Realm is, the agent that will answer, and
 * the space it works in — then Start.
 *
 * It was a sheet over the app with thirteen equal radio rows on one side and a form on the other,
 * which answered "which of these CLIs is on this Mac" for someone who had not yet been told what any
 * of them were for. A first run is a decision, not an inventory (design.md), and for a person who has
 * never opened a terminal the decision is: which assistant, signed in with which account. So the two
 * agents Realm carries end to end are cards, and each card does what its state needs IN PLACE —
 * Install, Sign in with Claude, Sign in with ChatGPT — without a terminal, a command to copy, or a
 * space to exist first (`agentSignIn.*`, which runs the CLI's own login with no space around it).
 * Claude needs no install at all: Realm carries the binary its sessions run.
 *
 * Nothing here is required, as before. The agent is preselected (a previous run's, else the first
 * that works, else Claude), the folder is optional, the name defaults to the folder's or to "Home",
 * the icon and colour have defaults — so Start is live from the first frame and Enter finishes the
 * whole thing. An agent that is not ready yet is said so under the button, and its session asks
 * again, with the same Install and Sign in.
 *
 * One form, on purpose: the first text field in `.onboarding` is the space's name and the form's
 * submit makes the space and opens its session, which is the hook every live check boots through.
 *
 * Keyboard-complete: the name takes focus on mount (the agent already has an answer; the name is the
 * only thing anyone types), arrows move between the agent radios and between the swatches, Enter
 * starts. There is no dismiss — with zero spaces there is nothing behind it — and while it is up the
 * rail and the sidebar are away (`AppShell`), since nothing in them works before a space exists.
 */
export function Onboarding() {
  const agentProbe = useApp((s) => s.agentProbe);
  const agentsProbed = useApp((s) => s.agentsProbed);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const probeAgents = useApp((s) => s.probeAgents);
  const probeAgent = useApp((s) => s.probeAgent);
  const refreshCliStatus = useApp((s) => s.refreshCliStatus);
  const setDefaultAgent = useApp((s) => s.setDefaultAgent);
  const completeOnboarding = useApp((s) => s.completeOnboarding);
  const run = useApp((s) => s.run);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [icon, setIcon] = useState(DEFAULT_SPACE_ICON);
  const [color, setColor] = useState<string>(DEFAULT_SPACE_COLOR);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState(false);

  /* The two cards are asked on their own as well as in the whole probe. That one answers when every
     agent has, and on a Mac with an ACP agent whose model listing takes half a minute, Claude and
     Codex would say "Checking…" for all of it; each alone answers in a second or so. */
  useEffect(() => {
    run(() => probeAgents());
    for (const k of LEAD_AGENTS) run(() => probeAgent(k));
    run(() => refreshCliStatus());
  }, [probeAgents, probeAgent, refreshCliStatus, run]);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const probed = agentsProbed || LEAD_AGENTS.every((k) => agentProbe.some((r) => r.kind === k));
  const availability = (k: AgentKind) => standing(k, agentProbe, agentsProbed);
  const others = SELECTABLE_AGENT_KINDS.filter((k) => !isLead(k));
  // Until the user picks: whatever a previous run remembered, else the first agent that actually
  // works, leads first, else Claude. The probe arrives after mount, so this is derived, not seeded.
  const firstReady = [...LEAD_AGENTS, ...others].find((k) => availability(k).state === "ready");
  const agent: AgentKind = picked ?? lastAgentKind ?? firstReady ?? FALLBACK_AGENT;
  const pick = (k: AgentKind) => { setPicked(k); run(() => setDefaultAgent(k)); };
  // The pick is never hidden: an agent from the folded list that is the answer opens the fold.
  const othersOpen = showOthers || !isLead(agent);

  /* The profile the space goes into (`completeOnboarding`'s pick): the picker's upload tab files an
     image under it, and the folder field asks where a space there would live. The server seeds
     "Personal" on first boot, so there is one here before this page renders; the fallback keeps the
     BUILT-IN icons working on the one path where there is not. */
  const profileId = useApp((s) => s.activeProfileId ?? s.profiles[0]?.id ?? "");

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

  const chosen = availability(agent);
  const chosenName = isLead(agent) ? LEAD_COPY[agent].name : AGENT_META[agent].label;
  const spaceName = name.trim() || suggested;
  // What Start will do, in one line beside it — and, when the agent is not ready yet, what the
  // session will ask for, so Start never reads as a promise the next screen breaks.
  const summary = chosen.state === "missing"
    ? `${chosenName} isn't installed yet — install it above, or from the session.`
    : chosen.state === "logged_out"
      ? `${chosenName} isn't signed in yet — sign in above, or from the session.`
      : `Starts a ${chosenName} session in ${spaceName}.`;

  return (
    <div className="onboarding-stage">
      <form className="onboarding" aria-labelledby="onboarding-title" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <header className="onboarding-hero">
          {/* The product's own mark, once, at the size the page opens on; decorative, beside its name. */}
          <img className="onboarding-mark" src={markUrl} alt="" width={40} height={48} draggable={false} />
          <h1 id="onboarding-title">Welcome to Realm</h1>
          <p className="onboarding-lead">One workspace for every coding agent, on your Mac.</p>
        </header>

        <fieldset className="onboarding-step" aria-busy={!probed || undefined}>
          <legend className="onboarding-step-head"><span className="onboarding-step-n" aria-hidden="true">1</span>Choose your agent</legend>
          <p className="onboarding-step-sub">It works in your files and answers in a session. Sign in once, with your own account.</p>
          <div className="agent-cards">
            {LEAD_AGENTS.map((k) => <AgentCard key={k} kind={k} selected={agent === k} onPick={() => pick(k)} />)}
          </div>
          <button type="button" className="onboarding-more" aria-expanded={othersOpen} onClick={() => setShowOthers((v) => !v)}>
            <Icon name="chevronDown" size={12} />
            {othersOpen ? "Fewer agents" : `${others.length} more agents`}
          </button>
          {othersOpen && (
            <div className="onboarding-others">
              {others.map((k) => {
                const a = availability(k);
                return (
                  <label key={k} className="onboarding-other" data-selected={agent === k || undefined}>
                    <input type="radio" name="default-agent" value={k} checked={agent === k} onChange={() => pick(k)} />
                    <Icon name={AGENT_META[k].icon} size={16} colored />
                    <span className="onboarding-other-name">{AGENT_META[k].label}</span>
                    <span className="onboarding-other-state" data-tone={a.state}>{shortState(a, agentProbe.find((p) => p.kind === k)?.loggedIn)}</span>
                  </label>
                );
              })}
              <p className="onboarding-note">Each of these installs and signs in from its first session, or from Settings › Engines.</p>
            </div>
          )}
        </fieldset>

        {/* The space, whole. Name leads because it is the field that takes focus and the only one
            anybody has to type, with how the space will look beside it; the folder sits next to it
            because picking one is what fills the name's placeholder. The New space sheet is made of
            the same two fields. */}
        <fieldset className="onboarding-step onboarding-space">
          <legend className="onboarding-step-head"><span className="onboarding-step-n" aria-hidden="true">2</span>Name your space</legend>
          <p className="onboarding-step-sub">A space keeps one project's sessions, files and memory together. Add more any time.</p>
          <div className="onboarding-space-row">
            <SpaceIdentityField nameRef={nameRef} name={name} onName={setName} placeholder={suggested}
              icon={icon} onIcon={setIcon} color={color} onColor={setColor} profileId={profileId} />
            <SpaceFolderField className="field" folder={folder} onFolder={setFolder} profileId={profileId} name={spaceName} />
          </div>
        </fieldset>

        <footer className="onboarding-foot">
          <p className="onboarding-summary" data-tone={chosen.state === "missing" || chosen.state === "logged_out" ? "warn" : undefined}>{summary}</p>
          <button type="submit" className="btn primary onboarding-start" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Starting…" : "Start"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * One lead agent, as a card: picking it (the radio is the card's head), and below, the one thing its
 * state needs — Checking…, Install, Sign in with …, the browser step of a sign-in, a code to paste
 * back, or Ready. Every action also picks the agent it acts on: someone who signs in to Codex means
 * Codex.
 */
function AgentCard({ kind, selected, onPick }: { kind: LeadAgent; selected: boolean; onPick: () => void }) {
  const probe = useApp((s) => s.agentProbe);
  const probedAll = useApp((s) => s.agentsProbed);
  const cli = useApp((s) => s.cliStatus.find((r) => r.kind === kind) ?? null);
  const job = useApp((s) => s.cliJobs[kind]);
  const signIn = useApp((s) => s.agentSignIns[kind]);
  const runCliAction = useApp((s) => s.runCliAction);
  const startAgentSignIn = useApp((s) => s.startAgentSignIn);
  const sendAgentSignInCode = useApp((s) => s.sendAgentSignInCode);
  const cancelAgentSignIn = useApp((s) => s.cancelAgentSignIn);
  const run = useApp((s) => s.run);
  const [code, setCode] = useState("");
  const copy = LEAD_COPY[kind];
  const a = standing(kind, probe, probedAll);
  const loggedIn = probe.find((p) => p.kind === kind)?.loggedIn ?? null;
  const live = signIn && (signIn.state === "starting" || signIn.state === "browser" || signIn.state === "code") ? signIn : null;

  const signInNow = () => { onPick(); setCode(""); run(() => startAgentSignIn(kind)); };
  const sendCode = () => {
    const c = code.trim();
    if (c === "") return;
    setCode("");
    run(() => sendAgentSignInCode(kind, c));
  };

  let foot: ReactNode;
  if (live) {
    foot = (
      <div className="agent-card-signin">
        {/* Claude asks for a code in the same breath as it prints the page — but the browser tab it
            opened itself finishes on its own, and only the page reached by "Open the page again"
            shows a code. So the browser leads, and the field is there for whoever needs it. */}
        <span className="agent-card-status" data-busy>
          <Spinner size={12} />
          {live.state === "starting" ? "Opening the sign-in page…" : "Finish signing in in your browser."}
        </span>
        {live.state === "code" && (
          <>
            <span className="agent-card-note">If the page shows a code, paste it here.</span>
            <div className="agent-code-row">
              {/* Enter would otherwise submit the whole page and start before the code went in. */}
              <input className="agent-code" aria-label={`Code from ${copy.name}'s sign-in page`} value={code}
                spellCheck={false} autoComplete="off" onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendCode(); } }} />
              <button type="button" className="btn primary" disabled={code.trim() === ""} onClick={sendCode}>Continue</button>
            </div>
          </>
        )}
        <span className="agent-card-actions">
          {live.url && (
            <button type="button" className="btn-quiet" onClick={() => window.open(live.url!, "_blank")}>Open the page again</button>
          )}
          <button type="button" className="btn-quiet" onClick={() => run(() => cancelAgentSignIn(kind))}>Cancel</button>
        </span>
      </div>
    );
  } else if (job?.state === "running") {
    const tail = job.output.trimEnd().split("\n").at(-1) ?? "";
    foot = (
      <div className="agent-card-signin">
        <span className="agent-card-status" data-busy><Spinner size={12} />Installing {copy.name}…</span>
        {tail && <span className="agent-card-tail" title={job.command}>{tail}</span>}
      </div>
    );
  } else if (a.state === "unknown") {
    foot = <span className="agent-card-status" data-busy><Spinner size={12} />Checking…</span>;
  } else if (a.state === "ready" || signIn?.state === "done") {
    foot = (
      <span className="agent-card-status" data-tone="ready">
        <Icon name="checkCircle" size={14} />{loggedIn || signIn?.state === "done" ? "Signed in" : "Ready"}
      </span>
    );
  } else if (a.state === "logged_out") {
    foot = (
      <div className="agent-card-signin">
        {signIn?.state === "failed" && <span className="agent-card-note" data-tone="danger" title={signIn.detail ?? undefined}>The sign-in didn't finish. Try again.</span>}
        <button type="button" className="btn agent-card-action" onClick={signInNow}>
          <Icon name={AGENT_META[kind].icon} size={14} colored />{copy.signIn}
        </button>
      </div>
    );
  } else {
    // Missing. The server offers the install it can actually run; where it cannot (no npm on this
    // Mac), it says why, and the honest next step is the thing that provides npm.
    const offer = cli && cli.action === "install" && cli.command ? cli.command : null;
    foot = (
      <div className="agent-card-signin">
        {job?.state === "failed" && <span className="agent-card-note" data-tone="danger" title={job.error ?? undefined}>The install didn't finish. Try again.</span>}
        {offer ? (
          <button type="button" className="btn agent-card-action" title={offer} onClick={() => { onPick(); run(() => runCliAction(kind, "install")); }}>
            <Icon name="download" size={14} />Install {copy.name}
          </button>
        ) : (
          <>
            <span className="agent-card-note">{cli?.refusal ?? `${copy.name} isn't on this Mac yet.`}</span>
            {/node/i.test(cli?.refusal ?? "") && (
              <button type="button" className="btn-quiet" onClick={() => window.open("https://nodejs.org/en/download", "_blank")}>Get Node.js</button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="agent-card" data-selected={selected || undefined}>
      <label className="agent-card-pick">
        <input type="radio" name="default-agent" value={kind} checked={selected} onChange={onPick} />
        <span className="agent-card-mark"><Icon name={AGENT_META[kind].icon} size={20} colored /></span>
        <span className="agent-card-text">
          <span className="agent-card-name">{copy.name}</span>
          <span className="agent-card-by">{copy.by}</span>
        </span>
      </label>
      <div className="agent-card-foot" aria-live="polite">{foot}</div>
    </div>
  );
}
