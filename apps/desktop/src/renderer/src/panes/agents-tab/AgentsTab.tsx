import { AGENT_META, sessionModeOf, type AgentKind, type DelegatedChild, type Session } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ScrollFades } from "../../components/ScrollFades";
import { activityOf, type SessionActivity } from "../../state/session-activity";
import { useApp, type DelegableModels } from "../../state/store";
import type { PaneProps } from "../registry";
import { useOpenChild } from "../session/DelegatedRuns";
import { isPlanDecision } from "../session/PlanCard";
import { formatDuration } from "../session/tool-group";
import { useElapsed } from "../session/use-elapsed";
import { canSend, delegationBrief, type BriefPick } from "./brief";
import { ModelChooser, OWN } from "./ModelChooser";
import { STATE_LABEL, isLive, modelLabel, reportSummary, subagentElapsed, subagentState, taskTitle, type SubagentState } from "./subagent-state";

/** How many models the composer offers as one-click chips before the rest are a chooser away. */
const CHIPS = 5;
/** The harnesses a chip is suggested from unasked: the vendors' own CLIs, whose lists are curated or
 *  in the vendor's order. A proxy's catalog runs to hundreds in no order anyone chose (fx's 165), and
 *  its first entry is nobody's suggestion — those wait in the chooser, or among the starred models. */
const SUGGESTED: readonly AgentKind[] = ["claude", "codex"];
/** How long a row asked for from the transcript stays lit — long enough to find, then gone. */
const FLASH_MS = 1600;

const NO_CHILDREN: readonly DelegatedChild[] = [];

/**
 * A session's Agents tab: its sub-agents, and the composer that hands it work for them.
 *
 * A tab of the session's side pane, the way its browser, terminal and documents open, because a
 * delegation is this session's business — the list is the session's children and the composer talks
 * to the session's own agent. The tab adds no state the transcript does not already imply: the list
 * is `delegation.children`, kept current by the broadcasts every window receives, and the composer
 * sends an ordinary message in the user's name.
 */
export function AgentsTab({ item, visible }: PaneProps) {
  const leadId = item.refId;
  const lead = useApp((s) => s.sessions[leadId] ?? s.allSessions[leadId]);
  const children = useApp((s) => s.subagents[leadId]) ?? NO_CHILDREN;
  const loaded = useApp((s) => s.subagents[leadId] !== undefined);
  const refreshSubagents = useApp((s) => s.refreshSubagents);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const ask = useApp((s) => s.agentsAsk[leadId]);
  const clearAgentsAsk = useApp((s) => s.clearAgentsAsk);
  const run = useApp((s) => s.run);
  const open = useOpenChild();
  // Both reads on mount: the list itself, and the engine's live set, which is what tells a child
  // that is about to start from one whose run is gone. Every later change arrives as a broadcast.
  useEffect(() => { run(() => refreshSubagents(leadId)); run(() => refreshDelegatedRuns(leadId)); }, [leadId, refreshSubagents, refreshDelegatedRuns, run]);

  /* What the tab was opened FOR — a plan to start the composer from, or a row a transcript line
     points at. Taken once and cleared, so a remount after a space switch does not put back a plan
     the user has since edited. */
  const [prefill, setPrefill] = useState<{ plan: string; n: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!ask) return;
    if (ask.plan !== undefined) setPrefill({ plan: ask.plan, n: ask.n });
    if (ask.childId) setFlash(ask.childId);
    clearAgentsAsk(leadId);
  }, [ask, leadId, clearAgentsAsk]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  const scroller = useRef<HTMLDivElement>(null);
  if (!lead) return <div className="pane-placeholder muted">This session no longer exists.</div>;
  return (
    <div className="subagents" data-visible={visible || undefined}>
      <div className="subagents-scroll" ref={scroller}>
        <ScrollFades scroller={scroller} />
        <SubagentList leadId={leadId} children={children} loaded={loaded} flash={flash} onOpen={open} />
      </div>
      <BuildWith lead={lead} prefill={prefill} />
    </div>
  );
}

function SubagentList({ leadId, children, loaded, flash, onOpen }: {
  leadId: string; children: readonly DelegatedChild[]; loaded: boolean; flash: string | null; onOpen: (childId: string) => void;
}) {
  // Nothing until the list has answered: an empty state shown for the moment before cards arrive is
  // a claim that there are none.
  if (!loaded) return null;
  if (children.length === 0) return <SubagentsEmpty />;
  return (
    <section className="subagents-section" aria-label="Sub-agents">
      {/* How many, and no more: each card says where it stands, and the session's bar already says
          how many are working. */}
      <h2 className="subagents-head">
        Sub-agents
        <span className="subagents-count">{children.length}</span>
      </h2>
      <ul className="subagents-list">
        {children.map((c) => <SubagentCard key={c.session.id} child={c} leadId={leadId} flash={flash === c.session.id} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

/** No sub-agents yet: the tab's subject, centred in the space above the composer, and the one thing
 *  to do about it — which is the composer just below, so the composition points there rather than
 *  growing a button that would do the same. */
function SubagentsEmpty() {
  return (
    <section className="subagents-empty" aria-label="Sub-agents">
      {/* off-ladder: the tab's one illustration, its own mark over the line that says what it is
          for — the subject of an empty composition, as the Scheduled page's clock is. */}
      <Icon name="agents" size={32} className="subagents-empty-mark" />
      <h2 className="subagents-empty-title">Hand work to sub-agents</h2>
      <p className="subagents-empty-line">Pick models below and say what to build. This session starts a sub-agent on each, and you can follow every one here.</p>
    </section>
  );
}

/** What the session was last seen doing — the live line when it is newer than the one the list was
 *  fetched with. A user message is the task itself, already the card's title, so it never stands
 *  in for activity. */
function latestDoing(live: SessionActivity | undefined, fetched: DelegatedChild["activity"]): SessionActivity | null {
  const seed = fetched ? activityOf(fetched) : null;
  const fresh = live && live.icon !== "send" ? live : null;
  if (!fresh) return seed;
  return !seed || fresh.ts >= seed.ts ? fresh : seed;
}

/** The state's mark: the session dot where something is live, the transcript's own glyphs where it
 *  has ended — so the tab and the tool rows above it say "done" and "failed" with the same shapes. */
function StateMark({ state }: { state: SubagentState }) {
  switch (state) {
    case "working": return <span className="status-dot" data-status="running" aria-hidden="true" />;
    case "waiting": return <span className="status-dot" data-status="waiting_permission" aria-hidden="true" />;
    case "queued": return <span className="status-dot" data-status="idle" aria-hidden="true" />;
    case "done": return <Icon name="check" size={12} />;
    case "failed": case "timeout": return <Icon name="errorCircle" size={12} />;
    case "stopped": case "cancelled": return <Icon name="stop" size={12} />;
  }
}

function SubagentCard({ child, leadId, flash, onOpen }: { child: DelegatedChild; leadId: string; flash: boolean; onOpen: (childId: string) => void }) {
  const id = child.session.id;
  const live = useApp((s) => s.sessionStatus[id]);
  const inFlight = useApp((s) => s.delegatedRuns[leadId]?.some((r) => r.sessionId === id) ?? false);
  const liveDoing = useApp((s) => s.sessionActivity[id]);
  const probe = useApp((s) => s.agentProbe);
  const state = subagentState(child, live, inFlight);
  const ticking = isLive(state);
  const runningFor = useElapsed(child.startedAt, ticking);
  const elapsed = ticking ? runningFor : subagentElapsed(child, state, Date.now());
  const kind = child.session.agentKind;
  const model = modelLabel(kind, child.session.model, probe);
  const task = taskTitle(child.goal, child.session.title);
  const doing = ticking ? latestDoing(liveDoing, child.activity) : null;
  const summary = !ticking && child.report ? reportSummary(child.report) : "";
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (flash) ref.current?.scrollIntoView?.({ block: "nearest" }); }, [flash]);
  return (
    <li ref={ref} className="subagent" data-state={state} data-flash={flash || undefined}>
      <button type="button" className="subagent-card" title="Open this sub-agent's transcript"
        aria-label={`${task}. ${model} on ${AGENT_META[kind].label}. ${STATE_LABEL[state]}, ${formatDuration(elapsed)}.`}
        onClick={() => onOpen(id)}>
        <span className="subagent-top">
          <Icon name={AGENT_META[kind].icon} size={16} colored className="subagent-mark" />
          <span className="subagent-model">{model}</span>
          <span className="subagent-harness">{AGENT_META[kind].label}</span>
          <span className="subagent-state"><StateMark state={state} />{STATE_LABEL[state]}<span className="subagent-time">{formatDuration(elapsed)}</span></span>
        </span>
        <span className="subagent-task">{task}</span>
        {doing && <span className="subagent-doing"><Icon name={doing.icon} size={12} /><span className="subagent-doing-text">{doing.text}</span></span>}
        {summary && <span className="subagent-report">{summary}</span>}
      </button>
    </li>
  );
}

/**
 * "Build with…": pick the models, say what to build, send.
 *
 * What it sends is a message to THIS session's agent in the user's name (`delegationBrief`), and the
 * agent does the delegating with the same tools it would use if the user had typed the request — so
 * the agent stays the one who splits the work, reads the reports and answers for them, and the
 * transcript shows the ask and everything done about it. The composer only makes the request
 * well-formed: models named the way the server resolves them, and the tools that do it named too.
 */
function BuildWith({ lead, prefill }: { lead: Session; prefill: { plan: string; n: number } | null }) {
  const delegableModels = useApp((s) => s.delegableModels);
  const delegateWork = useApp((s) => s.delegateWork);
  const favorites = useApp((s) => s.modelFavorites);
  const pendingPlan = useApp((s) => (s.sessionStatus[lead.id] ?? lead.status) === "waiting_permission"
    && (s.transcripts[lead.id]?.t.pendingPermissions.some(isPlanDecision) ?? false));
  const run = useApp((s) => s.run);
  const [catalog, setCatalog] = useState<DelegableModels | null>(null);
  const [work, setWork] = useState("");
  const [fromPlan, setFromPlan] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [split, setSplit] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const more = useRef<HTMLButtonElement>(null);

  // The session's own model is part of the answer, so a model switch re-reads it.
  useEffect(() => {
    let live = true;
    run(async () => { const c = await delegableModels(lead.id); if (live) setCatalog(c); });
    return () => { live = false; };
  }, [lead.id, lead.agentKind, lead.model, delegableModels, run]);
  useEffect(() => {
    if (!prefill) return;
    setWork(prefill.plan); setFromPlan(true);
    field.current?.focus();
  }, [prefill]);

  const models = catalog?.models ?? [];
  const own = catalog?.own ?? null;
  const byKey = useMemo(() => new Map(models.map((m) => [m.key, m])), [models]);
  const labelOf = (key: string) => (key === OWN ? own?.label ?? "" : byKey.get(key)?.label ?? key);
  const kindOf = (key: string) => (key === OWN ? own?.kind ?? lead.agentKind : byKey.get(key)?.kind ?? lead.agentKind);
  /* The one-click chips: the session's own model, whatever is picked, the user's starred models, then
     the first ready model of each vendor CLI — a short list of the likely, with the full catalog one
     click further. A chip never leaves while picked, so a choice made in the chooser stays in sight. */
  const chips = useMemo(() => {
    const out: string[] = own ? [OWN] : [];
    const add = (k: string) => { if (!out.includes(k) && (k === OWN || byKey.has(k))) out.push(k); };
    picks.forEach(add);
    const isOwn = (k: string) => { const m = byKey.get(k); return !!m && !!own && m.kind === own.kind && m.label === own.label; };
    for (const k of favorites) if (out.length < CHIPS && byKey.get(k)?.ready && !isOwn(k)) add(k);
    for (const kind of SUGGESTED) {
      const m = models.find((x) => x.kind === kind && x.ready && !isOwn(x.key));
      if (m && out.length < CHIPS) add(m.key);
    }
    return out;
  }, [own, picks, favorites, byKey, models]);

  const toggle = (key: string) => setPicks((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const briefPicks: BriefPick[] = picks.map((k) => ({ label: labelOf(k), own: k === OWN, task: tasks[k] ?? "" }));
  const splitting = split && picks.length > 0;
  const ready = canSend(work, briefPicks, splitting) && !sending;
  const inPlan = sessionModeOf(lead.permissionMode) === "plan";
  const why = picks.length === 0 ? "Pick at least one model" : !ready ? "Say what to build first" : "Send to this session's agent (⌘↩)";

  const send = () => {
    if (!ready) return;
    const text = delegationBrief({ work, picks: briefPicks, split: splitting, fromPlan });
    setSending(true);
    run(async () => {
      try {
        await delegateWork(lead.id, text);
        setWork(""); setTasks({}); setFromPlan(false);
      } finally { setSending(false); }
    });
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };

  return (
    <section className="subagents-build" aria-label="Build with">
      <div className="subagents-build-head">
        <h2 className="subagents-head">Build with</h2>
        <div className="subagents-picks" role="group" aria-label="Models">
          {chips.map((k) => (
            <button key={k} type="button" className="subagents-pick" aria-pressed={picks.includes(k)}
              title={k === OWN ? `This session's own model — ${labelOf(k)}` : `${labelOf(k)} on ${AGENT_META[kindOf(k)].label}`}
              onClick={() => toggle(k)}>
              <Icon name={AGENT_META[kindOf(k)].icon} size={14} colored />
              <span className="subagents-pick-label">{labelOf(k)}</span>
              {k === OWN && <span className="subagents-pick-own">this session</span>}
            </button>
          ))}
          <button ref={more} type="button" className="subagents-pick subagents-more" aria-haspopup="dialog" aria-expanded={choosing}
            disabled={catalog === null} title="Every model a sub-agent can run on" onClick={() => setChoosing((v) => !v)}>
            <Icon name="add" size={12} />
            <span className="subagents-pick-label">More models</span>
          </button>
        </div>
      </div>
      {/* data-no-agent: this sends paid work in the user's name. An agent driving the window with
          app_act could otherwise start sub-agents nobody asked for — PermissionCard.tsx says why the
          claim lives on the component. */}
      <div className="subagents-compose" data-no-agent="sub-agent launch">
        <textarea ref={field} className="subagents-work" value={work} rows={3} aria-label="What to build"
          placeholder={splitting ? "What every model should know — the plan, the files, the constraints"
            : picks.length > 1 ? "Describe the plan or feature — the agent splits it between them" : "Describe the plan or feature, or paste one"}
          onChange={(e) => { setWork(e.target.value); if (e.target.value === "") setFromPlan(false); }} onKeyDown={onKey} />
        {splitting && (
          <div className="subagents-tasks">
            {picks.map((k) => (
              <label key={k} className="subagents-task">
                <span className="subagents-task-who"><Icon name={AGENT_META[kindOf(k)].icon} size={14} colored />{labelOf(k)}</span>
                <input value={tasks[k] ?? ""} placeholder="Its part of the work" aria-label={`What ${labelOf(k)} should do`}
                  onChange={(e) => setTasks((t) => ({ ...t, [k]: e.target.value }))} onKeyDown={onKey} />
              </label>
            ))}
          </div>
        )}
        <div className="subagents-compose-foot">
          {picks.length > 1 && (
            <button type="button" className="btn-quiet subagents-split" aria-pressed={split}
              title="Give each model its own part of the work, rather than letting the agent split it"
              onClick={() => setSplit((v) => !v)}>Split by model</button>
          )}
          {/* What sending will also do, said before it is done (design.md: name the consequence). */}
          {(inPlan || pendingPlan) && (
            <span className="subagents-note">{pendingPlan ? "Sending answers the open plan with Keep planning and switches to Build." : "Sending switches this session from Plan to Build."}</span>
          )}
          <button type="button" className="composer-send subagents-send" disabled={!ready} aria-label="Send to this session's agent" title={why}
            onClick={send}>
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
      {choosing && catalog && (
        <ModelChooser anchor={more} models={catalog.models} own={catalog.own} picked={new Set(picks)}
          onToggle={toggle} onClose={() => setChoosing(false)} />
      )}
    </section>
  );
}
