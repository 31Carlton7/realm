import { Icon, Realmite, parseRealmiteSpec, type IconName } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { mediaUrl, type TeamActivity, type TeamRecordType, type TeamRole, type TeamSpace } from "@realm/contracts";
import { MakeTeam } from "./TeamPicker";
import { PoliciesPage } from "./PoliciesPage";
import { VaultPage } from "./VaultPage";
import { NewRecordTypePage, RecordPage, RecordTypePage, RecordsPage, typeGlyph, typeOfPath } from "./RecordPages";
import { BackoffNote, HandoffLines, TeamBudget } from "./HandoffParts";
import { realmiteState, reviewGlyph } from "../../components/sidebar/TeamRows";
import { useApp, type SpacePageTab } from "../../state/store";
import { activitySentence, agoPhrase, feedTime, meter, money, roleStateLine, sharesNote, spendLine } from "./team-format";
import { ChatList, chatRoleOf } from "./chat/ChatList";
import { EmptyTeam, TeamChat } from "./chat/TeamChat";
import { roleBlurb } from "./chat/chat-format";

/* ═══════════════════════════════ the column ═══════════════════════════════ */

export const isTeamTab = (tab: SpacePageTab): boolean =>
  tab === "team" || tab === "overview" || tab === "records" || tab === "roles" || tab === "policies" || tab === "vault" || tab === "activity" || tab.startsWith("role:") || tab.startsWith("record:")
  || tab.startsWith("records:") || tab.startsWith("recordtype:");

/** A team tab that is a chat, laid out as one — its own scroller and a prompter at its foot — rather
 *  than as a page that scrolls. A team with nobody on it shows its empty chat list the same way. */
export const isChatTab = (tab: SpacePageTab, team: TeamSpace | undefined): boolean =>
  team?.enabled === true && (tab === "team" || tab === "roles" || tab.startsWith("role:"));

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
  if (tab === "policies") return "Policies";
  if (tab === "vault") return "Vault";
  if (tab === "overview") return "Overview";
  if (tab === "team" || tab === "roles" || tab.startsWith("role:")) return chatRoleOf(tab, team)?.name ?? "Chats";
  if (tab === "recordtype:new") return "New record type";
  const type = tabRecordType(tab, team);
  if (tab === "records" || tab.startsWith("records:")) return type?.many ?? "Records";
  if (tab.startsWith("record:")) return (type ?? (team && typeOfPath(team, tab.slice(7))))?.one ?? "Record";
  if (tab.startsWith("recordtype:")) return type?.one ?? "Record type";
  return "Overview";
}

/**
 * The team in the space page's column: its chats first, a row per teammate (`ChatList`), then under a
 * "Team" head what belongs to the whole team — Review, the Overview, each kind of record it keeps, its
 * policies and vault, the log. Those are radios with one tab stop, as every page rail here is; a
 * kind's row stays lit while its fields are being shaped and unfolds to its records while one is open.
 */
export function TeamRailList({ spaceId, team, tab, pick }: { spaceId: string; team: TeamSpace; tab: SpacePageTab; pick: (t: SpacePageTab) => void }) {
  const records = useApp((s) => s.teamRecords[spaceId]);
  const loadTeamRecords = useApp((s) => s.loadTeamRecords);
  const openTeamReview = useApp((s) => s.openTeamReview);
  const run = useApp((s) => s.run);
  useEffect(() => { if ((tab.startsWith("record:") || tab.startsWith("records")) && !records) run(() => loadTeamRecords(spaceId)); }, [tab, records, spaceId, loadTeamRecords, run]);
  const name = `space-page-tab-${spaceId}`;
  const row = (id: SpacePageTab, label: string, glyph: IconName | null, count?: number, sub = false, lit = tab === id) => (
    <label key={id} className={`settings-tab page-rail-tab${sub ? " tp-sub" : ""}`} data-selected={lit || undefined}>
      {/* A kind's row is lit on its fields page too, where a click must still go to its list: a checked
          radio fires no change. */}
      <input type="radio" name={name} value={id} checked={lit} onChange={() => pick(id)} onClick={() => { if (lit && tab !== id) pick(id); }} />
      {glyph && <Icon name={glyph} size={16} className="page-rail-glyph" />}
      <span className="tp-rail-label">{label}</span>
      {count !== undefined && <span className="item-count tp-rail-count">{count}</span>}
    </label>
  );
  const open = tabRecordType(tab, team);
  const waiting = team.reviews.filter((r) => r.state === "waiting");
  return (
    <>
      <ChatList spaceId={spaceId} team={team} tab={tab} pick={pick} />
      <fieldset className="page-rail-list">
        <legend className="visually-hidden">Team</legend>
        <span className="page-rail-head" aria-hidden="true">Team</span>
        {/* Review is a pane of its own, not a page of this one, so its row is a way there. */}
        <button type="button" className="settings-tab page-rail-tab" onClick={() => run(() => openTeamReview(spaceId, waiting[0]?.id ?? null))}
          aria-label={waiting.length ? `Review, ${waiting.length} waiting on you` : "Review"}>
          <Icon name="review" size={16} className="page-rail-glyph" />
          <span className="tp-rail-label">Review</span>
          {waiting.length > 0 && <span className="item-count tp-rail-count">{waiting.length}</span>}
        </button>
        {row("overview", "Overview", "team")}
        {team.recordTypes.length === 0 && row("records", "Records", "records", undefined, false, tab === "records" || tab === "recordtype:new")}
        {team.recordTypes.map((t) => {
          const mine = open?.id === t.id && tab !== `recordtype:${t.key}` ? records?.filter((r) => r.path.startsWith(`${t.folder}/`)) : undefined;
          return [
            row(`records:${t.key}`, t.many, typeGlyph(t), mine?.length ? undefined : t.count, false, open?.id === t.id && (tab === "records" || !tab.startsWith("record:"))),
            ...(mine ?? []).map((r) => row(`record:${r.path}`, r.name, null, undefined, true)),
          ];
        })}
        {row("policies", "Policies", "shield")}
        {row("vault", "Vault", "padlock")}
        {row("activity", "Activity", "activity")}
      </fieldset>
    </>
  );
}

/** The team section the space page is showing. */
export function TeamPage({ spaceId, tab }: { spaceId: string; tab: SpacePageTab }) {
  const team = useApp((s) => s.teams[spaceId]);
  if (!team?.enabled) return <MakeTeam spaceId={spaceId} />;
  if (isChatTab(tab, team)) return <TeamChats spaceId={spaceId} team={team} tab={tab} />;
  if (tab === "records") return <RecordsPage spaceId={spaceId} team={team} typeKey={null} />;
  if (tab.startsWith("records:")) return <RecordsPage key={tab} spaceId={spaceId} team={team} typeKey={tab.slice(8)} />;
  if (tab === "recordtype:new") return <NewRecordTypePage spaceId={spaceId} team={team} />;
  if (tab.startsWith("recordtype:")) {
    const type = tabRecordType(tab, team);
    return type ? <RecordTypePage key={type.id} spaceId={spaceId} type={type} /> : <RecordsPage spaceId={spaceId} team={team} typeKey={null} />;
  }
  if (tab === "activity") return <ActivityPage spaceId={spaceId} team={team} />;
  if (tab === "policies") return <PoliciesPage spaceId={spaceId} team={team} />;
  if (tab === "vault") return <VaultPage spaceId={spaceId} team={team} />;
  if (tab.startsWith("record:")) return <RecordPage key={tab} spaceId={spaceId} path={tab.slice(7)} team={team} />;
  return <Overview spaceId={spaceId} team={team} />;
}

/** The chats: the one the tab names, or the one the team lands on. The details drawer stays as it was
 *  left while the person goes from chat to chat. */
function TeamChats({ spaceId, team, tab }: { spaceId: string; team: TeamSpace; tab: SpacePageTab }) {
  const [drawer, setDrawer] = useState(false);
  const role = chatRoleOf(tab, team);
  if (!role) return <EmptyTeam spaceId={spaceId} />;
  return <TeamChat key={role.id} team={team} role={role} drawer={drawer} onDrawer={setDrawer} />;
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
                    : <span className="tp-mark"><Icon name={reviewGlyph(r)} size={16} /></span>}
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
  const blurb = roleBlurb(role);
  const dot = role.state === "working" ? "working" : role.state === "waiting" ? "waiting" : role.state === "paused" ? "failed" : "idle";
  return (
    <button type="button" className="tp-card tp-role-card" onClick={onOpen} aria-label={`${role.name} — ${roleStateLine(role)}. Open its chat`}>
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

