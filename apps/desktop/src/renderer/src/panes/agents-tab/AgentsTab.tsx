import { AGENT_META, sessionModeOf, type AgentKind, type DelegatedChild, type Environment, type Session } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ScrollFades, useDissolve } from "../../components/ScrollFades";
import { activityOf, type SessionActivity } from "../../state/session-activity";
import { useApp, type DelegableModels } from "../../state/store";
import type { PaneProps } from "../registry";
import { AnswerHere } from "../session/AnswerHere";
import { permissionMark } from "../session/Composer";
import { harnessSubagents, useOpenChild } from "../session/DelegatedRuns";
import { isPlanDecision } from "../session/PlanCard";
import { formatDuration } from "../session/tool-group";
import type { Block } from "../session/transcript-model";
import { useElapsed } from "../session/use-elapsed";
import { canSend, delegationBrief, type BriefPick } from "./brief";
import { ModelChooser, OWN } from "./ModelChooser";
import { STATE_LABEL, childTitle, isLive, modelLabel, orchestratorOrder, reportSummary, rollup, spentMs, subagentElapsed, subagentState, type SubagentState } from "./subagent-state";

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
  // And again whenever a child changes state: a wait starting or ending is what moves its spent
  // budget from ticking to held, and only the server knows how long it was held.
  const statuses = useApp((s) => (s.subagents[leadId] ?? NO_CHILDREN).map((c) => s.sessionStatus[c.session.id] ?? "").join(","));
  const seenStatuses = useRef(statuses);
  useEffect(() => {
    if (seenStatuses.current === statuses) return;
    seenStatuses.current = statuses;
    run(() => refreshSubagents(leadId));
  }, [statuses, leadId, refreshSubagents, run]);

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
  const sessionStatus = useApp((s) => s.sessionStatus);
  const runs = useApp((s) => s.delegatedRuns[leadId]);
  const stateOf = (c: DelegatedChild) => subagentState(c, sessionStatus[c.session.id], runs?.some((r) => r.sessionId === c.session.id) ?? false);
  const ordered = orchestratorOrder(children, stateOf);
  const states = ordered.map(stateOf);
  const live = ordered.filter((_, i) => isLive(states[i]!));
  // The oldest thing still going — how long this session has had agents out.
  const since = live.length > 0 ? Math.min(...live.map((c) => c.startedAt)) : 0;
  const elapsed = useElapsed(since, live.length > 0);
  // Nothing until the list has answered: an empty state shown for the moment before cards arrive is
  // a claim that there are none.
  if (!loaded) return null;
  if (children.length === 0) return <SubagentsEmpty />;
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
        {ordered.map((c) => <SubagentCard key={c.session.id} child={c} leadId={leadId} flash={flash === c.session.id} onOpen={onOpen} />)}
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

/** Where a child works: its worktree's branch, or the checkout it shares. Nothing where this window
 *  holds no environment for it — a "—" would be a claim. */
function whereLabel(env: Environment | undefined): { text: string; branch: boolean } | null {
  if (!env) return null;
  if (env.kind === "primary") return { text: "primary checkout", branch: false };
  const name = env.branch ?? env.path.split("/").filter(Boolean).pop() ?? "";
  return name ? { text: name, branch: env.branch !== null } : null;
}

const NO_BLOCKS: readonly Block[] = [];

/**
 * One sub-agent as a card of the orchestrator: where it stands, on what, where, in which mode and how
 * much of its budget is spent, what it is doing — and, opened, its request to answer in place and
 * what can be done about it.
 *
 * The summary is the card's disclosure. A card waiting on you is open until you fold it, because the
 * request in it is the reason anyone came here; a card asked for from a transcript line opens too.
 */
function SubagentCard({ child, leadId, flash, onOpen, nested = false }: {
  child: DelegatedChild; leadId: string; flash: boolean; onOpen: (childId: string) => void; nested?: boolean;
}) {
  const id = child.session.id;
  const live = useApp((s) => s.sessionStatus[id]);
  const inFlight = useApp((s) => s.delegatedRuns[leadId]?.some((r) => r.sessionId === id) ?? false);
  const liveDoing = useApp((s) => s.sessionActivity[id]);
  const probe = useApp((s) => s.agentProbe);
  const env = useApp((s) => s.environments[child.session.environmentId]);
  const blocks = useApp((s) => s.transcripts[id]?.t.blocks ?? NO_BLOCKS);
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
  const brief = (child.goal ?? "").trim();

  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? state === "waiting";
  const [messaging, setMessaging] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!flash) return;
    setOpened(true);
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [flash]);
  const detailId = `subagent-detail-${id}`;
  return (
    <li ref={ref} className="subagent subagent-card" data-state={state} data-flash={flash || undefined} data-open={open || undefined} data-nested={nested || undefined}>
      <button ref={toggle} type="button" className="subagent-summary" aria-expanded={open} aria-controls={open ? detailId : undefined}
        aria-label={`${title}. ${model} on ${AGENT_META[kind].label}. ${STATE_LABEL[state]}, ${formatDuration(elapsed)}.`}
        onClick={() => setOpened(!open)}>
        <span className="subagent-top">
          <span className="subagent-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span>
          <span className="subagent-task">{title}</span>
          <span className="subagent-state"><StateMark state={state} />{STATE_LABEL[state]}<span className="subagent-time">{formatDuration(elapsed)}</span></span>
        </span>
        <span className="subagent-facts">
          <Icon name={AGENT_META[kind].icon} size={14} colored className="subagent-mark" />
          <span className="subagent-model">{model}</span>
          <span className="subagent-harness">{AGENT_META[kind].label}</span>
          {where && <span className="subagent-where" data-branch={where.branch || undefined} title={env?.path}>{where.text}</span>}
          <span className="subagent-mode" title={`Runs in ${mode.label}`}><Icon name={mode.icon} size={12} />{mode.label}</span>
          {spent !== null && child.budgetMs != null && (
            <span className="subagent-budget" title="Working time spent of its budget. Time waiting on you is not counted.">
              {formatDuration(spent)} of {formatDuration(child.budgetMs)}
            </span>
          )}
        </span>
        {doing && <span className="subagent-doing"><Icon name={doing.icon} size={12} /><span className="subagent-doing-text">{doing.text}</span></span>}
        {child.note && <span className="subagent-note">{child.note}</span>}
        {summary && <span className="subagent-report">{summary}</span>}
      </button>
      {inAgent.length > 0 && (
        <ul className="subagent-inner" aria-label={`Sub-agents ${title} is running in the agent`}>
          {inAgent.map((h) => <HarnessRow key={h.id} sessionId={id} row={h} onOpen={onOpen} />)}
        </ul>
      )}
      {child.children && child.children.length > 0 && (
        <ul className="subagents-list subagent-nested" aria-label={`Sub-agents ${title} started`}>
          {child.children.map((g) => <SubagentCard key={g.session.id} child={g} leadId={id} flash={false} onOpen={onOpen} nested />)}
        </ul>
      )}
      {open && (
        <div className="subagent-detail" id={detailId}>
          {brief && brief !== title && <Brief text={brief} />}
          {state === "waiting" && (
            <AnswerHere id={`subagent-ask-${id}`} session={child.session} asker={title}
              onLeave={() => { setOpened(false); toggle.current?.focus(); }} />
          )}
          <div className="subagent-actions">
            <button type="button" className="btn-quiet" onClick={() => onOpen(id)}>Open transcript</button>
            <button type="button" className="btn-quiet" aria-expanded={messaging} onClick={() => setMessaging((v) => !v)}>Message</button>
            {(state === "working" || state === "waiting") && <StopButton id={id} title={title} />}
          </div>
          {messaging && <MessageField child={child} title={title} leadId={leadId} onDone={() => setMessaging(false)} />}
        </div>
      )}
    </li>
  );
}

/** The whole task the child was handed, capped and dissolving where it scrolls. */
function Brief({ text }: { text: string }) {
  const scroller = useRef<HTMLParagraphElement>(null);
  useDissolve(scroller);
  return <p className="subagent-goal" ref={scroller}>{text}</p>;
}

/** Stop names what it stops, and asks nothing first: a stopped sub-agent keeps its transcript, and
 *  its lead is told a person stopped it (design.md: a confirm is owed by the object). */
function StopButton({ id, title }: { id: string; title: string }) {
  const interruptSession = useApp((s) => s.interruptSession);
  const run = useApp((s) => s.run);
  return <button type="button" className="btn-quiet" title={`Stop ${title}`} aria-label={`Stop ${title}`} onClick={() => run(() => interruptSession(id))}>Stop</button>;
}

/** A line to one sub-agent. Its placeholder says where the words go — and, once its run has ended,
 *  that the lead may never read the reply. */
function MessageField({ child, title, leadId, onDone }: { child: DelegatedChild; title: string; leadId: string; onDone: () => void }) {
  const sendMessage = useApp((s) => s.sendMessage);
  const lead = useApp((s) => s.sessions[leadId] ?? s.allSessions[leadId]);
  const run = useApp((s) => s.run);
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const consequence = child.outcome !== null ? ` If its run was already collected, ${lead?.title ?? "this session"} will not see the reply.` : "";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    run(async () => { await sendMessage(child.session.id, t); setText(""); onDone(); });
  };
  return (
    // data-no-agent: words sent in the user's name to an agent — an agent driving the window must not
    // be able to instruct its sibling through here.
    <div className="subagent-message" data-no-agent="message to a sub-agent">
      <input ref={field} value={text} aria-label={`Message ${title}`} placeholder={`Goes to this agent only.${consequence}`} title={`Goes to this agent only.${consequence}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); send(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(); }
        }} />
      <button type="button" className="btn-quiet" disabled={!text.trim()} onClick={send}>Send</button>
    </div>
  );
}

/** A sub-agent the CHILD's harness is running in its own process — no session behind it, so a click
 *  shows its calls on the panel docked to the child's transcript, beside this tab. */
function HarnessRow({ sessionId, row, onOpen }: { sessionId: string; row: { id: string; label: string; startedAt: number }; onOpen: (childId: string) => void }) {
  const docked = useApp((s) => s.sessionDock[sessionId]);
  const toggleSessionDock = useApp((s) => s.toggleSessionDock);
  const elapsed = useElapsed(row.startedAt, true);
  const watching = docked?.kind === "subagent" && docked.toolUseId === row.id;
  return (
    <li>
      <button type="button" className="subagent-inner-row" aria-label={`Watch ${row.label}, in the agent`}
        onClick={() => { onOpen(sessionId); if (!watching) toggleSessionDock(sessionId, { kind: "subagent", toolUseId: row.id }); }}>
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
