import { AGENT_META, sessionModeOf, type AgentKind, type DelegatedChild, type Session } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ScrollFades } from "../../components/ScrollFades";
import { activityOf, type SessionActivity } from "../../state/session-activity";
import { useApp, type DelegableModels } from "../../state/store";
import type { PaneProps } from "../registry";
import { AnswerHere } from "../session/AnswerHere";
import { permissionMark } from "../session/Composer";
import { harnessAgents, harnessSubagents, type HarnessAgent } from "../session/DelegatedRuns";
import { isPlanDecision } from "../session/PlanCard";
import { useSessionSubagents } from "../session/session-subagents";
import { formatDuration } from "../session/tool-group";
import type { Block } from "../session/transcript-model";
import { useElapsed } from "../session/use-elapsed";
import { canSend, delegationBrief, type BriefPick } from "./brief";
import { ModelChooser, OWN } from "./ModelChooser";
import { StateMark } from "./StateMark";
import { SubagentSwitch, SubagentViewer, findChild, whereLabel, type ShownSubagent } from "./SubagentViewer";
import { STATE_LABEL, childTitle, isLive, modelLabel, orchestratorOrder, reportSummary, rollup, spentMs, subagentElapsed, subagentState, type SubagentState } from "./subagent-state";

/** How many models the composer offers as one-click chips before the rest are a chooser away. */
const CHIPS = 5;
/** The harnesses a chip is suggested from unasked: the vendors' own CLIs, whose lists are curated or
 *  in the vendor's order. A proxy's catalog runs to hundreds in no order anyone chose (fx's 165), and
 *  its first entry is nobody's suggestion — those wait in the chooser, or among the starred models. */
const SUGGESTED: readonly AgentKind[] = ["claude", "codex"];
const NO_CHILDREN: readonly DelegatedChild[] = [];

/**
 * A session's Agents tab: its sub-agents, and the composer that hands it work for them.
 *
 * A tab of the session's side pane, the way its browser, terminal and documents open, because a
 * delegation is this session's business — the list is the session's children and the composer talks
 * to the session's own agent. The tab adds no state the transcript does not already imply: the list
 * is `delegation.children`, kept current by the broadcasts every window receives, and the composer
 * sends an ordinary message in the user's name.
 *
 * It is also where ONE sub-agent is looked at. Clicking a sub-agent anywhere — its line in the lead's
 * transcript, its chip over the lead's prompter, a card here — opens it in this tab's viewer, with its
 * siblings a tab away along the top. Beside the lead rather than over it, so the
 * lead stays readable and its prompter stays live (design.md: what a session's agents open arrives as
 * a tab of the one side panel). Which one is showing is remembered per lead (`agentsShown`).
 */
export function AgentsTab({ item, visible }: PaneProps) {
  const leadId = item.refId;
  const lead = useApp((s) => s.sessions[leadId] ?? s.allSessions[leadId]);
  const children = useApp((s) => s.subagents[leadId]) ?? NO_CHILDREN;
  const loaded = useApp((s) => s.subagents[leadId] !== undefined);
  const leadRead = useApp((s) => s.transcripts[leadId] !== undefined);
  const refreshSubagents = useApp((s) => s.refreshSubagents);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const hydrateAgentsShown = useApp((s) => s.hydrateAgentsShown);
  const shownId = useApp((s) => s.agentsShown[leadId] ?? null);
  const ask = useApp((s) => s.agentsAsk[leadId]);
  const clearAgentsAsk = useApp((s) => s.clearAgentsAsk);
  const run = useApp((s) => s.run);
  const agents = useSessionSubagents(leadId);
  // Both reads on mount: the list itself, and the engine's live set, which is what tells a child
  // that is about to start from one whose run is gone. Every later change arrives as a broadcast.
  useEffect(() => { run(() => refreshSubagents(leadId)); run(() => refreshDelegatedRuns(leadId)); }, [leadId, refreshSubagents, refreshDelegatedRuns, run]);
  useEffect(() => { run(() => hydrateAgentsShown()); }, [hydrateAgentsShown, run]);
  // And again whenever a child changes state: a wait starting or ending is what moves its spent
  // budget from ticking to held, and only the server knows how long it was held.
  const statuses = useApp((s) => (s.subagents[leadId] ?? NO_CHILDREN).map((c) => s.sessionStatus[c.session.id] ?? "").join(","));
  const seenStatuses = useRef(statuses);
  useEffect(() => {
    if (seenStatuses.current === statuses) return;
    seenStatuses.current = statuses;
    run(() => refreshSubagents(leadId));
  }, [statuses, leadId, refreshSubagents, run]);

  /* What the tab was opened FOR — a plan to start the composer from. Taken once and cleared, so a
     remount after a space switch does not put back a plan the user has since edited. */
  const [prefill, setPrefill] = useState<{ plan: string; n: number } | null>(null);
  useEffect(() => {
    if (!ask) return;
    if (ask.plan !== undefined) setPrefill({ plan: ask.plan, n: ask.n });
    clearAgentsAsk(leadId);
  }, [ask, leadId, clearAgentsAsk]);

  /* The one being looked at: a harness agent of the lead's, or a delegated child at any depth. Until
     both the list and the lead's transcript have answered, an id that names neither may yet — a tab
     restored at launch is read before either — so the body waits rather than flashing the overview.
     Once both have, an id naming nothing (a child since deleted) is the overview. */
  const shown = useMemo((): ShownSubagent | "pending" | null => {
    if (shownId === null) return null;
    if (agents.some((a) => a.id === shownId && a.source === "harness")) return { kind: "harness", id: shownId };
    const found = findChild(children, shownId, leadId);
    if (found) return { kind: "child", ...found };
    return loaded && leadRead ? null : "pending";
  }, [shownId, agents, children, leadId, loaded, leadRead]);

  /* The sub-agents whose report the reader closed, kept while this tab is up so going to a sibling
     and back finds it as it was left. Not persisted: every report opens again in a new tab. */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const onReportOpen = useCallback((open: boolean) => {
    if (shownId === null) return;
    setClosed((was) => { const next = new Set(was); if (open) next.delete(shownId); else next.add(shownId); return next; });
  }, [shownId]);

  const scroller = useRef<HTMLDivElement>(null);
  if (!lead) return <div className="pane-placeholder muted">This session no longer exists.</div>;
  return (
    <div className="subagents" data-visible={visible || undefined}>
      {agents.length > 0 && <SubagentSwitch leadId={leadId} agents={agents} shown={shown === null ? null : shownId} />}
      {shown === "pending" ? null : shown ? <SubagentViewer key={shownId!} leadId={leadId} shown={shown}
        reportOpen={!closed.has(shownId!)} onReportOpen={onReportOpen} /> : (
        <>
          <div className="subagents-scroll" ref={scroller}>
            <ScrollFades scroller={scroller} />
            <SubagentList leadId={leadId} children={children} loaded={loaded} />
          </div>
          <BuildWith lead={lead} prefill={prefill} />
        </>
      )}
    </div>
  );
}

function SubagentList({ leadId, children, loaded }: { leadId: string; children: readonly DelegatedChild[]; loaded: boolean }) {
  const sessionStatus = useApp((s) => s.sessionStatus);
  const runs = useApp((s) => s.delegatedRuns[leadId]);
  const leadBlocks = useApp((s) => s.transcripts[leadId]?.t.blocks ?? NO_BLOCKS);
  const leadStatus = sessionStatus[leadId];
  const leadLive = leadStatus === undefined || leadStatus === "running" || leadStatus === "waiting_permission";
  // The lead's OWN harness sub-agents — Claude's background `Agent` calls — which have no session and
  // so are not among `children`, but are as much this session's sub-agents as those are.
  const own = useMemo(() => harnessAgents(leadBlocks, leadLive), [leadBlocks, leadLive]);
  type Entry = { startedAt: number; child?: DelegatedChild; harness?: HarnessAgent };
  const stateOf = (e: Entry): SubagentState => e.harness
    ? e.harness.state
    : subagentState(e.child!, sessionStatus[e.child!.session.id], runs?.some((r) => r.sessionId === e.child!.session.id) ?? false);
  const entries: Entry[] = [...children.map((c) => ({ startedAt: c.startedAt, child: c })), ...own.map((h) => ({ startedAt: h.startedAt, harness: h }))];
  const ordered = orchestratorOrder(entries, stateOf);
  const states = ordered.map(stateOf);
  const live = ordered.filter((_, i) => isLive(states[i]!));
  // The oldest thing still going — how long this session has had agents out.
  const since = live.length > 0 ? Math.min(...live.map((c) => c.startedAt)) : 0;
  const elapsed = useElapsed(since, live.length > 0);
  // Nothing until the list has answered: an empty state shown for the moment before cards arrive is
  // a claim that there are none.
  if (!loaded && own.length === 0) return null;
  if (entries.length === 0) return <SubagentsEmpty />;
  return (
    <section className="subagents-section" aria-label="Sub-agents">
      {/* Where they all stand, in words — the cards below each say their own. Not sticky: it is a
          head, and the cards are what is read while scrolling (design.md). */}
      <h2 className="subagents-head">
        Sub-agents
        <span className="subagents-count">{rollup(states)}</span>
        {live.length > 0 && <span className="subagents-since" title="Since the oldest sub-agent still going started">{formatDuration(elapsed)}</span>}
      </h2>
      <ul className="subagents-list">
        {ordered.map((e) => e.child
          ? <SubagentCard key={e.child.session.id} child={e.child} leadId={leadId} tabLead={leadId} />
          : <HarnessCard key={e.harness!.id} agent={e.harness!} leadId={leadId} />)}
      </ul>
    </section>
  );
}

/**
 * One of the lead's own harness sub-agents as a card: its task, where it stands, for how long, and
 * which harness it runs inside. A click opens it in this tab's viewer.
 */
function HarnessCard({ agent, leadId }: { agent: HarnessAgent; leadId: string }) {
  const kind = useApp((s) => (s.sessions[leadId] ?? s.allSessions[leadId])?.agentKind ?? "claude");
  const showSubagent = useApp((s) => s.showSubagent);
  const ticking = agent.state === "working";
  const runningFor = useElapsed(agent.startedAt, ticking);
  const elapsed = ticking ? runningFor : agent.endedAt !== null ? Math.max(0, agent.endedAt - agent.startedAt) : null;
  const inside = `inside ${AGENT_META[kind].label}`;
  return (
    <li className="subagent subagent-card" data-state={agent.state} data-harness="">
      <button type="button" className="subagent-summary"
        aria-label={`${agent.label}, ${inside}. ${STATE_LABEL[agent.state]}${elapsed !== null ? `, ${formatDuration(elapsed)}` : ""}. Open it`}
        title="Show what it has done" onClick={() => showSubagent(leadId, agent.id)}>
        <span className="subagent-top">
          <span className="subagent-caret"><Icon name="bot" size={12} /></span>
          <span className="subagent-task">{agent.label}</span>
          <span className="subagent-state"><StateMark state={agent.state} />{STATE_LABEL[agent.state]}
            {elapsed !== null && <span className="subagent-time">{formatDuration(elapsed)}</span>}</span>
        </span>
        <span className="subagent-facts">
          <Icon name={AGENT_META[kind].icon} size={14} colored className="subagent-mark" />
          <span className="subagent-harness">Runs {inside}</span>
        </span>
      </button>
    </li>
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

const NO_BLOCKS: readonly Block[] = [];

/**
 * One sub-agent as a card of the orchestrator: where it stands, on what, where, in which mode and how
 * much of its budget is spent, and what it is doing. A click opens it in this tab's viewer, where it
 * is read, messaged and stopped.
 *
 * A card waiting on you carries its request, answered in place, because the request is the reason
 * anyone came here and a click away is a click too many for it. `leadId` is the session that started
 * it, whose runs say whether it is live; `tabLead` is the lead whose tab this is.
 */
function SubagentCard({ child, leadId, tabLead, nested = false }: { child: DelegatedChild; leadId: string; tabLead: string; nested?: boolean }) {
  const id = child.session.id;
  const live = useApp((s) => s.sessionStatus[id]);
  const inFlight = useApp((s) => s.delegatedRuns[leadId]?.some((r) => r.sessionId === id) ?? false);
  const liveDoing = useApp((s) => s.sessionActivity[id]);
  const probe = useApp((s) => s.agentProbe);
  const env = useApp((s) => s.environments[child.session.environmentId]);
  const blocks = useApp((s) => s.transcripts[id]?.t.blocks ?? NO_BLOCKS);
  const showSubagent = useApp((s) => s.showSubagent);
  const state = subagentState(child, live, inFlight);
  const ticking = isLive(state);
  const runningFor = useElapsed(child.startedAt, ticking);
  const now = ticking ? child.startedAt + runningFor : Date.now();
  const elapsed = ticking ? runningFor : subagentElapsed(child, state, now);
  const spent = spentMs(child, state, now);
  const kind = child.session.agentKind;
  const model = modelLabel(kind, child.session.model, probe);
  const title = childTitle(child);
  const doing = ticking ? latestDoing(liveDoing, child.activity) : null;
  const summary = !ticking && child.report ? reportSummary(child.report) : "";
  const where = whereLabel(env);
  const mode = permissionMark(child.session.permissionMode);
  const inAgent = useMemo(() => harnessSubagents(blocks), [blocks]);
  const card = useRef<HTMLButtonElement>(null);
  const open = () => showSubagent(tabLead, id);
  return (
    <li className="subagent subagent-card" data-state={state} data-nested={nested || undefined}>
      <button ref={card} type="button" className="subagent-summary"
        aria-label={`${title}. ${model} on ${AGENT_META[kind].label}. ${STATE_LABEL[state]}, ${formatDuration(elapsed)}. Open it`}
        title="Open its transcript here" onClick={open}>
        <span className="subagent-top">
          <span className="subagent-caret"><Icon name="chevronRight" size={12} /></span>
          <span className="subagent-task">{title}</span>
          <span className="subagent-state"><StateMark state={state} />{STATE_LABEL[state]}<span className="subagent-time">{formatDuration(elapsed)}</span></span>
        </span>
        <span className="subagent-facts">
          <Icon name={AGENT_META[kind].icon} size={14} colored className="subagent-mark" />
          <span className="subagent-model">{model}</span>
          <span className="subagent-harness">{AGENT_META[kind].label}</span>
          {where && <span className="subagent-where" data-branch={where.branch || undefined} title={where.path}>{where.text}</span>}
          <span className="subagent-mode" title={`Runs in ${mode.label}`}><Icon name={mode.icon} size={12} />{mode.label}</span>
          {spent !== null && child.budgetMs != null && (
            <span className="subagent-budget" title="Working time spent of its budget. Time waiting on you is not counted.">
              {formatDuration(spent)} of {formatDuration(child.budgetMs)}
            </span>
          )}
        </span>
        {/* Waiting, the request itself says what it is doing; the line would say it twice. */}
        {doing && state !== "waiting" && <span className="subagent-doing"><Icon name={doing.icon} size={12} /><span className="subagent-doing-text">{doing.text}</span></span>}
        {child.note && <span className="subagent-note">{child.note}</span>}
        {summary && <span className="subagent-report">{summary}</span>}
      </button>
      {state === "waiting" && (
        <div className="subagent-detail">
          <AnswerHere id={`subagent-ask-${id}`} session={child.session} asker={title} onLeave={() => card.current?.focus()} />
        </div>
      )}
      {inAgent.length > 0 && (
        <ul className="subagent-inner" aria-label={`Sub-agents ${title} is running in the agent`}>
          {inAgent.map((h) => <HarnessRow key={h.id} row={h} onOpen={open} />)}
        </ul>
      )}
      {child.children && child.children.length > 0 && (
        <ul className="subagents-list subagent-nested" aria-label={`Sub-agents ${title} started`}>
          {child.children.map((g) => <SubagentCard key={g.session.id} child={g} leadId={id} tabLead={tabLead} nested />)}
        </ul>
      )}
    </li>
  );
}

/** A sub-agent the CHILD's harness is running in its own process — no session behind it, so a click
 *  opens the child it runs inside, whose transcript carries its calls. */
function HarnessRow({ row, onOpen }: { row: { id: string; label: string; startedAt: number }; onOpen: () => void }) {
  const elapsed = useElapsed(row.startedAt, true);
  return (
    <li>
      <button type="button" className="subagent-inner-row" aria-label={`Watch ${row.label}, in the agent`} onClick={onOpen}>
        <span className="status-dot" data-status="running" aria-hidden="true" />
        <span className="subagent-inner-label">{row.label}</span>
        <span className="subagent-inner-where">in the agent</span>
        <span className="subagent-time">{formatDuration(elapsed)}</span>
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
    // The same model by either of its names: the lead on its harness's default is "Fable 5.1", and
    // the catalog calls that model "Claude Fable 5.1".
    const bare = (label: string, kind: AgentKind) => label.startsWith(`${AGENT_META[kind].label} `) ? label.slice(AGENT_META[kind].label.length + 1) : label;
    const isOwn = (k: string) => { const m = byKey.get(k); return !!m && !!own && m.kind === own.kind && bare(m.label, m.kind) === bare(own.label, own.kind); };
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
