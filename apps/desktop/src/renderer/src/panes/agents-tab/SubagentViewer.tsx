import { AGENT_META, sessionModeOf, type AgentKind, type DelegatedChild, type Environment } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDissolve } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import { harnessState, labelOf, useOpenChild } from "../session/DelegatedRuns";
import { Markdown } from "../session/Markdown";
import { PendingRequest } from "../session/PendingRequest";
import type { SessionSubagent } from "../session/session-subagents";
import { ToolCard } from "../session/ToolCard";
import { Transcript } from "../session/Transcript";
import { findToolNode, flattenRun, formatDuration, summarizeToolRun, withEnter, type ToolBlock, type ToolNode } from "../session/tool-group";
import { emptyTranscript, waitingToolIds, type Block } from "../session/transcript-model";
import { useElapsed } from "../session/use-elapsed";
import { StateMark } from "./StateMark";
import { STATE_LABEL, childTitle, isLive, modelLabel, subagentElapsed, subagentState, type SubagentState } from "./subagent-state";

/**
 * One sub-agent, opened in its lead's Agents tab: what it is, where it stands, what it is doing and
 * what it came back with — beside the lead's transcript rather than over it, so the lead stays
 * readable and its prompter stays live while the sub-agent is looked at.
 *
 * Both kinds draw the same frame. A delegated child is a whole session, so its body is its own
 * transcript, drawn by the transcript's renderer and streaming as it does in a pane, with its
 * requests answerable in place and a footer that can message it, stop it, or open it as a session.
 * A harness's own `Task`/`Agent` has no session: its body is the calls it made under its launching
 * call, which are the whole of its visible working life, and nothing can be sent to it or stop it
 * alone — so its footer is not drawn rather than drawn dead (design.md: offer a capability only
 * where its owner has said it exists).
 *
 * Escape goes back to the overview. A request card in the transcript takes Escape as Deny, and a
 * person leaving a view they only looked at must never send one, so the viewer catches it first.
 */
export function SubagentViewer({ leadId, shown }: { leadId: string; shown: ShownSubagent }) {
  const showSubagent = useApp((s) => s.showSubagent);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault(); e.stopPropagation();
    showSubagent(leadId, null);
  };
  return shown.kind === "harness"
    ? <HarnessView leadId={leadId} agentId={shown.id} onKeyDownCapture={onKeyDownCapture} />
    : <ChildView leadId={shown.leadId} child={shown.child} onKeyDownCapture={onKeyDownCapture} />;
}

/** What the tab has been asked to show, resolved: a harness agent of the lead's, or a delegated
 *  child at any depth (`leadId` is the session that started it, which is whose runs say it is live). */
export type ShownSubagent = { kind: "harness"; id: string } | { kind: "child"; child: DelegatedChild; leadId: string };

/** Find a delegated child by session id among a lead's children and theirs. */
export function findChild(children: readonly DelegatedChild[], id: string, leadId: string): { child: DelegatedChild; leadId: string } | null {
  for (const c of children) {
    if (c.session.id === id) return { child: c, leadId };
    const deeper = c.children ? findChild(c.children, id, c.session.id) : null;
    if (deeper) return deeper;
  }
  return null;
}

/**
 * The lead's sub-agents as a strip of tabs over the viewer, "All" first: one click between siblings,
 * each wearing its state's mark, and ←/→ along them as a tab strip takes them. The strip is the data
 * of unbounded length here, so it scrolls sideways and dissolves where it has more.
 *
 * A tab chosen by key takes the keyboard with it; one chosen by Escape from the viewer gets it back,
 * since the viewer it was in has gone.
 */
export function SubagentSwitch({ leadId, agents, shown }: { leadId: string; agents: readonly SessionSubagent[]; shown: string | null }) {
  const showSubagent = useApp((s) => s.showSubagent);
  const strip = useRef<HTMLDivElement>(null);
  useDissolve(strip, "x");
  const ids = useMemo(() => [null, ...agents.map((a) => a.id)], [agents]);
  const at = ids.indexOf(shown);
  useEffect(() => {
    const tab = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const active = document.activeElement;
    if (tab && (active === document.body || active === null || strip.current?.contains(active))) tab.focus();
  }, [at]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    showSubagent(leadId, ids[(to + ids.length) % ids.length] ?? null);
  };
  return (
    <div className="subagent-switch" ref={strip} role="tablist" aria-label="Sub-agents" onKeyDown={onKeyDown}>
      <button type="button" role="tab" className="subagent-switch-tab" aria-selected={at === 0} tabIndex={at === 0 || at === -1 ? 0 : -1}
        title="Every sub-agent, and work to hand them" onClick={() => showSubagent(leadId, null)}>
        <Icon name="agents" size={14} />
        <span className="subagent-switch-label">All</span>
      </button>
      {agents.map((a, i) => (
        <button key={a.id} type="button" role="tab" className="subagent-switch-tab" data-state={a.state}
          aria-selected={at === i + 1} tabIndex={at === i + 1 ? 0 : -1} aria-label={`${a.title}, ${STATE_LABEL[a.state]}`}
          title={`${a.title} — ${STATE_LABEL[a.state]}`} onClick={() => showSubagent(leadId, a.id)}>
          <span className="subagent-switch-mark"><StateMark state={a.state} /></span>
          <span className="subagent-switch-label">{a.title}</span>
        </button>
      ))}
    </div>
  );
}

/** The viewer's frame: the head, the result once there is one, the body, and the foot if any. */
function Frame({ title, facts, result, foot, children, onKeyDownCapture }: {
  title: string; facts: ReactNode; result: ReactNode; foot?: ReactNode; children: ReactNode;
  onKeyDownCapture: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <section className="subagent-view" aria-label={`Sub-agent: ${title}`} onKeyDownCapture={onKeyDownCapture}>
      <header className="subagent-view-head">
        <h2 className="subagent-view-title" title={title}>{title}</h2>
        <div className="subagent-view-facts">{facts}</div>
      </header>
      {result}
      <div className="subagent-view-body">{children}</div>
      {foot}
    </section>
  );
}

/** Where it stands in words and its mark, how long, on what, and in which checkout — the line under
 *  the title. The state is said, never only coloured. */
function Facts({ state, elapsed, kind, model, where }: {
  state: SubagentState; elapsed: number; kind: AgentKind; model: string; where?: { text: string; branch: boolean; path?: string } | null;
}) {
  return (
    <>
      <span className="subagent-view-state" data-state={state}><StateMark state={state} />{STATE_LABEL[state]}</span>
      <span className="subagent-view-time">{formatDuration(elapsed)}</span>
      <span className="subagent-view-model"><Icon name={AGENT_META[kind].icon} size={14} colored />{model}</span>
      {where && (
        <span className="subagent-view-where" data-branch={where.branch || undefined} title={where.path}>
          {where.branch && <Icon name="branch" size={12} />}{where.text}
        </span>
      )}
    </>
  );
}

/**
 * What it came back with, pinned under the head once it has ended: the report is the reason anyone
 * delegated, and it should not be a scroll to the bottom of the agent's whole log away. Capped, and
 * dissolving where it scrolls, so a long report cannot push the log off the panel.
 */
function Result({ text, failed }: { text: string; failed: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  return (
    <section className="subagent-view-result" data-error={failed || undefined} aria-label={failed ? "How it ended" : "What it reported"}>
      <h3 className="subagent-view-result-head">
        <Icon name={failed ? "errorCircle" : "checkCircle"} size={14} />{failed ? "How it ended" : "What it reported"}
      </h3>
      <div className="subagent-view-result-scroll" ref={scroller}><Markdown text={text} className="subagent-view-prose" /></div>
    </section>
  );
}

/** Where a child works: its worktree's branch, or the checkout it shares. Nothing where this window
 *  holds no environment for it — a "—" would be a claim. */
export function whereLabel(env: Environment | undefined): { text: string; branch: boolean; path: string } | null {
  if (!env) return null;
  if (env.kind === "primary") return { text: "primary checkout", branch: false, path: env.path };
  const name = env.branch ?? env.path.split("/").filter(Boolean).pop() ?? "";
  return name ? { text: name, branch: env.branch !== null, path: env.path } : null;
}

const NO_BLOCKS: readonly Block[] = [];
const NO_REQUESTS = emptyTranscript().pendingPermissions;

/** A delegated child: its own session's transcript, live, with its requests and a foot to act on it. */
function ChildView({ leadId, child, onKeyDownCapture }: { leadId: string; child: DelegatedChild; onKeyDownCapture: (e: KeyboardEvent<HTMLElement>) => void }) {
  const id = child.session.id;
  const live = useApp((s) => s.sessionStatus[id]);
  const inFlight = useApp((s) => s.delegatedRuns[leadId]?.some((r) => r.sessionId === id) ?? false);
  const transcript = useApp((s) => s.transcripts[id]?.t);
  const env = useApp((s) => s.environments[child.session.environmentId]);
  const probe = useApp((s) => s.agentProbe);
  const openSession = useApp((s) => s.openSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  // A child nobody has opened has no transcript in this window yet; the viewer is what reads it, and
  // from then on its events stream into it as they would into a pane.
  const loaded = transcript !== undefined;
  useEffect(() => { if (!loaded) run(() => openSession(id)); }, [loaded, id, openSession, run]);
  const state = subagentState(child, live, inFlight);
  const ticking = isLive(state);
  const runningFor = useElapsed(child.startedAt, ticking);
  const elapsed = ticking ? runningFor : subagentElapsed(child, state, Date.now());
  const kind = child.session.agentKind;
  const title = childTitle(child);
  const status = live ?? child.session.status;
  const ended = !isLive(state);
  return (
    <Frame title={title} onKeyDownCapture={onKeyDownCapture}
      facts={<Facts state={state} elapsed={elapsed} kind={kind} model={`${modelLabel(kind, child.session.model, probe)} on ${AGENT_META[kind].label}`} where={whereLabel(env)} />}
      result={ended && child.report ? <Result text={child.report} failed={state === "failed" || state === "timeout"} /> : null}
      foot={<ChildFoot leadId={leadId} child={child} title={title} state={state} />}>
      {transcript && (
        <Transcript transcript={transcript} sessionStatus={status} visible focused={false} cwd={child.session.cwd || null}
          mode={sessionModeOf(child.session.permissionMode)} requestsOwnEscape={false}
          onDecide={(requestId, d, answers) => run(() => respondPermission(id, requestId, d, answers))} />
      )}
    </Frame>
  );
}

/**
 * What can be done about a child from here: stop it while it works, open it as the session it is,
 * and send it a line. Stop asks nothing first — a stopped sub-agent keeps its transcript and its lead
 * is told a person stopped it — and the message field says, once its run has ended, that the lead may
 * never read the reply.
 */
function ChildFoot({ leadId, child, title, state }: { leadId: string; child: DelegatedChild; title: string; state: SubagentState }) {
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const lead = useApp((s) => s.sessions[leadId] ?? s.allSessions[leadId]);
  const run = useApp((s) => s.run);
  const openChild = useOpenChild();
  const [text, setText] = useState("");
  const id = child.session.id;
  const consequence = child.outcome !== null ? ` If its run was already collected, ${lead?.title ?? "its lead"} will not see the reply.` : "";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    run(async () => { await sendMessage(id, t); setText(""); });
  };
  return (
    <footer className="subagent-view-foot">
      <div className="subagent-view-actions">
        {(state === "working" || state === "waiting") && (
          <button type="button" className="btn-quiet" title={`Stop ${title}`} aria-label={`Stop ${title}`} onClick={() => run(() => interruptSession(id))}>
            <Icon name="stop" size={14} />Stop
          </button>
        )}
        <button type="button" className="btn-quiet subagent-view-open" title="Open it as a session, with its own prompter" onClick={() => openChild(id)}>
          <Icon name="session" size={14} />Open as session
        </button>
      </div>
      {/* data-no-agent: words sent in the user's name to an agent — an agent driving the window must
          not be able to instruct its sibling through here. */}
      <div className="subagent-view-compose" data-no-agent="message to a sub-agent">
        <input value={text} aria-label={`Message ${title}`} placeholder="Message this sub-agent" title={`Goes to this agent only.${consequence}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button type="button" className="composer-send subagent-view-send" disabled={!text.trim()}
          aria-label={`Send to ${title}`} title="Send to this sub-agent only (↩)" onClick={send}>
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
    </footer>
  );
}

/** One of the lead's own harness agents: the brief it was handed, the calls it has made under its
 *  launching call, the requests among them waiting on you, and its report once it has one. */
function HarnessView({ leadId, agentId, onKeyDownCapture }: { leadId: string; agentId: string; onKeyDownCapture: (e: KeyboardEvent<HTMLElement>) => void }) {
  const blocks = useApp((s) => s.transcripts[leadId]?.t.blocks ?? NO_BLOCKS);
  const kind = useApp((s) => (s.sessions[leadId] ?? s.allSessions[leadId])?.agentKind ?? "claude");
  const leadStatus = useApp((s) => s.sessionStatus[leadId] ?? "idle");
  const node = useMemo(() => findToolNode(blocks, agentId), [blocks, agentId]);
  const live = leadStatus === "running" || leadStatus === "waiting_permission";
  const block = node?.block as ToolBlock | undefined;
  const state = block ? harnessState(block, live) : "stopped";
  const ticking = state === "working";
  const runningFor = useElapsed(block?.ts ?? 0, ticking);
  const elapsed = ticking ? runningFor : block?.endedAt !== undefined ? Math.max(0, block.endedAt - block.ts) : 0;
  const title = block ? labelOf(block.input).slice(0, 80) : "Sub-agent";
  const type = typeof block?.input.subagent_type === "string" && block.input.subagent_type.trim() ? block.input.subagent_type.trim() : "Sub-agent";
  // A background agent's call result is its launch receipt, not a report: only a blocking call's
  // result is what the agent came back with.
  const report = block && block.background === undefined && block.result ? block.result : null;
  return (
    <Frame title={title} onKeyDownCapture={onKeyDownCapture}
      facts={<Facts state={state} elapsed={elapsed} kind={kind} model={`${type} inside ${AGENT_META[kind].label}`} />}
      result={report && state !== "working" ? <Result text={report.content} failed={report.isError} /> : null}>
      {node === null
        // The one honest failure: a call this transcript does not hold — the viewer outlived a
        // compaction that dropped the launching call.
        ? <p className="subagent-view-empty">This agent's call is no longer in the transcript.</p>
        : <HarnessLog leadId={leadId} node={node} working={state === "working"} />}
    </Frame>
  );
}

function HarnessLog({ leadId, node, working }: { leadId: string; node: ToolNode; working: boolean }) {
  const blocks = useApp((s) => s.transcripts[leadId]?.t.blocks ?? NO_BLOCKS);
  const pending = useApp((s) => (s.sessionStatus[leadId] === "waiting_permission" ? s.transcripts[leadId]?.t.pendingPermissions ?? NO_REQUESTS : NO_REQUESTS));
  const sessionStatus = useApp((s) => s.sessionStatus[leadId] ?? "idle");
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const block = node.block as ToolBlock;
  const brief = typeof block.input.prompt === "string" ? block.input.prompt : "";
  // Nothing entering: these cards are being read, not streamed into view at the transcript's edge.
  const steps = useMemo(() => withEnter(node.nested, () => false), [node.nested]);
  const calls = useMemo(() => flattenRun(node.nested), [node.nested]);
  const count = summarizeToolRun(calls).tools;
  /* The lead's requests that are THIS agent's: the ones whose call hangs under its launching call.
     The lead answers for its harness, so the answer goes to the lead's session. */
  const mine = useMemo(() => {
    const under = new Set(calls.map((c) => c.toolUseId));
    return pending.filter((p) => waitingToolIds(blocks, [p]).some((id) => under.has(id)));
  }, [pending, blocks, calls]);
  return (
    <div className="subagent-view-log" ref={scroller}>
      {brief && (
        <section className="subagent-view-brief" aria-label="What it was asked">
          <h3 className="subagent-view-section">What it was asked</h3>
          <Markdown text={brief} className="subagent-view-prose" />
        </section>
      )}
      <section className="subagent-view-work" aria-label="What it has done">
        <h3 className="subagent-view-section">
          What it has done
          {count > 0 && <span className="subagent-view-count">{`${count} ${count === 1 ? "call" : "calls"}`}</span>}
        </h3>
        {steps.length === 0
          ? <p className="subagent-view-empty">{working ? "Nothing yet — it is still working out what to do." : "It finished without calling any tools."}</p>
          : <div className="subagent-view-steps">
              {steps.map((s) => <ToolCard key={s.key} block={s.block} sessionStatus={sessionStatus} nested={s.nested} />)}
            </div>}
      </section>
      {mine.map((p) => (
        <PendingRequest key={p.requestId} permission={p} ownsEscape={false}
          onDecide={(...decision) => run(() => respondPermission(leadId, p.requestId, ...decision))} />
      ))}
    </div>
  );
}
