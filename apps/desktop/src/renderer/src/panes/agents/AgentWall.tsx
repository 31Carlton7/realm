import { AGENT_META, DEFAULT_MODEL_LABEL, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { basenameOf, ago, type groupAgents } from "./AgentsPage";

/**
 * One agent, as a tile on the wall.
 *
 * A card rather than a row because it carries three lines, and three lines separated by nothing but
 * a line break read as one block of prose. It says no status word: the tile lives under a heading
 * that already says it, and repeating "Working" on every tile of the Working group is the label
 * nobody reads by the third one.
 *
 * The live line is the one thing the list cannot show — what this agent is doing RIGHT NOW, folded
 * out of the event broadcast (`session-activity.ts`). Where nothing has been heard from a session
 * since this window connected, the tile draws no line at all rather than a placeholder: an agent
 * that has said nothing is not an agent doing nothing, and only one of those two is knowable.
 */
function AgentTile({ session, spaceName, onOpen }: { session: Session; spaceName: string; onOpen: () => void }) {
  const doing = useApp((s) => s.sessionActivity[session.id]);
  const model = session.model ?? DEFAULT_MODEL_LABEL[session.agentKind];
  return (
    <button type="button" className="agent-tile" onClick={onOpen}
      title={`${session.title} — ${spaceName} · ${session.cwd} · ${model}`}>
      <span className="agent-tile-head">
        <Icon name={AGENT_META[session.agentKind].icon} size={16} colored className="agent-tile-mark" />
        <span className="agent-tile-title">{session.title}</span>
        <span className="agent-tile-when">{ago(session.updatedAt)}</span>
      </span>
      {doing && (
        <span className="agent-tile-doing">
          <Icon name={doing.icon} size={12} className="agent-tile-doing-mark" />
          <span className="agent-tile-doing-text">{doing.text}</span>
        </span>
      )}
      <span className="agent-tile-sub">
        <span>{spaceName}</span>
        {/* The folder is what tells a fan-out's agents apart — one worktree each — so it is the
            part of this line that may not be given up first. Mono, like the list's own row. */}
        <span className="agent-tile-mono">{basenameOf(session.cwd)}</span>
      </span>
    </button>
  );
}

/**
 * The live ones as a field of tiles: the same sessions the list ranks, read for what each is doing
 * rather than for what it needs from you.
 *
 * Deliberately NOT every session. `Ready` is every session that ever finished — 254 rows on a real
 * home — and a wall is a shape you count, so drawing history as tiles would be the mosaic of tiny
 * panels the guidelines refuse, with the three that matter lost in it. The list keeps the whole
 * archive and its folds; the wall shows the ones that are live, and says so when none are.
 */
export function AgentWall({ groups, spaceName, onOpen, visible }: {
  /* The page's own grouping, verbatim. Taking `groupAgents`' return type rather than restating its
     shape is what keeps the two views from ever disagreeing about which group a session is in. */
  groups: ReturnType<typeof groupAgents>;
  spaceName: (spaceId: string) => string;
  onOpen: (session: Session) => void;
  visible: boolean;
}) {
  const live = groups.filter((g) => LIVE.has(g.state.status));
  if (live.length === 0) {
    return <p className="env-empty">No agents are working right now. The list has every session that has finished.</p>;
  }
  return (
    <>
      {live.map((g) => (
        <section key={g.state.status} className="agents-group" aria-label={g.state.label}>
          <h2 className="agents-group-label" title={g.state.hint}>
            <span className="agents-dot" data-status={g.state.status} aria-hidden="true" />
            {g.state.label}
            <span className="agents-group-count">{g.rows.length}</span>
          </h2>
          <div className="agent-wall">
            {g.rows.map((s) => (
              <AgentTile key={s.id} session={s} spaceName={spaceName(s.spaceId)} onOpen={() => onOpen(s)} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** The three states a wall is for: blocked on you, working, or stopped on an error. Typed against
 *  `SessionStatus` so a status renamed out from under this set is a build error rather than a group
 *  that quietly stops being drawn. */
const LIVE = new Set<SessionStatus>(["waiting_permission", "running", "error"]);
