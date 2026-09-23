import { AGENT_META, DEFAULT_MODEL_LABEL, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { AgentOffice } from "./AgentOffice";
import { AgentWall } from "./AgentWall";
import { useApp, type AgentsView } from "../../state/store";
import type { PaneProps } from "../registry";

/** The states as a manager reads them, in the order they want attention. `fold` is how many rows a
 *  group shows before it asks to be opened: the three that need attention show everything, because
 *  everything in them is the point; Ready is every session that ever finished and would otherwise
 *  be a wall of history (254 rows on a real home), and Ended is history outright. */
const STATE: { status: SessionStatus; label: string; hint: string; fold: number }[] = [
  { status: "waiting_permission", label: "Needs you", hint: "Waiting on a permission you have not answered.", fold: Infinity },
  { status: "running", label: "Working", hint: "A turn is in progress.", fold: Infinity },
  { status: "error", label: "Failed", hint: "The last turn ended in an error.", fold: Infinity },
  { status: "idle", label: "Ready", hint: "Finished, and waiting for the next message.", fold: 8 },
  { status: "ended", label: "Ended", hint: "The agent process is gone; sending resumes it.", fold: 0 },
];

export const basenameOf = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/** "3m", "2h", "yesterday": how long since the row last moved, for a column the eye scans. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d}d`;
}

/**
 * Group every session by its live status, newest activity first within a group. Pure, so the
 * page's one interesting decision — what counts as needing you, and what order the rest come in —
 * is testable without a DOM. `status` comes from the live map, never the row: the row is what the
 * server had when the list was fetched, and a session that finished since is stale there.
 */
export function groupAgents(sessions: readonly Session[], status: Record<string, SessionStatus>): { state: (typeof STATE)[number]; rows: Session[] }[] {
  const by = new Map<SessionStatus, Session[]>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const st = status[s.id] ?? s.status;
    const held = by.get(st); if (held) held.push(s); else by.set(st, [s]);
  }
  return STATE.map((state) => ({ state, rows: by.get(state.status) ?? [] })).filter((g) => g.rows.length > 0);
}

/** The two readings, and what each is FOR — the tooltip is where the difference is stated, because
 *  a word on a button cannot carry it and a sentence beside them would be a third thing to read. */
const VIEWS: { view: AgentsView; label: string; hint: string }[] = [
  { view: "list", label: "List", hint: "Every session, ranked by what it needs from you." },
  { view: "wall", label: "Wall", hint: "The live ones as tiles, each showing what it is doing now." },
  { view: "office", label: "Office", hint: "The live ones as people working in a room you can change." },
];

/**
 * Every agent in the profile, by what it needs from you.
 *
 * The page a person running several sessions keeps open: which ones are blocked on a permission,
 * which are working, which have finished and are waiting to be read. The sidebar badges say the
 * same per space; this is the same fact across all of them on one screen, with enough context on
 * each row — where it runs, on what model, how long ago it moved — to choose without opening it.
 *
 * Rows come from one `sessions.listAll` and re-read whenever any status changes, which is the
 * moment a row would move between groups. Clicking a row goes to the session, switching space if
 * it has to — the same move a permission notification makes.
 *
 * The wall is the same sessions read for a different question — what each is DOING rather than what
 * it needs from you — and is a view of this page rather than a page of its own, because a second
 * destination would be a second place to look for one set of agents. Both draw `groupAgents`, so
 * the two can never disagree about which group a session is in. See `AgentWall`.
 */
export function AgentsPage({ item, visible }: PaneProps) {
  const spaces = useApp((s) => s.spaces);
  const status = useApp((s) => s.sessionStatus);
  const listAll = useApp((s) => s.listAllSessions);
  const reveal = useApp((s) => s.revealSession);
  const view = useApp((s) => s.agentsView);
  const setView = useApp((s) => s.setAgentsView);
  const openSheet = useApp((s) => s.openSheet);
  const canFanOut = useApp((s) => s.activeSpaceId !== null);
  const run = useApp((s) => s.run);
  const [rows, setRows] = useState<Session[] | null>(null);
  /** Groups the user has opened past their fold. */
  const [opened, setOpened] = useState<Set<SessionStatus>>(() => new Set());
  // The status map is a new object on every change, so it is the dependency that re-reads the list.
  useEffect(() => { let live = true; run(async () => { const all = await listAll(); if (live) setRows(all); }); return () => { live = false; }; }, [listAll, run, status]);
  const groups = useMemo(() => groupAgents(rows ?? [], status), [rows, status]);
  const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
  const needsYou = groups.find((g) => g.state.status === "waiting_permission")?.rows.length ?? 0;
  void item;

  return (
    <div className="page agents-page">
      <header className="page-head">
        <div className="page-title"><h1>Agents</h1></div>
        {/* The one number, as the vantage: how many are blocked on you right now. */}
        {needsYou > 0 && <span className="page-vantage">{needsYou} waiting on you</span>}
        <div className="agents-head-actions">
          {/* Two readings of one page, each button naming the view rather than its own state — so
              `aria-pressed` says which is on without the label and the flag disagreeing. */}
          <div className="agents-views" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.view} type="button" className="agents-view" aria-pressed={view === v.view}
                title={v.hint} onClick={() => setView(v.view)}>{v.label}</button>
            ))}
          </div>
          {canFanOut && (
            <button type="button" className="btn" onClick={() => openSheet({ kind: "fan-out" })}>Start agents…</button>
          )}
        </div>
      </header>
      <div className="page-body">
        {/* The wall takes the wide measure the Tasks lens already defines, because it is the same
            kind of surface: a comparison, where the reading is across the row rather than down it.
            At the ordinary 720px column a grid of readable tiles is two wide, which is a list with
            extra steps. The head widens with it — a head narrower than the content it heads is the
            misalignment the wide measure exists to avoid. */}
        <div className="page-content" data-wide={view !== "list" || undefined}>
          {rows !== null && rows.length === 0 && (
            <p className="env-empty">No agents yet. Start a session in any space and it shows up here with what it needs from you.</p>
          )}
          {view === "wall" && rows !== null && rows.length > 0 && (
            <AgentWall groups={groups} spaceName={spaceName} visible={visible}
              onOpen={(s) => run(() => reveal(s.id, s.spaceId))} />
          )}
          {view === "office" && rows !== null && (
            <AgentOffice sessions={rows} status={status} visible={visible}
              onPick={(s) => run(() => reveal(s.id, s.spaceId))} />
          )}
          {view === "list" && groups.map((g) => {
            const open = opened.has(g.state.status);
            const shown = open ? g.rows : g.rows.slice(0, g.state.fold);
            const hidden = g.rows.length - shown.length;
            return (
            <section key={g.state.status} className="agents-group" aria-label={g.state.label}>
              <h2 className="agents-group-label" title={g.state.hint}>
                <span className="agents-dot" data-status={g.state.status} aria-hidden="true" />
                {g.state.label}
                <span className="agents-group-count">{g.rows.length}</span>
              </h2>
              <ul className="agents-list">
                {shown.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="agents-row" data-status={g.state.status}
                      title={`${s.title} — ${spaceName(s.spaceId)} · ${s.cwd}`}
                      onClick={() => run(() => reveal(s.id, s.spaceId))}>
                      <Icon name={AGENT_META[s.agentKind].icon} size={16} colored className="agents-row-mark" />
                      <span className="agents-row-text">
                        <span className="agents-row-title">{s.title}</span>
                        {/* Where it runs and on what: the facts that pick between two rows with the
                            same title. Mono for the folder and model, which are machine names. */}
                        <span className="agents-row-sub">
                          <span>{spaceName(s.spaceId)}</span>
                          <span className="agents-row-mono">{basenameOf(s.cwd)}</span>
                          <span className="agents-row-mono">{s.model ?? DEFAULT_MODEL_LABEL[s.agentKind]}</span>
                        </span>
                      </span>
                      <span className="agents-row-when">{ago(s.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {/* The fold. A text line rather than a row, so it cannot be mistaken for an agent. */}
              {(hidden > 0 || (open && g.state.fold < g.rows.length)) && (
                <button type="button" className="agents-more" aria-expanded={open}
                  onClick={() => setOpened((prev) => { const next = new Set(prev); if (open) next.delete(g.state.status); else next.add(g.state.status); return next; })}>
                  <Icon name="chevronDown" size={12} />
                  {open ? `Show fewer` : hidden === g.rows.length ? `Show ${hidden}` : `${hidden} more`}
                </button>
              )}
            </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
