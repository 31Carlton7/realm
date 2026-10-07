import { Icon } from "@realm/ui";
import type { Goal, GoalStatus } from "@realm/contracts";
import { RESUMABLE_GOAL_STATUSES } from "@realm/contracts";

/**
 * The objective the session is pursuing, pinned above the prompter.
 *
 * It sits here rather than in the transcript for `TodoStrip`'s reason, which applies more strongly:
 * a goal is standing context, and the one in the log scrolls away after two turns while the agent is
 * still working on it. It is also the only place the state that matters is legible — a session that
 * will start its own next turn has to say so somewhere the user is already looking.
 *
 * Every stop offers its way out, in one control. That is the whole interaction: a goal is either
 * running (and can be paused), stopped and resumable (paused, blocked, spent budget), or finished.
 */

const WORDS: Record<GoalStatus, { label: string; dot: string }> = {
  active: { label: "Pursuing", dot: "running" },
  paused: { label: "Paused", dot: "machine-off" },
  blocked: { label: "Blocked", dot: "error" },
  budget_limited: { label: "Budget spent", dot: "machine-off" },
  complete: { label: "Done", dot: "done" },
  abandoned: { label: "Dropped", dot: "machine-off" },
};

/** The turn count and what it has cost, in the fewest words that stay true. Absent where it would
 *  say nothing: a goal that has not taken a turn yet has no figures to report. */
function facts(goal: Goal): string | null {
  const parts: string[] = [];
  if (goal.turns > 0) parts.push(`${goal.turns} turn${goal.turns === 1 ? "" : "s"}`);
  if (goal.tokenBudget !== null) {
    parts.push(`${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}% of budget`);
  } else if (goal.tokensUsed > 0) {
    parts.push(`${Math.round(goal.tokensUsed / 1000)}k tokens`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function GoalStrip({ goal, onPause, onResume, onDrop }: {
  goal: Goal | null;
  onPause: () => void;
  onResume: () => void;
  onDrop: () => void;
}) {
  if (!goal) return null;
  const words = WORDS[goal.status];
  const resumable = RESUMABLE_GOAL_STATUSES.includes(goal.status);
  const meta = facts(goal);
  return (
    <div className="composer-goal" data-status={goal.status}>
      <div className="composer-goal-head">
        <span className="status-dot" data-status={words.dot} aria-hidden="true" />
        <span className="composer-goal-label">{words.label}</span>
        {meta && <span className="composer-goal-facts">{meta}</span>}
        <span className="composer-goal-actions">
          {goal.status === "active" && (
            <button type="button" className="icon-btn" aria-label="Pause this goal" title="Pause" onClick={onPause}>
              <Icon name="pause" size={12} />
            </button>
          )}
          {resumable && (
            <button type="button" className="icon-btn" aria-label="Resume this goal" title="Resume" onClick={onResume}>
              <Icon name="play" size={12} />
            </button>
          )}
          {/* Drops the objective, never the work. What the agent did stays in the transcript and on
              disk; this is only Realm forgetting what it was for. */}
          <button type="button" className="icon-btn" aria-label="Drop this goal" title="Drop" onClick={onDrop}>
            <Icon name="close" size={12} />
          </button>
        </span>
      </div>
      {/* The objective itself, in the user's words, clamped rather than truncated mid-thought: two
          lines is enough to recognise a goal you set, and the transcript has the whole of it. */}
      <p className="composer-goal-objective">{goal.objective}</p>
      {/* Why it stopped, when something stopped it. The agent's own sentence on `blocked` and
          `complete`, Realm's on a spent budget — either way it is the last word on the goal, and a
          strip that said only "Blocked" would make the user go looking for it. */}
      {goal.note && goal.status !== "active" && <p className="composer-goal-note">{goal.note}</p>}
    </div>
  );
}
