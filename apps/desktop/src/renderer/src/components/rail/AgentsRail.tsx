import { itemIdOfLeaf, type Session } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo } from "react";
import { ago } from "../../panes/agents/AgentsPage";
import { useApp } from "../../state/store";
import { SpaceIcon } from "../SpaceIcon";
import { railAgents, workingKey } from "./rail-agents";

/**
 * The one control that opens and closes the right rail (⌥⌘B).
 *
 * The left sidebar's toggle, mirrored, and for the same reason it is rendered in both states: open,
 * it sits at the right end of the rail's own head; closed, the same button reappears in the window's
 * top-right corner. Same glyph, same name pattern, same 40px band — so it reads as having moved, and
 * there is never a state with no way back.
 */
export function RailToggle() {
  const open = useApp((s) => s.railOpen);
  const toggleRail = useApp((s) => s.toggleRail);
  const run = useApp((s) => s.run);
  return (
    <button className="sb-toggle rail-toggle" aria-label={open ? "Hide agents at work (⌥⌘B)" : "Show agents at work (⌥⌘B)"}
      aria-expanded={open} aria-controls="app-rail" onClick={() => run(() => toggleRail())}>
      <Icon name="sidebarRight" size={14} />
    </button>
  );
}

/**
 * The right rail: every agent at work, in every space, one click from its session.
 *
 * A column of the window rather than a pane. It does not split, it is not in any layout, and it
 * survives a space switch — which is the point of it. The Agents page answers "what is everything
 * doing" when you go and ask; this answers it while you are doing something else, and the thing
 * most worth seeing from the corner of an eye is an agent in ANOTHER space that has stopped to wait
 * for you.
 *
 * Mounted whether it is showing or not, for the sidebar's reason: closing is a move rather than an
 * unmount, and `inert` keeps a hidden column out of the keyboard and the accessibility tree.
 *
 * It asks the server for nothing on its own. Status and the "doing" line are pushed for every
 * session; the rows it names them from come from the cross-space list the store already keeps. The
 * one request it makes is re-reading that list when the set of working agents CHANGES — an agent
 * started, and its title may be newer than the list — never on a status flicker inside the set.
 */
export function AgentsRail() {
  const open = useApp((s) => s.railOpen);
  const rows = useApp((s) => s.sessionRows);
  const local = useApp((s) => s.sessions);
  const status = useApp((s) => s.sessionStatus);
  const quickChatId = useApp((s) => s.quickChat?.sessionId ?? null);
  const spaces = useApp((s) => s.spaces);
  const reveal = useApp((s) => s.revealSession);
  const refreshAllSessions = useApp((s) => s.refreshAllSessions);
  const run = useApp((s) => s.run);
  /* The session under the keyboard right now, so its row can say "you are here". A string or null,
     so the selector's answer compares by value and a re-render of the layout does not re-render
     every row. */
  const current = useApp((s) => {
    const id = itemIdOfLeaf(s.layout, s.focusedLeafId);
    const it = id ? s.items.find((i) => i.id === id) : undefined;
    return it?.kind === "session" ? it.refId : null;
  });

  const groups = useMemo(() => railAgents({ rows, local, status, quickChatId }), [rows, local, status, quickChatId]);
  const key = workingKey(groups);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);

  // Only while it is showing: a closed rail re-reading the session list every time an agent started
  // would be a request per turn for a column nobody can see.
  useEffect(() => { if (open && key) run(() => refreshAllSessions()); }, [open, key, run, refreshAllSessions]);

  const spaceOf = (id: string) => spaces.find((sp) => sp.id === id);

  return (
    <aside id="app-rail" className="rail" data-open={open || undefined} inert={!open || undefined}
      aria-label="Agents at work">
      {/* A fixed-width inner column, so the rail CLIPS while it opens and closes rather than
          re-wrapping its rows at every width it passes through on the way. */}
      <div className="rail-inner">
        <div className="rail-head">
          <span className="rail-title">At work</span>
          {count > 0 && <span className="rail-count" aria-label={`${count} ${count === 1 ? "agent" : "agents"}`}>{count}</span>}
          {/* Not while closed — the corner has it then. Two buttons with one name, told apart only by
              `inert`, is the trap the left sidebar already refused. */}
          {open && <RailToggle />}
        </div>
        <div className="rail-body">
          {groups.length === 0 ? (
            // What is true, not what would be encouraging: nothing is running, waiting, or broken.
            <p className="rail-empty">No agent is working right now.</p>
          ) : groups.map((g) => (
            <section key={g.state.status} className="rail-group" aria-label={g.state.label}>
              <h3 className="rail-group-label" title={g.state.hint}>{g.state.label}</h3>
              <ul className="rail-list">
                {g.rows.map((s) => (
                  <RailRow key={s.id} session={s} spaceName={spaceOf(s.spaceId)?.name ?? ""}
                    spaceIcon={spaceOf(s.spaceId)?.icon ?? ""} current={s.id === current}
                    onOpen={() => run(() => reveal(s.id, s.spaceId))} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}

function RailRow({ session, spaceName, spaceIcon, current, onOpen }: {
  session: Session; spaceName: string; spaceIcon: string; current: boolean; onOpen: () => void;
}) {
  const doing = useApp((s) => s.sessionActivity[session.id]);
  const status = useApp((s) => s.sessionStatus[session.id] ?? session.status);
  // The live stamp where one has been heard, which a status change moves; the row's own otherwise.
  const moved = useApp((s) => s.sessionUpdatedAt[session.id] ?? session.updatedAt);
  return (
    <li>
      <button type="button" className="rail-row" onClick={onOpen} aria-current={current ? "true" : undefined}
        title={`${session.title} — ${spaceName}`}>
        <span className="rail-row-head">
          <span className="status-dot rail-row-status" data-status={status} />
          <span className="rail-row-title">{session.title}</span>
          <span className="rail-row-when">{ago(moved)}</span>
        </span>
        {/* No line at all rather than a placeholder when nothing has been heard: an agent that has
            said nothing is not an agent doing nothing, and only one of those is knowable. */}
        {doing && (
          <span className="rail-row-doing">
            <Icon name={doing.icon} size={12} className="rail-row-doing-mark" />
            <span className="rail-row-doing-text">{doing.text}</span>
          </span>
        )}
        <span className="rail-row-space">
          {spaceIcon && <SpaceIcon icon={spaceIcon} size={12} />}
          <span>{spaceName}</span>
        </span>
      </button>
    </li>
  );
}
