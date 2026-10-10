import { Icon, Realmite, parseRealmiteSpec, type IconName } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_TEMPLATES, mediaUrl, type TeamActivity, type TeamRecordType, type TeamRole, type TeamSpace } from "@realm/contracts";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { MODES, RoleSheet, modelLabel } from "./RoleSheet";
import { MakeTeam } from "./TeamPicker";
import { VaultPage } from "./VaultPage";
import { NewRecordTypePage, RecordPage, RecordTypePage, RecordsPage, typeGlyph, typeOfPath } from "./RecordPages";
import { BackoffNote, HandoffLines, HandsOffTo, MentionWake, RoleBudget, RoleGoalPanel, TeamBudget } from "./HandoffParts";
import { REVIEW_GLYPH, realmiteState } from "../../components/sidebar/TeamRows";
import { shortWhen } from "../schedules/schedule-model";
import { useApp, type SpacePageTab } from "../../state/store";
import {
  activitySentence, agoPhrase, duration, feedTime, meter, money, roleStateLine, runChip, sharesNote, spendLine, wakeSentence, wokeLine,
} from "./team-format";

/* ═══════════════════════════════ the column ═══════════════════════════════ */

export const isTeamTab = (tab: SpacePageTab): boolean =>
  tab === "team" || tab === "records" || tab === "roles" || tab === "vault" || tab === "activity" || tab.startsWith("role:") || tab.startsWith("record:")
  || tab.startsWith("records:") || tab.startsWith("recordtype:");

/** The kind of record a team tab is about: its list, one of its records, or its fields. */
export function tabRecordType(tab: SpacePageTab, team: TeamSpace | undefined): TeamRecordType | null {
  const types = team?.recordTypes ?? [];
  if (tab === "records") return types[0] ?? null;
  if (tab.startsWith("records:")) return types.find((t) => t.key === tab.slice(8)) ?? null;
  if (tab.startsWith("recordtype:")) return types.find((t) => t.key === tab.slice(11)) ?? null;
  if (tab.startsWith("record:")) return types.find((t) => tab.slice(7).startsWith(`${t.folder}/`)) ?? null;
  return null;
}

/** The page's name for a team tab — the head the bar and Back speak of. */
export function teamTabLabel(tab: SpacePageTab, team: TeamSpace | undefined): string {
  if (tab === "activity") return "Activity";
  if (tab === "roles") return "Roles";
  if (tab === "vault") return "Vault";
  if (tab.startsWith("role:")) return team?.roles.find((r) => r.id === tab.slice(5))?.name ?? "Role";
  if (tab === "recordtype:new") return "New record type";
  const type = tabRecordType(tab, team);
  if (tab === "records" || tab.startsWith("records:")) return type?.many ?? "Records";
  if (tab.startsWith("record:")) return (type ?? (team && typeOfPath(team, tab.slice(7))))?.one ?? "Record";
  if (tab.startsWith("recordtype:")) return type?.one ?? "Record type";
  return "Overview";
}

/**
 * The team's sections in the space page's column, under a "Team" head (the Teams plan, 13.2): the
 * Overview, each kind of record the team keeps and the roles — each of which unfolds to its members
 * while one of them is open, the open one lit — and the log. Radios, one tab stop, as every page rail
 * here is. A kind's row stays lit while its fields are being shaped.
 */
export function TeamRailList({ spaceId, team, tab, pick }: { spaceId: string; team: TeamSpace; tab: SpacePageTab; pick: (t: SpacePageTab) => void }) {
  const records = useApp((s) => s.teamRecords[spaceId]);
  const loadTeamRecords = useApp((s) => s.loadTeamRecords);
  const run = useApp((s) => s.run);
  useEffect(() => { if ((tab.startsWith("record:") || tab.startsWith("records")) && !records) run(() => loadTeamRecords(spaceId)); }, [tab, records, spaceId, loadTeamRecords, run]);
  const name = `space-page-tab-${spaceId}`;
  const row = (id: SpacePageTab, label: string, glyph: IconName | TeamRole | null, count?: number, sub = false, lit = tab === id) => (
    <label key={id} className={`settings-tab page-rail-tab${sub ? " tp-sub" : ""}${glyph && typeof glyph === "object" ? " tp-sub-role" : ""}`} data-selected={lit || undefined}>
      <input type="radio" name={name} value={id} checked={lit} onChange={() => pick(id)} />
      {glyph && (typeof glyph === "object"
        ? <span className="page-rail-glyph tp-rail-realmite"><Realmite spec={parseRealmiteSpec(glyph.realmite, glyph.id)} size={16} state={realmiteState(glyph)} /></span>
        : <Icon name={glyph} size={16} className="page-rail-glyph" />)}
      <span className="tp-rail-label">{label}</span>
      {count !== undefined && <span className="item-count tp-rail-count">{count}</span>}
    </label>
  );
  const inRoles = tab.startsWith("role:") || tab === "roles";
  const open = tabRecordType(tab, team);
  return (
    <fieldset className="page-rail-list">
      <legend className="visually-hidden">Team</legend>
      <span className="page-rail-head" aria-hidden="true">Team</span>
      {row("team", "Overview", "team")}
      {team.recordTypes.length === 0 && row("records", "Records", "records", undefined, false, tab === "records" || tab === "recordtype:new")}
      {team.recordTypes.map((t) => {
        const mine = open?.id === t.id && tab !== `recordtype:${t.key}` ? records?.filter((r) => r.path.startsWith(`${t.folder}/`)) : undefined;
        return [
          row(`records:${t.key}`, t.many, typeGlyph(t), mine?.length ? undefined : t.count, false, open?.id === t.id && (tab === "records" || !tab.startsWith("record:"))),
          ...(mine ?? []).map((r) => row(`record:${r.path}`, r.name, null, undefined, true)),
        ];
      })}
      {row("roles", "Roles", "user", inRoles ? undefined : team.roles.length)}
      {inRoles && team.roles.map((r) => row(`role:${r.id}`, r.name, r, undefined, true))}
      {row("vault", "Vault", "padlock")}
      {row("activity", "Activity", "activity")}
    </fieldset>
  );
}

/** The team section the space page is showing. */
export function TeamPage({ spaceId, tab }: { spaceId: string; tab: SpacePageTab }) {
  const team = useApp((s) => s.teams[spaceId]);
  if (!team?.enabled) return <MakeTeam spaceId={spaceId} />;
  if (tab === "records") return <RecordsPage spaceId={spaceId} team={team} typeKey={null} />;
  if (tab.startsWith("records:")) return <RecordsPage key={tab} spaceId={spaceId} team={team} typeKey={tab.slice(8)} />;
  if (tab === "recordtype:new") return <NewRecordTypePage spaceId={spaceId} team={team} />;
  if (tab.startsWith("recordtype:")) {
    const type = tabRecordType(tab, team);
    return type ? <RecordTypePage key={type.id} spaceId={spaceId} type={type} /> : <RecordsPage spaceId={spaceId} team={team} typeKey={null} />;
  }
  if (tab === "activity") return <ActivityPage spaceId={spaceId} team={team} />;
  if (tab === "roles") return <RolesPage spaceId={spaceId} team={team} />;
  if (tab === "vault") return <VaultPage spaceId={spaceId} team={team} />;
  if (tab.startsWith("record:")) return <RecordPage key={tab} spaceId={spaceId} path={tab.slice(7)} team={team} />;
  if (tab.startsWith("role:")) {
    const role = team.roles.find((r) => r.id === tab.slice(5));
    return role ? <RolePage key={role.id} role={role} team={team} /> : <Overview spaceId={spaceId} team={team} />;
  }
  return <Overview spaceId={spaceId} team={team} />;
}

/* ═══════════════════════════════ overview ═══════════════════════════════ */

function Overview({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const openTeamReview = useApp((s) => s.openTeamReview);
  const activity = useApp((s) => s.teamActivity[spaceId]);
  const loadTeamActivity = useApp((s) => s.loadTeamActivity);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const addTeammate = () => openSheet({ kind: "add-teammates", spaceId });
  useEffect(() => { run(() => loadTeamActivity(spaceId)); }, [spaceId, loadTeamActivity, run]);
  const waiting = team.reviews.filter((r) => r.state === "waiting");
  const today = (activity ?? []).filter((a) => a.ts > Date.now() - 2 * 86_400_000).slice(0, 8);
  const vantage = [
    `${team.roles.length} role${team.roles.length === 1 ? "" : "s"}`,
    team.hasRepo && team.recordTypes.length > 0 ? team.recordTypes.map((t) => `${t.count} ${(t.count === 1 ? t.one : t.many).toLowerCase()}`).join(" · ") : null,
    `${money(team.weekSpendUsd)} of ${money(team.weekBudgetUsd)} this week`,
  ].filter(Boolean).join(" · ");
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{space?.name} team</h1></div>
        <span className="page-vantage" title="Dollars are what the runs would cost on the API. On a subscription they measure how heavy the work was, not a bill.">{vantage}</span>
        <button type="button" className="btn" onClick={addTeammate}><Icon name="add" size={16} />Add teammate</button>
      </header>
      <div className="form">
        <BackoffNote team={team} />
        {waiting.length > 0 && (
          <>
            <h3 className="settings-head">Waiting for you</h3>
            <div className="tp-wait">
              {waiting.map((r, i) => (
                <div key={r.id} className="tp-wait-row">
                  {r.thumb && space ? <img src={mediaUrl(`${space.folderPath}/${r.thumb}`)} alt="" draggable={false} />
                    : <span className="tp-mark"><Icon name={REVIEW_GLYPH[r.kind]} size={16} /></span>}
                  <div className="tp-wait-text">
                    <div className="tp-card-name">{r.title}</div>
                    <div className="tp-card-line">{[r.roleName, `made ${agoPhrase(r.createdAt)}`, r.kind === "message" && r.account ? `sends from ${r.account}` : "nothing posts until you approve"].filter(Boolean).join(" · ")}</div>
                  </div>
                  <button type="button" className={i === 0 ? "btn primary" : "btn"} onClick={() => run(() => openTeamReview(spaceId, r.id))}>Review</button>
                </div>
              ))}
            </div>
          </>
        )}
        <h3 className="settings-head">Roles</h3>
        <div className="tp-cards">
          {team.roles.map((r) => <RoleCard key={r.id} role={r} onOpen={() => setSpacePageTab(spaceId, `role:${r.id}`)} />)}
          <div className="tp-card tp-card-note">
            <span className="tp-card-line">Teammates wake on a schedule, when you answer one of their reviews, on a handoff, on an @mention, or on a goal you give them.</span>
            <span className="tp-card-line t-num">{sharesNote(team.sharesUsd, team.weekBudgetUsd).text}.</span>
            <button type="button" className="btn-quiet tp-card-new" onClick={addTeammate}>Add teammate…</button>
          </div>
        </div>
        {team.handoffs.length > 0 && (
          <>
            <h3 className="settings-head">Handoffs</h3>
            <HandoffLines team={team} rows={team.handoffs.slice(0, 5)} />
          </>
        )}
        <h3 className="settings-head">Budget</h3>
        <TeamBudget team={team} />
        {today.length > 0 && (
          <>
            <h3 className="settings-head">Today</h3>
            <Feed rows={today} team={team} />
          </>
        )}
      </div>
    </>
  );
}

function RoleCard({ role, onOpen }: { role: TeamRole; onOpen: () => void }) {
  const m = meter(role.weekSpendUsd, role.weekBudgetUsd);
  const blurb = ROLE_TEMPLATES.find((t) => t.id === role.template)?.blurb ?? firstSentence(role.brief);
  const dot = role.state === "working" ? "working" : role.state === "waiting" ? "waiting" : role.state === "paused" ? "failed" : "idle";
  return (
    <button type="button" className="tp-card tp-role-card" onClick={onOpen} aria-label={`${role.name} — ${roleStateLine(role)}. Open its page`}>
      <span className="tp-card-head">
        <span className="tp-mark"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} state={realmiteState(role)} /></span>
        <span className="tp-card-name">{role.name}</span>
        <span className="tp-state"><span className="t-dot" data-s={dot} /><span className="tp-state-text">{roleStateLine(role)}</span></span>
      </span>
      <span className="tp-card-line">{blurb}</span>
      <span className="tp-card-foot">
        <span className="t-num">{spendLine(role.weekSpendUsd, role.weekBudgetUsd)}</span>
        {m && <span className="tp-meter" data-high={m.high || undefined}><i style={{ width: `${m.pct}%` }} /></span>}
      </span>
    </button>
  );
}

const firstSentence = (s: string) => {
  const t = s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  const cut = t.search(/[.!?](\s|$)/);
  return (cut > 0 ? t.slice(0, cut + 1) : t).replace(/`/g, "");
};

/** The log, one line each: when, whose Realmite, what, and the quieter half after a dot. */
function Feed({ rows, team }: { rows: readonly TeamActivity[]; team: TeamSpace }) {
  return (
    <ul className="tp-feed">
      {rows.map((a) => {
        const id = a.actor.startsWith("role:") ? a.actor.slice(5) : null;
        // A removed role's lines keep its name and its Realmite: its history stays its own.
        const role = id ? team.roles.find((r) => r.id === id) ?? team.formerRoles.find((r) => r.id === id) : undefined;
        const s = activitySentence(a, role?.name ?? (a.actor === "user" ? "You" : "Realm"));
        return (
          <li key={a.id}>
            <time>{feedTime(a.ts)}</time>
            <span className="t-glyph">{role
              ? <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={16} {...("state" in role ? { state: realmiteState(role as TeamRole) } : {})} />
              : <Icon name={a.actor === "user" ? "user" : "activity"} size={12} />}</span>
            <span>{s.text}{s.detail && <small> · {s.detail}</small>}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Every role as its card, and the way to make another. */
function RolesPage({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const openSheet = useApp((s) => s.openSheet);
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Roles</h1></div>
        <span className="page-vantage t-num">{team.roles.length} on this team · {money(team.sharesUsd)} of {money(team.weekBudgetUsd)} a week in shares</span>
        <button type="button" className="btn" onClick={() => openSheet({ kind: "add-teammates", spaceId })}><Icon name="add" size={16} />Add teammate</button>
      </header>
      <div className="form">
        <div className="tp-cards">
          {team.roles.map((r) => <RoleCard key={r.id} role={r} onOpen={() => setSpacePageTab(spaceId, `role:${r.id}`)} />)}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════ a role ═══════════════════════════════ */

function RolePage({ role, team }: { role: TeamRole; team: TeamSpace }) {
  const runs = useApp((s) => s.teamRoleRuns[role.id]);
  const loadRoleRuns = useApp((s) => s.loadRoleRuns);
  const runRole = useApp((s) => s.runRole);
  const updateRole = useApp((s) => s.updateRole);
  const archiveRole = useApp((s) => s.archiveRole);
  const revealSession = useApp((s) => s.revealSession);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  const [messaging, setMessaging] = useState(false);
  const [message, setMessage] = useState("");
  const [sheet, setSheet] = useState<"edit" | "duplicate" | "remove" | null>(null);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { run(() => loadRoleRuns(role.id)); }, [role.id, loadRoleRuns, run]);
  useEffect(() => { if (messaging) field.current?.focus(); }, [messaging]);
  const mine = team.handoffs.filter((h) => h.toRoleId === role.id || h.fromRoleId === role.id).slice(0, 8);
  const send = () => {
    const text = message.trim();
    run(async () => { await runRole(role.id, text || null); setMessage(""); setMessaging(false); });
  };
  const openRun = (sessionId: string | null) => { if (!sessionId) return; closePageOverlay(); run(() => revealSession(sessionId, role.spaceId).then(() => undefined)); };
  return (
    <>
      <header className="page-head tp-role-head">
        <span className="tp-hero"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={160} state={realmiteState(role)} title={`${role.name}'s Realmite`} /></span>
        <div className="page-title"><h1>{role.name}</h1></div>
        <span className="page-vantage">{roleStateLine(role)}</span>
        <button type="button" className="btn" onClick={() => setMessaging((v) => !v)} aria-expanded={messaging}>Message</button>
        <button type="button" className="btn" onClick={() => run(() => runRole(role.id, null).then(() => undefined))}
          title={`Start a run of ${role.name} now, on its brief`}>Run now</button>
        <button type="button" ref={more} className="icon-btn" aria-label={`More for ${role.name}`} title={`More for ${role.name}`} aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}><Icon name="more" size={16} /></button>
        {menu && (
          <Menu anchorRef={more} align="right" label={`More for ${role.name}`} onClose={() => setMenu(false)} items={[
            { label: "Edit…", onSelect: () => setSheet("edit") },
            { label: "Duplicate…", onSelect: () => setSheet("duplicate"), detail: "A new teammate with this one's brief, model and clock" },
            { kind: "separator" },
            { label: `Remove ${role.name} from the team…`, danger: true, onSelect: () => setSheet("remove") },
          ]} />
        )}
      </header>
      <div className="form">
        {messaging && (
          <form className="tp-message" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea ref={field} className="tp-message-field" rows={3} value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder={`What should ${role.name} do? It starts a run with your words and its brief.`}
              aria-label={`Message ${role.name}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                if (e.key === "Escape") { e.stopPropagation(); setMessaging(false); }
              }} />
            <div className="tp-message-foot">
              <span className="tp-make-note">A run stops at {money(role.runCapUsd)} or {Math.round(role.runCapMs / 60_000)} minutes.</span>
              <button type="button" className="btn" onClick={() => setMessaging(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!message.trim()}>Send (⌘↩)</button>
            </div>
          </form>
        )}
        <h3 className="settings-head">Brief</h3>
        <BriefEditor role={role} />
        <h3 className="settings-head">Goal</h3>
        <RoleGoalPanel role={role} />
        <h3 className="settings-head">Recent runs</h3>
        {!runs ? <p className="tp-empty">Loading…</p> : runs.length === 0 ? <p className="tp-empty">No runs yet. Run now starts one on its brief.</p> : (
          <table className="tp-table">
            <thead><tr><th>When</th><th>Woke on</th><th>What it did</th><th className="num">Time</th><th className="num">Cost</th><th /></tr></thead>
            <tbody>
              {runs.slice(0, 12).map((r) => {
                const chip = runChip(r);
                return (
                  <tr key={r.id}>
                    <td className="t-dim t-num">{shortWhen(r.createdAt)}</td>
                    <td className="t-dim">{wokeLine(r)}</td>
                    <td className="tp-what">
                      {r.sessionId
                        ? <button type="button" className="tp-run-link" title="Open this run's session" onClick={() => openRun(r.sessionId)}>{r.summary ?? r.error ?? (r.state === "running" ? "Working…" : "—")}</button>
                        : (r.summary ?? r.error ?? "Waiting for a free slot")}
                    </td>
                    <td className="num">{duration(r.startedAt ? (r.settledAt ?? Date.now()) - r.startedAt : null)}</td>
                    <td className="num">{money(r.costUsd)}</td>
                    <td><span className="tp-chip" data-tone={chip.tone ?? undefined}>{chip.word}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {mine.length > 0 && (
          <>
            <h3 className="settings-head">Handoffs</h3>
            <HandoffLines team={team} rows={mine} />
          </>
        )}
        <h3 className="settings-head">Wakes</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">{wakeSentence(role.cron)}</span>
              <span className="settings-row-detail">{role.cron ? (role.pausedWhy ?? "Does what its brief says is due") : "Runs when you press Run now or send it a message"}</span>
            </div>
            {role.cron && (
              <input type="checkbox" role="switch" className="switch" checked={role.scheduleEnabled} aria-label={`${wakeSentence(role.cron)}, on`}
                onChange={(e) => run(() => updateRole({ id: role.id, scheduleEnabled: e.target.checked }).then(() => undefined))} />
            )}
          </li>
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">When you answer one of its reviews</span>
              <span className="settings-row-detail">“Request changes” goes back to the run that made it</span>
            </div>
            <input type="checkbox" role="switch" className="switch" checked={role.wakeOnReview} aria-label="When you answer one of its reviews, on"
              onChange={(e) => run(() => updateRole({ id: role.id, wakeOnReview: e.target.checked }).then(() => undefined))} />
          </li>
          <MentionWake role={role} />
        </ul>
        <h3 className="settings-head">Runs on</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main"><span className="settings-row-name">Model</span></div>
            <span className="tp-chip tp-model-chip">{modelLabel(role.model)}</span>
          </li>
          <RoleBudget role={role} />
          <HandsOffTo role={role} team={team} />
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Can use</span>
              <span className="settings-row-detail">{["Records and Review", ...role.skills.map((s) => `the ${s} skill`)].join(", ")} · {MODES.find((m) => m.id === role.permissionMode)?.label ?? role.permissionMode}</span>
            </div>
            <button type="button" className="btn-quiet" onClick={() => setSheet("edit")}>Edit</button>
          </li>
        </ul>
        <div className="tp-danger">
          <button type="button" className="btn-quiet danger" onClick={() => setSheet("remove")}>Remove {role.name} from the team…</button>
        </div>
      </div>
      {sheet === "edit" && <RoleSheet spaceId={role.spaceId} role={role} team={team} onClose={() => setSheet(null)} />}
      {sheet === "duplicate" && <RoleSheet spaceId={role.spaceId} copyOf={role} team={team} onClose={() => setSheet(null)} onMade={(made) => setSpacePageTab(role.spaceId, `role:${made.id}`)} />}
      {sheet === "remove" && (
        <RemoveRoleSheet role={role} onClose={() => setSheet(null)}
          onRemove={() => run(async () => { await archiveRole(role.id, role.spaceId); setSheet(null); setSpacePageTab(role.spaceId, "team"); })} />
      )}
    </>
  );
}

/**
 * Removing a teammate asks first, because a role is an object a stray click would cost: its clock,
 * its brief and its Realmite. It names exactly what goes and what stays — the role stops waking and
 * leaves the team; its runs, its reviews and its lines in Activity stay under its name.
 */
function RemoveRoleSheet({ role, onClose, onRemove }: { role: TeamRole; onClose: () => void; onRemove: () => void }) {
  const live = role.state === "working" || role.state === "waiting" || role.state === "queued";
  return (
    <Sheet title={`Remove ${role.name} from the team?`} onClose={onClose} width={460}>
      <div className="form">
        <div className="tp-remove-who">
          <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} />
          <span className="tp-card-name">{role.name}</span>
        </div>
        <p className="tp-lede">
          {role.name} stops waking{role.cron ? " and its schedule is deleted" : ""}. Its runs, what it sent to Review and its lines in
          Activity stay, under its name.{live ? " A run already going finishes first." : ""}
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Keep {role.name}</button>
          <button type="button" className="btn destructive" onClick={onRemove}>Remove {role.name}</button>
        </div>
      </div>
    </Sheet>
  );
}

/** The brief keeps itself: a pause writes it, leaving the field writes it at once, and the head says
 *  where it stands (design.md, "A document a person writes keeps itself"). */
function BriefEditor({ role }: { role: TeamRole }) {
  const updateRole = useApp((s) => s.updateRole);
  const run = useApp((s) => s.run);
  const [text, setText] = useState(role.brief);
  const [state, setState] = useState<"saved" | "edited" | "saving">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const save = (value: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (value.trim() === role.brief.trim() || !value.trim()) { setState("saved"); return; }
    setState("saving");
    run(async () => { await updateRole({ id: role.id, brief: value }); setState("saved"); });
  };
  useEffect(() => { if (state === "saved") setText(role.brief); }, [role.brief]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = field.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  return (
    <div className="tp-brief-wrap">
      <textarea ref={field} className="tp-brief" value={text} aria-label={`${role.name}'s brief`} spellCheck
        onChange={(e) => { setText(e.target.value); setState("edited"); if (timer.current) clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => save(v), 1200); }}
        onBlur={() => save(text)} />
      <span className="tp-brief-state" aria-live="polite">{state === "saving" ? "Saving…" : state === "edited" ? "Edited" : "Saved"}</span>
    </div>
  );
}

/* ═══════════════════════════════ activity ═══════════════════════════════ */

function ActivityPage({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const activity = useApp((s) => s.teamActivity[spaceId]);
  const loadTeamActivity = useApp((s) => s.loadTeamActivity);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => loadTeamActivity(spaceId)); }, [spaceId, loadTeamActivity, run]);
  const days = useMemo(() => {
    const out: { label: string; rows: TeamActivity[] }[] = [];
    for (const a of activity ?? []) {
      const d = new Date(a.ts);
      const label = d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(a); else out.push({ label, rows: [a] });
    }
    return out;
  }, [activity]);
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Activity</h1></div>
        <span className="page-vantage">Everything the team did, newest first</span>
      </header>
      <div className="form">
        {activity && activity.length === 0 && <p className="tp-empty">Nothing yet.</p>}
        {days.map((d) => (
          <div key={d.label}>
            <h3 className="settings-head">{d.label}</h3>
            <Feed rows={d.rows} team={team} />
          </div>
        ))}
      </div>
    </>
  );
}

