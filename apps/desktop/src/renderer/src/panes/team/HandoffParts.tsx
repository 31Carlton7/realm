import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { TeamHandoff, TeamRole, TeamSpace } from "@realm/contracts";
import { realmiteState } from "../../components/sidebar/TeamRows";
import { useApp } from "../../state/store";
import { backoffLine, feedTime, goalLine, handoffChip, limitsLine, meter, money, spendLine } from "./team-format";

/**
 * Teams, Phase 4 on the team's pages: handoffs between roles, a role's goal, who it hands work to and
 * whether a mention wakes it, the week's budgets and run caps, how many runs go at once, and an
 * engine's back-off. Every Realmite here wears its role's state — working, needs you, asleep — never a
 * mood.
 */

type RoleLike = Pick<TeamRole, "id" | "name" | "realmite"> & Partial<Pick<TeamRole, "state">>;

function Mite({ role, size = 16 }: { role: RoleLike | undefined; size?: number }) {
  if (!role) return <Icon name="user" size={12} />;
  return <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={size} {...(role.state ? { state: realmiteState({ state: role.state }) } : {})} />;
}

const roleOf = (team: TeamSpace, id: string | null): RoleLike | undefined =>
  id ? team.roles.find((r) => r.id === id) ?? team.formerRoles.find((r) => r.id === id) : undefined;

/** An engine said its account is at its limit: unattended runs wait, and the person may let them go. */
export function BackoffNote({ team }: { team: TeamSpace }) {
  const lift = useApp((s) => s.liftTeamBackoff);
  const run = useApp((s) => s.run);
  if (team.limits.backoff.length === 0) return null;
  return (
    <div className="tp-banner" role="status">
      {team.limits.backoff.map((b) => (
        <div key={b.agentKind} className="tp-banner-row">
          <Icon name="clock" size={16} className="tp-banner-glyph" />
          <span className="tp-banner-text">{backoffLine(b)}</span>
          <button type="button" className="btn" onClick={() => run(() => lift(team.spaceId, b.agentKind))}
            title="Let queued runs start now. If the limit still holds, the engine will say so again.">Try now</button>
        </div>
      ))}
    </div>
  );
}

/** Handoffs and mentions, one line each: who passed work to whom, its note, and where it stands. */
export function HandoffLines({ team, rows }: { team: TeamSpace; rows: readonly TeamHandoff[] }) {
  const revealSession = useApp((s) => s.revealSession);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  const run = useApp((s) => s.run);
  if (rows.length === 0) return null;
  return (
    <ul className="tp-handoffs">
      {rows.map((h) => {
        const from = roleOf(team, h.fromRoleId);
        const to = roleOf(team, h.toRoleId);
        const chip = handoffChip(h.state);
        const who = h.kind === "mention" ? (from ? `${from.name} asked ${to?.name ?? "a role"}` : `You mentioned ${to?.name ?? "a role"}`)
          : `${from?.name ?? "A role"} handed work to ${to?.name ?? "a role"}`;
        const open = h.sessionId ? () => { closePageOverlay(); run(() => revealSession(h.sessionId!, h.spaceId).then(() => undefined)); } : undefined;
        return (
          <li key={h.id}>
            <time>{feedTime(h.createdAt)}</time>
            <span className="tp-handoff-pair" aria-hidden="true">
              {h.kind === "mention" && !from ? <Icon name="user" size={12} /> : <Mite role={from} />}
              <Icon name="arrowRight" size={12} className="tp-handoff-arrow" />
              <Mite role={to} />
            </span>
            <span className="tp-handoff-text">
              {open ? <button type="button" className="tp-run-link" onClick={open} title="Open the session doing this work">{who}</button> : who}
              <small> · “{h.note.length > 140 ? `${h.note.slice(0, 139)}…` : h.note}”{h.recordPath ? ` · ${h.recordPath}` : ""}{h.files.length ? ` · ${h.files.length} file${h.files.length === 1 ? "" : "s"}` : ""}</small>
            </span>
            <span className="tp-chip" data-tone={chip.tone ?? undefined}>{chip.word}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The team's week and how many of its runs go at once — the budget and the plan-limit protection,
 *  both editable where they are read. */
export function TeamBudget({ team }: { team: TeamSpace }) {
  const setTeamBudget = useApp((s) => s.setTeamBudget);
  const setTeamLimits = useApp((s) => s.setTeamLimits);
  const run = useApp((s) => s.run);
  const [editing, setEditing] = useState(false);
  const [week, setWeek] = useState(String(team.weekBudgetUsd));
  const m = meter(team.weekSpendUsd, team.weekBudgetUsd);
  const save = () => {
    const n = Number(week);
    if (!(n > 0)) return;
    run(async () => { await setTeamBudget(team.spaceId, n); setEditing(false); });
  };
  const steps = [1, 2, 3, 4, 5];
  return (
    <ul className="settings-list">
      <li className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">The team's week</span>
          <span className="settings-row-detail t-num">{spendLine(team.weekSpendUsd, team.weekBudgetUsd)} · at its week a role skips its clock until Monday</span>
        </div>
        {editing ? (
          <form className="tp-num-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <span className="tp-num-unit">$</span>
            <input className="tp-num-field" inputMode="decimal" autoFocus value={week} aria-label="The team's week, in dollars"
              onChange={(e) => setWeek(e.target.value.replace(/[^\d.]/g, ""))} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />
            <button type="submit" className="btn primary" disabled={!(Number(week) > 0)}>Save</button>
          </form>
        ) : (
          <>
            {m && <span className="tp-meter tp-meter-wide" data-high={m.high || undefined} role="meter" aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100} aria-label="The team's week spent"><i style={{ width: `${m.pct}%` }} /></span>}
            <button type="button" className="btn-quiet" onClick={() => { setWeek(String(team.weekBudgetUsd)); setEditing(true); }}>Edit</button>
          </>
        )}
      </li>
      <li className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Runs at once</span>
          <span className="settings-row-detail t-num">{limitsLine(team.limits)} · the rest wait their turn</span>
        </div>
        <label className="tp-step">
          <span className="tp-step-label">This team</span>
          <select value={team.limits.teamMaxLive} aria-label="This team's runs at once"
            onChange={(e) => run(() => setTeamLimits(team.spaceId, { teamMaxLive: Number(e.target.value) }))}>
            {steps.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="tp-step">
          <span className="tp-step-label">All of Realm</span>
          <select value={team.limits.realmMaxUnattended} aria-label="Unattended runs at once across Realm"
            onChange={(e) => run(() => setTeamLimits(team.spaceId, { realmMaxUnattended: Number(e.target.value) }))}>
            {steps.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </li>
    </ul>
  );
}

/** A role's week and its run caps, read and edited in one row. */
export function RoleBudget({ role }: { role: TeamRole }) {
  const updateRole = useApp((s) => s.updateRole);
  const run = useApp((s) => s.run);
  const [editing, setEditing] = useState(false);
  const [week, setWeek] = useState("");
  const [cap, setCap] = useState("");
  const [mins, setMins] = useState("");
  const m = meter(role.weekSpendUsd, role.weekBudgetUsd);
  const open = () => {
    setWeek(role.weekBudgetUsd === null ? "" : String(role.weekBudgetUsd));
    setCap(String(role.runCapUsd)); setMins(String(Math.round(role.runCapMs / 60_000))); setEditing(true);
  };
  const valid = Number(cap) > 0 && Number(mins) >= 1 && Number(mins) <= 1440 && (week.trim() === "" || Number(week) > 0);
  const save = () => {
    if (!valid) return;
    run(async () => {
      await updateRole({ id: role.id, weekBudgetUsd: week.trim() === "" ? null : Number(week), runCapUsd: Number(cap), runCapMs: Math.round(Number(mins)) * 60_000 });
      setEditing(false);
    });
  };
  const num = (v: string, set: (s: string) => void, label: string, unit: string, before = true) => (
    <label className="tp-num-form">
      {before && <span className="tp-num-unit">{unit}</span>}
      <input className="tp-num-field" inputMode="decimal" value={v} aria-label={label} onChange={(e) => set(e.target.value.replace(/[^\d.]/g, ""))} />
      {!before && <span className="tp-num-unit">{unit}</span>}
    </label>
  );
  return (
    <li className="settings-row tp-budget-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Budget</span>
        <span className="settings-row-detail t-num">{spendLine(role.weekSpendUsd, role.weekBudgetUsd)} · a run stops at {money(role.runCapUsd)} or {Math.round(role.runCapMs / 60_000)} minutes{role.pausedWhy ? ` · paused: ${role.pausedWhy}` : ""}</span>
      </div>
      {editing ? (
        <form className="tp-budget-form" onSubmit={(e) => { e.preventDefault(); save(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }}>
          <span className="tp-step-label">Week</span>{num(week, setWeek, `${role.name}'s week, in dollars (empty for none)`, "$")}
          <span className="tp-step-label">A run</span>{num(cap, setCap, `${role.name}'s run limit, in dollars`, "$")}
          {num(mins, setMins, `${role.name}'s run limit, in minutes`, "min", false)}
          <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!valid}>Save</button>
        </form>
      ) : (
        <>
          {m && <span className="tp-meter tp-meter-wide" data-high={m.high || undefined} role="meter" aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Spent this week"><i style={{ width: `${m.pct}%` }} /></span>}
          <button type="button" className="btn-quiet" onClick={open}>Edit</button>
        </>
      )}
    </li>
  );
}

/** Who this role hands work to: the team's other roles as switches, one press each. */
export function HandsOffTo({ role, team }: { role: TeamRole; team: TeamSpace }) {
  const setRoleHandoffs = useApp((s) => s.setRoleHandoffs);
  const run = useApp((s) => s.run);
  const others = team.roles.filter((r) => r.id !== role.id);
  const toggle = (id: string) => {
    const next = role.handsOffTo.includes(id) ? role.handsOffTo.filter((x) => x !== id) : [...role.handsOffTo, id];
    run(() => setRoleHandoffs({ id: role.id, handsOffTo: next }));
  };
  return (
    <li className="settings-row tp-edges-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Hands off to</span>
        <span className="settings-row-detail">{role.handsOffTo.length ? "It can pass work on to these roles, with a note and the files; each wakes as a run of its own" : "No one yet — pick who it may pass work to"}</span>
      </div>
      <div className="tp-edges" role="group" aria-label={`Roles ${role.name} hands off to`}>
        {others.map((r) => {
          const on = role.handsOffTo.includes(r.id);
          return (
            <button key={r.id} type="button" className="tp-edge" aria-pressed={on} onClick={() => toggle(r.id)}>
              <Realmite spec={parseRealmiteSpec(r.realmite, r.id)} size={16} state={realmiteState(r)} />{r.name}
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** A role's goal: what it is working toward and where the loop stands, or the way to give it one. */
export function RoleGoalPanel({ role }: { role: TeamRole }) {
  const giveRoleGoal = useApp((s) => s.giveRoleGoal);
  const run = useApp((s) => s.run);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (writing) field.current?.focus(); }, [writing]);
  const live = role.goal && (role.goal.status === "active" || role.goal.status === "queued");
  const send = () => { const t = text.trim(); if (t) run(async () => { await giveRoleGoal(role.id, t); setText(""); setWriting(false); }); };
  const line = role.goal ? goalLine(role.goal) : null;
  return (
    <>
      {role.goal && line && (
        <div className="tp-goal">
          <Icon name="target" size={16} className="tp-goal-glyph" />
          <div className="tp-goal-text">
            <span className="tp-goal-objective">{role.goal.objective}</span>
            <span className="tp-goal-line">{line.text}</span>
          </div>
          {line.tone && <span className="tp-chip" data-tone={line.tone}>{line.tone === "ok" ? "Met" : "Stopped"}</span>}
        </div>
      )}
      {writing ? (
        <form className="tp-message" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea ref={field} className="tp-message-field" rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label={`A goal for ${role.name}`}
            placeholder={`What should ${role.name} keep working toward? It continues turn after turn until it says it is met or stuck.`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              if (e.key === "Escape") { e.stopPropagation(); setWriting(false); }
            }} />
          <div className="tp-message-foot">
            <span className="tp-make-note">Stops at {money(role.runCapUsd)} or {Math.round(role.runCapMs / 60_000)} minutes, or after three turns that change nothing.</span>
            <button type="button" className="btn" onClick={() => setWriting(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!text.trim()}>Give goal (⌘↩)</button>
          </div>
        </form>
      ) : !live && (
        <button type="button" className="btn tp-goal-new" onClick={() => setWriting(true)}><Icon name="target" size={16} />Give {role.name} a goal…</button>
      )}
    </>
  );
}

/** The wake a mention is, as a switch row. */
export function MentionWake({ role }: { role: TeamRole }) {
  const setRoleHandoffs = useApp((s) => s.setRoleHandoffs);
  const run = useApp((s) => s.run);
  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">When someone @mentions it</span>
        <span className="settings-row-detail">It answers as that session's sub-agent, never in a looser mode than the session</span>
      </div>
      <input type="checkbox" role="switch" className="switch" checked={role.wakeOnMention} aria-label="When someone @mentions it, on"
        onChange={(e) => run(() => setRoleHandoffs({ id: role.id, wakeOnMention: e.target.checked }))} />
    </li>
  );
}
