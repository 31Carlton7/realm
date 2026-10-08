import { AGENT_META, type DispatchKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState, type MouseEvent } from "react";
import { useApp } from "../../state/store";
import { sessionMark } from "../../state/attention";
import { relativeTime } from "../../components/CheckpointsSheet";
import { TallyMarks } from "../../components/sidebar/SessionRows";
import { tallyWords, type SessionRow } from "../../components/sidebar/model";
import { useChord, useSidebarState } from "../../components/sidebar/use-sidebar-model";
import { agentTitle, spaceSessionPage, type PageRow, type SessionsView } from "./session-list";

/** How a delegated child is named after its title, by the call that started it. */
const CHILD_WORD: Partial<Record<DispatchKind, string>> = { agent_run: "agent", browser_agent_run: "browser agent", review: "reviewer" };

/** The words in a row's second slot, and the tone they are set in: what it is waiting on, what went
 *  wrong, that it is at work — or, for a session nothing was ever sent in, that. */
function stateWords(row: SessionRow, empty: boolean): { text: string; tone?: "warning" | "danger" } | null {
  if (row.status === "waiting_permission") return { text: "Needs you", tone: "warning" };
  if (row.status === "error") return { text: "Failed", tone: "danger" };
  if (row.status === "running") return { text: "Working…" };
  return empty ? { text: "Nothing sent yet" } : null;
}

/**
 * A space's Sessions page: every session in the space, Active or Archived, grouped by when each last
 * moved, with a lead's sub-agents folded under it (`spaceSessionPage`).
 *
 * The toolbar is the Library's grammar — a filter that carries the counts, a search, and the one
 * action at its end as a plain button. The accent fill is kept for the one place starting a session
 * is the only thing to do: a space with none.
 */
export function SessionsList({ spaceId }: { spaceId: string }) {
  const state = useSidebarState();
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const view = useApp((s) => s.spaceSessionsView[spaceId] ?? "active");
  const setView = useApp((s) => s.setSpaceSessionsView);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const run = useApp((s) => s.run);
  const newChord = useChord("session.new");
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const now = Date.now();
  const page = spaceSessionPage(state, spaceId, view, query, now);
  const newSession = () => run(() => newSessionInstant(null, undefined, spaceId));
  const toggle = (id: string) => setUnfolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (page.counts.active + page.counts.archived === 0) {
    return (
      <div className="space-sessions">
        <p className="env-empty">No sessions in {space?.name ?? "this space"} yet.</p>
        <button type="button" className="btn primary space-sessions-start" onClick={newSession}>
          <Icon name="add" size={14} /> New session{newChord ? ` (${newChord})` : ""}
        </button>
      </div>
    );
  }

  const searching = query.trim() !== "";
  return (
    <div className="space-sessions">
      <div className="library-toolbar space-sessions-toolbar">
        <fieldset className="seg space-sessions-view">
          <legend className="visually-hidden">Show sessions</legend>
          {(["active", "archived"] as const satisfies readonly SessionsView[]).map((v) => (
            <label key={v} className="seg-opt" data-selected={view === v || undefined}>
              <input type="radio" name={`space-sessions-view-${spaceId}`} value={v} checked={view === v}
                onChange={() => setView(spaceId, v)} />
              {v === "active" ? "Active" : "Archived"} <span className="space-sessions-count">{page.counts[v]}</span>
            </label>
          ))}
        </fieldset>
        <label className="library-search space-sessions-search">
          <Icon name="search" size={14} />
          <input className="search-field" type="search" aria-label="Search sessions" placeholder="Search sessions…"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query !== "") { e.preventDefault(); e.stopPropagation(); setQuery(""); } }} />
        </label>
        <button type="button" className="btn library-add space-sessions-new" onClick={newSession} title={newChord ? `New session (${newChord})` : "New session"}>
          <Icon name="add" size={14} /> New session
        </button>
      </div>
      {page.groups.length === 0 ? (
        searching ? (
          <div className="space-sessions-none">
            <p className="env-empty">No sessions match “{query.trim()}”.</p>
            <button type="button" className="btn" onClick={() => setQuery("")}>Clear search</button>
          </div>
        ) : view === "archived" ? (
          <p className="env-empty">Nothing archived. Archive a session from its row and it waits here, out of the sidebar.</p>
        ) : (
          <p className="env-empty">Every session in {space?.name ?? "this space"} is archived.</p>
        )
      ) : page.groups.map((g) => (
        <section key={g.key} className="space-sessions-group" aria-label={g.label}>
          <h2 className="space-sessions-head">{g.label}</h2>
          <ul className="space-sessions-list">
            {g.rows.map((r) => (
              <PageRowView key={r.id} r={r} now={now} open={unfolded.has(r.id) || r.hits.length > 0} onToggle={() => toggle(r.id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One row of the page, and its agents under it when it is unfolded. */
function PageRowView({ r, now, open, onToggle }: { r: PageRow; now: number; open: boolean; onToggle: () => void }) {
  const openItem = useApp((s) => s.openItem);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const peekSession = useApp((s) => s.peekSession);
  const run = useApp((s) => s.run);
  const openRow = (row: SessionRow, e: MouseEvent) => run(() => (e.metaKey ? openItemBeside(row.item.id) : openItem(row.item.id)));
  // A sub-agent is looked at BESIDE its lead, the way the lead's own agent list opens one; ⌘ opens it
  // as a pane of its own.
  const peekChild = (child: SessionRow, e: MouseEvent) =>
    run(async () => { if (e.metaKey) await openItem(child.item.id); else await peekSession(child.id, child.spaceId); });

  const lead = r.kind === "fan-out" ? null : r;
  const children = r.kind === "fan-out" ? r.row.sessions : r.agents;
  const title = r.kind === "fan-out" ? `Fan-out: ${r.row.title}` : r.row.title;
  const tally = r.kind === "fan-out" ? r.row.tally : r.tally;
  const folds = children.length > 0;
  const noun = r.kind === "fan-out" ? (children.length === 1 ? "session" : "sessions") : (children.length === 1 ? "agent" : "agents");
  const own = lead ? lead.row : null;
  const mark = own ? sessionMark(own.status, own.unread) : null;
  const words = own ? stateWords(own, lead!.empty) : null;
  const other = lead?.otherAgent ? AGENT_META[lead.otherAgent] : null;
  const named = [title, other?.label, mark?.label ?? (lead?.empty ? "nothing sent yet" : undefined),
    folds ? `${children.length} ${noun}` : undefined, ...tallyWords(tally)].filter(Boolean).join(", ");

  return (
    <li className="space-sessions-item">
      <div className="space-sessions-row" data-empty={lead?.empty || undefined} data-unread={mark?.mark === "unseen" || undefined}>
        <span className="space-sessions-gutter">
          {folds ? (
            // The disclosure's second target, for the pointer; the keyboard has the count's button.
            <button type="button" className="space-sessions-caret" tabIndex={-1} aria-hidden="true" onClick={onToggle}>
              <span className="sb-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span>
            </button>
          ) : other ? <Icon name={other.icon} size={16} colored /> : null}
        </span>
        <button type="button" className="space-sessions-open" aria-label={named}
          onClick={(e) => { if (own) openRow(own, e); else onToggle(); }}>
          <span className="space-sessions-title">{title}</span>
          {folds && other && <Icon name={other.icon} size={12} colored />}
          {words && <span className="space-sessions-snippet" data-tone={words.tone}>{words.text}</span>}
        </button>
        {folds && (
          <button type="button" className="space-sessions-agents" aria-expanded={open} onClick={onToggle}
            aria-label={`${open ? "Hide" : "Show"} ${children.length} ${noun} of ${title}`}>
            {children.length}<span className="space-sessions-noun">{noun}</span>
            <TallyMarks tally={tally} />
          </button>
        )}
        <span className="space-sessions-time">{relativeTime(r.at, now)}</span>
        <span className="space-sessions-dot">
          {mark && <span className="status-dot" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
        </span>
      </div>
      {folds && open && (
        <ul className="space-sessions-children">
          {children.map((c) => {
            const child = r.kind === "session";
            const shown = child ? agentTitle(c.title) : c.title;
            const cMark = sessionMark(c.status, c.unread);
            const cWords = stateWords(c, false);
            const word = child ? CHILD_WORD[c.session?.dispatchedBy?.kind ?? "agent_run"] ?? "agent" : undefined;
            return (
              <li key={c.id} className="space-sessions-item">
                <div className="space-sessions-row" data-child="" data-hit={r.hits.includes(c.id) || undefined} data-unread={cMark?.mark === "unseen" || undefined}>
                  <span className="space-sessions-gutter" />
                  <button type="button" className="space-sessions-open" aria-label={[shown, word, cMark?.label].filter(Boolean).join(", ")}
                    onClick={(e) => (child ? peekChild(c, e) : openRow(c, e))}>
                    <span className="space-sessions-title">{shown}</span>
                    {cWords && <span className="space-sessions-snippet" data-tone={cWords.tone}>{cWords.text}</span>}
                  </button>
                  <span className="space-sessions-time">{relativeTime(c.at, now)}</span>
                  <span className="space-sessions-dot">
                    {cMark && <span className="status-dot" data-status={cMark.mark} title={cMark.mark === "unseen" ? "New since you were here" : cMark.label} />}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
