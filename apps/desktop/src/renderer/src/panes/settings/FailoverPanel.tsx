import { AGENT_META, SELECTABLE_AGENT_KINDS, agentLabel, type AgentKind, type FailoverPolicy } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { useApp } from "../../state/store";
import { agentAvailability, isBlocked } from "../../state/agent-availability";

/**
 * Failover: what happens to a turn the agent could not finish.
 *
 * Two settings, and they are deliberately unequal. The retry switch is on by default and cannot
 * surprise anyone — it finishes the turn on the agent the user picked, after a wait. The chain is
 * empty by default and stays empty until someone fills it, because handing work to another agent
 * changes who is doing it and who is billed for it, and that is a decision to make once rather than
 * one Realm makes silently at the worst possible moment.
 *
 * An agent that is not installed is offered anyway, greyed and labelled. Hiding it would make the
 * list quietly different on every machine, and someone who installs Codex tomorrow should find the
 * chain they configured today still meaning what they wrote.
 */
export function FailoverPanel() {
  const policy = useApp((s) => s.failover);
  const loadFailover = useApp((s) => s.loadFailover);
  const setFailover = useApp((s) => s.setFailover);
  const agentProbe = useApp((s) => s.agentProbe);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => loadFailover()); }, [run, loadFailover]);

  // Null is "not read yet", not "off" — a switch drawn off against an unread row would lie for a
  // frame and then jump.
  if (!policy) return <p className="env-empty">Reading this space's failover policy…</p>;

  const save = (next: FailoverPolicy) => run(() => setFailover(next));
  const inChain = (k: AgentKind) => policy.chain.includes(k);
  const toggle = (k: AgentKind) => save({
    ...policy,
    // Appended at the end rather than inserted in the list's own order: the chain is an ORDER, and
    // the order someone clicks in is the order they meant.
    chain: inChain(k) ? policy.chain.filter((x) => x !== k) : [...policy.chain, k],
  });
  const move = (k: AgentKind, by: -1 | 1) => {
    const i = policy.chain.indexOf(k);
    const j = i + by;
    if (i === -1 || j < 0 || j >= policy.chain.length) return;
    const chain = [...policy.chain];
    [chain[i], chain[j]] = [chain[j]!, chain[i]!];
    save({ ...policy, chain });
  };

  return (
    <section className="failover">
      <div className="settings-row">
        <div className="settings-row-main">
          <h4 className="settings-row-title">Retry a stalled turn</h4>
          <p className="settings-hint">
            A dropped connection or an overloaded provider is a turn that has not finished, not one
            that failed. Realm waits and asks again, up to three times, on the same agent.
          </p>
        </div>
        <input type="checkbox" role="switch" className="switch" aria-label="Retry a stalled turn"
          checked={policy.retry} onChange={(e) => save({ ...policy, retry: e.target.checked })} />
      </div>

      <div className="settings-row-main">
        <h4 className="settings-row-title">Hand over to</h4>
        <p className="settings-hint">
          {policy.chain.length === 0
            ? "Nothing. When this space's agent hits its usage limit or cannot be reached, the turn stops and says so."
            : `In order: ${policy.chain.map(agentLabel).join(" → ")}. The conversation is carried across as text — no agent can import another's, so the incoming one gets a written briefing and the same files.`}
        </p>
      </div>
      <ul className="page-list failover-list">
        {SELECTABLE_AGENT_KINDS.map((k) => {
          const meta = AGENT_META[k];
          const pos = policy.chain.indexOf(k);
          const on = pos !== -1;
          // `unknown` (the probe has not answered yet) is deliberately not "unavailable": labelling a
          // row "not installed" on no evidence is worse than saying nothing for a second.
          const blocked = isBlocked(agentAvailability(k, agentProbe));
          return (
            <li key={k} className="failover-row" data-on={on || undefined}>
              {/* The position is the point of the row when it is on: a chain is an order, and a list
                  of ticks would not say which agent is asked first. */}
              <span className="failover-pos" aria-hidden="true">{on ? pos + 1 : ""}</span>
              <span className="engine-mark"><Icon name={meta.icon} size={16} colored /></span>
              <span className="failover-name">{meta.label}</span>
              {/* Offered even when it is not installed or not signed in, and labelled rather than
                  hidden: a list that is quietly different on every machine is a list nobody can
                  reason about, and a chain configured today should still mean what it said when the
                  CLI arrives tomorrow. */}
              {blocked && <span className="failover-note">not ready</span>}
              {on && (
                <span className="failover-order">
                  <button type="button" className="icon-btn" aria-label={`Ask ${meta.label} earlier`}
                    disabled={pos === 0} onClick={() => move(k, -1)}><Icon name="arrowUp" size={12} /></button>
                  <button type="button" className="icon-btn" aria-label={`Ask ${meta.label} later`}
                    disabled={pos === policy.chain.length - 1} onClick={() => move(k, 1)}><Icon name="arrowDown" size={12} /></button>
                </span>
              )}
              <input type="checkbox" role="switch" className="switch" aria-label={`Hand over to ${meta.label}`}
                checked={on} onChange={() => toggle(k)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
