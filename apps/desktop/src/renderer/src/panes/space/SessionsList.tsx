import { AGENT_META, type DispatchKind, type Item } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useApp } from "../../state/store";
import { sessionMark } from "../../state/attention";
import { relativeTime } from "../../components/CheckpointsSheet";
import { RenameInput } from "../../components/RenameInput";
import { useItemContextMenu } from "../../components/sidebar/ItemContextMenu";
import { TallyMarks } from "../../components/sidebar/SessionRows";
import { tallyWords, type SessionRow } from "../../components/sidebar/model";
import { useChord, useSidebarState } from "../../components/sidebar/use-sidebar-model";
import { agentTitle, spaceSessionPage, type PageRow, type SessionsView } from "./session-list";

/** How a delegated child is named after its title, by the call that started it. */
const CHILD_WORD: Partial<Record<DispatchKind, string>> = { agent_run: "agent", browser_agent_run: "browser agent", review: "reviewer" };

/** The words in a row's second slot, and the tone they are set in: what it is waiting on, what went
 *  wrong, that it is at work, that nothing was ever sent in it — or where its last reply left off. */
function stateWords(row: SessionRow, empty: boolean, reply: string | null = null): { text: string; tone?: "warning" | "danger" } | null {
  if (row.status === "waiting_permission") return { text: "Needs you", tone: "warning" };
  if (row.status === "error") return { text: "Failed", tone: "danger" };
  if (row.status === "running") return { text: "Working…" };
  if (empty) return { text: "Nothing sent yet" };
  // Where it left off: the first line of its newest reply, which is what makes a row scannable
  // without opening it.
  return reply ? { text: reply } : null;
}

/**
 * One row the keyboard can land on, in reading order: a top-level row, or one of the sessions an
 * unfolded row holds. The page's keys act on these, never on the DOM's idea of what is next.
 */
type Stop = {
  key: string;
  /** The session it opens; none for a fan-out's own row, which only folds. */
  session: SessionRow | null;
  /** A sub-agent: looked at beside its lead rather than opened. */
  agent: boolean;
  /** Whether it folds, and which way it is now, for a top-level row with sessions under it. */
  folds: { open: boolean } | null;
  /** The top-level row it sits under, for a session inside an unfolded one. */
  parent: string | null;
};

function stopsOf(groups: { rows: PageRow[] }[], isOpen: (r: PageRow) => boolean): Stop[] {
  const out: Stop[] = [];
  for (const g of groups) for (const r of g.rows) {
    const children = r.kind === "fan-out" ? r.row.sessions : r.agents;
    const open = children.length > 0 && isOpen(r);
    out.push({ key: r.id, session: r.kind === "fan-out" ? null : r.row, agent: false, folds: children.length > 0 ? { open } : null, parent: null });
    if (open) for (const c of children) out.push({ key: c.id, session: c, agent: r.kind === "session", folds: null, parent: r.id });
  }
  return out;
}

/** The top-level row after `key` (or, at the end, before it) — where the keyboard goes when `key`'s
 *  row leaves the list. */
function neighbour(stops: Stop[], key: string): Stop | undefined {
  const at = stops.findIndex((s) => s.key === key);
  return stops.slice(at + 1).find((s) => s.parent === null) ?? stops.slice(0, Math.max(0, at)).reverse().find((s) => s.parent === null);
}

/**
 * A space's Sessions page: every session in the space, Active or Archived, grouped by when each last
 * moved, with a lead's sub-agents folded under it (`spaceSessionPage`).
 *
 * The toolbar is the Library's grammar — a filter that carries the counts, a search, and the one
 * action at its end as a plain button. The accent fill is kept for the one place starting a session
 * is the only thing to do: a space with none.
 *
 * The list is one tab stop: ↑/↓ move through every row on screen, →/← unfold and fold, ↩ opens (⌘↩
 * beside), ⌘⌫ archives — or, among the archived, deletes, asking first when deletes ask. ⌘F is the
 * search; Escape there clears it, and otherwise leaves the page as it always has.
 */
export function SessionsList({ spaceId }: { spaceId: string }) {
  const state = useSidebarState();
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const view = useApp((s) => s.spaceSessionsView[spaceId] ?? "active");
  const setView = useApp((s) => s.setSpaceSessionsView);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const openItem = useApp((s) => s.openItem);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const peekSession = useApp((s) => s.peekSession);
  const archiveItem = useApp((s) => s.archiveItem);
  const deleteItem = useApp((s) => s.deleteItem);
  const confirmDelete = useApp((s) => s.confirmDelete);
  const run = useApp((s) => s.run);
  const newChord = useChord("session.new");
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // The row the keyboard is on, and whether the next render should put focus there (an arrow moved
  // it, or the row it was on went away).
  const [current, setCurrent] = useState<string | null>(null);
  const refocus = useRef(false);
  // The row whose delete has been asked for once and waits on the second ask.
  const [armed, setArmed] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const now = Date.now();
  const page = spaceSessionPage(state, spaceId, view, query, now);
  const replies = useApp((s) => s.sessionReplies);
  const loadSessionReplies = useApp((s) => s.loadSessionReplies);
  // Read again whenever a session in the space changes state — a turn ending is when a reply lands.
  const states = Object.entries(state.sessionStatus).filter(([id]) => state.sessionSpace[id] === spaceId).map(([id, st]) => `${id}:${st}`).join(",");
  useEffect(() => { run(() => loadSessionReplies(spaceId)); }, [spaceId, states, run, loadSessionReplies]);
  const isOpen = (r: PageRow) => unfolded.has(r.id) || r.hits.length > 0;
  const stops = stopsOf(page.groups, isOpen);
  const here = stops.find((s) => s.key === current) ?? stops[0] ?? null;

  useEffect(() => {
    if (!refocus.current || !here) return;
    refocus.current = false;
    list.current?.querySelector<HTMLElement>(`[data-stop="${CSS.escape(here.key)}"]`)?.focus();
  });

  // ⌘F is the search while the page is up. Nothing else in the window binds it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); search.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const newSession = () => run(() => newSessionInstant(null, undefined, spaceId));
  const setFold = (id: string, open: boolean) => setUnfolded((prev) => {
    const next = new Set(prev);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  const go = (key: string) => { setCurrent(key); refocus.current = true; };

  const open = (stop: Stop, beside: boolean) => {
    const s = stop.session;
    if (!s) { if (stop.folds) setFold(stop.key, !stop.folds.open); return; }
    // A sub-agent is looked at BESIDE its lead, the way the lead's own agent list opens one; ⌘ opens
    // it as a pane of its own.
    if (stop.agent) run(async () => { if (beside) await openItem(s.item.id); else await peekSession(s.id, s.spaceId); });
    else run(() => (beside ? openItemBeside(s.item.id) : openItem(s.item.id)));
  };
  /** Put a row away, keeping the keyboard on the list at the row that takes its place. */
  const archive = (item: Item, key: string) => {
    const next = neighbour(stops, key);
    if (next) go(next.key);
    run(() => archiveItem(item.id, true));
  };
  /** Delete — on the second ask when deletes ask first. */
  const remove = (item: Item, key: string) => {
    if (confirmDelete && armed !== key) { setArmed(key); return; }
    setArmed(null);
    const next = neighbour(stops, key);
    if (next) go(next.key);
    run(() => deleteItem(item.id));
  };
  const restore = (item: Item) => run(() => archiveItem(item.id, false));

  const onListKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    // The row the key was pressed on — the focused one — whatever the last render thought.
    const onKey = target.closest("[data-stop]")?.getAttribute("data-stop");
    const here = stops.find((s) => s.key === onKey) ?? null;
    if (!here) return;
    const at = stops.indexOf(here);
    // Any other key takes back a delete asked for once.
    if (e.key !== "Meta" && !(e.metaKey && e.key === "Backspace")) setArmed(null);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = stops[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) go(next.key);
      else if (e.key === "ArrowUp") search.current?.focus();
    } else if (e.key === "ArrowRight") {
      if (here.folds && !here.folds.open) { e.preventDefault(); setFold(here.key, true); }
    } else if (e.key === "ArrowLeft") {
      if (here.folds?.open) { e.preventDefault(); setFold(here.key, false); }
      else if (here.parent) { e.preventDefault(); go(here.parent); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(here, e.metaKey);
    } else if (e.metaKey && e.key === "Backspace") {
      const s = here.session;
      if (!s || here.parent) return;
      e.preventDefault();
      if (view === "active") archive(s.item, here.key); else remove(s.item, here.key);
    }
  };

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
                onChange={() => { setView(spaceId, v); setArmed(null); }} />
              {v === "active" ? "Active" : "Archived"} <span className="space-sessions-count">{page.counts[v]}</span>
            </label>
          ))}
        </fieldset>
        <label className="library-search space-sessions-search">
          <Icon name="search" size={14} />
          <input ref={search} className="search-field" type="search" aria-label="Search sessions" placeholder="Search sessions…"
            title="Search sessions (⌘F)" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query !== "") { e.preventDefault(); e.stopPropagation(); setQuery(""); }
              if (e.key === "ArrowDown" && stops[0]) { e.preventDefault(); go(stops[0].key); }
            }} />
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
      ) : (
        <div ref={list} className="space-sessions-groups" onKeyDown={onListKey}>
          {page.groups.map((g) => (
            <section key={g.key} className="space-sessions-group" aria-label={g.label}>
              <h2 className="space-sessions-head">{g.label}</h2>
              <ul className="space-sessions-list">
                {g.rows.map((r) => (
                  <PageRowView key={r.id} r={r} now={now} view={view} reply={r.kind === "session" ? replies[r.id] ?? null : null} open={isOpen(r)} current={here?.key ?? null} armed={armed}
                    onToggle={() => setFold(r.id, !isOpen(r))} onFocusStop={setCurrent}
                    onOpen={open} onArchive={archive} onDelete={remove} onRestore={restore} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  r: PageRow; now: number; view: SessionsView; reply: string | null; open: boolean; current: string | null; armed: string | null;
  onToggle: () => void; onFocusStop: (key: string) => void; onOpen: (stop: Stop, beside: boolean) => void;
  onArchive: (item: Item, key: string) => void; onDelete: (item: Item, key: string) => void; onRestore: (item: Item) => void;
};

/** One row of the page, and its sessions under it when it is unfolded. */
function PageRowView({ r, now, view, reply, open, current, armed, onToggle, onFocusStop, onOpen, onArchive, onDelete, onRestore }: RowProps) {
  const [renaming, setRenaming] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true));
  const lead = r.kind === "fan-out" ? null : r;
  const children = r.kind === "fan-out" ? r.row.sessions : r.agents;
  const title = r.kind === "fan-out" ? `Fan-out: ${r.row.title}` : r.row.title;
  const tally = r.kind === "fan-out" ? r.row.tally : r.tally;
  const folds = children.length > 0;
  const noun = r.kind === "fan-out" ? (children.length === 1 ? "session" : "sessions") : (children.length === 1 ? "agent" : "agents");
  const own = lead ? lead.row : null;
  const mark = own ? sessionMark(own.status, own.unread) : null;
  const isArmed = armed === r.id;
  const words = isArmed ? { text: "Press ⌘⌫ again to delete it and its transcript", tone: "danger" as const } : own ? stateWords(own, lead!.empty, reply) : null;
  const other = lead?.otherAgent ? AGENT_META[lead.otherAgent] : null;
  const named = [title, other?.label, mark?.label ?? (lead?.empty ? "nothing sent yet" : undefined),
    folds ? `${children.length} ${noun}` : undefined, ...tallyWords(tally)].filter(Boolean).join(", ");
  const stop: Stop = { key: r.id, session: own, agent: false, folds: folds ? { open } : null, parent: null };
  // The ⋯ is the row's own right-click menu, opened under the button.
  const menuAt = (e: MouseEvent<HTMLButtonElement>) => {
    if (!own) return;
    const box = e.currentTarget.getBoundingClientRect();
    onContextMenu(own.item)({ preventDefault: () => {}, clientX: box.left, clientY: box.bottom } as unknown as MouseEvent);
  };

  return (
    <li className="space-sessions-item">
      <div className="space-sessions-row" data-empty={lead?.empty || undefined} data-unread={mark?.mark === "unseen" || undefined}
        data-armed={isArmed || undefined} onContextMenu={own ? onContextMenu(own.item) : undefined}>
        <span className="space-sessions-gutter">
          {folds ? (
            // The disclosure's second target, for the pointer; the keyboard has → and ←.
            <button type="button" className="space-sessions-caret" tabIndex={-1} aria-hidden="true" onClick={onToggle}>
              <span className="sb-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span>
            </button>
          ) : other ? <Icon name={other.icon} size={16} colored /> : null}
        </span>
        {renaming && own ? <RenameInput item={own.item} onDone={() => setRenaming(false)} /> : (
          <button type="button" className="space-sessions-open" aria-label={named} data-stop={r.id} tabIndex={current === r.id ? 0 : -1}
            onFocus={() => onFocusStop(r.id)} onClick={(e) => onOpen(stop, e.metaKey)}>
            <span className="space-sessions-title">{title}</span>
            {folds && other && <Icon name={other.icon} size={12} colored />}
            {words && <span className="space-sessions-snippet" data-tone={words.tone}>{words.text}</span>}
          </button>
        )}
        {folds && (
          <button type="button" className="space-sessions-agents" aria-expanded={open} tabIndex={-1} onClick={onToggle}
            aria-label={`${open ? "Hide" : "Show"} ${children.length} ${noun} of ${title}`}>
            {children.length}<span className="space-sessions-noun">{noun}</span>
            <TallyMarks tally={tally} />
          </button>
        )}
        <span className="space-sessions-time">{relativeTime(r.at, now)}</span>
        <span className="space-sessions-dot">
          {mark && <span className="status-dot" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
        </span>
        {own && (
          <span className="space-sessions-actions">
            {view === "active" ? (
              <>
                <button type="button" className="icon-btn" tabIndex={-1} aria-label={`Open ${own.title} beside`} title="Open beside (⌘↩)"
                  onClick={() => onOpen(stop, true)}><Icon name="splitRight" size={14} /></button>
                {/* Nothing was sent in it, so there is nothing to lose: Delete is on the row itself. */}
                {lead!.empty && <DeleteButton title={own.title} armed={isArmed} onClick={() => onDelete(own.item, r.id)} />}
                <button type="button" className="icon-btn" tabIndex={-1} aria-label={`Archive ${own.title}`} title="Archive (⌘⌫)"
                  onClick={() => onArchive(own.item, r.id)}><Icon name="archive" size={14} /></button>
                <button type="button" className="icon-btn" tabIndex={-1} aria-label={`More for ${own.title}`} aria-haspopup="menu"
                  title="More" onClick={menuAt}><Icon name="more" size={14} /></button>
              </>
            ) : (
              <>
                <button type="button" className="btn space-sessions-restore" tabIndex={-1} aria-label={`Restore ${own.title}`}
                  title="Put it back in the sidebar" onClick={() => onRestore(own.item)}>Restore</button>
                <DeleteButton title={own.title} armed={isArmed} onClick={() => onDelete(own.item, r.id)} />
              </>
            )}
          </span>
        )}
      </div>
      {element}
      {folds && open && (
        <ul className="space-sessions-children">
          {children.map((c) => {
            const agent = r.kind === "session";
            const shown = agent ? agentTitle(c.title) : c.title;
            const cMark = sessionMark(c.status, c.unread);
            const cWords = stateWords(c, false);
            const word = agent ? CHILD_WORD[c.session?.dispatchedBy?.kind ?? "agent_run"] ?? "agent" : undefined;
            const cStop: Stop = { key: c.id, session: c, agent, folds: null, parent: r.id };
            return (
              <li key={c.id} className="space-sessions-item">
                <div className="space-sessions-row" data-child="" data-hit={r.hits.includes(c.id) || undefined} data-unread={cMark?.mark === "unseen" || undefined}>
                  <span className="space-sessions-gutter" />
                  <button type="button" className="space-sessions-open" aria-label={[shown, word, cMark?.label].filter(Boolean).join(", ")}
                    data-stop={c.id} tabIndex={current === c.id ? 0 : -1} onFocus={() => onFocusStop(c.id)}
                    onClick={(e) => onOpen(cStop, e.metaKey)}>
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

/** Delete, naming what goes. Asked for once while deletes ask, it says so and becomes the word. */
function DeleteButton({ title, armed, onClick }: { title: string; armed: boolean; onClick: () => void }) {
  return armed ? (
    <button type="button" className="btn danger space-sessions-delete" tabIndex={-1} aria-label={`Delete ${title} and its transcript`}
      onClick={onClick}>Delete</button>
  ) : (
    <button type="button" className="icon-btn" tabIndex={-1} aria-label={`Delete ${title}`} title="Delete (⌘⌫)"
      onClick={onClick}><Icon name="trash" size={14} /></button>
  );
}
