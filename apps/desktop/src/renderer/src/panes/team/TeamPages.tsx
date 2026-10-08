import { Icon, Realmite, parseRealmiteSpec, type IconName } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ROLE_TEMPLATES, mediaUrl, parseAccount, parseRecord, type ParsedRecord, type RecordLine, type TeamActivity,
  type TeamRecord, type TeamRole, type TeamSpace,
} from "@realm/contracts";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { MODES, RoleSheet, modelLabel } from "./RoleSheet";
import { MakeTeam } from "./TeamPicker";
import { REVIEW_GLYPH, realmiteState } from "../../components/sidebar/TeamRows";
import { shortWhen } from "../schedules/schedule-model";
import { useApp, type SpacePageTab } from "../../state/store";
import {
  activitySentence, agoPhrase, duration, feedTime, meter, money, roleStateLine, runChip, sharesNote, spendLine, wakeSentence, wokeLine,
} from "./team-format";

/* ═══════════════════════════════ the column ═══════════════════════════════ */

export const isTeamTab = (tab: SpacePageTab): boolean =>
  tab === "team" || tab === "records" || tab === "roles" || tab === "activity" || tab.startsWith("role:") || tab.startsWith("record:");

/** The page's name for a team tab — the head the bar and Back speak of. */
export function teamTabLabel(tab: SpacePageTab, team: TeamSpace | undefined): string {
  if (tab === "records") return "Creators";
  if (tab === "activity") return "Activity";
  if (tab === "roles") return "Roles";
  if (tab.startsWith("role:")) return team?.roles.find((r) => r.id === tab.slice(5))?.name ?? "Role";
  if (tab.startsWith("record:")) return "Creator";
  return "Overview";
}

/**
 * The team's sections in the space page's column, under a "Team" head (the Teams plan, 13.2): the
 * Overview, the creators and the roles — each of which unfolds to its members while one of them is
 * open, the open one lit — and the log. Radios, one tab stop, as every page rail here is.
 */
export function TeamRailList({ spaceId, team, tab, pick }: { spaceId: string; team: TeamSpace; tab: SpacePageTab; pick: (t: SpacePageTab) => void }) {
  const records = useApp((s) => s.teamRecords[spaceId]);
  const loadTeamRecords = useApp((s) => s.loadTeamRecords);
  const run = useApp((s) => s.run);
  useEffect(() => { if (tab.startsWith("record:") && !records) run(() => loadTeamRecords(spaceId)); }, [tab, records, spaceId, loadTeamRecords, run]);
  const name = `space-page-tab-${spaceId}`;
  const row = (id: SpacePageTab, label: string, glyph: IconName | TeamRole | null, count?: number, sub = false) => (
    <label key={id} className={`settings-tab page-rail-tab${sub ? " tp-sub" : ""}${glyph && typeof glyph === "object" ? " tp-sub-role" : ""}`} data-selected={tab === id || undefined}>
      <input type="radio" name={name} value={id} checked={tab === id} onChange={() => pick(id)} />
      {glyph && (typeof glyph === "object"
        ? <span className="page-rail-glyph tp-rail-realmite"><Realmite spec={parseRealmiteSpec(glyph.realmite, glyph.id)} size={16} state={realmiteState(glyph)} /></span>
        : <Icon name={glyph} size={16} className="page-rail-glyph" />)}
      <span className="tp-rail-label">{label}</span>
      {count !== undefined && <span className="item-count tp-rail-count">{count}</span>}
    </label>
  );
  const inRoles = tab.startsWith("role:") || tab === "roles";
  const inRecords = tab.startsWith("record:") || tab === "records";
  return (
    <fieldset className="page-rail-list">
      <legend className="visually-hidden">Team</legend>
      <span className="page-rail-head" aria-hidden="true">Team</span>
      {row("team", "Overview", "team")}
      {row("records", "Creators", "records", inRecords && records?.length ? undefined : team.recordCount)}
      {inRecords && records?.map((r) => row(`record:${r.path}`, r.name, null, undefined, true))}
      {row("roles", "Roles", "user", inRoles ? undefined : team.roles.length)}
      {inRoles && team.roles.map((r) => row(`role:${r.id}`, r.name, r, undefined, true))}
      {row("activity", "Activity", "activity")}
    </fieldset>
  );
}

/** The team section the space page is showing. */
export function TeamPage({ spaceId, tab }: { spaceId: string; tab: SpacePageTab }) {
  const team = useApp((s) => s.teams[spaceId]);
  if (!team?.enabled) return <MakeTeam spaceId={spaceId} />;
  if (tab === "records") return <RecordsPage spaceId={spaceId} />;
  if (tab === "activity") return <ActivityPage spaceId={spaceId} team={team} />;
  if (tab === "roles") return <RolesPage spaceId={spaceId} team={team} />;
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
    team.hasRepo ? `${team.recordCount} creator${team.recordCount === 1 ? "" : "s"}` : null,
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
            <span className="tp-card-line">Teammates wake on a schedule, when you answer one of their reviews, or when you run them.</span>
            <span className="tp-card-line t-num">{sharesNote(team.sharesUsd, team.weekBudgetUsd).text}.</span>
            <button type="button" className="btn-quiet tp-card-new" onClick={addTeammate}>Add teammate…</button>
          </div>
        </div>
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
              ? <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={16} />
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
  const m = meter(role.weekSpendUsd, role.weekBudgetUsd);
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
        </ul>
        <h3 className="settings-head">Runs on</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main"><span className="settings-row-name">Model</span></div>
            <span className="tp-chip tp-model-chip">{modelLabel(role.model)}</span>
          </li>
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Budget</span>
              <span className="settings-row-detail t-num">{spendLine(role.weekSpendUsd, role.weekBudgetUsd)} · a run stops at {money(role.runCapUsd)} or {Math.round(role.runCapMs / 60_000)} minutes</span>
            </div>
            {m && <span className="tp-meter tp-meter-wide" data-high={m.high || undefined} role="meter" aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Spent this week"><i style={{ width: `${m.pct}%` }} /></span>}
          </li>
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

/* ═══════════════════════════════ records ═══════════════════════════════ */

function RecordsPage({ spaceId }: { spaceId: string }) {
  const records = useApp((s) => s.teamRecords[spaceId]);
  const loadTeamRecords = useApp((s) => s.loadTeamRecords);
  const createTeamRecord = useApp((s) => s.createTeamRecord);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => { run(() => loadTeamRecords(spaceId)); }, [spaceId, loadTeamRecords, run]);
  const add = () => run(async () => { const r = await createTeamRecord(spaceId, name.trim()); setAdding(false); setName(""); setSpacePageTab(spaceId, `record:${r.path}`); });
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Creators</h1></div>
        <span className="page-vantage">{records ? `${records.length} record${records.length === 1 ? "" : "s"}` : ""}</span>
        <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="add" size={16} />New record</button>
      </header>
      <div className="form">
        <p className="tp-file"><code>creators/</code> · team memory · one Markdown file per person, read by every role</p>
        {adding && (
          <form className="tp-message tp-inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add(); }}>
            <input className="tp-inline-field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" aria-label="The creator's name"
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} />
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>Make record</button>
          </form>
        )}
        {records && records.length === 0 && !adding && <p className="tp-empty">No records yet. Creator Manager keeps one for each creator it works with, or make one yourself.</p>}
        {records && records.length > 0 && (
          <ul className="settings-list">
            {records.map((r) => (
              <li key={r.path} className="settings-row tp-row-link">
                <button type="button" className="tp-row-button" onClick={() => setSpacePageTab(spaceId, `record:${r.path}`)}>
                  <span className="settings-row-main">
                    <span className="settings-row-name">{r.name}</span>
                    <span className="settings-row-detail t-mono">{r.path}</span>
                  </span>
                  {r.status && <StatusChip status={r.status} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const STATUS_TONE: Record<string, "ok" | "warn" | undefined> = { signed: "ok", active: "ok", contacted: "warn", negotiating: "warn", paused: "warn" };
function StatusChip({ status }: { status: string }) {
  const word = status.split(/[\s,·]/)[0] ?? status;
  return <span className="tp-chip" data-tone={STATUS_TONE[word.toLowerCase()]}>{word.charAt(0).toUpperCase() + word.slice(1)}</span>;
}

/**
 * A record as Realm draws it — the Deal as a card of properties, Accounts with where each sign-in is
 * kept and whether it is consented, Deadlines and Content — over the Markdown file that IS the record.
 * A file not in the record's shape is shown as its Markdown, never as a half-drawn form; Edit is the
 * file itself, saved under the person's name.
 */
function RecordPage({ spaceId, path, team }: { spaceId: string; path: string; team: TeamSpace }) {
  const fetchTeamRecord = useApp((s) => s.fetchTeamRecord);
  const writeTeamRecord = useApp((s) => s.writeTeamRecord);
  const runRole = useApp((s) => s.runRole);
  const reveal = window.realm?.files?.reveal;
  const run = useApp((s) => s.run);
  const [rec, setRec] = useState<TeamRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const records = useApp((s) => s.teamRecords[spaceId]);
  useEffect(() => { run(async () => setRec(await fetchTeamRecord(spaceId, path))); }, [spaceId, path, fetchTeamRecord, run, records]);
  if (!rec) return <p className="tp-empty">Loading…</p>;
  const parsed = parseRecord(rec.markdown);
  const manager = team.roles.find((r) => r.template === "creator-manager") ?? team.roles[0];
  const save = () => run(async () => { setRec(await writeTeamRecord(spaceId, rec.path, draft)); setEditing(false); });
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{parsed?.title ?? rec.name}</h1></div>
        <span className="page-vantage">{rec.status ? rec.status.charAt(0).toUpperCase() + rec.status.slice(1) : ""}</span>
        {editing ? (
          <>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={save}>Save</button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => { setDraft(rec.markdown); setEditing(true); }}>Edit</button>
            {reveal && <button type="button" className="btn" onClick={() => { void reveal(rec.absPath); }}>Show in Finder</button>}
            {manager && <button type="button" className="btn" onClick={() => run(() => runRole(manager.id, `About ${parsed?.title ?? rec.name} (${rec.path}): check the record and tell me what is due.`).then(() => undefined))}>Ask {manager.name}</button>}
          </>
        )}
      </header>
      <div className="form">
        <p className="tp-file"><code>{rec.path}</code> · team memory{rec.lastAuthor ? ` · last changed by ${rec.lastAuthor} ${feedTime(rec.updatedAt ?? Date.now())}` : ""}</p>
        {editing ? (
          <textarea className="tp-record-source" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`${rec.name}'s record, as Markdown`} spellCheck={false} />
        ) : parsed ? <RecordView record={parsed} spaceId={spaceId} /> : (
          <>
            <p className="tp-make-note">This file is not in a record's shape, so it is shown as written.</p>
            <pre className="tp-record-source tp-record-pre">{rec.markdown}</pre>
          </>
        )}
      </div>
    </>
  );
}

const ACCOUNT_GLYPH = (channel: string): IconName => {
  const c = channel.toLowerCase();
  return c.includes("tiktok") ? "tiktok" : c.includes("instagram") ? "instagram" : c.includes("youtube") ? "youtube" : c.includes("mail") ? "mail" : "user";
};

function RecordView({ record, spaceId }: { record: ParsedRecord; spaceId: string }) {
  const section = (name: string) => record.sections.find((s) => s.heading.toLowerCase() === name)?.lines ?? [];
  const deal = [...record.head, ...section("deal")].filter((l) => l.field);
  const loose = [...record.head, ...section("deal")].filter((l) => !l.field);
  const accounts = section("accounts");
  const deadlines = section("deadlines");
  const content = section("content");
  const others = record.sections.filter((s) => !["deal", "accounts", "deadlines", "content"].includes(s.heading.toLowerCase()));
  void spaceId;
  return (
    <>
      <h3 className="settings-head">Deal</h3>
      {deal.length === 0 && loose.length === 0 ? <p className="tp-empty">Nothing on the deal yet.</p> : (
        <div className="tp-props">
          {deal.map((l, i) => (
            <PropRow key={i} line={l} />
          ))}
          {loose.map((l, i) => <div key={`loose-${i}`} className="tp-prop-full">{l.text}</div>)}
        </div>
      )}
      <h3 className="settings-head">Accounts</h3>
      {accounts.length === 0 ? <p className="tp-empty">No accounts on record.</p> : (
        <ul className="settings-list">
          {accounts.map((l, i) => {
            const a = parseAccount(l);
            const consent = a.parts.consent;
            return (
              <li key={i} className="settings-row">
                <span className="t-glyph"><Icon name={ACCOUNT_GLYPH(a.channel)} size={16} /></span>
                <div className="settings-row-main">
                  <span className="settings-row-name">{a.handle ?? a.channel}</span>
                  <span className="settings-row-detail">{[a.handle ? a.channel : null, a.parts.vault ? `sign-in kept as ${a.parts.vault}` : null, a.parts.device ?? null, a.handle ? a.note : null].filter(Boolean).join(" · ")}</span>
                </div>
                {a.handle
                  ? <span className="tp-chip" data-tone={consent ? "ok" : "warn"} title={consent ? `Consent: ${consent}` : "Add consent: to this line before anything is posted to it"}>{consent ? "Consented" : "No consent yet"}</span>
                  : a.note && <span className="tp-chip" data-tone="warn">{capital(a.note)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="settings-head">Deadlines</h3>
      {deadlines.length === 0 ? <p className="tp-empty">No deadlines on record.</p> : (
        <ul className="settings-list">
          {deadlines.map((l, i) => {
            const [what = "", ...rest] = l.text.split(/\s+·\s+/);
            const state = rest.at(-1);
            const done = state && /^(done|sent|paid)$/i.test(state);
            return (
              <li key={i} className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">{what}</span>
                  {rest.length > (state ? 1 : 0) && <span className="settings-row-detail">{rest.slice(0, state ? -1 : undefined).join(" · ")}</span>}
                </div>
                {state && <span className="tp-chip" data-tone={done ? "ok" : "warn"}>{capital(state)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="settings-head">Content</h3>
      {content.length === 0 ? <p className="tp-empty">Nothing posted yet.</p> : (
        <ul className="settings-list">
          {content.map((l, i) => {
            const [what = "", ...rest] = l.text.split(/\s+·\s+/);
            return (
              <li key={i} className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">{what}</span>
                  {rest.length > 0 && <span className="settings-row-detail">{rest.join(" · ")}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {others.map((s) => (
        <div key={s.heading}>
          <h3 className="settings-head">{s.heading}</h3>
          <ul className="settings-list">
            {s.lines.map((l, i) => <li key={i} className="settings-row"><div className="settings-row-main"><span className="settings-row-name">{l.text}</span></div></li>)}
          </ul>
        </div>
      ))}
    </>
  );
}

function PropRow({ line }: { line: RecordLine }) {
  const f = line.field!;
  const statusish = f.key.toLowerCase() === "status";
  return (
    <>
      <div>{f.key}</div>
      <div>{statusish ? <><StatusChip status={f.value} /> <span className="t-faint">{f.value.split(/[\s,·]/).slice(1).join(" ").replace(/^[·,\s]+/, "")}</span></> : f.value}</div>
    </>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

